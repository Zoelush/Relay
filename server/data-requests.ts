import { zipSync, strToU8 } from "fflate";
import { assert, canonical, DomainError, tenant, type Connect, type Sql } from "./db";
import { authorize } from "./policy";
import { enqueueJob, type Job } from "./jobs";
import { recordAudit } from "./audit";
import type { AttachmentStorage } from "./attachments";
import { securityOn } from "./two-factor";
import { erase, findSubject, objectsOf, type Subject } from "./erasure";
import { eraseAnalytics } from "./erasure-analytics";
import type { AnalyticsStore } from "./analytics";
import { SmsRejected, type SmsApi } from "./sms-api";
import { credentials as smsCredentials } from "./sms";
import { PROCESSORS } from "../lib/processors";

/**
 * Data subject requests (phase 16, step C5a; docs/SECURITY_STEP7.md): Settings › Security › Data
 * requests (`security.manage`, behind `security_v1`). Find one person; export everything about them
 * (`dsr.export`: a zip of `person.json` and their files, behind a signed link for seven days), or
 * delete it (`dsr.delete`: `server/erasure.ts`'s cascade, their files, and, from C5b, the
 * analytical store (`server/erasure-analytics.ts`) and Twilio; then a signed certificate that also
 * lists every processor (`lib/processors.ts`) and when backups stop holding them).
 *
 * A request is in the audit log by its id only. Once a deletion finishes (or an export expires)
 * the request keeps no personal data: only its kind, counts and certificate.
 */
export type DataRequestEnvironment = {
  storage?: AttachmentStorage;
  key?: string;
  /** C5b: the analytical store, Twilio, and how long PostgreSQL's backups keep someone (days). */
  analytics?: AnalyticsStore;
  sms?: SmsApi;
  backupDays?: number;
};
const EXPORT_DAYS = 7;
const EXPORT_FILE_BYTES = 50 * 1024 * 1024;
type Ref = { contactId?: string; email?: string; phone?: string; externalId?: string };

/** One field, typed by what it looks like: an email, a phone, a contact id, or an external id. */
function readRef(value: unknown): Ref {
  const v = typeof value === "string" ? value.trim() : "";
  assert(v && v.length <= 320, "INVALID_FIELD", "Enter an email, phone number, external ID or contact ID.");
  if (v.includes("@")) return { email: v.toLowerCase() };
  if (/^\+?[\d\s()-]{6,20}$/.test(v)) return { phone: v.replace(/[\s()-]/g, "") };
  return { contactId: v, externalId: v };
}

async function preview(db: Sql, w: string, contactId: string) {
  const c = (await db.query<{ id: string; name: string | null; external_id: string | null }>("SELECT id,name,external_id FROM contacts WHERE workspace_id=$1 AND id=$2", [w, contactId])).rows[0];
  assert(c, "NOT_FOUND", "Nobody here matches that.", 404);
  const s = (await findSubject(db, w, { contactId }))!;
  return {
    contactId: c.id,
    name: c.name,
    externalId: c.external_id,
    emails: s.addresses.filter((a) => a.includes("@")),
    phones: s.addresses.filter((a) => !a.includes("@")),
    conversations: s.conversations.length,
    takesPartIn: s.others.length,
    mergedContacts: s.contacts.length - 1,
  };
}

export async function readDataRequests(db: Sql, w: string, principal: string) {
  await authorize(db, w, principal, "security.manage");
  await securityOn(db, w);
  const rows = (
    await db.query<{
      id: string;
      kind: string;
      state: string;
      label: string | null;
      created_at: Date;
      finished_at: Date | null;
      error: string | null;
      export_key: string | null;
      export_expires_at: Date | null;
      counts: Record<string, number> | null;
      certificate: unknown;
      requested_by: string;
      by: string | null;
    }>(
      `SELECT r.*,t.name AS by FROM data_requests r LEFT JOIN teammates t ON t.workspace_id=r.workspace_id AND t.id=r.requested_by
       WHERE r.workspace_id=$1 ORDER BY r.created_at DESC LIMIT 50`,
      [w],
    )
  ).rows;
  return {
    requests: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      state: r.state,
      label: r.label,
      requestedBy: r.by,
      createdAt: new Date(r.created_at).toISOString(),
      finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
      error: r.error,
      exportReady: !!r.export_key && !!r.export_expires_at && new Date(r.export_expires_at) > new Date(),
      exportExpiresAt: r.export_expires_at ? new Date(r.export_expires_at).toISOString() : null,
      counts: r.counts,
      certificate: r.certificate ?? null,
    })),
  };
}

export async function changeDataRequests(db: Sql, w: string, principal: string, env: DataRequestEnvironment, origin: string | null, p: Record<string, unknown>) {
  const me = await authorize(db, w, principal, "security.manage");
  await securityOn(db, w);
  if (p.action === "find") {
    const s = await findSubject(db, w, readRef(p.query));
    assert(s, "NOT_FOUND", "Nobody here matches that.", 404);
    return { found: await preview(db, w, s!.contacts[0]) };
  }
  if (p.action === "export" || p.action === "delete") {
    const found = await preview(db, w, String(p.contactId ?? ""));
    if (p.action === "delete") {
      const confirm = typeof p.confirm === "string" ? p.confirm.trim().toLowerCase() : "";
      assert(confirm === "delete" || found.emails.includes(confirm), "CONFIRM", "Type their email address, or the word delete, to confirm.");
    }
    const id = crypto.randomUUID();
    await db.query("INSERT INTO data_requests(workspace_id,id,kind,subject,label,requested_by) VALUES($1,$2,$3,$4,$5,$6)", [
      w,
      id,
      p.action,
      JSON.stringify({ contactId: found.contactId }),
      found.emails[0] ?? found.name ?? found.externalId ?? found.phones[0] ?? found.contactId,
      me.id,
    ]);
    await enqueueJob(db, w, p.action === "export" ? "dsr.export" : "dsr.delete", { requestId: id }, {});
    await recordAudit(db, w, p.action === "export" ? "data.subject_export_requested" : "data.erasure_requested", { type: "data_request", id });
    return { requestId: id, ...(await readDataRequests(db, w, principal)) };
  }
  if (p.action === "download") {
    const r = (await db.query<{ export_key: string | null; export_expires_at: Date | null }>("SELECT export_key,export_expires_at FROM data_requests WHERE workspace_id=$1 AND id=$2", [w, String(p.id ?? "")])).rows[0];
    assert(r?.export_key && r.export_expires_at && new Date(r.export_expires_at) > new Date(), "NOT_FOUND", "That export has expired or isn't ready.", 404);
    assert(env.storage, "UNAVAILABLE", "Storage isn't available.", 503);
    await recordAudit(db, w, "data.subject_export_downloaded", { type: "data_request", id: String(p.id) });
    return { url: new URL((await env.storage!.signDownload(r!.export_key!, false)).url, origin ?? "http://localhost").toString() };
  }
  throw new DomainError("INVALID_DATA_REQUEST", "Choose find, export, delete or download.");
}

/* ------------------------------------------------------------------------------------------ */
/* The export                                                                                  */
/* ------------------------------------------------------------------------------------------ */
const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
const from = (t: string) => (t === "contact" ? "you" : t === "teammate" ? "teammate" : t === "ai" ? "Zoe (AI agent)" : "system");

/** What they can see and what is about them: their records and customer-visible messages, never internal notes. */
async function exportDocument(db: Sql, w: string, s: Subject) {
  const contacts = (
    await db.query<{ id: string; name: string | null; external_id: string | null; role: string; profile: unknown; first_seen_at: Date; last_seen_at: Date | null; signed_up_at: Date | null }>(
      "SELECT id,name,external_id,role,profile,first_seen_at,last_seen_at,signed_up_at FROM contacts WHERE workspace_id=$1 AND id=ANY($2) ORDER BY merged_into_contact_id IS NOT NULL,first_seen_at",
      [w, s.contacts],
    )
  ).rows;
  const subscriptions = (
    await db.query<{ name: string; state: string; updated_at: Date }>(
      `SELECT t.name,cs.state,cs.changed_at AS updated_at FROM contact_subscriptions cs JOIN subscription_types t ON t.workspace_id=cs.workspace_id AND t.id=cs.subscription_type_id
       WHERE cs.workspace_id=$1 AND cs.contact_id=ANY($2)`,
      [w, s.contacts],
    )
  ).rows;
  const events = (
    await db.query<{ name: string; metadata: unknown; occurred_at: Date }>("SELECT name,metadata,occurred_at FROM contact_events WHERE workspace_id=$1 AND contact_id=ANY($2) ORDER BY occurred_at", [w, s.contacts])
  ).rows;
  const conversations = (
    await db.query<{ id: string; channel: string; created_at: Date; status: string; title: string | null; rating: number | null }>(
      "SELECT id,channel,created_at,status,title,rating FROM conversations WHERE workspace_id=$1 AND id=ANY($2) ORDER BY created_at",
      [w, s.conversations],
    )
  ).rows;
  const parts = (
    await db.query<{ id: string; conversation_id: string; created_at: Date; author_type: string; channel: string; body: string; kind: string }>(
      `SELECT id,conversation_id,created_at,author_type,channel,body,kind FROM conversation_parts
       WHERE workspace_id=$1 AND (conversation_id=ANY($2) OR id=ANY($3)) AND audience='public' AND body<>'' ORDER BY conversation_id,seq`,
      [w, s.conversations, s.parts],
    )
  ).rows;
  const tickets = (
    await db.query<{ conversation_id: string; number: string; type: string; state: string; created_at: Date }>(
      `SELECT k.conversation_id,k.number,ty.name AS type,st.name AS state,k.created_at FROM tickets k JOIN ticket_types ty ON ty.workspace_id=k.workspace_id AND ty.id=k.type_id
       JOIN ticket_states st ON st.workspace_id=k.workspace_id AND st.type_id=k.type_id AND st.id=k.state_id WHERE k.workspace_id=$1 AND k.conversation_id=ANY($2)`,
      [w, s.conversations],
    )
  ).rows;
  const files = (
    await db.query<{ id: string; conversation_id: string | null; name: string; mime: string; size: string; clean_key: string | null }>(
      // Files they sent, and files teammates sent them; never internal ones.
      "SELECT id,conversation_id,name,mime,size,clean_key FROM attachments WHERE workspace_id=$1 AND status='clean' AND (owner_identity_id=ANY($3) OR (conversation_id=ANY($2) AND audience='customer_visible')) ORDER BY created_at",
      [w, s.conversations, s.identities],
    )
  ).rows;
  const addresses = (await db.query<{ channel: string; address: string; verified: boolean }>("SELECT channel,address,verified FROM identity_addresses WHERE workspace_id=$1 AND identity_id=ANY($2)", [w, s.identities])).rows;
  const byConversation = new Map<string, typeof parts>();
  for (const p of parts) byConversation.set(p.conversation_id, [...(byConversation.get(p.conversation_id) ?? []), p]);
  return {
    files,
    document: {
      exportedAt: new Date().toISOString(),
      format: "relay-person-export/1",
      person: contacts.map((c) => ({
        id: c.id,
        name: c.name,
        externalId: c.external_id,
        role: c.role,
        attributes: c.profile,
        firstSeenAt: iso(c.first_seen_at),
        lastSeenAt: iso(c.last_seen_at),
        signedUpAt: iso(c.signed_up_at),
      })),
      emails: s.addresses.filter((a) => a.includes("@")),
      phones: s.addresses.filter((a) => !a.includes("@")),
      channelAddresses: addresses,
      subscriptions: subscriptions.map((x) => ({ type: x.name, state: x.state, since: iso(x.updated_at) })),
      events: events.map((e) => ({ name: e.name, metadata: e.metadata, at: iso(e.occurred_at) })),
      conversations: conversations.map((c) => ({
        id: c.id,
        channel: c.channel,
        startedAt: iso(c.created_at),
        status: c.status,
        title: c.title,
        rating: c.rating,
        messages: (byConversation.get(c.id) ?? []).map((m) => ({ at: iso(m.created_at), from: from(m.author_type), channel: m.channel, text: m.body })),
      })),
      messagesInOthersConversations: parts.filter((p) => s.parts.includes(p.id)).map((m) => ({ at: iso(m.created_at), channel: m.channel, text: m.body })),
      tickets: tickets.map((t) => ({ conversation: t.conversation_id, number: Number(t.number), type: t.type, state: t.state, createdAt: iso(t.created_at) })),
      files: [] as { name: string; conversation: string | null; inZip: string | null; note?: string }[],
    },
  };
}

export async function dataExportJob(connect: Connect, env: DataRequestEnvironment, job: Job) {
  const w = job.workspace_id;
  const { requestId } = job.payload as { requestId: string };
  const r = (await tenant(connect, w, async (db) => (await db.query<{ subject: { contactId: string } | null; state: string }>("SELECT subject,state FROM data_requests WHERE workspace_id=$1 AND id=$2", [w, requestId])).rows[0]))!;
  if (!r || r.state === "done" || !r.subject) return { done: true, result: { skipped: true } };
  if (!env.storage) {
    await tenant(connect, w, (db) => db.query("UPDATE data_requests SET state='failed',error=$3,finished_at=now() WHERE workspace_id=$1 AND id=$2", [w, requestId, "Storage isn't available here."]));
    return { done: true, result: { failed: "no storage" } };
  }
  const built = await tenant(connect, w, async (db) => {
    const s = await findSubject(db, w, { contactId: r.subject!.contactId });
    return s ? { s, ...(await exportDocument(db, w, s)) } : null;
  });
  if (!built) {
    await tenant(connect, w, (db) => db.query("UPDATE data_requests SET state='failed',error='They are no longer here.',finished_at=now() WHERE workspace_id=$1 AND id=$2", [w, requestId]));
    return { done: true, result: { failed: "gone" } };
  }
  // Their files, up to 50 MB in all; any beyond are listed by name.
  const zip: Record<string, Uint8Array> = {};
  let bytes = 0;
  for (const f of built.files) {
    const safe = `files/${f.id.slice(0, 8)}-${f.name.replace(/[^\w.\- ]+/g, "_").slice(0, 120)}`;
    const body = f.clean_key && env.storage.readClean && bytes + Number(f.size) <= EXPORT_FILE_BYTES ? await env.storage.readClean(f.clean_key).catch(() => null) : null;
    if (body?.ok) {
      const data = new Uint8Array(await body.arrayBuffer());
      bytes += data.length;
      zip[safe] = data;
      built.document.files.push({ name: f.name, conversation: f.conversation_id, inZip: safe });
    } else built.document.files.push({ name: f.name, conversation: f.conversation_id, inZip: null, note: "Not included: too large for the export, or no longer stored." });
  }
  zip["person.json"] = strToU8(JSON.stringify(built.document, null, 2));
  const key = `dsr/${w}/${requestId}.zip`;
  await env.storage.putClean(key, zipSync(zip, { level: 6 }), "application/zip", "relay-person-export.zip");
  const counts = { conversations: built.document.conversations.length, messages: built.document.conversations.reduce((n, c) => n + c.messages.length, 0), files: Object.keys(zip).length - 1 };
  await tenant(connect, w, async (db) => {
    await db.query(
      "UPDATE data_requests SET state='done',finished_at=now(),export_key=$3,export_expires_at=now()+($4::int*interval '1 day'),counts=$5 WHERE workspace_id=$1 AND id=$2",
      [w, requestId, key, EXPORT_DAYS, JSON.stringify(counts)],
    );
    await recordAudit(db, w, "data.subject_exported", { type: "data_request", id: requestId }, counts);
  });
  return { done: true, result: counts };
}

/* ------------------------------------------------------------------------------------------ */
/* The deletion, and its certificate                                                           */
/* ------------------------------------------------------------------------------------------ */
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
async function certificateKey(master: string) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(master), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const derived = await crypto.subtle.sign("HMAC", base, new TextEncoder().encode("relay-dsr-certificate/1"));
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
/** A certificate's signature: HMAC-SHA-256 over its canonical JSON, with a key derived from the connector key. */
export async function signCertificate(master: string, body: Record<string, unknown>) {
  const signature = hex(await crypto.subtle.sign("HMAC", await certificateKey(master), new TextEncoder().encode(canonical(body))));
  return { ...body, signature: { algorithm: "HMAC-SHA-256", value: signature } };
}
/** Whether Relay issued this certificate, unchanged. */
export async function verifyCertificate(master: string, certificate: Record<string, unknown>) {
  const { signature, ...body } = certificate as { signature?: { value?: string } } & Record<string, unknown>;
  if (!signature?.value || !/^[0-9a-f]{64}$/.test(signature.value)) return false;
  const bytes = new Uint8Array(signature.value.match(/../g)!.map((h) => parseInt(h, 16)));
  return crypto.subtle.verify("HMAC", await certificateKey(master), bytes, new TextEncoder().encode(canonical(body)));
}

type Pending = {
  quarantine: string[];
  clean: string[];
  /** C5b: the ids the analytical store knows them by. */
  analytics?: { conversations: string[]; contacts: string[]; identities: string[] };
  /** C5b: what Twilio holds of them. */
  twilio?: { recordings: string[]; messages: string[] };
  /** Each later stage's result, kept as it finishes so a retry carries on. */
  done?: { files?: number; analytics?: Record<string, number> | null; twilio?: { recordings: number; messages: number; refused: string[] } | null };
};
const twilioOf = async (db: Sql, w: string, s: Subject) => ({
  recordings: (
    await db.query<{ sid: string }>(
      `SELECT recording_sid AS sid FROM voice_calls WHERE workspace_id=$1 AND recording_sid IS NOT NULL AND (conversation_id=ANY($2) OR lower(from_phone)=ANY($3) OR lower(to_phone)=ANY($3))
       UNION SELECT payload->>'RecordingSid' FROM voice_inbound WHERE workspace_id=$1 AND payload ? 'RecordingSid'
         AND call_sid IN (SELECT call_sid FROM voice_calls WHERE workspace_id=$1 AND (conversation_id=ANY($2) OR lower(from_phone)=ANY($3) OR lower(to_phone)=ANY($3)))`,
      [w, s.conversations, s.addresses],
    )
  ).rows.map((r) => r.sid),
  messages: (
    await db.query<{ sid: string }>(
      `SELECT provider_id AS sid FROM channel_deliveries WHERE workspace_id=$1 AND channel='sms' AND provider_id IS NOT NULL AND (conversation_id=ANY($2) OR lower(address)=ANY($3))
       UNION SELECT external_id FROM channel_messages WHERE workspace_id=$1 AND channel='sms' AND conversation_id=ANY($2)`,
      [w, s.conversations, s.addresses],
    )
  ).rows.map((r) => r.sid),
});
const save = (connect: Connect, w: string, id: string, pending: Pending) =>
  tenant(connect, w, (db) => db.query("UPDATE data_requests SET pending_objects=$3 WHERE workspace_id=$1 AND id=$2", [w, id, JSON.stringify(pending)]));

export async function dataDeleteJob(connect: Connect, env: DataRequestEnvironment, job: Job) {
  const w = job.workspace_id;
  const { requestId } = job.payload as { requestId: string };
  assert(env.key, "UNAVAILABLE", "Relay has no key to sign the certificate with.", 503);
  // 1. Every row, in one transaction: the person is either wholly erased from PostgreSQL or not at all.
  //    What the later stages need (storage keys, the analytical store's ids, Twilio's ids) is kept first.
  const step = await tenant(connect, w, async (db) => {
    const r = (
      await db.query<{ subject: { contactId: string } | null; state: string; created_at: Date; pending_objects: Pending | null; counts: Record<string, number> | null; certificate: { identifiersDigest?: string } | null }>(
        "SELECT subject,state,created_at,pending_objects,counts,certificate FROM data_requests WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [w, requestId],
      )
    ).rows[0];
    if (!r || r.state === "done") return null;
    if (r.pending_objects) return { pending: r.pending_objects, counts: r.counts ?? {}, digest: r.certificate?.identifiersDigest ?? null, createdAt: r.created_at };
    const s = r.subject ? await findSubject(db, w, { contactId: r.subject.contactId }) : null;
    if (!s) {
      await db.query("UPDATE data_requests SET state='failed',error='They are no longer here.',finished_at=now(),subject=NULL,label=NULL WHERE workspace_id=$1 AND id=$2", [w, requestId]);
      return null;
    }
    const pending: Pending = {
      ...(await objectsOf(db, w, s)),
      analytics: { conversations: s.conversations, contacts: s.contacts, identities: s.identities },
      twilio: await twilioOf(db, w, s),
      done: {},
    };
    const counts = await erase(db, w, s);
    const digest = await sha256(canonical([...s.contacts, ...s.identities, ...s.addresses, ...s.externalIds].sort()));
    await db.query("UPDATE data_requests SET state='running',subject=NULL,pending_objects=$3,counts=$4,certificate=jsonb_build_object('identifiersDigest',$5::text) WHERE workspace_id=$1 AND id=$2", [
      w,
      requestId,
      JSON.stringify(pending),
      JSON.stringify(counts),
      digest,
    ]);
    return { pending, counts, digest, createdAt: r.created_at };
  });
  if (!step) return { done: true, result: { skipped: true } };
  const pending = step.pending;
  pending.done ??= {};
  // 2. Their files (the rows that named them are gone; the keys were kept for this).
  if (pending.done.files === undefined) {
    let removed = 0;
    if (env.storage) {
      for (const k of pending.quarantine) await env.storage.deleteQuarantine(k).then(() => removed++);
      for (const k of pending.clean) if (env.storage.deleteClean) await env.storage.deleteClean(k).then(() => removed++);
    }
    pending.done.files = removed;
    await save(connect, w, requestId, pending);
  }
  // 3. C5b: the analytical store keeps its counts and loses them.
  if (pending.done.analytics === undefined) {
    pending.done.analytics = env.analytics && pending.analytics ? await eraseAnalytics(env.analytics, w, pending.analytics) : null;
    await save(connect, w, requestId, pending);
  }
  // 4. C5b: Twilio's recordings and text records. A refusal for good is recorded, not retried forever.
  if (pending.done.twilio === undefined) {
    const sids = pending.twilio ?? { recordings: [], messages: [] };
    const account = sids.recordings.length + sids.messages.length && env.sms ? await tenant(connect, w, (db) => smsCredentials(db, w, env.key!)) : null;
    if (account && env.sms) {
      const result = { recordings: 0, messages: 0, refused: [] as string[] };
      for (const [kind, list] of [["recording", sids.recordings], ["message", sids.messages]] as const)
        for (const sid of list)
          try {
            await (kind === "recording" ? env.sms.deleteRecording(account, sid) : env.sms.deleteMessage(account, sid));
            result[kind === "recording" ? "recordings" : "messages"]++;
          } catch (e) {
            if (!(e instanceof SmsRejected)) throw e;
            result.refused.push(`${kind} ${sid}: ${e.message.slice(0, 120)}`);
          }
      pending.done.twilio = result;
    } else pending.done.twilio = null;
    await save(connect, w, requestId, pending);
  }
  // 5. The certificate, signed, and the request left with nothing about them.
  const done = pending.done;
  const completedAt = new Date();
  const backupDays = env.backupDays ?? 7;
  await tenant(connect, w, async (db) => {
    const certificate = await signCertificate(env.key!, {
      kind: "relay-deletion-certificate/1",
      request: requestId,
      workspace: w,
      requestedAt: new Date(step.createdAt).toISOString(),
      completedAt: completedAt.toISOString(),
      identifiersDigest: step.digest,
      stores: {
        postgresql: step.counts,
        files: { objects: done.files ?? 0 },
        analyticalStore: done.analytics ?? "not in use in this workspace",
        embeddings: "holds no customer data: only knowledge content is embedded",
        twilio: done.twilio ?? "nothing held there",
      },
      processors: PROCESSORS.map((p) => ({ id: p.id, name: p.name, deletion: p.deletion, keeps: p.keeps })),
      backups: { windowDays: backupDays, clearBy: new Date(completedAt.getTime() + backupDays * 86_400_000).toISOString() },
    });
    const total: Record<string, number> = { ...step.counts, "files (storage)": done.files ?? 0 };
    for (const [t, n] of Object.entries(done.analytics ?? {})) total[`${t} (analytical store, unlinked)`] = n;
    if (done.twilio) total["Twilio recordings and messages"] = done.twilio.recordings + done.twilio.messages;
    await db.query(
      "UPDATE data_requests SET state='done',finished_at=now(),pending_objects=NULL,label=NULL,subject=NULL,certificate=$3,counts=$4,error=$5 WHERE workspace_id=$1 AND id=$2",
      [w, requestId, JSON.stringify(certificate), JSON.stringify(total), done.twilio?.refused.length ? `Twilio refused ${done.twilio.refused.length}: see the certificate.` : null],
    );
    await recordAudit(db, w, "data.erased", { type: "data_request", id: requestId }, { tables: Object.keys(step.counts).length, files: done.files ?? 0, twilio: done.twilio ? done.twilio.recordings + done.twilio.messages : 0 });
  });
  return { done: true, result: { tables: Object.keys(step.counts).length, files: done.files ?? 0 } };
}

/** From the sweep: exports past their seven days are deleted, and their requests forget who they were for. */
export async function expireDataExports(connect: Connect, w: string, storage?: AttachmentStorage) {
  const due = await tenant(connect, w, async (db) =>
    (await db.query<{ id: string; export_key: string }>("SELECT id,export_key FROM data_requests WHERE workspace_id=$1 AND export_key IS NOT NULL AND export_expires_at<=now() LIMIT 100", [w])).rows,
  );
  for (const r of due) {
    if (storage?.deleteClean) await storage.deleteClean(r.export_key).catch(() => undefined);
    await tenant(connect, w, (db) => db.query("UPDATE data_requests SET export_key=NULL,subject=NULL,label=NULL WHERE workspace_id=$1 AND id=$2", [w, r.id]));
  }
  return due.length;
}

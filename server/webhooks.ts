import { assert, DomainError, tenant, type Connect, type Sql } from "./db";
import { authorize } from "./policy";
import { seal, unseal } from "./connectors";
import { checkAddress, FetchRefused, safeRequest, type FetchPolicy } from "./safe-fetch";
import { enqueueJob, type Job } from "./jobs";
import { developerOn } from "./developer";
import { contactOut, CONTACT_SELECT, cursor, invalid, listOf, readConversation, type ContactRow, type Context } from "./rest";
import { articleOut, eventOut, readRecord, readTicket, type EventRow } from "./rest-more";
import { LATEST_VERSION } from "../lib/api-spec";
import { TOPICS, TOPIC_IDS } from "../lib/webhook-topics";

/**
 * Webhooks (phase 15, step D3; docs/DEVELOPER_PLATFORM_STEP3.md), behind `developer_api_v1`.
 *
 * - **Events** are written by the database, in the transaction that made the change, only while a
 *   subscription wants the topic (`webhook_emit`, migration 0078).
 * - **Delivery** is the `webhooks.run` job (scheduled by the sweep): each event fans out to its
 *   subscriptions with its payload built once, in the API's own shapes (kept, so a retry or replay
 *   sends exactly the same body); then due deliveries are POSTed, signed, with a 10-second timeout.
 * - **At least once:** a failure is retried with exponential backoff (1 minute, doubling, at most
 *   2 hours apart) until 24 hours have passed, then abandoned. A subscription that has failed for
 *   24 hours with no success is disabled; its creator is told in Relay, and by email if it names an
 *   address (through `sendAlert`, the one alert email path).
 * - **Signing:** `Relay-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">`; while a secret is
 *   being rotated, the previous secret's signature is a second `v1` for 24 hours.
 * - **The log:** every attempt, its status, time and the first 1 KB of the answer, kept 30 days; any
 *   delivery can be replayed (a new delivery, the same event id and body).
 */
export type WebhookEnvironment = { key: string; policy?: FetchPolicy };
const RETRY_FOR_MS = 24 * 3_600_000;
const DISABLE_AFTER_MS = 24 * 3_600_000;
const KEEP_DAYS = 30;
const backoffMs = (attempts: number) => Math.min(2 * 3_600_000, 60_000 * 2 ** Math.max(0, attempts - 1));

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function hmac(secret: string, text: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
}
/** The `Relay-Signature` header for a body at a time, under each live secret. */
export async function signature(secrets: string[], body: string, at = Math.floor(Date.now() / 1000)) {
  const parts = [`t=${at}`];
  for (const s of secrets) parts.push(`v1=${await hmac(s, `${at}.${body}`)}`);
  return parts.join(",");
}
const newSecret = () => "whsec_" + [...crypto.getRandomValues(new Uint8Array(32))].map((b) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[b % 62]).join("");
const sealed = (env: WebhookEnvironment, w: string, id: string, secret: string) => seal(env.key, w, id, "webhook_secret", secret);
const opened = (env: WebhookEnvironment, w: string, id: string, s: string) => unseal(env.key, w, id, "webhook_secret", s);

async function teammateOf(db: Sql, w: string, principal: string) {
  const t = (await db.query<{ id: string }>("SELECT id FROM teammates WHERE workspace_id=$1 AND principal_id=$2", [w, principal])).rows[0];
  assert(t, "FORBIDDEN", "Sign in as a teammate.", 403);
  return t.id;
}
const field = (f: string, message: string) => new DomainError("INVALID_FIELD", message, 400, { field: f });
function checkUrl(raw: unknown, env: WebhookEnvironment) {
  if (typeof raw !== "string") throw field("url", "Give the address to send to.");
  try {
    return checkAddress(raw, env.policy ?? {}).toString();
  } catch {
    throw field("url", "Webhooks go to a public https address.");
  }
}
function checkTopics(raw: unknown) {
  const topics = Array.isArray(raw) ? [...new Set(raw.map(String))] : [];
  if (!topics.length) throw field("topics", "Choose at least one topic.");
  const unknown = topics.filter((t) => !TOPIC_IDS.includes(t));
  if (unknown.length) throw field("topics", `There's no topic ${unknown[0]}.`);
  return topics;
}
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;
function checkEmail(raw: unknown) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" || !EMAIL.test(raw)) throw field("alert_email", "Expected an email address.");
  return raw.toLowerCase();
}

type SubscriptionRow = {
  id: string;
  url: string;
  topics: string[];
  version: string;
  active: boolean;
  failing_since: Date | null;
  disabled_at: Date | null;
  disabled_reason: string | null;
  alert_email: string | null;
  previous_until: Date | null;
  created_at: Date;
  created_by: string;
};
const SUBSCRIPTION = "SELECT id,url,topics,version,active,failing_since,disabled_at,disabled_reason,alert_email,previous_until,created_at,created_by FROM webhook_subscriptions";
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
const subscriptionOut = (s: SubscriptionRow, secret?: string) => ({
  type: "webhook",
  id: s.id,
  url: s.url,
  topics: s.topics,
  version: s.version,
  status: !s.active ? "disabled" : s.failing_since ? "failing" : "active",
  failing_since: iso(s.failing_since),
  disabled_at: iso(s.disabled_at),
  disabled_reason: s.disabled_reason,
  alert_email: s.alert_email,
  previous_secret_until: s.previous_until && new Date(s.previous_until) > new Date() ? iso(s.previous_until) : null,
  created_at: iso(s.created_at),
  ...(secret ? { secret } : {}),
});
async function readSubscription(db: Sql, w: string, id: string) {
  const s = (await db.query<SubscriptionRow>(`${SUBSCRIPTION} WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL`, [w, id])).rows[0];
  assert(s, "NOT_FOUND", "No such webhook.", 404);
  return s;
}
async function allowed(db: Sql, w: string, principal: string) {
  await authorize(db, w, principal, "workspace.manage");
  assert(await developerOn(db, w), "NOT_FOUND", "The API isn't enabled for this workspace.", 404);
}

// Managing subscriptions: the API's /webhooks operations and Settings › Developers › Webhooks share these.
export async function listWebhooks(db: Sql, w: string, principal: string) {
  await allowed(db, w, principal);
  return (await db.query<SubscriptionRow>(`${SUBSCRIPTION} WHERE workspace_id=$1 AND deleted_at IS NULL ORDER BY created_at,id`, [w])).rows.map((s) => subscriptionOut(s));
}
export async function getWebhook(db: Sql, w: string, principal: string, id: string) {
  await allowed(db, w, principal);
  return subscriptionOut(await readSubscription(db, w, id));
}
/** A new subscription; its secret is returned this once. */
export async function createWebhook(db: Sql, w: string, principal: string, env: WebhookEnvironment, p: Record<string, unknown>) {
  await allowed(db, w, principal);
  const url = checkUrl(p.url, env);
  const topics = checkTopics(p.topics);
  const alert = checkEmail(p.alert_email);
  const count = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM webhook_subscriptions WHERE workspace_id=$1 AND deleted_at IS NULL", [w])).rows[0].n;
  assert(count < 20, "TOO_MANY", "A workspace can have up to 20 webhooks.", 409);
  const id = crypto.randomUUID();
  const secret = newSecret();
  await db.query(
    "INSERT INTO webhook_subscriptions(workspace_id,id,url,topics,version,secret_sealed,alert_email,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [w, id, url, topics, LATEST_VERSION, await sealed(env, w, id, secret), alert, await teammateOf(db, w, principal)],
  );
  return subscriptionOut(await readSubscription(db, w, id), secret);
}
export async function updateWebhook(db: Sql, w: string, principal: string, env: WebhookEnvironment, id: string, p: Record<string, unknown>) {
  await allowed(db, w, principal);
  const s = await readSubscription(db, w, id);
  const url = p.url === undefined ? s.url : checkUrl(p.url, env);
  const topics = p.topics === undefined ? s.topics : checkTopics(p.topics);
  const alert = p.alert_email === undefined ? s.alert_email : checkEmail(p.alert_email);
  if (p.active !== undefined && typeof p.active !== "boolean") throw field("active", "Expected true or false.");
  const active = p.active === undefined ? s.active : (p.active as boolean);
  // Turned back on: a fresh start (its failures are forgiven; it's disabled again only after 24 more hours).
  const reenabled = active && !s.active;
  await db.query(
    `UPDATE webhook_subscriptions SET url=$3,topics=$4,alert_email=$5,active=$6,updated_at=now(),
       failing_since=CASE WHEN $7 THEN NULL ELSE failing_since END,disabled_at=CASE WHEN $6 THEN NULL ELSE COALESCE(disabled_at,now()) END,
       disabled_reason=CASE WHEN $6 THEN NULL WHEN $8 THEN 'Turned off by a teammate.' ELSE disabled_reason END
     WHERE workspace_id=$1 AND id=$2`,
    [w, id, url, topics, alert, active, reenabled, s.active && !active],
  );
  return subscriptionOut(await readSubscription(db, w, id));
}
/** A new secret; the previous one also signs for 24 hours, so a receiver can switch without missing any. */
export async function rotateWebhookSecret(db: Sql, w: string, principal: string, env: WebhookEnvironment, id: string) {
  await allowed(db, w, principal);
  await readSubscription(db, w, id);
  const current = (await db.query<{ secret_sealed: string }>("SELECT secret_sealed FROM webhook_subscriptions WHERE workspace_id=$1 AND id=$2", [w, id])).rows[0].secret_sealed;
  const secret = newSecret();
  await db.query(
    "UPDATE webhook_subscriptions SET previous_secret_sealed=$3,previous_until=now()+interval '24 hours',secret_sealed=$4,updated_at=now() WHERE workspace_id=$1 AND id=$2",
    [w, id, current, await sealed(env, w, id, secret)],
  );
  return subscriptionOut(await readSubscription(db, w, id), secret);
}
export async function deleteWebhook(db: Sql, w: string, principal: string, id: string) {
  await allowed(db, w, principal);
  await readSubscription(db, w, id);
  await db.query("UPDATE webhook_subscriptions SET deleted_at=now(),active=false,updated_at=now() WHERE workspace_id=$1 AND id=$2", [w, id]);
  await db.query("UPDATE webhook_deliveries SET status='abandoned',last_error='The webhook was deleted.' WHERE workspace_id=$1 AND subscription_id=$2 AND status='pending'", [w, id]);
  return { type: "webhook", id, deleted: true };
}

type DeliveryRow = { id: string; event_id: string; topic: string; status: string; attempts: number; next_attempt_at: Date; delivered_at: Date | null; last_status: number | null; last_error: string; replay_of: string | null; created_at: Date; payload: unknown };
const deliveryOut = (d: DeliveryRow, attempts?: { status_code: number | null; duration_ms: number; error: string; response_excerpt: string; attempted_at: Date }[]) => ({
  type: "webhook_delivery",
  id: d.id,
  event_id: d.event_id,
  topic: d.topic,
  status: d.status,
  attempts: d.attempts,
  next_attempt_at: d.status === "pending" ? iso(d.next_attempt_at) : null,
  delivered_at: iso(d.delivered_at),
  last_status: d.last_status,
  last_error: d.last_error || null,
  replay_of: d.replay_of,
  created_at: iso(d.created_at),
  ...(attempts
    ? {
        payload: d.payload,
        attempt_log: attempts.map((a) => ({ at: iso(a.attempted_at), status: a.status_code, duration_ms: a.duration_ms, error: a.error || null, response: a.response_excerpt })),
      }
    : {}),
});
export async function listDeliveries(db: Sql, w: string, principal: string, id: string, page: { perPage: number; after: [string, string] | null }) {
  await allowed(db, w, principal);
  await readSubscription(db, w, id);
  const values: unknown[] = [w, id];
  if (page.after) values.push(page.after[0], page.after[1]);
  const rows = (
    await db.query<DeliveryRow>(
      `SELECT id,event_id,topic,status,attempts,next_attempt_at,delivered_at,last_status,last_error,replay_of,created_at,payload FROM webhook_deliveries
       WHERE workspace_id=$1 AND subscription_id=$2${page.after ? " AND (created_at,id)<($3::timestamptz,$4)" : ""} ORDER BY created_at DESC,id DESC LIMIT ${page.perPage + 1}`,
      values,
    )
  ).rows;
  const shown = rows.slice(0, page.perPage);
  return { rows: shown.map((d) => deliveryOut(d)), next: rows.length > page.perPage ? [iso(shown.at(-1)!.created_at)!, shown.at(-1)!.id] : null };
}
export async function getDelivery(db: Sql, w: string, principal: string, id: string, deliveryId: string) {
  await allowed(db, w, principal);
  const d = (
    await db.query<DeliveryRow>(
      "SELECT id,event_id,topic,status,attempts,next_attempt_at,delivered_at,last_status,last_error,replay_of,created_at,payload FROM webhook_deliveries WHERE workspace_id=$1 AND subscription_id=$2 AND id=$3",
      [w, id, deliveryId],
    )
  ).rows[0];
  assert(d, "NOT_FOUND", "No such delivery.", 404);
  const attempts = (
    await db.query<{ status_code: number | null; duration_ms: number; error: string; response_excerpt: string; attempted_at: Date }>(
      "SELECT status_code,duration_ms,error,response_excerpt,attempted_at FROM webhook_attempts WHERE workspace_id=$1 AND delivery_id=$2 ORDER BY attempted_at",
      [w, deliveryId],
    )
  ).rows;
  return deliveryOut(d, attempts);
}
/** The same event and body again, as a new delivery (sent by the next run). */
export async function replayDelivery(db: Sql, w: string, principal: string, id: string, deliveryId: string) {
  await allowed(db, w, principal);
  const s = await readSubscription(db, w, id);
  assert(s.active, "WEBHOOK_DISABLED", "Turn the webhook back on to replay to it.", 409);
  const d = (await db.query<{ event_id: string; topic: string; payload: unknown }>("SELECT event_id,topic,payload FROM webhook_deliveries WHERE workspace_id=$1 AND subscription_id=$2 AND id=$3", [w, id, deliveryId])).rows[0];
  assert(d, "NOT_FOUND", "No such delivery.", 404);
  const replay = crypto.randomUUID();
  await db.query("INSERT INTO webhook_deliveries(workspace_id,id,subscription_id,event_id,topic,payload,replay_of) VALUES($1,$2,$3,$4,$5,$6,$7)", [w, replay, id, d.event_id, d.topic, JSON.stringify(d.payload), deliveryId]);
  return getDelivery(db, w, principal, id, replay);
}
/** A `ping` delivery, to check the address and the receiver's signature check. */
export async function pingWebhook(db: Sql, w: string, principal: string, id: string) {
  await allowed(db, w, principal);
  const s = await readSubscription(db, w, id);
  assert(s.active, "WEBHOOK_DISABLED", "Turn the webhook back on to test it.", 409);
  const event = crypto.randomUUID();
  const delivery = crypto.randomUUID();
  const payload = { type: "webhook_event", id: event, topic: "ping", created_at: new Date().toISOString(), workspace_id: w, data: { item: { type: "ping", webhook_id: id } } };
  await db.query("INSERT INTO webhook_deliveries(workspace_id,id,subscription_id,event_id,topic,payload) VALUES($1,$2,$3,$4,'ping',$5)", [w, delivery, id, event, JSON.stringify(payload)]);
  return getDelivery(db, w, principal, id, delivery);
}

/* ------------------------------------------------------------------------------------------ */
/* Delivery                                                                                    */
/* ------------------------------------------------------------------------------------------ */

/** What a delivery's `data` holds: the resource as the API shows it, and the part or change it's about. */
async function payloadData(db: Sql, w: string, e: { topic: string; resource_type: string; resource_id: string; detail: Record<string, unknown> }) {
  const safe = async <T>(f: () => Promise<T>) => f().catch(() => null);
  const data: Record<string, unknown> = {};
  if (e.resource_type === "conversation") data.item = (await safe(() => readConversation(db, w, e.resource_id))) ?? { type: "conversation", id: e.resource_id };
  else if (e.resource_type === "ticket") data.item = (await safe(() => readTicket(db, w, e.resource_id))) ?? { type: "ticket", id: e.resource_id };
  else if (e.resource_type === "contact") {
    const c = (await db.query<ContactRow>(`${CONTACT_SELECT} WHERE c.workspace_id=$1 AND c.id=$2`, [w, e.resource_id])).rows[0];
    data.item = c ? contactOut(c) : { type: "contact", id: e.resource_id };
  } else if (e.resource_type === "event") {
    const ev = (await db.query<EventRow>("SELECT id,contact_id,name,metadata,source,occurred_at FROM contact_events WHERE workspace_id=$1 AND id=$2", [w, e.resource_id])).rows[0];
    data.item = ev ? eventOut(ev) : { type: "event", id: e.resource_id };
  } else if (e.resource_type === "article") data.item = (await safe(async () => articleOut(await readRecord(db, w, e.resource_id, true)))) ?? { type: "article", id: e.resource_id };
  const d = e.detail ?? {};
  if (typeof d.part_id === "string") {
    const p = (await db.query<{ id: string; seq: string; kind: string; audience: string; author_type: string; author_id: string; body: string; created_at: Date }>(
      "SELECT id,seq,kind,audience,author_type,author_id,body,created_at FROM conversation_parts WHERE workspace_id=$1 AND id=$2",
      [w, d.part_id],
    )).rows[0];
    // An internal note is never delivered outside Relay; only a public part carries its text.
    if (p && p.kind !== "internal_note")
      data.part = { type: "conversation_part", id: p.id, seq: Number(p.seq), kind: p.kind, audience: p.audience, author: { type: p.author_type, id: p.author_type === "system" ? null : p.author_id }, body: p.audience === "public" ? p.body : "", created_at: iso(p.created_at) };
  }
  if (typeof d.tag_id === "string") {
    const t = (await db.query<{ id: string; name: string }>("SELECT id,name FROM tags WHERE workspace_id=$1 AND id=$2", [w, d.tag_id])).rows[0];
    if (t) data.tag = { type: "tag", id: t.id, name: t.name };
  }
  if (typeof d.metric === "string") data.metric = d.metric;
  if (typeof d.merged_contact_id === "string") data.merged_contact_id = d.merged_contact_id;
  if (d.from_state_id !== undefined) data.changes = { state_id: { from: d.from_state_id, to: d.to_state_id } };
  return data;
}

/** Events fanned out to their subscriptions, each with its body built once. */
async function fanOut(connect: Connect, w: string) {
  return tenant(connect, w, async (db) => {
    const events = (
      await db.query<{ id: string; topic: string; resource_type: string; resource_id: string; detail: Record<string, unknown>; created_at: Date }>(
        "SELECT id,topic,resource_type,resource_id,detail,created_at FROM webhook_events WHERE workspace_id=$1 AND dispatched_at IS NULL ORDER BY created_at,id LIMIT 200 FOR UPDATE SKIP LOCKED",
        [w],
      )
    ).rows;
    const subs = (await db.query<{ id: string; topics: string[] }>("SELECT id,topics FROM webhook_subscriptions WHERE workspace_id=$1 AND active AND deleted_at IS NULL", [w])).rows;
    for (const e of events) {
      const to = subs.filter((s) => s.topics.includes(e.topic));
      if (to.length) {
        const payload = { type: "webhook_event", id: e.id, topic: e.topic, created_at: iso(e.created_at), workspace_id: w, data: await payloadData(db, w, e) };
        // First due at the event's own time, so events go out in the order they happened.
        for (const s of to)
          await db.query("INSERT INTO webhook_deliveries(workspace_id,id,subscription_id,event_id,topic,payload,next_attempt_at) VALUES($1,$2,$3,$4,$5,$6,$7)", [
            w,
            crypto.randomUUID(),
            s.id,
            e.id,
            e.topic,
            JSON.stringify(payload),
            e.created_at,
          ]);
      }
      await db.query("UPDATE webhook_events SET dispatched_at=now() WHERE workspace_id=$1 AND id=$2", [w, e.id]);
    }
    return events.length;
  });
}

/** Up to 25 due deliveries sent, each between transactions (a receiver's slowness never holds a lock). */
async function deliverDue(connect: Connect, env: WebhookEnvironment, w: string) {
  const due = await tenant(connect, w, async (db) =>
    (
      await db.query<{ id: string; subscription_id: string; event_id: string; topic: string; payload: unknown; attempts: number; first_attempt_at: Date | null }>(
        `SELECT d.id,d.subscription_id,d.event_id,d.topic,d.payload,d.attempts,d.first_attempt_at FROM webhook_deliveries d
         JOIN webhook_subscriptions s ON s.workspace_id=d.workspace_id AND s.id=d.subscription_id AND s.active AND s.deleted_at IS NULL
         WHERE d.workspace_id=$1 AND d.status='pending' AND d.next_attempt_at<=now() ORDER BY d.next_attempt_at,d.id LIMIT 25`,
        [w],
      )
    ).rows,
  );
  for (const d of due) {
    const sub = await tenant(connect, w, async (db) =>
      (await db.query<{ url: string; secret_sealed: string; previous_secret_sealed: string | null; previous_until: Date | null }>(
        "SELECT url,secret_sealed,previous_secret_sealed,previous_until FROM webhook_subscriptions WHERE workspace_id=$1 AND id=$2",
        [w, d.subscription_id],
      )).rows[0],
    );
    const secrets = [await opened(env, w, d.subscription_id, sub.secret_sealed)];
    if (sub.previous_secret_sealed && sub.previous_until && new Date(sub.previous_until) > new Date()) secrets.push(await opened(env, w, d.subscription_id, sub.previous_secret_sealed));
    const body = JSON.stringify(d.payload);
    const started = Date.now();
    let status: number | null = null;
    let error = "";
    let excerpt = "";
    try {
      const r = await safeRequest(
        sub.url,
        env.policy ?? {},
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "relay-signature": await signature(secrets, body),
            "relay-webhook-id": d.id,
            "relay-event-id": d.event_id,
            "relay-topic": d.topic,
          },
          body,
        },
        { maxBytes: 1024, timeoutMs: 10_000 },
      );
      status = r.status;
      excerpt = String(r.body ?? "").slice(0, 1024);
      if (r.status < 200 || r.status >= 300) error = `The receiver answered ${r.status}.`;
    } catch (e) {
      error =
        e instanceof FetchRefused
          ? { TIMEOUT: "No answer within 10 seconds.", UNREACHABLE: "The address couldn't be reached.", ADDRESS_NOT_ALLOWED: "That address isn't allowed.", TOO_LARGE: "", TOO_MANY_REDIRECTS: "Redirects aren't followed." }[e.code] || "The request failed."
          : "The request failed.";
    }
    const ok = !error && status !== null;
    const tookMs = Date.now() - started;
    await tenant(connect, w, async (db) => {
      await db.query("INSERT INTO webhook_attempts(workspace_id,id,delivery_id,status_code,duration_ms,error,response_excerpt) VALUES($1,$2,$3,$4,$5,$6,$7)", [
        w,
        crypto.randomUUID(),
        d.id,
        status,
        tookMs,
        error,
        excerpt,
      ]);
      const first = d.first_attempt_at ? new Date(d.first_attempt_at).getTime() : Date.now();
      if (ok) {
        await db.query("UPDATE webhook_deliveries SET status='delivered',attempts=attempts+1,delivered_at=now(),last_status=$3,last_error='',first_attempt_at=COALESCE(first_attempt_at,now()) WHERE workspace_id=$1 AND id=$2", [w, d.id, status]);
        await db.query("UPDATE webhook_subscriptions SET failing_since=NULL WHERE workspace_id=$1 AND id=$2", [w, d.subscription_id]);
        return;
      }
      const giveUp = Date.now() - first >= RETRY_FOR_MS;
      await db.query(
        `UPDATE webhook_deliveries SET attempts=attempts+1,last_status=$3,last_error=$4,first_attempt_at=COALESCE(first_attempt_at,now()),
           status=CASE WHEN $5 THEN 'abandoned' ELSE 'pending' END,next_attempt_at=now()+($6::bigint*interval '1 millisecond') WHERE workspace_id=$1 AND id=$2`,
        [w, d.id, status, error, giveUp, backoffMs(d.attempts + 1)],
      );
      await db.query("UPDATE webhook_subscriptions SET failing_since=COALESCE(failing_since,now()) WHERE workspace_id=$1 AND id=$2", [w, d.subscription_id]);
      await disableIfFailing(db, w, d.subscription_id);
    });
  }
  return due.length;
}

/** Failing for 24 hours with no success: off, its pending deliveries kept for a replay, its creator told. */
async function disableIfFailing(db: Sql, w: string, id: string) {
  const s = (
    await db.query<{ created_by: string; alert_email: string | null; url: string }>(
      `UPDATE webhook_subscriptions SET active=false,disabled_at=now(),disabled_reason='Failed for 24 hours without a success.'
       WHERE workspace_id=$1 AND id=$2 AND active AND failing_since<=now()-($3::bigint*interval '1 millisecond') RETURNING created_by,alert_email,url`,
      [w, id, DISABLE_AFTER_MS],
    )
  ).rows[0];
  if (!s) return;
  await db.query(
    `INSERT INTO notifications(workspace_id,id,teammate_id,kind,webhook_subscription_id,excerpt) VALUES($1,$2,$3,'webhook_disabled',$4,$5)`,
    [w, crypto.randomUUID(), s.created_by, id, `A webhook to ${s.url.slice(0, 100)} was turned off after failing for 24 hours.`.slice(0, 140)],
  );
  if (s.alert_email) {
    const alert = crypto.randomUUID();
    await db.query("INSERT INTO email_alerts(workspace_id,id,kind,webhook_subscription_id,address) VALUES($1,$2,'webhook_disabled',$3,$4)", [w, alert, id, s.alert_email]);
    await enqueueJob(db, w, "email.alert", { alertId: alert }, {});
  }
}

/** The `webhooks.run` job: fan out, then send what's due, until there's nothing left right now. */
export async function runWebhooks(connect: Connect, env: WebhookEnvironment, job: Job) {
  const w = job.workspace_id;
  const on = await tenant(connect, w, (db) => developerOn(db, w));
  if (!on) return { done: true, result: { off: true } };
  const fanned = await fanOut(connect, w);
  const sent = await deliverDue(connect, env, w);
  return { done: fanned < 200 && sent < 25, result: { fanned, sent } };
}

/** From the sweep: a run when there's work and none is queued; and the log kept to 30 days. */
export async function scheduleWebhooks(connect: Connect, w: string) {
  await tenant(connect, w, async (db) => {
    if (!(await developerOn(db, w))) return;
    const work = (
      await db.query(
        `SELECT 1 WHERE EXISTS (SELECT 1 FROM webhook_events WHERE workspace_id=$1 AND dispatched_at IS NULL)
           OR EXISTS (SELECT 1 FROM webhook_deliveries WHERE workspace_id=$1 AND status='pending' AND next_attempt_at<=now())`,
        [w],
      )
    ).rows.length;
    if (work && !(await db.query("SELECT 1 FROM jobs WHERE workspace_id=$1 AND kind='webhooks.run' AND state IN ('queued','running') LIMIT 1", [w])).rows.length)
      await enqueueJob(db, w, "webhooks.run", {}, {});
    await db.query(`DELETE FROM webhook_attempts WHERE workspace_id=$1 AND attempted_at<now()-interval '${KEEP_DAYS} days'`, [w]);
    await db.query(`DELETE FROM webhook_events WHERE workspace_id=$1 AND dispatched_at<now()-interval '${KEEP_DAYS} days'`, [w]);
  });
}

export { TOPICS };

/** Settings › Developers › Webhooks' one action route (phase 15 D3). */
export async function changeWebhooks(db: Sql, w: string, principal: string, env: WebhookEnvironment | undefined, p: Record<string, unknown>) {
  const need = () => {
    assert(env, "UNAVAILABLE", "Webhooks aren't set up on this server.", 503);
    return env!;
  };
  const id = String(p.id ?? "");
  switch (p.action) {
    case "create":
      return createWebhook(db, w, principal, need(), p);
    case "update":
      return updateWebhook(db, w, principal, need(), id, p);
    case "rotate":
      return rotateWebhookSecret(db, w, principal, need(), id);
    case "delete":
      return deleteWebhook(db, w, principal, id);
    case "test":
      return pingWebhook(db, w, principal, id);
    case "replay":
      return replayDelivery(db, w, principal, id, String(p.deliveryId ?? ""));
  }
  throw new DomainError("INVALID_WEBHOOK", "Choose create, update, rotate, delete, test or replay.");
}

/** The API's /webhooks operations (phase 15 D3), as the token's teammate. */
export const WEBHOOK_HANDLERS: Record<string, (x: Context) => Promise<unknown>> = {
  listWebhooks: async (x) => listOf(await listWebhooks(x.db, x.w, x.token.principal), null),
  createWebhook: (x) => createWebhook(x.db, x.w, x.token.principal, needEnv(x), x.body),
  getWebhook: (x) => getWebhook(x.db, x.w, x.token.principal, String(x.params.id)),
  updateWebhook: (x) => updateWebhook(x.db, x.w, x.token.principal, needEnv(x), String(x.params.id), x.body),
  deleteWebhook: (x) => deleteWebhook(x.db, x.w, x.token.principal, String(x.params.id)),
  rotateWebhookSecret: (x) => rotateWebhookSecret(x.db, x.w, x.token.principal, needEnv(x), String(x.params.id)),
  testWebhook: (x) => pingWebhook(x.db, x.w, x.token.principal, String(x.params.id)),
  async listWebhookDeliveries(x) {
    const after = x.params.starting_after === undefined ? null : cursor.read<[string, string]>(x.params.starting_after);
    if (x.params.starting_after !== undefined && !(Array.isArray(after) && after.length === 2)) throw invalid("starting_after", "That cursor isn't one of ours.");
    const r = await listDeliveries(x.db, x.w, x.token.principal, String(x.params.id), { perPage: Number(x.params.per_page), after });
    return listOf(r.rows, r.next);
  },
  getWebhookDelivery: (x) => getDelivery(x.db, x.w, x.token.principal, String(x.params.id), String(x.params.delivery_id)),
  replayWebhookDelivery: (x) => replayDelivery(x.db, x.w, x.token.principal, String(x.params.id), String(x.params.delivery_id)),
};
function needEnv(x: Context): WebhookEnvironment {
  assert(x.webhooks, "UNAVAILABLE", "Webhooks aren't set up on this server.", 503);
  return x.webhooks!;
}

import { decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import { assert, DomainError, once, tenant, type Connect, type Sql } from "./db";
import { authorize } from "./policy";
import { getIdentity, resolveContact } from "./people";
import { identityIssuer, unwrapIdentityKey } from "./identity";

/**
 * Events (phase 13, step O1; docs/OUTBOUND_STEP1.md), behind `segments_v1`: what a contact did,
 * for segments ("upgraded in the last 30 days") and, from O2, outbound triggers and goals.
 *
 * They come from two places, both proving who the contact is:
 * - **the messenger** (`Relay("track", {name, metadata})`), only for a signed-in user;
 * - **the customer's server** (`POST /v1/events`), signed with the workspace's identity key (the
 *   one its server already signs messenger users with), audience `relay-events`, for one user.
 *
 * Each is kept once by its sender's id. An archived name is no longer kept; a new name past the
 * 120 tracked is refused. TODO(phase 15): API keys for the server, and events for leads.
 */
export const EVENT_LIMIT = 120;
const NAME = /^[A-Za-z0-9][A-Za-z0-9 _.:-]{0,99}$/;
const META_KEY = /^[A-Za-z0-9_.-]{1,40}$/;
const PAST_DAYS = 30;

export type EventInput = { name: unknown; metadata?: unknown; occurredAt?: unknown };
type Checked = { name: string; metadata: Record<string, string | number | boolean | null>; occurredAt: Date };

/** An event as sent, checked: its name, up to 10 scalar values, and when (within the last 30 days). */
export function checkEvent(e: EventInput, now = Date.now()): Checked {
  const bad = (m: string): never => {
    throw new DomainError("INVALID_EVENT", m, 400);
  };
  const name = typeof e.name === "string" ? e.name.trim() : "";
  if (!NAME.test(name)) bad("An event's name is 1 to 100 letters, digits, spaces and . _ : - (starting with a letter or digit).");
  const metadata: Checked["metadata"] = {};
  if (e.metadata !== undefined && e.metadata !== null) {
    if (typeof e.metadata !== "object" || Array.isArray(e.metadata)) bad("An event's metadata is an object.");
    const entries = Object.entries(e.metadata as Record<string, unknown>);
    if (entries.length > 10) bad("An event has 10 metadata values at most.");
    for (const [k, v] of entries) {
      if (!META_KEY.test(k)) bad(`Metadata names are letters, digits and _ . - (40 at most): "${k.slice(0, 40)}".`);
      if (!(v === null || typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && v.length <= 255)))
        bad(`Metadata "${k}" is text (255 characters at most), a number, true or false.`);
      if (typeof v === "number" && !Number.isFinite(v)) bad(`Metadata "${k}" is a number.`);
      metadata[k] = v as Checked["metadata"][string];
    }
  }
  let occurredAt = new Date(now);
  if (e.occurredAt !== undefined && e.occurredAt !== null) {
    const t = typeof e.occurredAt === "number" ? e.occurredAt * 1000 : typeof e.occurredAt === "string" ? Date.parse(e.occurredAt) : NaN;
    if (!Number.isFinite(t) || t > now + 5 * 60_000 || t < now - PAST_DAYS * 86_400_000) bad(`An event happened within the last ${PAST_DAYS} days.`);
    occurredAt = new Date(t);
  }
  return { name, metadata, occurredAt };
}

async function on(db: Sql, w: string) {
  return (await db.query("SELECT 1 FROM workspace_features WHERE workspace_id=$1 AND name='segments_v1' AND enabled", [w])).rows.length > 0;
}

/** Kept once by `dedupeKey`: "kept", "duplicate", or "ignored" (its name archived). */
export async function recordEvent(db: Sql, w: string, contactId: string, e: Checked, source: "messenger" | "api", dedupeKey: string): Promise<"kept" | "duplicate" | "ignored"> {
  const def = (await db.query<{ archived_at: string | null }>("SELECT archived_at FROM event_definitions WHERE workspace_id=$1 AND name=$2 FOR UPDATE", [w, e.name])).rows[0];
  if (def?.archived_at) return "ignored";
  if ((await db.query("SELECT 1 FROM contact_events WHERE workspace_id=$1 AND dedupe_key=$2", [w, dedupeKey])).rows.length) return "duplicate";
  if (!def) {
    // A new name: one at a time, so the limit holds under concurrency.
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["event-names:" + w]);
    const tracked = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM event_definitions WHERE workspace_id=$1 AND archived_at IS NULL", [w])).rows[0].n;
    if (tracked >= EVENT_LIMIT && !(await db.query("SELECT 1 FROM event_definitions WHERE workspace_id=$1 AND name=$2", [w, e.name])).rows.length)
      throw new DomainError("EVENT_LIMIT", `${EVENT_LIMIT} events are tracked already: archive one in Settings › Events first.`, 409);
  }
  const added = await db.query(
    "INSERT INTO contact_events(workspace_id,id,contact_id,name,metadata,source,dedupe_key,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (workspace_id,dedupe_key) DO NOTHING RETURNING id",
    [w, crypto.randomUUID(), contactId, e.name, JSON.stringify(e.metadata), source, dedupeKey, e.occurredAt.toISOString()],
  );
  if (!added.rows.length) return "duplicate";
  await db.query(
    `INSERT INTO event_definitions(workspace_id,name,count,first_seen_at,last_seen_at) VALUES($1,$2,1,$3,$3)
     ON CONFLICT (workspace_id,name) DO UPDATE SET count=event_definitions.count+1,last_seen_at=greatest(event_definitions.last_seen_at,EXCLUDED.last_seen_at)`,
    [w, e.name, e.occurredAt.toISOString()],
  );
  return "kept";
}

/** The messenger's `Relay("track")`: a signed-in user's event, kept once by its idempotency key. */
export async function messengerEvent(db: Sql, w: string, session: { identityId: string; verified: boolean }, key: string, p: EventInput) {
  assert(await on(db, w), "SEGMENTS_DISABLED", "Events are not enabled for this workspace.", 404);
  assert(session.verified, "EVENTS_SIGN_IN_REQUIRED", "Events are tracked only for signed-in users.", 403);
  assert(/^[A-Za-z0-9_-]{8,128}$/.test(key), "IDEMPOTENCY_REQUIRED", "An Idempotency-Key header is required.", 400);
  const e = checkEvent(p);
  const mapping = (await db.query<{ contact_id: string }>("SELECT contact_id FROM identity_contact_mappings WHERE workspace_id=$1 AND identity_id=$2", [w, session.identityId])).rows[0];
  assert(mapping, "IDENTITY_NOT_FOUND", "Identity unavailable.", 404);
  return { result: await recordEvent(db, w, await resolveContact(db, w, mapping.contact_id), e, "messenger", `m:${session.identityId}:${key}`) };
}

/**
 * `POST /v1/events`: `Authorization: Bearer <JWT>`, HS256 with the workspace's identity key (its
 * `kid`), issuer `relay-customer:<workspace>`, audience `relay-events`, `sub` the user's id, and
 * an hour at most; the body is `{events: [{id, name, metadata?, occurredAt?}]}` (100 at most), each
 * kept once by its `id`. The user is found (or added) as the messenger would.
 */
export async function apiEvents(connect: Connect, identityMaster: string, authorization: string, body: unknown) {
  const unauthorized = () => new DomainError("UNAUTHORIZED", "Sign the request with your workspace's identity key.", 401);
  const token = /^Bearer (.{20,8192})$/.exec(authorization)?.[1];
  if (!token) throw unauthorized();
  let w: string, kid: string;
  try {
    w = String(decodeJwt(token).workspace_id ?? "");
    kid = String(decodeProtectedHeader(token).kid ?? "");
  } catch {
    throw unauthorized();
  }
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(w) || !kid) throw unauthorized();
  const events = (body as { events?: unknown })?.events;
  if (!Array.isArray(events) || !events.length || events.length > 100) throw new DomainError("INVALID_EVENT", "Send 1 to 100 events.", 400);
  return tenant(connect, w, async (db) => {
    // The signature first: nothing about the workspace is told to a caller who can't sign for it.
    const row = (await db.query<{ wrapped_key: string }>("SELECT wrapped_key FROM identity_keys WHERE workspace_id=$1 AND kid=$2", [w, kid])).rows[0];
    if (!row) throw unauthorized();
    let sub: string;
    try {
      const { payload, protectedHeader } = await jwtVerify(token, await unwrapIdentityKey(row.wrapped_key, identityMaster, w, kid), {
        algorithms: ["HS256"],
        issuer: identityIssuer(w),
        audience: "relay-events",
        requiredClaims: ["exp", "iat", "sub", "workspace_id"],
      });
      if (protectedHeader.alg !== "HS256" || typeof payload.exp !== "number" || typeof payload.iat !== "number" || payload.exp - payload.iat > 3600 || payload.workspace_id !== w) throw unauthorized();
      sub = String(payload.sub);
    } catch {
      throw unauthorized();
    }
    if (!sub || sub.length > 200) throw unauthorized();
    if (!(await on(db, w))) throw new DomainError("SEGMENTS_DISABLED", "Events are not enabled for this workspace.", 404);
    const checked = events.map((e: EventInput & { id?: unknown }) => {
      if (typeof e?.id !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(e.id)) throw new DomainError("INVALID_EVENT", "Each event has an id (1 to 128 letters, digits and _ . : -), so a retry counts once.", 400);
      return { id: e.id, event: checkEvent(e) };
    });
    const { contactId } = await getIdentity(db, w, "user", sub);
    const counts = { kept: 0, duplicate: 0, ignored: 0 };
    for (const c of checked) counts[await recordEvent(db, w, contactId, c.event, "api", `a:${sub}:${c.id}`)]++;
    return counts;
  });
}

/* ------------------------------------------------------------------------------------------ */
/* Settings › Events                                                                           */

export async function readEvents(db: Sql, w: string, principal: string) {
  await authorize(db, w, principal, "workspace.manage");
  assert(await on(db, w), "SEGMENTS_DISABLED", "Events are not enabled for this workspace.", 404);
  const rows = (
    await db.query<{ name: string; description: string; count: string; first_seen_at: Date; last_seen_at: Date; archived_at: Date | null }>(
      "SELECT name,description,count,first_seen_at,last_seen_at,archived_at FROM event_definitions WHERE workspace_id=$1 ORDER BY archived_at IS NOT NULL,last_seen_at DESC,name",
      [w],
    )
  ).rows;
  return {
    limit: EVENT_LIMIT,
    tracked: rows.filter((r) => !r.archived_at).length,
    events: rows.map((r) => ({
      name: r.name,
      description: r.description,
      count: Number(r.count),
      firstSeenAt: new Date(r.first_seen_at).toISOString(),
      lastSeenAt: new Date(r.last_seen_at).toISOString(),
      archived: !!r.archived_at,
    })),
  };
}

/** Describe an event, archive it (no longer kept), or track it again (within the limit). */
export async function changeEvents(db: Sql, w: string, principal: string, key: string, p: Record<string, unknown>) {
  await authorize(db, w, principal, "workspace.manage");
  assert(await on(db, w), "SEGMENTS_DISABLED", "Events are not enabled for this workspace.", 404);
  return once(db, w, "events:" + principal, key, p, async () => {
    const name = String(p.name ?? "");
    const def = (await db.query<{ archived_at: Date | null }>("SELECT archived_at FROM event_definitions WHERE workspace_id=$1 AND name=$2 FOR UPDATE", [w, name])).rows[0];
    assert(def, "EVENT_NOT_FOUND", "That event isn't tracked.", 404);
    if (p.action === "describe") {
      const description = String(p.description ?? "").trim();
      if (description.length > 300) throw new DomainError("INVALID_EVENT", "Keep the description to 300 characters.", 400);
      await db.query("UPDATE event_definitions SET description=$3 WHERE workspace_id=$1 AND name=$2", [w, name, description]);
    } else if (p.action === "archive") {
      await db.query("UPDATE event_definitions SET archived_at=now() WHERE workspace_id=$1 AND name=$2 AND archived_at IS NULL", [w, name]);
    } else if (p.action === "restore") {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["event-names:" + w]);
      const tracked = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM event_definitions WHERE workspace_id=$1 AND archived_at IS NULL", [w])).rows[0].n;
      if (def.archived_at && tracked >= EVENT_LIMIT) throw new DomainError("EVENT_LIMIT", `${EVENT_LIMIT} events are tracked already: archive another first.`, 409);
      await db.query("UPDATE event_definitions SET archived_at=NULL WHERE workspace_id=$1 AND name=$2", [w, name]);
    } else throw new DomainError("INVALID_EVENT", "Unknown change.", 400);
    return readEvents(db, w, principal);
  });
}

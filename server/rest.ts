import { assert, DomainError, tenant, type Connect, type Sql } from "./db";
import { authorize, capabilities, scopeSql, type Capability, type Teammate } from "./policy";
import { command } from "./conversations";
import { getIdentity, resolveContact } from "./people";
import { API_VERSIONS, operations, SPEC, type Operation } from "../lib/api-spec";
import { check, readParameters } from "../lib/api-validate";
import { LIMITS, memoryRateLimiter, type RateLimiter } from "./rate-limit";
import type { AttachmentStorage } from "./attachments";
import { MORE_HANDLERS } from "./rest-more";
import { WEBHOOK_HANDLERS, type WebhookEnvironment } from "./webhooks";
import { actingVia, recordContactView } from "./audit";
import { networkAllowed, normalIp } from "./allowlists";
import { errorFingerprint } from "./api";

/**
 * The public REST API (phase 15, step D1; docs/DEVELOPER_PLATFORM_STEP1.md), behind
 * `developer_api_v1`, at `/rest/*`. Every route is an operation in `lib/api-spec.ts`: the router
 * matches it there, validates the request with the spec's own schemas, checks the operation's scope
 * against the token and its teammate's role, and calls the same domain functions the inbox does
 * (`command`, `authorize`). A token acts as the teammate who made it.
 *
 * Errors are `{type:"error", request_id, errors:[{code, message, field}]}` with a stable code;
 * anything unexpected is `internal_error`, with no detail. Lists are cursor-paged. Every response
 * says its version and rate limits in headers.
 */
export type RestEnvironment = { connect: Connect; rateLimiter?: RateLimiter; storage?: AttachmentStorage; webhooks?: WebhookEnvironment };
const defaultLimiter = memoryRateLimiter();

/**
 * Changes between versions, newest first: each turns a request in an older version into the
 * newest, and the newest's response back. Empty while there's one version; a test proves the chain.
 */
export type VersionChange = {
  /** The version that made the change, and the one before it (whose requests and responses are translated). */
  version: string;
  before: string;
  request?: (operationId: string, body: unknown) => unknown;
  response?: (operationId: string, body: unknown) => unknown;
};
export const VERSION_CHANGES: VersionChange[] = [];
/** The versions a request may name: the spec's, and each change's predecessor still supported. */
export const supportedVersions = () => [...new Set([...API_VERSIONS, ...VERSION_CHANGES.map((c) => c.before)])];
/** The operations the router can serve (a test holds them to the spec). */
export const handledOperations = () => [...Object.keys(HANDLERS), ...Object.keys(MORE_HANDLERS), ...Object.keys(WEBHOOK_HANDLERS)];
/** An operation's work: D1's here, D2's in rest-more.ts (looked up when called; the two import each other). */
const handlerFor = (operationId: string) => HANDLERS[operationId] ?? MORE_HANDLERS[operationId] ?? WEBHOOK_HANDLERS[operationId];

const TOKEN = /^relay_pat_([A-Za-z0-9_-]{2,140})_([A-Za-z0-9]{40})$/;
const b64 = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s: string) => {
  try {
    return atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
};
export async function sha256(s: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
/** A new token's text (shown once) and what's kept of it. The workspace is in it, so it's found in its own tenant. */
export async function mintToken(w: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const random = crypto.getRandomValues(new Uint8Array(40));
  const secret = [...random].map((b) => alphabet[b % 62]).join("");
  const text = `relay_pat_${b64(w)}_${secret}`;
  return { text, hash: await sha256(text), lastFour: secret.slice(-4) };
}

export const cursor = {
  write: (v: unknown) => b64(JSON.stringify(v)),
  read: <T>(s: unknown): T | null => {
    if (typeof s !== "string") return null;
    const raw = unb64(s);
    try {
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  },
};
export const invalid = (field: string, message: string) => new DomainError("INVALID_FIELD", message, 400, { field });

export type Token = { id: string; teammateId: string; principal: string; scopes: string[]; version: string; grantId?: string | null };
/** `me`: the token's teammate as authorized for this call, with their role's scope (phase 16 C2). */
export type Context = { db: Sql; w: string; token: Token; me?: Teammate; params: Record<string, unknown>; body: Record<string, unknown>; key: string | null; storage?: AttachmentStorage; origin?: string; webhooks?: WebhookEnvironment };

// The shapes the spec promises.
export type ConversationRow = { id: string; title: string; status: string; channel: string; brand_id: string | null; primary_identity_id: string | null; assigned: string; team_id: string | null; priority: boolean; snooze_until: Date | null; last_contact_reply_at: Date | null; last_teammate_reply_at: Date | null; created_at: Date; updated_at: Date };
export const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
export async function conversationOut(db: Sql, w: string, c: ConversationRow) {
  const tags = (await db.query<{ id: string; name: string }>("SELECT t.id,t.name FROM conversation_tags ct JOIN tags t ON t.workspace_id=ct.workspace_id AND t.id=ct.tag_id WHERE ct.workspace_id=$1 AND ct.conversation_id=$2 ORDER BY lower(t.name)", [w, c.id])).rows;
  const contact = c.primary_identity_id
    ? (await db.query<{ contact_id: string }>("SELECT contact_id FROM identity_contact_mappings WHERE workspace_id=$1 AND identity_id=$2", [w, c.primary_identity_id])).rows[0]?.contact_id
    : undefined;
  const waiting = c.status === "open" && c.last_contact_reply_at && (!c.last_teammate_reply_at || new Date(c.last_contact_reply_at) > new Date(c.last_teammate_reply_at));
  return {
    type: "conversation",
    id: c.id,
    title: c.title,
    status: c.status,
    channel: c.channel,
    brand_id: c.brand_id,
    contact_id: contact ? await resolveContact(db, w, contact) : null,
    assignee_id: c.assigned || null,
    team_id: c.team_id,
    priority: !!c.priority,
    tags: tags.map((t) => ({ type: "tag", id: t.id, name: t.name })),
    snoozed_until: c.status === "snoozed" ? iso(c.snooze_until) : null,
    waiting_since: waiting ? iso(c.last_contact_reply_at) : null,
    created_at: iso(c.created_at),
    updated_at: iso(c.updated_at),
  };
}
export const CONVERSATION_COLUMNS = "id,title,status,channel,brand_id,primary_identity_id,assigned,team_id,priority,snooze_until,last_contact_reply_at,last_teammate_reply_at,created_at,updated_at";
/** A conversation in the API's shape; with `scope`, only if that teammate's role may see it (phase 16 C2). */
export async function readConversation(db: Sql, w: string, id: string, scope?: Teammate) {
  const values: unknown[] = [w, id];
  const visible = scope ? scopeSql(scope, "conversations", values) : "true";
  const c = (await db.query<ConversationRow>(`SELECT ${CONVERSATION_COLUMNS} FROM conversations WHERE workspace_id=$1 AND id=$2 AND merged_into_id IS NULL AND visibility='customer' AND ${visible}`, values)).rows[0];
  assert(c, "NOT_FOUND", "No such conversation.", 404);
  return conversationOut(db, w, c);
}
export type ContactRow = { id: string; role: string; name: string; external_id: string | null; profile: Record<string, unknown>; first_seen_at: Date; last_seen_at: Date; signed_up_at: Date | null; email: string | null };
export const CONTACT_SELECT = `SELECT c.id,c.role,c.name,c.external_id,c.profile,c.first_seen_at,c.last_seen_at,c.signed_up_at,
  (SELECT e.email FROM contact_emails e WHERE e.workspace_id=c.workspace_id AND e.contact_id=c.id ORDER BY e.verified DESC,e.email LIMIT 1) AS email FROM contacts c`;
export const contactOut = (c: ContactRow) => ({
  type: "contact",
  id: c.id,
  role: c.role,
  name: c.name,
  email: c.email,
  external_id: c.external_id,
  custom_attributes: c.profile ?? {},
  first_seen_at: iso(c.first_seen_at),
  last_seen_at: iso(c.last_seen_at),
  signed_up_at: iso(c.signed_up_at),
});
export async function readContact(db: Sql, w: string, id: string) {
  const found = (await db.query<{ id: string }>("SELECT id FROM contacts WHERE workspace_id=$1 AND id=$2", [w, id])).rows[0];
  assert(found, "NOT_FOUND", "No such contact.", 404);
  const live = await resolveContact(db, w, id);
  return contactOut((await db.query<ContactRow>(`${CONTACT_SELECT} WHERE c.workspace_id=$1 AND c.id=$2`, [w, live])).rows[0]);
}
const teammateOut = (t: { id: string; name: string; presence: string }) => ({ type: "teammate", id: t.id, name: t.name, presence: t.presence });
async function teamsOut(db: Sql, w: string, id?: string) {
  const teams = (await db.query<{ id: string; name: string }>(`SELECT id,name FROM teams WHERE workspace_id=$1${id ? " AND id=$2" : ""} ORDER BY lower(name),id`, id ? [w, id] : [w])).rows;
  const members = (await db.query<{ team_id: string; teammate_id: string }>("SELECT team_id,teammate_id FROM teammate_teams WHERE workspace_id=$1 ORDER BY teammate_id", [w])).rows;
  return teams.map((t) => ({ type: "team", id: t.id, name: t.name, member_ids: members.filter((m) => m.team_id === t.id).map((m) => m.teammate_id) }));
}
export const listOf = (data: unknown[], next: unknown) => ({ type: "list", data, pages: { next: next === null ? null : cursor.write(next) } });

/** A conversation command as the token's teammate, then the conversation as it now is. */
export async function act(x: Context, p: Record<string, unknown>) {
  const id = String(x.params.id);
  await readConversation(x.db, x.w, id, x.me);
  await command(x.db, x.w, { type: "teammate", principal: x.token.principal }, x.key ?? crypto.randomUUID(), { conversationId: id, ...p } as never);
  return readConversation(x.db, x.w, id, x.me);
}
const sanitizeAttributes = (a: unknown) => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries((a ?? {}) as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(k)) throw invalid(`custom_attributes.${k}`, "Names are letters, digits, dots, dashes and underscores, up to 64.");
    out[k] = v;
  }
  return out;
};

/** Each operation's work, by operationId. */
const HANDLERS: Record<string, (x: Context) => Promise<unknown>> = {
  async getMe(x) {
    const t = (await x.db.query<{ id: string; name: string; presence: string }>("SELECT id,name,presence FROM teammates WHERE workspace_id=$1 AND id=$2", [x.w, x.token.teammateId])).rows[0];
    return { type: "token", workspace_id: x.w, teammate: teammateOut(t), scopes: x.token.scopes, version: x.token.version };
  },
  async listConversations(x) {
    const after = cursor.read<[string, string]>(x.params.starting_after);
    if (x.params.starting_after !== undefined && !after) throw invalid("starting_after", "That cursor isn't one of ours.");
    const values: unknown[] = [x.w];
    const where = ["workspace_id=$1", "merged_into_id IS NULL", "visibility='customer'"];
    const add = (sql: string, v: unknown) => {
      values.push(v);
      where.push(sql.replace("?", "$" + values.length));
    };
    if (x.params.status) add("status=?", x.params.status);
    if (x.params.assignee_id) add("assigned=?", x.params.assignee_id === "none" ? "" : x.params.assignee_id);
    if (x.params.team_id) add("team_id=?", x.params.team_id);
    if (after) {
      values.push(after[0], after[1]);
      where.push(`(updated_at,id)<($${values.length - 1}::timestamptz,$${values.length})`);
    }
    const n = Number(x.params.per_page);
    if (x.me) where.push(scopeSql(x.me, "conversations", values));
    const rows = (await x.db.query<ConversationRow>(`SELECT ${CONVERSATION_COLUMNS} FROM conversations WHERE ${where.join(" AND ")} ORDER BY updated_at DESC,id DESC LIMIT ${n + 1}`, values)).rows;
    const page = rows.slice(0, n);
    return listOf(await Promise.all(page.map((c) => conversationOut(x.db, x.w, c))), rows.length > n ? [iso(page.at(-1)!.updated_at), page.at(-1)!.id] : null);
  },
  async createConversation(x) {
    const contactId = await resolveContact(x.db, x.w, String(x.body.contact_id)).catch(() => {
      throw invalid("contact_id", "No such contact.");
    });
    const identity = (await x.db.query<{ identity_id: string }>(
      "SELECT m.identity_id FROM identity_contact_mappings m JOIN identities i ON i.workspace_id=m.workspace_id AND i.id=m.identity_id WHERE m.workspace_id=$1 AND m.contact_id=$2 ORDER BY i.kind='user' DESC,m.identity_id LIMIT 1",
      [x.w, contactId],
    )).rows[0];
    if (!identity) throw invalid("contact_id", "That contact can't write in yet.");
    const brand = (await x.db.query<{ id: string }>("SELECT id FROM brands WHERE workspace_id=$1 ORDER BY (id='default') DESC,id LIMIT 1", [x.w])).rows[0];
    const started = (await command(x.db, x.w, { type: "contact", identityId: identity.identity_id, brandId: brand.id }, x.key ?? crypto.randomUUID(), { action: "start", text: String(x.body.body) })) as { conversationId: string };
    return readConversation(x.db, x.w, started.conversationId, x.me);
  },
  getConversation: (x) => readConversation(x.db, x.w, String(x.params.id), x.me),
  async listConversationParts(x) {
    const id = String(x.params.id);
    await readConversation(x.db, x.w, id, x.me);
    const after = cursor.read<number>(x.params.starting_after);
    if (x.params.starting_after !== undefined && typeof after !== "number") throw invalid("starting_after", "That cursor isn't one of ours.");
    const n = Number(x.params.per_page);
    const rows = (
      await x.db.query<{ id: string; seq: string; kind: string; audience: string; author_type: string; author_id: string; body: string; data: { deleted?: boolean }; created_at: Date }>(
        `SELECT id,seq,kind,audience,author_type,author_id,body,data,created_at FROM conversation_parts WHERE workspace_id=$1 AND conversation_id=$2 AND seq>$3 ORDER BY seq LIMIT ${n + 1}`,
        [x.w, id, after ?? 0],
      )
    ).rows;
    const page = rows.slice(0, n);
    return listOf(
      page.map((p) => ({
        type: "conversation_part",
        id: p.id,
        seq: Number(p.seq),
        kind: p.kind,
        audience: p.audience,
        author: { type: p.author_type, id: p.author_type === "system" ? null : p.author_id },
        body: p.data?.deleted ? "" : p.body,
        created_at: iso(p.created_at),
      })),
      rows.length > n ? Number(page.at(-1)!.seq) : null,
    );
  },
  replyToConversation: (x) => act(x, { action: "reply", text: String(x.body.body) }),
  addConversationNote: (x) => act(x, { action: "note", text: String(x.body.body) }),
  async assignConversation(x) {
    const now = (await x.db.query<{ assigned: string; team_id: string | null }>("SELECT assigned,team_id FROM conversations WHERE workspace_id=$1 AND id=$2", [x.w, String(x.params.id)])).rows[0];
    const teammate = x.body.assignee_id === undefined ? now?.assigned || undefined : (x.body.assignee_id as string | null) ?? undefined;
    const team = x.body.team_id === undefined ? (now?.team_id ?? undefined) : ((x.body.team_id as string | null) ?? undefined);
    return act(x, { action: "assign", teammateId: teammate, teamId: team });
  },
  snoozeConversation: (x) => act(x, { action: "snooze", wakeAt: String(x.body.until) }),
  closeConversation: (x) => act(x, { action: "close" }),
  openConversation: (x) => act(x, { action: "reopen" }),
  tagConversation: (x) => act(x, { action: "tag_add", tagId: String(x.body.tag_id) }),
  untagConversation: (x) => act(x, { action: "tag_remove", tagId: String(x.params.tag_id) }),
  async listContacts(x) {
    const after = cursor.read<string>(x.params.starting_after);
    if (x.params.starting_after !== undefined && typeof after !== "string") throw invalid("starting_after", "That cursor isn't one of ours.");
    const values: unknown[] = [x.w];
    const where = ["c.workspace_id=$1", "c.merged_into_contact_id IS NULL"];
    if (x.params.email) {
      values.push(String(x.params.email).toLowerCase());
      where.push(`EXISTS (SELECT 1 FROM contact_emails e WHERE e.workspace_id=c.workspace_id AND e.contact_id=c.id AND lower(e.email)=$${values.length})`);
    }
    if (x.params.external_id) {
      values.push(x.params.external_id);
      where.push(`c.external_id=$${values.length}`);
    }
    if (after) {
      values.push(after);
      where.push(`c.id>$${values.length}`);
    }
    const n = Number(x.params.per_page);
    const rows = (await x.db.query<ContactRow>(`${CONTACT_SELECT} WHERE ${where.join(" AND ")} ORDER BY c.id LIMIT ${n + 1}`, values)).rows;
    const page = rows.slice(0, n);
    return listOf(page.map(contactOut), rows.length > n ? page.at(-1)!.id : null);
  },
  async createContact(x) {
    const external = x.body.external_id as string | undefined;
    const email = x.body.email as string | undefined;
    if (!external && !email) throw invalid("external_id", "Give an external_id (a user) or an email (a lead).");
    const attributes = sanitizeAttributes(x.body.custom_attributes);
    const found = external
      ? await getIdentity(x.db, x.w, "user", external, { name: x.body.name as string | undefined, email })
      : await getIdentity(x.db, x.w, "anonymous", "api:" + (x.key ?? crypto.randomUUID()), { name: x.body.name as string | undefined, email });
    if (Object.keys(attributes).length)
      await x.db.query("UPDATE contacts SET profile=jsonb_strip_nulls(profile||$3::jsonb),version=version+1 WHERE workspace_id=$1 AND id=$2", [x.w, found.contactId, JSON.stringify(attributes)]);
    return readContact(x.db, x.w, found.contactId);
  },
  async getContact(x) {
    const contact = await readContact(x.db, x.w, String(x.params.id));
    // Phase 16 C1: a customer's record read through the API (once an hour in the audit log).
    await recordContactView(x.db, x.w, contact.id, { where: "api", personalData: true });
    return contact;
  },
  async updateContact(x) {
    const current = await readContact(x.db, x.w, String(x.params.id));
    const attributes = sanitizeAttributes(x.body.custom_attributes);
    await x.db.query(
      "UPDATE contacts SET name=COALESCE($3,name),profile=jsonb_strip_nulls(profile||$4::jsonb),version=version+1 WHERE workspace_id=$1 AND id=$2",
      [x.w, current.id, (x.body.name as string | undefined) ?? null, JSON.stringify(attributes)],
    );
    return readContact(x.db, x.w, current.id);
  },
  async listTags(x) {
    const rows = (await x.db.query<{ id: string; name: string }>("SELECT id,name FROM tags WHERE workspace_id=$1 AND archived_at IS NULL ORDER BY lower(name),id", [x.w])).rows;
    return listOf(rows.map((t) => ({ type: "tag", id: t.id, name: t.name })), null);
  },
  async createTag(x) {
    const name = String(x.body.name).trim().replace(/\s+/g, " ");
    if (!name) throw invalid("name", "Can't be empty.");
    const existing = (await x.db.query<{ id: string; name: string }>("SELECT id,name FROM tags WHERE workspace_id=$1 AND lower(name)=lower($2)", [x.w, name])).rows[0];
    if (existing) return { type: "tag", id: existing.id, name: existing.name };
    const id = crypto.randomUUID();
    await x.db.query("INSERT INTO tags(workspace_id,id,name) VALUES($1,$2,$3)", [x.w, id, name]);
    return { type: "tag", id, name };
  },
  async listTeammates(x) {
    const rows = (await x.db.query<{ id: string; name: string; presence: string }>("SELECT id,name,presence FROM teammates WHERE workspace_id=$1 ORDER BY lower(name),id", [x.w])).rows;
    return listOf(rows.map(teammateOut), null);
  },
  async getTeammate(x) {
    const t = (await x.db.query<{ id: string; name: string; presence: string }>("SELECT id,name,presence FROM teammates WHERE workspace_id=$1 AND id=$2", [x.w, String(x.params.id)])).rows[0];
    assert(t, "NOT_FOUND", "No such teammate.", 404);
    return teammateOut(t);
  },
  listTeams: async (x) => listOf(await teamsOut(x.db, x.w), null),
  async getTeam(x) {
    const [t] = await teamsOut(x.db, x.w, String(x.params.id));
    assert(t, "NOT_FOUND", "No such team.", 404);
    return t;
  },
};

/** The spec's operations, each with a matcher for its path. */
const ROUTES = operations().map(({ path, method, operation }) => {
  const names: string[] = [];
  const pattern = new RegExp("^" + path.replace(/\{([a-z_]+)\}/g, (_, n) => (names.push(n), "([^/]+)")) + "$");
  return { method, operation, pattern, names };
});

/** HTTP status and code for an error: domain errors keep theirs; anything else says nothing about why. */
function failure(e: unknown): { status: number; code: string; message: string; field?: string } {
  if (e instanceof DomainError) {
    const status = e.status >= 400 && e.status < 600 ? e.status : 400;
    const code = status === 404 ? "not_found" : status === 403 ? "forbidden" : e.code === "INVALID_FIELD" ? "invalid_field" : e.code.toLowerCase();
    return { status, code, message: e.message, field: typeof e.details?.field === "string" ? e.details.field : undefined };
  }
  return { status: 500, code: "internal_error", message: "Something went wrong on our side. Try again; quote the request id if it keeps happening." };
}

export async function handleRest(req: Request, env: RestEnvironment): Promise<Response> {
  const requestId = crypto.randomUUID();
  const url = new URL(req.url);
  const headers: Record<string, string> = { "cache-control": "no-store", "x-request-id": requestId };
  const reply = (body: unknown, status = 200) => Response.json(body, { status, headers });
  const error = (status: number, code: string, message: string, field?: string) =>
    reply({ type: "error", request_id: requestId, errors: [{ code, message, ...(field ? { field } : {}) }] }, status);
  try {
    const path = url.pathname.slice("/rest".length) || "/";
    if (path === "/openapi.json" && req.method === "GET") return reply(SPEC);
    const route = ROUTES.find((r) => r.method === req.method && r.pattern.test(path));
    if (!route) return ROUTES.some((r) => r.pattern.test(path)) ? error(405, "method_not_allowed", "That method isn't allowed here.") : error(404, "not_found", "There's no such endpoint.");
    // The token: its workspace is in it, so it's looked up in that workspace's own tenant.
    const auth = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "");
    const parsed = auth ? TOKEN.exec(auth[1]) : null;
    const w = parsed ? unb64(parsed[1]) : null;
    if (!parsed || !w) return error(401, "unauthorized", "Send a personal access token as `Authorization: Bearer <token>`.");
    const hash = await sha256(auth![1]);
    // Phase 16 C3b: the API's IP allowlist, against the address Cloudflare sets (a caller can't).
    const ip = req.headers.get("cf-connecting-ip");
    const token = await tenant(env.connect, w, async (db) => {
      const on = (await db.query("SELECT 1 FROM workspace_features WHERE workspace_id=$1 AND name='developer_api_v1' AND enabled", [w])).rows.length > 0;
      if (!on) return null;
      const t = (
        await db.query<{ id: string; teammate_id: string; principal_id: string; scopes: string[]; version: string; last_used_at: Date | null; grant_id: string | null }>(
          `SELECT k.id,k.teammate_id,m.principal_id,k.scopes,k.version,k.last_used_at,k.grant_id FROM api_tokens k JOIN teammates m ON m.workspace_id=k.workspace_id AND m.id=k.teammate_id
           WHERE k.workspace_id=$1 AND k.token_hash=$2 AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>now())
             AND (k.grant_id IS NULL OR EXISTS (SELECT 1 FROM oauth_grants g WHERE g.workspace_id=k.workspace_id AND g.id=k.grant_id AND g.revoked_at IS NULL))`,
          [w, hash],
        )
      ).rows[0];
      if (!t) return null;
      if (!(await networkAllowed(db, w, "api", ip))) return "network" as const;
      // At most once a minute per token: its last use, and usage older than seven days goes.
      if (!t.last_used_at || Date.now() - new Date(t.last_used_at).getTime() > 60_000) {
        await db.query("UPDATE api_tokens SET last_used_at=now() WHERE workspace_id=$1 AND id=$2", [w, t.id]);
        await db.query("DELETE FROM api_usage WHERE workspace_id=$1 AND minute<now()-interval '7 days'", [w]);
      }
      return { id: t.id, teammateId: t.teammate_id, principal: t.principal_id, scopes: t.scopes, version: t.version, grantId: t.grant_id } satisfies Token;
    }).catch(() => null);
    if (!token) return error(401, "unauthorized", "That token isn't valid: it may have been revoked.");
    if (token === "network") return error(403, "network_not_allowed", `This workspace's API isn't available from this address${normalIp(ip) ? ` (${normalIp(ip)})` : ""}. Ask someone who manages security to add it.`);
    // Rate limits, per token and per workspace; each call is counted for the Developers page.
    const limiter = env.rateLimiter ?? defaultLimiter;
    const mine = limiter.take("token:" + token.id, LIMITS.token);
    const ours = mine.ok ? limiter.take("workspace:" + w, LIMITS.workspace) : mine;
    const limited = !mine.ok || !ours.ok;
    headers["x-ratelimit-limit"] = String(LIMITS.token.perSecond * 60);
    headers["x-ratelimit-remaining"] = String(Math.min(mine.remaining, ours.remaining));
    headers["x-ratelimit-reset"] = String(Math.max(mine.resetSeconds, ours.resetSeconds));
    await tenant(env.connect, w, (db) =>
      db.query(
        `INSERT INTO api_usage(workspace_id,token_id,minute,calls,limited) VALUES($1,$2,date_trunc('minute',now()),$3,$4)
         ON CONFLICT(workspace_id,token_id,minute) DO UPDATE SET calls=api_usage.calls+$3,limited=api_usage.limited+$4`,
        [w, token.id, limited ? 0 : 1, limited ? 1 : 0],
      ),
    );
    if (limited) {
      headers["retry-after"] = String(Math.max(mine.retryAfterSeconds, ours.retryAfterSeconds));
      return error(429, "rate_limited", "Too many requests: wait for Retry-After seconds, then try again.");
    }
    // The version: the header's, else the token's.
    const version = req.headers.get("relay-version") ?? token.version;
    if (!supportedVersions().includes(version)) return error(400, "invalid_version", `Relay-Version must be one of: ${supportedVersions().join(", ")}.`, "Relay-Version");
    headers["relay-version"] = version;
    const op: Operation = route.operation;
    // Scope: the token's, and the teammate's role now.
    const scope = op["x-relay-scope"] as Capability | null;
    if (scope && !token.scopes.includes(scope)) return error(403, "forbidden", `This token doesn't have the ${scope} scope.`);
    // Parameters and body, checked against the spec.
    const match = route.pattern.exec(path)!;
    const pathValues = Object.fromEntries(route.names.map((n, i) => [n, decodeURIComponent(match[i + 1])]));
    const read = readParameters(op.parameters ?? [], { path: pathValues, query: url.searchParams });
    if ("problem" in read && read.problem) return error(400, "invalid_field", read.problem.message, read.problem.field);
    let body: Record<string, unknown> = {};
    if (op.requestBody) {
      const raw = await req.text();
      if (raw.length > 64_000) return error(413, "too_large", "The body can be up to 64 KB.");
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return error(400, "invalid_json", "The body isn't valid JSON.");
      }
      // An older version's request is brought forward, change by change, oldest first.
      for (const change of [...VERSION_CHANGES].reverse().filter((c) => version <= c.before))
        if (change.request) body = change.request(op.operationId, body) as Record<string, unknown>;
      const problem = check(op.requestBody.content["application/json"].schema, body);
      if (problem) return error(400, "invalid_field", problem.message, problem.field);
    }
    const key = req.headers.get("idempotency-key");
    if (key !== null && !/^[A-Za-z0-9_.:-]{1,200}$/.test(key)) return error(400, "invalid_field", "Idempotency-Key is letters, digits and _.:- up to 200.", "Idempotency-Key");
    const result = await tenant(env.connect, w, async (db) => {
      // Phase 16 C1: audited as the token's teammate, via the token (or the app's installation).
      await actingVia(db, token.grantId ? "app:" + token.grantId : "api_token:" + token.id);
      // Phase 16 C2: and seen through their role's scope.
      const me = scope ? await authorize(db, w, token.principal, scope) : undefined;
      return handlerFor(op.operationId)({ db, w, token, me, params: "values" in read ? read.values! : {}, body, key: key ? `api:${token.id}:${key}` : null, storage: env.storage, origin: url.origin, webhooks: env.webhooks });
    });
    // And the newest response is taken back, newest change first.
    let out: unknown = result;
    for (const change of VERSION_CHANGES.filter((c) => version <= c.before)) if (change.response) out = change.response(op.operationId, out);
    const status = Object.keys(op.responses).find((s) => s.startsWith("2")) ?? "200";
    return reply(out, Number(status));
  } catch (e) {
    const f = failure(e);
    // Phase 16 C6b: never the error itself (it can carry what was sent); only where it came from.
    if (f.status === 500) console.error("rest", requestId, errorFingerprint(e));
    return error(f.status, f.code, f.message, f.field);
  }
}

/** Every capability a token can be given: the registry's (a token never has more than its maker). */
export const TOKEN_SCOPES: readonly Capability[] = capabilities;

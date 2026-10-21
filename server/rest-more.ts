import { assert, DomainError, tenant, type Connect, type Sql } from "./db";
import { scopeSql, type Teammate } from "./policy";
import { command } from "./conversations";
import { requireTickets } from "./tickets";
import { changeKnowledge, requireKnowledge } from "./knowledge";
import { applyMacro } from "./macros";
import { runManually } from "./workflows";
import { outboundOn } from "./outbound";
import { checkEvent, recordEvent } from "./events";
import { compileSegment, segmentsOn } from "./segments";
import { saveAttribute } from "./workspace-data";
import { enqueueJob, type Job } from "./jobs";
import { recordAudit } from "./audit";
import type { AttachmentStorage } from "./attachments";
import { PREDEFINED, type SegmentDefinition } from "../lib/segments";
import { plainText, type RichDoc } from "../lib/rich-doc";
import { CONTACT_FIELDS, CONVERSATION_FIELDS, compileSearch, compileSort, SearchError, type Field } from "../lib/api-search";
import {
  contactOut,
  conversationOut,
  CONTACT_SELECT,
  CONVERSATION_COLUMNS,
  cursor,
  invalid,
  iso,
  listOf,
  readContact,
  readConversation,
  type ContactRow,
  type Context,
  type ConversationRow,
} from "./rest";

/**
 * The public API's wider coverage (phase 15, step D2; docs/DEVELOPER_PLATFORM_STEP2.md): tickets,
 * help centers and articles, knowledge, macros, workflows, outbound, events, data attributes,
 * segments, search and export. Reads are the API's own queries into the shapes the spec promises
 * (each area's feature switch checked first); every write goes through the area's own domain
 * function (`command`, `changeKnowledge`, `applyMacro`, `runManually`, `recordEvent`, `saveAttribute`),
 * as the token's teammate.
 */
const on = async (db: Sql, w: string, flag: string, what: string) =>
  assert((await db.query("SELECT 1 FROM workspace_features WHERE workspace_id=$1 AND name=$2 AND enabled", [w, flag])).rows.length > 0, "NOT_FOUND", `${what} aren't enabled for this workspace.`, 404);
const page = <T>(rows: T[], n: number, next: (last: T) => unknown) => ({ rows: rows.slice(0, n), next: rows.length > n ? next(rows[n - 1]) : null });
const readCursor = <T>(x: Context, check: (v: unknown) => boolean): T | null => {
  if (x.params.starting_after === undefined) return null;
  const v = cursor.read<T>(x.params.starting_after);
  if (v === null || !check(v)) throw invalid("starting_after", "That cursor isn't one of ours.");
  return v;
};
const pair = (v: unknown) => Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "string");
/** Plain text as an article's document: a blank line starts a paragraph. */
const docOf = (text: string): RichDoc => ({
  type: "doc",
  content: text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => ({ type: "paragraph", content: [{ type: "text", text: p }] })) as RichDoc["content"],
});
const textOf = (doc: unknown) => (doc && typeof doc === "object" ? plainText(doc as RichDoc) : "");
const teammateOf = async (x: Context) => (await x.db.query<{ id: string }>("SELECT id FROM teammates WHERE workspace_id=$1 AND principal_id=$2", [x.w, x.token.principal])).rows[0].id;

// Tickets.
type TicketRow = { conversation_id: string; number: string; type_id: string; state_id: string; state_name: string; state_kind: string; title: string; created_at: Date; updated_at: Date };
const TICKETS = `SELECT t.conversation_id,t.number,t.type_id,t.state_id,s.name AS state_name,s.kind AS state_kind,c.title,t.created_at,t.updated_at
  FROM tickets t JOIN ticket_states s ON s.workspace_id=t.workspace_id AND s.id=t.state_id JOIN conversations c ON c.workspace_id=t.workspace_id AND c.id=t.conversation_id`;
const ticketOut = (t: TicketRow) => ({
  type: "ticket",
  id: t.conversation_id,
  number: Number(t.number),
  title: t.title,
  ticket_type_id: t.type_id,
  state: { id: t.state_id, name: t.state_name, kind: t.state_kind },
  conversation_id: t.conversation_id,
  created_at: iso(t.created_at),
  updated_at: iso(t.updated_at),
});
/** A ticket in the API's shape; with `scope`, only if that teammate's role may see it (phase 16 C2). */
export async function readTicket(db: Sql, w: string, id: string, scope?: Teammate) {
  const values: unknown[] = [w, id];
  const visible = scope ? scopeSql(scope, "c", values) : "true";
  const t = (await db.query<TicketRow>(`${TICKETS} WHERE t.workspace_id=$1 AND t.conversation_id=$2 AND ${visible}`, values)).rows[0];
  assert(t, "NOT_FOUND", "No such ticket.", 404);
  return ticketOut(t);
}
async function ticketTypes(db: Sql, w: string, id?: string) {
  const types = (await db.query<{ id: string; name: string; category: string; description: string }>(`SELECT id,name,category,description FROM ticket_types WHERE workspace_id=$1 AND NOT archived${id ? " AND id=$2" : ""} ORDER BY lower(name),id`, id ? [w, id] : [w])).rows;
  const states = (await db.query<{ id: string; type_id: string; name: string; customer_label: string; kind: string }>("SELECT id,type_id,name,customer_label,kind FROM ticket_states WHERE workspace_id=$1 AND NOT archived ORDER BY position,id", [w])).rows;
  return types.map((t) => ({ type: "ticket_type", id: t.id, name: t.name, category: t.category, description: t.description, states: states.filter((s) => s.type_id === t.id).map((s) => ({ id: s.id, name: s.name, customer_label: s.customer_label, kind: s.kind })) }));
}

// Articles and knowledge.
type ArticleRow = { id: string; source: string; audience: string; for_ai: boolean; for_help_center: boolean; for_inbox: boolean; updated_at: Date; locale: string; status: string; draft_title: string; draft_body: unknown; draft_version: string; published_title: string | null; published_text: string | null; published_at: Date | null };
const KNOWLEDGE = `SELECT r.id,r.source,r.audience,r.for_ai,r.for_help_center,r.for_inbox,r.updated_at,l.locale,l.status,l.draft_title,l.draft_body,l.draft_version::text AS draft_version,l.published_title,l.published_text,l.published_at
  FROM knowledge_records r JOIN LATERAL (SELECT * FROM knowledge_locales x WHERE x.workspace_id=r.workspace_id AND x.record_id=r.id ORDER BY x.status='published' DESC,x.locale LIMIT 1) l ON true`;
export const articleOut = (a: ArticleRow) => ({
  type: "article",
  id: a.id,
  title: a.draft_title,
  body: textOf(a.draft_body),
  state: a.status === "published" ? "published" : "draft",
  published_title: a.published_title,
  published_body: a.published_text,
  locale: a.locale,
  audience: a.audience,
  updated_at: iso(a.updated_at),
  published_at: iso(a.published_at),
});
const knowledgeOut = (a: ArticleRow) => ({
  type: "knowledge_record",
  id: a.id,
  source: a.source,
  title: a.published_title ?? a.draft_title,
  audience: a.audience,
  for_ai: a.for_ai,
  for_help_center: a.for_help_center,
  for_inbox: a.for_inbox,
  published: a.status === "published",
  updated_at: iso(a.updated_at),
});
export async function readRecord(db: Sql, w: string, id: string, article: boolean) {
  const a = (await db.query<ArticleRow>(`${KNOWLEDGE} WHERE r.workspace_id=$1 AND r.id=$2${article ? " AND r.source='article'" : ""}`, [w, id])).rows[0];
  assert(a, "NOT_FOUND", article ? "No such article." : "No such knowledge record.", 404);
  return a;
}
async function listKnowledgeRows(x: Context, where: string, values: unknown[]) {
  await requireKnowledge(x.db, x.w);
  const after = readCursor<[string, string]>(x, pair);
  const params = [x.w, ...values];
  if (after) params.push(after[0], after[1]);
  const n = Number(x.params.per_page);
  const rows = (await x.db.query<ArticleRow>(`${KNOWLEDGE} WHERE r.workspace_id=$1 ${where}${after ? ` AND (r.updated_at,r.id)<($${params.length - 1}::timestamptz,$${params.length})` : ""} ORDER BY r.updated_at DESC,r.id DESC LIMIT ${n + 1}`, params)).rows;
  return page(rows, n, (l) => [iso(l.updated_at), l.id]);
}

// Macros, workflows, outbound.
type MacroRow = { id: string; name: string; mode: string; shared: boolean; body: unknown; actions: { type?: string }[] };
const macroOut = (m: MacroRow) => ({ type: "macro", id: m.id, name: m.name, mode: m.mode, shared: m.shared, body: textOf(m.body), actions: m.actions ?? [] });
const MACROS = "SELECT id,name,mode,shared,body,actions FROM macros WHERE workspace_id=$1 AND NOT archived AND (shared OR owner_id=$2)";
type WorkflowRow = { id: string; name: string; trigger: string; state: string; updated_at: Date };
const workflowOut = (r: WorkflowRow) => ({ type: "workflow", id: r.id, name: r.name, trigger: r.trigger, state: r.state, updated_at: iso(r.updated_at) });
type OutboundRow = { id: string; title: string; kind: string; state: string; live_version: number | null; updated_at: Date; sent: number; seen: number; replied: number; clicked: number; dismissed: number };
const OUTBOUND = `SELECT m.id,m.title,m.type AS kind,m.state,m.live_version,m.updated_at,
  count(e.*) FILTER (WHERE e.status='sent')::int AS sent,count(e.seen_at)::int AS seen,count(e.replied_at)::int AS replied,count(e.clicked_at)::int AS clicked,count(e.dismissed_at)::int AS dismissed
  FROM outbound_messages m LEFT JOIN outbound_entries e ON e.workspace_id=m.workspace_id AND e.message_id=m.id`;
const outboundOut = (m: OutboundRow) => ({
  type: "outbound_message",
  id: m.id,
  title: m.title,
  kind: m.kind,
  state: m.state,
  live_version: m.live_version,
  stats: { sent: m.sent, seen: m.seen, replied: m.replied, clicked: m.clicked, dismissed: m.dismissed },
  updated_at: iso(m.updated_at),
});

// Events.
export type EventRow = { id: string; contact_id: string; name: string; metadata: Record<string, unknown>; source: string; occurred_at: Date };
export const eventOut = (e: EventRow) => ({ type: "event", id: e.id, contact_id: e.contact_id, name: e.name, metadata: e.metadata, source: e.source, occurred_at: iso(e.occurred_at) });

/** A search over conversations or contacts: the grammar compiled, sorted, cursor-paged. */
async function searchRows<R extends { id: string }>(x: Context, fields: Record<string, Field>, resource: "conversation" | "contact", from: string, base: string, fallback: string) {
  const params: unknown[] = [x.w];
  // Phase 16 C2: conversations within the token teammate's scope.
  if (resource === "conversation" && x.me) base += ` AND ${scopeSql(x.me, "c", params)}`;
  let where: string;
  let sort: ReturnType<typeof compileSort>;
  try {
    where = compileSearch(x.body.query, fields, params, resource);
    sort = compileSort(x.body.sort, fields, fallback);
  } catch (e) {
    if (e instanceof SearchError) throw invalid(e.field, e.message);
    throw e;
  }
  const key = fields[sort.field].type === "time" ? `COALESCE(${sort.sql},'-infinity'::timestamptz)` : `COALESCE(${sort.sql},'')`;
  const after = x.body.starting_after === undefined ? null : cursor.read<[string, string]>(x.body.starting_after);
  if (x.body.starting_after !== undefined && !pair(after)) throw invalid("starting_after", "That cursor isn't one of ours.");
  if (after) {
    params.push(after[0], after[1]);
    const cast = fields[sort.field].type === "time" ? "::timestamptz" : "";
    where += ` AND (${key},c.id) ${sort.desc ? "<" : ">"} ($${params.length - 1}${cast},$${params.length})`;
  }
  const n = Math.min(100, Math.max(1, Number(x.body.per_page ?? 20) || 20));
  const rows = (
    await x.db.query<R & { sort_key: Date | string }>(`${from} WHERE ${base} AND (${where}) ORDER BY ${key} ${sort.desc ? "DESC" : "ASC"},c.id ${sort.desc ? "DESC" : "ASC"} LIMIT ${n + 1}`, params)
  ).rows;
  return page(rows, n, (l) => [l.sort_key instanceof Date ? l.sort_key.toISOString() : String(l.sort_key ?? ""), l.id]);
}

export const MORE_HANDLERS: Record<string, (x: Context) => Promise<unknown>> = {
  async searchConversations(x) {
    const sortField = (x.body.sort as { field?: string } | undefined)?.field ?? "updated_at";
    const sql = CONVERSATION_FIELDS[sortField]?.sql ?? "c.updated_at";
    const r = await searchRows<ConversationRow>(
      x,
      CONVERSATION_FIELDS,
      "conversation",
      `SELECT ${CONVERSATION_COLUMNS.split(",").map((col) => "c." + col).join(",")},${sql} AS sort_key FROM conversations c`,
      "c.workspace_id=$1 AND c.merged_into_id IS NULL AND c.visibility='customer'",
      "updated_at",
    );
    return listOf(await Promise.all(r.rows.map((c) => conversationOut(x.db, x.w, c))), r.next);
  },
  async searchContacts(x) {
    const sortField = (x.body.sort as { field?: string } | undefined)?.field ?? "last_seen_at";
    const sql = CONTACT_FIELDS[sortField]?.sql ?? "c.last_seen_at";
    const select = CONTACT_SELECT.replace("SELECT c.id,", `SELECT ${sql} AS sort_key,c.id,`);
    const r = await searchRows<ContactRow>(x, CONTACT_FIELDS, "contact", select, "c.workspace_id=$1 AND c.merged_into_contact_id IS NULL", "last_seen_at");
    return listOf(r.rows.map(contactOut), r.next);
  },

  async listContactEvents(x) {
    const contact = (await readContact(x.db, x.w, String(x.params.id))).id;
    const after = readCursor<[string, string]>(x, pair);
    const values: unknown[] = [x.w, contact];
    if (after) values.push(after[0], after[1]);
    const n = Number(x.params.per_page);
    const rows = (
      await x.db.query<EventRow>(
        `SELECT id,contact_id,name,metadata,source,occurred_at FROM contact_events WHERE workspace_id=$1 AND contact_id=$2${after ? " AND (occurred_at,id)<($3::timestamptz,$4)" : ""} ORDER BY occurred_at DESC,id DESC LIMIT ${n + 1}`,
        values,
      )
    ).rows;
    const r = page(rows, n, (l) => [iso(l.occurred_at), l.id]);
    return listOf(r.rows.map(eventOut), r.next);
  },
  async createContactEvent(x) {
    assert(await segmentsOn(x.db, x.w), "NOT_FOUND", "Events aren't enabled for this workspace.", 404);
    const contact = (await readContact(x.db, x.w, String(x.params.id))).id;
    let checked;
    try {
      checked = checkEvent({ name: x.body.name, metadata: x.body.metadata, occurredAt: x.body.occurred_at });
    } catch (e) {
      if (e instanceof DomainError) throw invalid(/metadata/i.test(e.message) ? "metadata" : /time|when|occurred/i.test(e.message) ? "occurred_at" : "name", e.message);
      throw e;
    }
    const dedupe = `api:${contact}:${String(x.body.id)}`;
    await recordEvent(x.db, x.w, contact, checked, "api", dedupe);
    const e = (await x.db.query<EventRow>("SELECT id,contact_id,name,metadata,source,occurred_at FROM contact_events WHERE workspace_id=$1 AND dedupe_key=$2", [x.w, dedupe])).rows[0];
    assert(e, "INVALID_FIELD", "That event's name is archived, so it isn't kept.", 400);
    return eventOut(e);
  },

  async listTickets(x) {
    await requireTickets(x.db, x.w);
    const after = readCursor<[string, string]>(x, pair);
    const values: unknown[] = [x.w];
    const where = ["t.workspace_id=$1"];
    if (x.me) where.push(scopeSql(x.me, "c", values));
    if (x.params.ticket_type_id) where.push(`t.type_id=$${values.push(x.params.ticket_type_id)}`);
    if (x.params.state) where.push(`s.kind=$${values.push(x.params.state)}`);
    if (after) {
      values.push(after[0], after[1]);
      where.push(`(t.created_at,t.conversation_id)<($${values.length - 1}::timestamptz,$${values.length})`);
    }
    const n = Number(x.params.per_page);
    const rows = (await x.db.query<TicketRow>(`${TICKETS} WHERE ${where.join(" AND ")} ORDER BY t.created_at DESC,t.conversation_id DESC LIMIT ${n + 1}`, values)).rows;
    const r = page(rows, n, (l) => [iso(l.created_at), l.conversation_id]);
    return listOf(r.rows.map(ticketOut), r.next);
  },
  async getTicket(x) {
    await requireTickets(x.db, x.w);
    return readTicket(x.db, x.w, String(x.params.id), x.me);
  },
  async createTicket(x) {
    await requireTickets(x.db, x.w);
    const id = String(x.body.conversation_id);
    await readConversation(x.db, x.w, id, x.me).catch(() => {
      throw invalid("conversation_id", "No such conversation.");
    });
    await command(x.db, x.w, { type: "teammate", principal: x.token.principal }, x.key ?? crypto.randomUUID(), { action: "ticket", conversationId: id, typeId: String(x.body.ticket_type_id), stateId: x.body.state_id as string | undefined });
    return readTicket(x.db, x.w, id, x.me);
  },
  async setTicketState(x) {
    await requireTickets(x.db, x.w);
    const id = String(x.params.id);
    await readTicket(x.db, x.w, id, x.me);
    await command(x.db, x.w, { type: "teammate", principal: x.token.principal }, x.key ?? crypto.randomUUID(), { action: "ticket_state", conversationId: id, stateId: String(x.body.state_id) });
    return readTicket(x.db, x.w, id, x.me);
  },
  async listTicketTypes(x) {
    await requireTickets(x.db, x.w);
    return listOf(await ticketTypes(x.db, x.w), null);
  },
  async getTicketType(x) {
    await requireTickets(x.db, x.w);
    const [t] = await ticketTypes(x.db, x.w, String(x.params.id));
    assert(t, "NOT_FOUND", "No such ticket type.", 404);
    return t;
  },

  async listHelpCenters(x) {
    await on(x.db, x.w, "help_center_v1", "Help centers");
    return listOf(await helpCenters(x.db, x.w), null);
  },
  async getHelpCenter(x) {
    await on(x.db, x.w, "help_center_v1", "Help centers");
    const [c] = await helpCenters(x.db, x.w, String(x.params.id));
    assert(c, "NOT_FOUND", "No such help center.", 404);
    return c;
  },
  async listArticles(x) {
    const state = x.params.state === "published" ? " AND l.status='published'" : x.params.state === "draft" ? " AND l.status='draft'" : "";
    const r = await listKnowledgeRows(x, `AND r.source='article'${state}`, []);
    return listOf(r.rows.map(articleOut), r.next);
  },
  async getArticle(x) {
    await requireKnowledge(x.db, x.w);
    return articleOut(await readRecord(x.db, x.w, String(x.params.id), true));
  },
  async createArticle(x) {
    await requireKnowledge(x.db, x.w);
    const made = (await changeKnowledge(x.db, x.w, x.token.principal, {
      op: "create",
      source: "article",
      locale: x.body.locale ?? "en",
      title: x.body.title,
      body: x.body.body ? docOf(String(x.body.body)) : null,
    })) as { id: string };
    return articleOut(await readRecord(x.db, x.w, made.id, true));
  },
  async updateArticle(x) {
    await requireKnowledge(x.db, x.w);
    const a = await readRecord(x.db, x.w, String(x.params.id), true);
    await changeKnowledge(x.db, x.w, x.token.principal, {
      op: "save",
      id: a.id,
      locale: a.locale,
      draftVersion: a.draft_version,
      title: x.body.title ?? a.draft_title,
      body: x.body.body !== undefined ? docOf(String(x.body.body)) : a.draft_body,
    });
    return articleOut(await readRecord(x.db, x.w, a.id, true));
  },
  async publishArticle(x) {
    await requireKnowledge(x.db, x.w);
    const a = await readRecord(x.db, x.w, String(x.params.id), true);
    await changeKnowledge(x.db, x.w, x.token.principal, { op: "publish", id: a.id, locale: a.locale, draftVersion: a.draft_version });
    return articleOut(await readRecord(x.db, x.w, a.id, true));
  },
  async listKnowledgeRecords(x) {
    const values = x.params.source ? [x.params.source] : [];
    const r = await listKnowledgeRows(x, x.params.source ? "AND r.source=$2" : "", values);
    return listOf(r.rows.map(knowledgeOut), r.next);
  },
  async getKnowledgeRecord(x) {
    await requireKnowledge(x.db, x.w);
    return knowledgeOut(await readRecord(x.db, x.w, String(x.params.id), false));
  },

  async listMacros(x) {
    const rows = (await x.db.query<MacroRow>(`${MACROS} ORDER BY lower(name),id`, [x.w, await teammateOf(x)])).rows;
    return listOf(rows.map(macroOut), null);
  },
  async getMacro(x) {
    const m = (await x.db.query<MacroRow>(`${MACROS} AND id=$3`, [x.w, await teammateOf(x), String(x.params.id)])).rows[0];
    assert(m, "NOT_FOUND", "No such macro.", 404);
    return macroOut(m);
  },
  async applyMacro(x) {
    const id = String(x.params.id);
    await readConversation(x.db, x.w, id, x.me);
    // The inbox fills the composer with a macro's text; the API has no composer, so it sends it too.
    const key = x.key ?? crypto.randomUUID();
    const applied = (await applyMacro(x.db, x.w, x.token.principal, key, { macroId: String(x.body.macro_id), conversationId: id })) as { mode: "reply" | "note"; doc: RichDoc | null };
    if (applied.doc && textOf(applied.doc).trim())
      await command(x.db, x.w, { type: "teammate", principal: x.token.principal }, key + ":send", { action: applied.mode, conversationId: id, doc: applied.doc, text: textOf(applied.doc) });
    return readConversation(x.db, x.w, id, x.me);
  },

  async listWorkflows(x) {
    await on(x.db, x.w, "workflows_v1", "Workflows");
    const rows = (await x.db.query<WorkflowRow>("SELECT id,name,trigger,state,updated_at FROM workflows WHERE workspace_id=$1 AND NOT archived ORDER BY lower(name),id", [x.w])).rows;
    return listOf(rows.map(workflowOut), null);
  },
  async getWorkflow(x) {
    await on(x.db, x.w, "workflows_v1", "Workflows");
    const r = (await x.db.query<WorkflowRow>("SELECT id,name,trigger,state,updated_at FROM workflows WHERE workspace_id=$1 AND id=$2", [x.w, String(x.params.id)])).rows[0];
    assert(r, "NOT_FOUND", "No such workflow.", 404);
    return workflowOut(r);
  },
  async listWorkflowRuns(x) {
    await on(x.db, x.w, "workflows_v1", "Workflows");
    const after = readCursor<[string, string]>(x, pair);
    const values: unknown[] = [x.w, String(x.params.id)];
    if (after) values.push(after[0], after[1]);
    const n = Number(x.params.per_page);
    const rows = (
      await x.db.query<{ id: string; workflow_id: string; conversation_id: string | null; status: string; started_at: Date; ended_at: Date | null }>(
        `SELECT id,workflow_id,conversation_id,status,started_at,ended_at FROM workflow_runs WHERE workspace_id=$1 AND workflow_id=$2${after ? " AND (started_at,id)<($3::timestamptz,$4)" : ""} ORDER BY started_at DESC,id DESC LIMIT ${n + 1}`,
        values,
      )
    ).rows;
    const r = page(rows, n, (l) => [iso(l.started_at), l.id]);
    return listOf(
      r.rows.map((x) => ({ type: "workflow_run", id: x.id, workflow_id: x.workflow_id, conversation_id: x.conversation_id, status: x.status, started_at: iso(x.started_at), finished_at: iso(x.ended_at) })),
      r.next,
    );
  },
  async triggerWorkflow(x) {
    await runManually(x.db, x.w, x.token.principal, x.key ?? crypto.randomUUID(), { workflowId: String(x.params.id), conversationId: String(x.body.conversation_id) });
    return { type: "workflow_run", queued: true };
  },

  async listOutboundMessages(x) {
    assert(await outboundOn(x.db, x.w), "NOT_FOUND", "Outbound isn't enabled for this workspace.", 404);
    const rows = (await x.db.query<OutboundRow>(`${OUTBOUND} WHERE m.workspace_id=$1 GROUP BY m.id,m.workspace_id ORDER BY m.updated_at DESC,m.id`, [x.w])).rows;
    return listOf(rows.map(outboundOut), null);
  },
  async getOutboundMessage(x) {
    assert(await outboundOn(x.db, x.w), "NOT_FOUND", "Outbound isn't enabled for this workspace.", 404);
    const m = (await x.db.query<OutboundRow>(`${OUTBOUND} WHERE m.workspace_id=$1 AND m.id=$2 GROUP BY m.id,m.workspace_id`, [x.w, String(x.params.id)])).rows[0];
    assert(m, "NOT_FOUND", "No such outbound message.", 404);
    return outboundOut(m);
  },

  async listDataAttributes(x) {
    const values: unknown[] = [x.w];
    const model = x.params.model ? ` AND owner_type=$${values.push(x.params.model)}` : " AND owner_type IN ('conversation','contact')";
    const rows = (await x.db.query<{ id: string; name: string; owner_type: string; value_type: string; options: string[] | null; archived: boolean }>(
      `SELECT id,name,owner_type,value_type,options,archived_at IS NOT NULL AS archived FROM attribute_definitions WHERE workspace_id=$1${model} ORDER BY owner_type,lower(name),id`,
      values,
    )).rows;
    return listOf(rows.map((a) => ({ type: "data_attribute", id: a.id, name: a.name, model: a.owner_type, value_type: a.value_type, options: a.options ?? [], archived: a.archived })), null);
  },
  async createDataAttribute(x) {
    const made = (await saveAttribute(x.db, x.w, x.token.principal, { name: x.body.name, valueType: x.body.value_type, options: x.body.options })) as { id: string };
    const a = (await x.db.query<{ id: string; name: string; value_type: string; options: string[] | null }>("SELECT id,name,value_type,options FROM attribute_definitions WHERE workspace_id=$1 AND id=$2", [x.w, made.id])).rows[0];
    return { type: "data_attribute", id: a.id, name: a.name, model: "conversation", value_type: a.value_type, options: a.options ?? [], archived: false };
  },

  async listSegments(x) {
    assert(await segmentsOn(x.db, x.w), "NOT_FOUND", "Segments aren't enabled for this workspace.", 404);
    const saved = (await x.db.query<{ id: string; name: string }>("SELECT id,name FROM segments WHERE workspace_id=$1 AND archived_at IS NULL ORDER BY lower(name),id", [x.w])).rows;
    return listOf([...PREDEFINED.map((s) => ({ type: "segment", id: s.id, name: s.name, predefined: true })), ...saved.map((s) => ({ type: "segment", id: s.id, name: s.name, predefined: false }))], null);
  },
  async listSegmentContacts(x) {
    assert(await segmentsOn(x.db, x.w), "NOT_FOUND", "Segments aren't enabled for this workspace.", 404);
    const id = String(x.params.id);
    const def =
      PREDEFINED.find((s) => s.id === id)?.definition ??
      (await x.db.query<{ definition: SegmentDefinition }>("SELECT definition FROM segments WHERE workspace_id=$1 AND id=$2 AND archived_at IS NULL", [x.w, id])).rows[0]?.definition;
    assert(def, "NOT_FOUND", "No such segment.", 404);
    const after = readCursor<string>(x, (v) => typeof v === "string");
    const params: unknown[] = [x.w];
    let where = `c.workspace_id=$1 AND c.merged_into_contact_id IS NULL AND ${compileSegment(def, params)}`;
    if (after) where += ` AND c.id>$${params.push(after)}`;
    const n = Number(x.params.per_page);
    const rows = (await x.db.query<ContactRow>(`${CONTACT_SELECT} WHERE ${where} ORDER BY c.id LIMIT ${n + 1}`, params)).rows;
    const r = page(rows, n, (l) => l.id);
    return listOf(r.rows.map(contactOut), r.next);
  },

  async createExport(x) {
    const resources = [...new Set((x.body.resources as string[]) ?? [])];
    if (!resources.length) throw invalid("resources", "Choose at least one of conversations, contacts or tickets.");
    if (x.body.created_after && x.body.created_before && String(x.body.created_after) >= String(x.body.created_before)) throw invalid("created_before", "Must be after created_after.");
    const payload = { resources, after: x.body.created_after ?? null, before: x.body.created_before ?? null };
    const id = await enqueueJob(x.db, x.w, "api.export", payload, { teammateId: await teammateOf(x) });
    // Phase 16 C1: a data export is audited when it's asked for.
    await recordAudit(x.db, x.w, "data.export_requested", { type: "export", id }, payload);
    return exportOut(x, id);
  },
  getExport: (x) => exportOut(x, String(x.params.id)),
};

async function helpCenters(db: Sql, w: string, id?: string) {
  const centers = (
    await db.query<{ id: string; name: string; brand_id: string; slug: string; access: string; default_locale: string; locales: string[] }>(
      `SELECT id,name,brand_id,slug,access,default_locale,locales FROM help_centers WHERE workspace_id=$1${id ? " AND id=$2" : ""} ORDER BY lower(name),id`,
      id ? [w, id] : [w],
    )
  ).rows;
  const collections = (
    await db.query<{ id: string; center_id: string; name: string; description: string }>(
      `SELECT n.id,n.center_id,l.name,l.description FROM help_nodes n JOIN help_centers h ON h.workspace_id=n.workspace_id AND h.id=n.center_id
       JOIN help_node_locales l ON l.workspace_id=n.workspace_id AND l.node_id=n.id AND l.locale=h.default_locale
       WHERE n.workspace_id=$1 AND n.kind='collection' AND NOT n.archived ORDER BY n.position,n.id`,
      [w],
    )
  ).rows;
  return centers.map((c) => ({
    type: "help_center",
    id: c.id,
    name: c.name,
    brand_id: c.brand_id,
    slug: c.slug,
    access: c.access,
    default_locale: c.default_locale,
    locales: c.locales,
    collections: collections.filter((x) => x.center_id === c.id).map((x) => ({ id: x.id, name: x.name, description: x.description })),
  }));
}

/* ------------------------------------------------------------------------------------------ */
/* Data export: a background job writing newline-delimited JSON in parts.                     */
/* ------------------------------------------------------------------------------------------ */
const EXPORT_BATCH = 1000;
type ExportResult = { i: number; after: [string, string] | null; part: number; rows: number; files: { resource: string; key: string; rows: number }[] };

async function exportOut(x: Context, id: string) {
  const job = (
    await x.db.query<{ id: string; state: string; payload: { resources: string[] }; result: ExportResult | null; created_at: Date }>(
      "SELECT id,state,payload,result,created_at FROM jobs WHERE workspace_id=$1 AND id=$2 AND kind='api.export' AND owner_teammate_id=$3",
      [x.w, id, await teammateOf(x)],
    )
  ).rows[0];
  assert(job, "NOT_FOUND", "No such export (an export is seen only by the teammate whose token made it).", 404);
  const status = job.state === "succeeded" ? "done" : job.state === "failed" || job.state === "dead_letter" ? "failed" : job.state === "running" ? "running" : "queued";
  const files =
    status === "done" && x.storage
      ? await Promise.all(
          (job.result?.files ?? []).map(async (f) => {
            const signed = await x.storage!.signDownload(f.key, false);
            // Always a full link (local storage signs paths; they're served from this origin too).
            return { resource: f.resource, url: new URL(signed.url, x.origin ?? "http://localhost").toString(), expires_at: signed.expiresAt, rows: f.rows };
          }),
        )
      : [];
  return { type: "export", id: job.id, status, resources: job.payload.resources, rows: job.result?.rows ?? 0, files, created_at: iso(job.created_at) };
}

/** One step of an export: up to 1,000 rows of one resource into one part file; continues until all are done. */
export async function exportJob(connect: Connect, storage: AttachmentStorage, job: Job): Promise<{ done: boolean; result: Record<string, unknown> }> {
  const w = job.workspace_id;
  const p = job.payload as { resources: string[]; after: string | null; before: string | null };
  const state: ExportResult = (job.result as ExportResult | null) ?? { i: 0, after: null, part: 0, rows: 0, files: [] };
  if (state.i >= p.resources.length) return { done: true, result: state };
  const resource = p.resources[state.i];
  const lines = await tenant(connect, w, async (db) => {
    const values: unknown[] = [w];
    const range = (column: string) =>
      [p.after ? ` AND ${column}>=$${values.push(p.after)}::timestamptz` : "", p.before ? ` AND ${column}<$${values.push(p.before)}::timestamptz` : ""].join("");
    const cursorAt = (column: string, idColumn: string) => (state.after ? ` AND (${column},${idColumn})>($${values.push(state.after[0])}::timestamptz,$${values.push(state.after[1])})` : "");
    if (resource === "conversations") {
      const rows = (
        await db.query<ConversationRow>(
          `SELECT ${CONVERSATION_COLUMNS} FROM conversations WHERE workspace_id=$1 AND merged_into_id IS NULL AND visibility='customer'${range("created_at")}${cursorAt("created_at", "id")} ORDER BY created_at,id LIMIT ${EXPORT_BATCH}`,
          values,
        )
      ).rows;
      return { out: await Promise.all(rows.map((c) => conversationOut(db, w, c))), last: rows.at(-1) ? ([iso(rows.at(-1)!.created_at)!, rows.at(-1)!.id] as [string, string]) : null };
    }
    if (resource === "contacts") {
      const rows = (
        await db.query<ContactRow>(`${CONTACT_SELECT} WHERE c.workspace_id=$1 AND c.merged_into_contact_id IS NULL${range("c.first_seen_at")}${cursorAt("c.first_seen_at", "c.id")} ORDER BY c.first_seen_at,c.id LIMIT ${EXPORT_BATCH}`, values)
      ).rows;
      return { out: rows.map(contactOut), last: rows.at(-1) ? ([iso(rows.at(-1)!.first_seen_at)!, rows.at(-1)!.id] as [string, string]) : null };
    }
    const rows = (await db.query<TicketRow>(`${TICKETS} WHERE t.workspace_id=$1${range("t.created_at")}${cursorAt("t.created_at", "t.conversation_id")} ORDER BY t.created_at,t.conversation_id LIMIT ${EXPORT_BATCH}`, values)).rows;
    return { out: rows.map(ticketOut), last: rows.at(-1) ? ([iso(rows.at(-1)!.created_at)!, rows.at(-1)!.conversation_id] as [string, string]) : null };
  });
  const next: ExportResult = { ...state, files: [...state.files] };
  if (lines.out.length) {
    const key = `exports/${w}/${job.id}/${resource}-${String(state.part).padStart(4, "0")}.ndjson`;
    await storage.putClean(key, new TextEncoder().encode(lines.out.map((o) => JSON.stringify(o)).join("\n") + "\n"), "application/x-ndjson", `${resource}-${state.part}.ndjson`);
    next.files.push({ resource, key, rows: lines.out.length });
    next.rows += lines.out.length;
    next.part += 1;
  }
  if (lines.out.length < EXPORT_BATCH) {
    next.i += 1;
    next.after = null;
  } else next.after = lines.last;
  return { done: next.i >= p.resources.length, result: next };
}

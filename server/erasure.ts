import type { Sql } from "./db";

/**
 * Erasing one person from PostgreSQL (phase 16, step C5a; docs/SECURITY_STEP7.md): the documented
 * cascade. Every table in the schema is either a step here (deleted by the person's contacts,
 * identities, conversations, addresses or what mentions them; or scrubbed, for the ledgers others
 * rely on) or in `NO_PERSONAL_DATA` with why; `tests/erasure.test.ts` fails on a table in neither.
 *
 * The steps run in order (children before parents, as the foreign keys require) in one transaction
 * with `relay.erasure` set, which is what lets the append-only tables' triggers (0087) delete the
 * person's rows and scrub the ledgers' links; nothing else ever sets it.
 *
 * Parameters every step's SQL may use: $1 workspace, $2 contact ids, $3 identity ids, $4 the
 * conversations they're the customer in, $5 their addresses (lower-cased emails and phones), $6
 * LIKE patterns for anything that names them (addresses, external ids, contact, identity, conversation and message ids),
 * $7 their own messages in conversations someone else leads, $8 those conversations.
 */
export type Subject = {
  contacts: string[];
  identities: string[];
  conversations: string[];
  /** Conversations someone else leads, where they only took part. */
  others: string[];
  /** Their own messages in those conversations. */
  parts: string[];
  addresses: string[];
  externalIds: string[];
};
export type Step = { table: string; how: "delete" | "scrub"; sql: string };

const PARTS = "(SELECT id FROM conversation_parts WHERE workspace_id=$1 AND (conversation_id=ANY($4) OR id=ANY($7)))";
const ATTACHMENTS = "(SELECT id FROM attachments WHERE workspace_id=$1 AND (conversation_id=ANY($4) OR owner_identity_id=ANY($3)))";
const DELIVERIES = "(SELECT id FROM channel_deliveries WHERE workspace_id=$1 AND (conversation_id=ANY($4) OR identity_id=ANY($3) OR lower(address)=ANY($5) OR part_id=ANY($7)))";
const RUNS = "(SELECT id FROM workflow_runs WHERE workspace_id=$1 AND (conversation_id=ANY($4) OR trigger_data::text ILIKE ANY($6)))";
const JOBS = "(SELECT id FROM jobs WHERE workspace_id=$1 AND (owner_identity_id=ANY($3) OR payload::text ILIKE ANY($6) OR result::text ILIKE ANY($6)))";
// Zoe's answers in their conversations, and to their own messages in someone else's.
const ANSWERS = "(SELECT id FROM ai_answers WHERE workspace_id=$1 AND (conversation_id=ANY($4) OR question_part_id=ANY($7) OR reply_part_id=ANY($7)))";
const REVIEWS = `(SELECT id FROM ai_reviews WHERE workspace_id=$1 AND (conversation_id=ANY($4) OR answer_id IN ${ANSWERS}))`;
const WEBHOOK_DELIVERIES = "(SELECT id FROM webhook_deliveries WHERE workspace_id=$1 AND payload::text ILIKE ANY($6))";
const del = (table: string, where: string): Step => ({ table, how: "delete", sql: `DELETE FROM ${table} WHERE workspace_id=$1 AND (${where})` });
const byConversation = (table: string) => del(table, "conversation_id=ANY($4)");

/** The cascade, in order. */
export const ERASURE: Step[] = [
  // Messages' pieces, then the messages' delivery records.
  del("conversation_part_images", `part_id IN ${PARTS} OR attachment_id IN ${ATTACHMENTS}`),
  del("conversation_part_delivery_events", `part_id IN ${PARTS}`),
  del("side_messages", "side_id IN (SELECT id FROM side_conversations WHERE workspace_id=$1 AND conversation_id=ANY($4)) OR part_id=ANY($7)"),
  byConversation("side_conversations"),
  del("email_events", `delivery_id IN ${DELIVERIES}`),
  del("channel_deliveries", `id IN ${DELIVERIES}`),
  del("email_messages", "conversation_id=ANY($4) OR part_id=ANY($7)"),
  // In conversations someone else leads, their addresses come off the messages' recipients.
  {
    table: "email_messages",
    how: "scrub",
    sql: `UPDATE email_messages SET to_addresses=ARRAY(SELECT a FROM unnest(to_addresses) a WHERE NOT (a ILIKE ANY($6))),
            cc_addresses=ARRAY(SELECT a FROM unnest(cc_addresses) a WHERE NOT (a ILIKE ANY($6)))
          WHERE workspace_id=$1 AND conversation_id=ANY($8) AND (array_to_string(to_addresses,' ') ILIKE ANY($6) OR array_to_string(cc_addresses,' ') ILIKE ANY($6))`,
  },
  byConversation("email_reply_addresses"),
  byConversation("email_away"),
  del("email_inbound", "conversation_id=ANY($4) OR lower(envelope_from)=ANY($5)"),
  byConversation("channel_messages"),
  byConversation("channel_threads"),
  // Everything kept per conversation.
  byConversation("conversation_attribute_values"),
  byConversation("conversation_cycles"),
  byConversation("conversation_drafts"),
  del("conversation_mentions", "conversation_id=ANY($4) OR part_id=ANY($7)"),
  del("conversation_participants", "conversation_id=ANY($4) OR identity_id=ANY($3)"),
  byConversation("conversation_reads"),
  del("conversation_search_documents", "conversation_id=ANY($4) OR part_id=ANY($7)"),
  byConversation("conversation_tags"),
  byConversation("conversation_unread"),
  del("customer_reads", "conversation_id=ANY($4) OR identity_id=ANY($3)"),
  del("customer_unread_threads", "conversation_id=ANY($4) OR identity_id=ANY($3) OR contact_id=ANY($2)"),
  byConversation("inbox_filter_members"),
  byConversation("inbox_projection_dirty"),
  byConversation("inbox_view_memberships"),
  del("notifications", "conversation_id=ANY($4) OR part_id=ANY($7)"),
  byConversation("sla_clocks"),
  byConversation("broadcast_items"),
  byConversation("bulk_items"),
  del("ticket_links", "conversation_id=ANY($4) OR ticket_id=ANY($4)"),
  del("ticket_broadcasts", "tracker_id=ANY($4)"),
  byConversation("tickets"),
  // Zoe's records of their conversations; her ledger and connector log keep their counts, stripped.
  byConversation("ai_action_approvals"),
  del("ai_content_gaps", `conversation_id=ANY($4) OR review_id IN ${REVIEWS}`),
  del("ai_reviews", `id IN ${REVIEWS}`),
  del("ai_answers", `id IN ${ANSWERS}`),
  byConversation("ai_connector_pins"),
  byConversation("ai_model_calls"),
  byConversation("ai_procedure_runs"),
  {
    table: "ai_resolutions",
    how: "scrub",
    sql: "UPDATE ai_resolutions SET conversation_id=NULL,detail='',answer_ids='{}',reply_part_ids='{}' WHERE workspace_id=$1 AND conversation_id=ANY($4)",
  },
  {
    table: "ai_connector_calls",
    how: "scrub",
    sql: `UPDATE ai_connector_calls SET conversation_id=NULL,inputs='{}',outputs='{}',url=regexp_replace(url,'^(https?://[^/?#]+).*$','\\1'),error=NULL,idempotency_key=NULL
          WHERE workspace_id=$1 AND (conversation_id=ANY($4) OR inputs::text ILIKE ANY($6) OR outputs::text ILIKE ANY($6))`,
  },
  del("knowledge_feedback", "conversation_id=ANY($4) OR identity_id=ANY($3)"),
  byConversation("canvas_sessions"),
  // Calls, workflows and outbound.
  del("voice_inbound", "call_sid IN (SELECT call_sid FROM voice_calls WHERE workspace_id=$1 AND conversation_id=ANY($4)) OR payload::text ILIKE ANY($6)"),
  del("voice_calls", "conversation_id=ANY($4) OR lower(from_phone)=ANY($5) OR lower(to_phone)=ANY($5)"),
  { table: "workflow_alerts", how: "scrub", sql: `UPDATE workflow_alerts SET last_run_id=NULL WHERE workspace_id=$1 AND last_run_id IN ${RUNS}` },
  del("workflow_run_steps", `run_id IN ${RUNS}`),
  del("workflow_runs", `id IN ${RUNS}`),
  del("outbound_entries", "contact_id=ANY($2) OR conversation_id=ANY($4)"),
  del("outbound_contact_locks", "contact_id=ANY($2)"),
  // Files and messages, then the conversations.
  del("attachments", `id IN ${ATTACHMENTS}`),
  del("conversation_parts", "conversation_id=ANY($4) OR id=ANY($7)"),
  byConversation("messages"),
  del("conversation_snapshots", "conversation_id=ANY($4) OR contact_id=ANY($2)"),
  { table: "conversations", how: "scrub", sql: "UPDATE conversations SET merged_into_id=NULL WHERE workspace_id=$1 AND merged_into_id=ANY($4) AND NOT id=ANY($4)" },
  del("conversations", "id=ANY($4)"),
  // Work queued about them, and copies of them sent or received. Someone else's file made by such a job only loses the link.
  { table: "attachments", how: "scrub", sql: `UPDATE attachments SET job_id=NULL WHERE workspace_id=$1 AND job_id IN ${JOBS}` },
  del("job_events", `job_id IN ${JOBS}`),
  del("jobs", `id IN ${JOBS}`),
  del("outbox", "resource_id=ANY($4) OR resource_id=ANY($2) OR payload::text ILIKE ANY($6)"),
  del("webhook_attempts", `delivery_id IN ${WEBHOOK_DELIVERIES}`),
  del("webhook_deliveries", `id IN ${WEBHOOK_DELIVERIES}`),
  del("webhook_events", "resource_id=ANY($4) OR resource_id=ANY($2) OR detail::text ILIKE ANY($6)"),
  del("idempotency_receipts", "key ILIKE ANY($6) OR response::text ILIKE ANY($6)"),
  del("community_inbound", "payload::text ILIKE ANY($6)"),
  del("meta_inbound", "payload::text ILIKE ANY($6)"),
  del("sms_inbound", "payload::text ILIKE ANY($6)"),
  del("whatsapp_inbound", "payload::text ILIKE ANY($6)"),
  del("help_search_queries", "query ILIKE ANY($6)"),
  // The person: their contact records, identities and addresses.
  del("contact_events", "contact_id=ANY($2)"),
  del("contact_subscription_changes", "contact_id=ANY($2)"),
  del("contact_subscriptions", "contact_id=ANY($2)"),
  del("contact_changes", "contact_id=ANY($2)"),
  del("contact_emails", "contact_id=ANY($2)"),
  del("contact_phones", "contact_id=ANY($2)"),
  del("customer_unread_totals", "identity_id=ANY($3) OR contact_id=ANY($2)"),
  del("customer_counters", "identity_id=ANY($3)"),
  del("identity_addresses", "identity_id=ANY($3)"),
  del("messenger_sessions", "identity_id=ANY($3)"),
  del("portal_sessions", "identity_id=ANY($3)"),
  del("portal_handoffs", "identity_id=ANY($3)"),
  del("identity_contact_mappings", "identity_id=ANY($3) OR contact_id=ANY($2)"),
  del("identities", "id=ANY($3)"),
  del("contact_merges", "loser_id=ANY($2) OR survivor_id=ANY($2)"),
  { table: "contacts", how: "scrub", sql: "UPDATE contacts SET merged_into_contact_id=NULL WHERE workspace_id=$1 AND merged_into_contact_id=ANY($2)" },
  del("contacts", "id=ANY($2)"),
  // Opt-outs and consents for their addresses: nothing about them remains.
  del("suppressions", "lower(address)=ANY($5)"),
  del("sms_consents", "lower(phone)=ANY($5)"),
  del("whatsapp_opt_ins", "lower(phone)=ANY($5)"),
  // Earlier exports of them: their zips go with the files (`objectsOf`), and the requests forget them.
  {
    table: "data_requests",
    how: "scrub",
    sql: "UPDATE data_requests SET subject=NULL,label=NULL,export_key=NULL,export_expires_at=NULL WHERE workspace_id=$1 AND kind='export' AND subject->>'contactId'=ANY($2)",
  },
  // The audit log keeps who did what and when; rows about the person lose their target and details.
  {
    table: "audit_events",
    how: "scrub",
    sql: `UPDATE audit_events SET target_id=NULL,target_name=NULL,details='{}' WHERE workspace_id=$1
          AND (target_id=ANY($2) OR target_id=ANY($3) OR target_id=ANY($4) OR target_name ILIKE ANY($6) OR details::text ILIKE ANY($6))`,
  },
];

const CONFIG = "workspace settings and content, not about customers";
const TEAMMATES = "teammates' own accounts and activity, not customers'";
const COUNTS = "counts and timings only, with no one's identity";
/** Tables that hold no customer's data, and why (the test fails on a table that is in neither list). */
export const NO_PERSONAL_DATA: Record<string, string> = {
  ...Object.fromEntries(
    [
      "ai_agent_identities", "ai_agents", "ai_connector_oauth_states", "ai_connector_secrets", "ai_connector_tokens", "ai_connector_versions", "ai_connectors",
      "ai_escalation_rules", "ai_guidance_versions", "ai_monitor_settings", "ai_procedure_versions", "ai_procedures", "ai_specialists", "attribute_definitions",
      "audit_settings", "brand_assets", "brands", "business_calendars", "calendar_assignments", "calendars", "community_connections", "email_domains",
      "email_settings", "event_definitions", "help_centers", "help_node_locales", "help_nodes", "help_placements", "help_redirects", "inbox_filter_sets",
      "inbox_view_folders", "inbox_views", "knowledge_chunk_vectors", "knowledge_chunks", "knowledge_duplicate_dismissals", "knowledge_duplicate_pairs",
      "knowledge_files", "knowledge_locales", "knowledge_records", "knowledge_revisions", "knowledge_search", "knowledge_source_pages", "knowledge_sources",
      "macros", "messenger_drafts", "messenger_versions", "meta_pages", "outbound_messages", "outbound_settings", "outbound_versions", "portal_domains",
      "portal_settings", "role_capabilities", "roles", "security_settings", "segments", "sla_policies", "sms_accounts", "sms_numbers", "sms_prices",
      "sso_connections", "sso_domains", "sso_role_mappings", "subscription_types", "tags", "teams", "ticket_states", "ticket_transitions",
      "ticket_type_attributes", "ticket_types", "voice_agents", "voice_settings", "webhook_subscriptions", "whatsapp_numbers", "whatsapp_templates",
      "workflow_versions", "workflows", "workspace", "workspace_features", "oauth_apps", "retention_settings",
    ].map((t) => [t, CONFIG]),
  ),
  ...Object.fromEntries(
    [
      "teammates", "teammate_credentials", "teammate_sessions", "teammate_invitations", "teammate_presence_changes", "teammate_recovery_codes",
      "teammate_teams", "teammate_two_factor", "teammate_challenges", "sso_identities", "sso_logins", "api_tokens", "oauth_codes", "oauth_grants",
      "oauth_refresh_tokens", "email_alerts", "ai_incidents", "ai_monitor_checks", "ai_monitor_runs", "ai_review_days", "bulk_operations",
    ].map((t) => [t, TEAMMATES]),
  ),
  ...Object.fromEntries(
    [
      "api_usage", "canvas_app_daily", "canvas_calls", "email_send_counts", "identity_failures", "inbox_counters", "knowledge_retrievals",
      "knowledge_duplicate_runs", "knowledge_index_dirty", "knowledge_index_generations", "knowledge_sync_frontier", "knowledge_sync_runs",
      "ai_connector_rate", "outbound_occurrences", "ticket_counters", "workflow_ticks",
    ].map((t) => [t, COUNTS]),
  ),
  identity_keys: "the workspace's identity verification keys (wrapped), not anyone's identity",
  migration_runs: "Relay's own migration bookkeeping",
  relay_schema_migrations: "Relay's own migration bookkeeping",
  storage_migration_state: "Relay's own storage bookkeeping",
};

/** Escaped for LIKE, between wildcards. */
const pattern = (s: string) => "%" + s.replace(/[\\%_]/g, (c) => "\\" + c) + "%";

/** Who a request is about: one contact (by contact id, email, phone or external id) and everything that is theirs. */
export async function findSubject(db: Sql, w: string, ref: { contactId?: string; email?: string; phone?: string; externalId?: string }) {
  const first = (
    await db.query<{ id: string }>(
      `SELECT c.id FROM contacts c WHERE c.workspace_id=$1 AND (
         c.id=$2 OR c.external_id=$5
         OR EXISTS (SELECT 1 FROM contact_emails e WHERE e.workspace_id=c.workspace_id AND e.contact_id=c.id AND lower(e.email)=lower($3))
         OR EXISTS (SELECT 1 FROM contact_phones p WHERE p.workspace_id=c.workspace_id AND p.contact_id=c.id AND p.phone=$4))
       ORDER BY (c.merged_into_contact_id IS NULL) DESC LIMIT 1`,
      [w, ref.contactId ?? "", ref.email ?? "", ref.phone ?? "", ref.externalId ?? ""],
    )
  ).rows[0];
  if (!first) return null;
  // The contact they were merged into (if any), and every contact merged into it.
  const contacts = (
    await db.query<{ id: string }>(
      `WITH RECURSIVE top AS (SELECT id,merged_into_contact_id FROM contacts WHERE workspace_id=$1 AND id=$2
         UNION SELECT c.id,c.merged_into_contact_id FROM contacts c JOIN top ON c.workspace_id=$1 AND c.id=top.merged_into_contact_id),
       root AS (SELECT id FROM top WHERE merged_into_contact_id IS NULL UNION SELECT $2 WHERE NOT EXISTS (SELECT 1 FROM top WHERE merged_into_contact_id IS NULL)),
       tree AS (SELECT id FROM root UNION SELECT c.id FROM contacts c JOIN tree ON c.workspace_id=$1 AND c.merged_into_contact_id=tree.id)
       SELECT id FROM tree UNION SELECT loser_id FROM contact_merges WHERE workspace_id=$1 AND survivor_id IN (SELECT id FROM tree)`,
      [w, first.id],
    )
  ).rows.map((r) => r.id);
  const identities = (await db.query<{ id: string }>("SELECT DISTINCT identity_id AS id FROM identity_contact_mappings WHERE workspace_id=$1 AND contact_id=ANY($2)", [w, contacts])).rows.map((r) => r.id);
  const conversations = (await db.query<{ id: string }>("SELECT id FROM conversations WHERE workspace_id=$1 AND primary_identity_id=ANY($2)", [w, identities])).rows.map((r) => r.id);
  const others = (
    await db.query<{ id: string }>("SELECT DISTINCT conversation_id AS id FROM conversation_participants WHERE workspace_id=$1 AND identity_id=ANY($2) AND NOT conversation_id=ANY($3)", [w, identities, conversations])
  ).rows.map((r) => r.id);
  const parts = (
    await db.query<{ id: string }>("SELECT id FROM conversation_parts WHERE workspace_id=$1 AND conversation_id=ANY($2) AND author_type='contact' AND (author_id=ANY($3) OR author_id=ANY($4))", [
      w,
      others,
      identities,
      contacts,
    ])
  ).rows.map((r) => r.id);
  const addresses = (
    await db.query<{ a: string }>(
      `SELECT DISTINCT lower(a) AS a FROM (
         SELECT email AS a FROM contact_emails WHERE workspace_id=$1 AND contact_id=ANY($2)
         UNION SELECT phone FROM contact_phones WHERE workspace_id=$1 AND contact_id=ANY($2)
         UNION SELECT address FROM identity_addresses WHERE workspace_id=$1 AND identity_id=ANY($3)
         UNION SELECT email FROM conversations WHERE workspace_id=$1 AND id=ANY($4) AND email IS NOT NULL AND email<>'') x WHERE a IS NOT NULL AND a<>''`,
      [w, contacts, identities, conversations],
    )
  ).rows.map((r) => r.a);
  const externalIds = (await db.query<{ e: string }>("SELECT DISTINCT external_id AS e FROM contacts WHERE workspace_id=$1 AND id=ANY($2) AND external_id IS NOT NULL AND external_id<>''", [w, contacts])).rows.map(
    (r) => r.e,
  );
  return { contacts, identities, conversations, others, parts, addresses, externalIds } satisfies Subject;
}

/** What names them, as LIKE patterns: addresses, external ids, and their contact, identity, conversation and message ids. */
export const needles = (s: Subject) =>
  [...new Set([...s.addresses, ...s.externalIds, ...s.contacts, ...s.identities, ...s.conversations, ...s.parts])].filter((x) => x.length >= 4).map(pattern);

/** The storage keys their files live under (read before the rows go). */
export async function objectsOf(db: Sql, w: string, s: Subject) {
  const files = (
    await db.query<{ object_key: string | null; clean_key: string | null; preview_key: string | null }>(
      "SELECT object_key,clean_key,preview_key FROM attachments WHERE workspace_id=$1 AND (conversation_id=ANY($2) OR owner_identity_id=ANY($3))",
      [w, s.conversations, s.identities],
    )
  ).rows;
  const raw = (await db.query<{ raw_key: string | null }>("SELECT raw_key FROM email_inbound WHERE workspace_id=$1 AND (conversation_id=ANY($2) OR lower(envelope_from)=ANY($3))", [w, s.conversations, s.addresses]))
    .rows;
  const exports = (
    await db.query<{ export_key: string | null }>("SELECT export_key FROM data_requests WHERE workspace_id=$1 AND kind='export' AND subject->>'contactId'=ANY($2) AND export_key IS NOT NULL", [w, s.contacts])
  ).rows;
  return {
    quarantine: [...files.map((f) => f.object_key), ...raw.map((r) => r.raw_key)].filter((k): k is string => !!k),
    clean: [...files.flatMap((f) => [f.clean_key, f.preview_key]), ...exports.map((e) => e.export_key)].filter((k): k is string => !!k),
  };
}

/** The cascade, in the caller's transaction; returns rows per table. Sets `relay.erasure` for this transaction only. */
export async function erase(db: Sql, w: string, s: Subject) {
  await db.query("SELECT set_config('relay.erasure','on',true)");
  const values = [w, s.contacts, s.identities, s.conversations, s.addresses, needles(s), s.parts, s.others];
  const counts: Record<string, number> = {};
  for (const step of ERASURE) {
    const sql = step.sql;
    const used = [...new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
    // Each statement gets only the parameters it uses, renumbered (PostgreSQL refuses unused ones' types).
    const map = new Map(used.map((n, i) => [n, i + 1]));
    const r = await db.query(sql.replace(/\$(\d+)/g, (_, n) => "$" + map.get(Number(n))) + " RETURNING 1", used.map((n) => values[n - 1]));
    const key = step.how === "scrub" ? `${step.table} (scrubbed)` : step.table;
    if (r.rows.length) counts[key] = (counts[key] ?? 0) + r.rows.length;
  }
  await db.query("SELECT set_config('relay.erasure','off',true)");
  return counts;
}

import { tenant, type Connect, type Sql } from "./db";
import { getIdentity } from "./people";
import { command } from "./conversations";
import { assetId, assetsIn } from "./brand-assets";
import { themeFiles, themeOf } from "../lib/help-theme";
import type { AttachmentStorage } from "./attachments";
import { cleanKeyIn, copyBytes, readUploads, writeUpload, type Upload } from "./uploads";

/**
 * What a test workspace is made of (docs/TEST_WORKSPACE_PLAN.md, T1b): the configuration its
 * production workspace set up, copied in when the pair is made, and made-up customers to work
 * with.
 *
 * Every table in the schema is either in `COPIED` or in `NOT_COPIED` with the reason;
 * `tests/test-workspace.test.ts` fails on a table in neither, so a new table is a decision
 * somebody makes rather than something that quietly isn't there.
 *
 * Two rules the copy keeps:
 *
 * - **The order is the foreign keys' order.** A table goes in after whatever it points at, which
 *   is why `business_calendars` comes before `calendars` and a version table before its owner.
 * - **Nothing is copied by SQL across tenants.** Row-level security means the source rows are
 *   invisible from the other side, so every table is read in one transaction and written in the
 *   other. A cross-tenant `INSERT … SELECT` would silently copy nothing.
 * - **The images come with the bytes.** An image a copied setting names is copied into the test
 *   workspace with its id and its bytes (`copyUploads`), under a key of its own.
 * - **No secret and no connection comes with it.** A test workspace holds no keys, no tokens, no
 *   provider accounts and no domains of its own: it cannot reach anyone, so it needs none of them.
 */
export const COPIED: { table: string; why?: string; uploads?: true }[] = [
  // The workspace itself, its people and what they may do (T1a makes these with the pair).
  { table: "workspace" },
  { table: "workspace_features", why: "the same features are on, so a test means something" },
  { table: "workspace_plans", why: "the same plan: the same limits and gates" },
  { table: "brands", why: "without one there is nowhere for a conversation to belong" },
  { table: "roles" },
  { table: "role_capabilities" },
  { table: "teammates", why: "the same people, with the same roles; they sign in once" },
  // How work is organised.
  { table: "teams" },
  { table: "teammate_teams" },
  // A calendar points at the version it publishes, so the versions go in first.
  { table: "business_calendars" },
  { table: "calendars" },
  { table: "calendar_assignments" },
  { table: "sla_policies" },
  // An attribute is defined before a ticket type can ask for it.
  { table: "attribute_definitions" },
  { table: "ticket_types" },
  { table: "ticket_states" },
  { table: "ticket_transitions" },
  { table: "ticket_type_attributes" },
  { table: "tags" },
  { table: "macros" },
  // Automation, and what it is allowed to do.
  { table: "workflows" },
  { table: "workflow_versions" },
  { table: "event_definitions" },
  { table: "segments" },
  { table: "subscription_types" },
  { table: "outbound_settings" },
  // Zoe: who she is, how she answers, and what she may use. Her connectors come without their
  // secrets, so a test run asks nobody's system until a key is put in here.
  { table: "ai_agents" },
  { table: "ai_agent_identities" },
  { table: "ai_specialists" },
  { table: "ai_escalation_rules" },
  { table: "ai_guidance_versions" },
  { table: "ai_monitor_settings" },
  { table: "ai_connectors" },
  { table: "ai_connector_versions" },
  { table: "ai_procedures" },
  { table: "ai_procedure_versions" },
  // What customers read, and what Zoe answers from.
  { table: "knowledge_records" },
  { table: "knowledge_locales" },
  { table: "help_centers" },
  { table: "help_nodes" },
  { table: "help_node_locales" },
  { table: "help_placements" },
  // The messenger and the portal as they are live.
  { table: "messenger_versions" },
  { table: "portal_settings" },
  // Security and data settings: what is configured keeps applying, here as there.
  { table: "security_settings" },
  { table: "retention_settings" },
  { table: "redaction_rules" },
  { table: "link_policies" },
  { table: "audit_settings" },
  // T2b: the images the configuration above refers to, brought by `copyUploads` rather than by
  // the column copy — bytes have to be copied too, and each workspace keys its own.
  { table: "brand_assets", uploads: true, why: "the messenger's images and Zoe's avatars, as the copied settings name them" },
  { table: "knowledge_files", uploads: true, why: "a help centre's theme images and the images in copied articles" },
];

const CUSTOMERS = "a test workspace has made-up customers of its own, never the real ones";
const RUNTIME = "what the workspace is doing, not how it is set up";
const LEDGER = "a record of what happened in production, which never happened here";
const SECRET = "a key, token or account a test workspace is deliberately without";
const REACHES = "a connection to a provider, which a test workspace must never have";
const SIGN_IN = "sign-in belongs to the production workspace: one sign-in, used in both";
const BILLING = "a test workspace is never billed";
const PAIR = "the production workspace's record of the pair, kept and read only on its side";
/** Tables a test workspace starts without, and why (the test fails on a table in neither list). */
export const NOT_COPIED: Record<string, string> = {
  ...Object.fromEntries(
    [
      "contacts", "contact_changes", "contact_emails", "contact_phones", "contact_events", "contact_merges",
      "contact_subscriptions", "contact_subscription_changes", "identities", "identity_addresses",
      "identity_contact_mappings", "conversations", "conversation_parts", "conversation_part_images",
      "conversation_part_delivery_events", "conversation_participants", "conversation_reads", "conversation_tags",
      "conversation_attribute_values", "conversation_cycles", "conversation_drafts", "conversation_mentions",
      "conversation_search_documents", "conversation_snapshots", "conversation_unread", "customer_reads",
      "customer_counters", "customer_unread_threads", "customer_unread_totals", "messages", "attachments",
      "side_conversations", "side_messages", "tickets", "ticket_links", "ticket_broadcasts", "broadcast_items",
      "sla_clocks", "knowledge_feedback", "knowledge_retrievals", "help_search_queries", "part_links",
      "suppressions", "notifications", "messenger_sessions", "portal_sessions", "portal_handoffs",
    ].map((t) => [t, CUSTOMERS]),
  ),
  ...Object.fromEntries(
    [
      "jobs", "job_events", "outbox", "idempotency_receipts", "inbox_counters", "inbox_filter_sets",
      "inbox_filter_members", "inbox_projection_dirty", "inbox_views", "inbox_view_folders",
      "inbox_view_memberships", "ticket_counters", "workflow_runs", "workflow_run_steps", "workflow_ticks",
      "workflow_alerts", "outbound_messages", "outbound_versions", "outbound_entries", "outbound_occurrences",
      "outbound_contact_locks", "bulk_operations", "bulk_items", "knowledge_index_dirty",
      "knowledge_index_generations", "knowledge_chunks", "knowledge_chunk_vectors", "knowledge_search",
      "knowledge_revisions", "knowledge_duplicate_runs", "knowledge_duplicate_pairs",
      "knowledge_duplicate_dismissals", "knowledge_sync_runs", "knowledge_sync_frontier", "knowledge_source_pages",
      "help_redirects", "messenger_drafts", "ai_answers", "ai_resolutions", "ai_model_calls",
      "ai_reviews", "ai_review_days", "ai_content_gaps", "ai_incidents", "ai_monitor_runs", "ai_monitor_checks",
      "ai_procedure_runs", "ai_action_approvals", "ai_connector_calls", "ai_connector_rate", "ai_connector_pins",
      "api_usage", "canvas_sessions", "canvas_calls", "canvas_app_daily", "webhook_events", "webhook_deliveries",
      "webhook_attempts", "email_send_counts", "email_away", "relay_schema_migrations", "migration_runs",
      "storage_migration_state", "test_deliveries", "data_requests",
    ].map((t) => [t, RUNTIME]),
  ),
  // T2a: the two sides of promoting a change back, both production's own (server/promote.ts).
  test_baselines: PAIR,
  promotions: PAIR,
  // T3a: an app's versions stay with the workspace that registered it; its test pair is the app's
  // sandbox and installs it from there, so a copy would be a second app nobody registered.
  oauth_app_versions: "an app belongs to the workspace that registered it; the test pair installs it from there",
  // T3b: the directory is a tenant of its own, never any workspace's, so there is nothing to copy.
  ...Object.fromEntries(["app_submissions", "app_listings", "app_suspensions"].map((t) => [t, "the app directory's own tenant, never a workspace's"])),
  ...Object.fromEntries(
    [
      "audit_events", "seat_changes", "plan_changes", "teammate_presence_changes", "identity_failures",
      "contact_subscription_changes_placeholder",
    ]
      .filter((t) => t !== "contact_subscription_changes_placeholder")
      .map((t) => [t, LEDGER]),
  ),
  ...Object.fromEntries(
    [
      "ai_providers", "ai_connector_secrets", "ai_connector_tokens", "ai_connector_oauth_states", "api_tokens",
      "oauth_apps", "oauth_codes", "oauth_grants", "oauth_refresh_tokens", "identity_keys", "webhook_subscriptions",
    ].map((t) => [t, SECRET]),
  ),
  ...Object.fromEntries(
    [
      "email_settings", "email_domains", "email_reply_addresses", "email_messages", "email_inbound", "email_events",
      "email_alerts", "whatsapp_numbers", "whatsapp_templates", "whatsapp_opt_ins", "whatsapp_inbound",
      "sms_accounts", "sms_numbers", "sms_prices", "sms_consents", "sms_inbound", "meta_pages", "meta_inbound",
      "voice_settings", "voice_agents", "voice_calls", "voice_inbound", "community_connections", "community_inbound",
      "channel_deliveries", "channel_messages", "channel_threads", "portal_domains",
      // Website sync fetches a real site on a schedule; a test workspace crawls nothing.
      "knowledge_sources",
    ].map((t) => [t, REACHES]),
  ),
  ...Object.fromEntries(
    [
      "teammate_credentials", "teammate_sessions", "teammate_invitations", "teammate_two_factor",
      "teammate_recovery_codes", "teammate_challenges", "sso_connections", "sso_domains", "sso_identities",
      "sso_logins", "sso_role_mappings", "support_grants", "support_logins", "support_sessions",
    ].map((t) => [t, SIGN_IN]),
  ),
  ...Object.fromEntries(
    ["invoices", "invoice_lines", "invoice_line_units", "billing_profiles", "billing_customers", "billing_alerts", "payment_events", "usage_limits", "usage_settings", "usage_alerts"].map((t) => [
      t,
      BILLING,
    ]),
  ),
};

/** The columns the database fills itself, which an insert must leave alone. */
async function copyableColumns(db: Sql, table: string) {
  const rows = (
    await db.query<{ column_name: string; is_generated: string; is_identity: string; identity_generation: string | null }>(
      `SELECT column_name,is_generated,is_identity,identity_generation FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
      [table],
    )
  ).rows;
  return rows
    .filter((c) => c.is_generated !== "ALWAYS" && !(c.is_identity === "YES" && c.identity_generation === "ALWAYS"))
    .map((c) => c.column_name);
}

const BATCH = 200;
/**
 * Copies the configuration of `from` into `to`, in the order the foreign keys need. Each table is
 * read in its own workspace's transaction and written in the other's — never both at once.
 */
export async function copyConfiguration(connect: Connect, from: string, to: string, only?: string[]) {
  const copied: Record<string, number> = {};
  for (const { table, uploads } of COPIED) {
    // The workspace row and the few T1a makes are already there.
    if (only && !only.includes(table)) continue;
    // The uploads come with their bytes, through `copyUploads`.
    if (uploads) continue;
    const columns = await tenant(connect, from, (db) => copyableColumns(db, table));
    const rows = await tenant(connect, from, async (db) =>
      (await db.query<Record<string, unknown>>(`SELECT ${columns.map((c) => `"${c}"`).join(",")} FROM "${table}" WHERE workspace_id=$1`, [from])).rows,
    );
    if (!rows.length) continue;
    await tenant(connect, to, async (db) => {
      for (let i = 0; i < rows.length; i += BATCH) {
        const chunk = rows.slice(i, i + BATCH);
        const values: unknown[] = [];
        const tuples = chunk.map(
          (row) =>
            "(" +
            columns
              .map((c) => {
                values.push(c === "workspace_id" ? to : row[c]);
                return "$" + values.length;
              })
              .join(",") +
            ")",
        );
        await db.query(
          `INSERT INTO "${table}"(${columns.map((c) => `"${c}"`).join(",")}) VALUES${tuples.join(",")} ON CONFLICT DO NOTHING`,
          values,
        );
      }
    });
    copied[table] = rows.length;
  }
  return copied;
}

/**
 * The images the copied configuration refers to (T2b, docs/TEST_WORKSPACE_STEP4.md): the
 * messenger's own images and Zoe's avatars (`brand_assets`), and a help centre's theme and
 * homepage images and the images inside copied articles (`knowledge_files`).
 *
 * Every id is kept, exactly as the rest of the copy keeps ids, so the copied settings still name
 * their images. Only the stored object is new: each workspace keys its own, and the bytes are
 * copied into the test workspace's key, so neither side can take the other's image away.
 *
 * An image whose bytes cannot be read — a deployment without storage, or an object already tidied
 * away — is left out rather than written as a row pointing at nothing.
 */
export async function copyUploads(connect: Connect, from: string, to: string, storage: AttachmentStorage | undefined, by: string) {
  const uploads = await tenant(connect, from, async (db) => {
    // What the copied settings name: the live messenger of each brand, every published version
    // (an earlier one can be restored in the test workspace too) and Zoe's identities.
    const assets = new Set<string>();
    for (const r of (
      await db.query<{ config: Record<string, unknown> }>(
        `SELECT settings AS config FROM brands WHERE workspace_id=$1
         UNION ALL SELECT config FROM messenger_versions WHERE workspace_id=$1`,
        [from],
      )
    ).rows)
      for (const id of assetsIn(r.config)) assets.add(id);
    for (const r of (
      await db.query<{ avatar: string | null; avatar_dark: string | null }>("SELECT avatar,avatar_dark FROM ai_agent_identities WHERE workspace_id=$1", [from])
    ).rows)
      for (const v of [r.avatar, r.avatar_dark]) {
        const id = assetId(v);
        if (id) assets.add(id);
      }
    const files = new Set<string>();
    for (const c of (
      await db.query<{ theme: Record<string, unknown>; layout: unknown[] }>("SELECT theme,layout FROM help_centers WHERE workspace_id=$1", [from])
    ).rows)
      for (const f of themeFiles(themeOf(c.theme), c.layout as Parameters<typeof themeFiles>[1])) files.add(f.id);
    // An article's images are named inside its body, which is copied with it.
    for (const r of (await db.query<{ id: string }>("SELECT id FROM knowledge_files WHERE workspace_id=$1 AND purpose='article_image'", [from])).rows)
      files.add(r.id);
    return [...(await readUploads(db, from, "brand_assets", [...assets])), ...(await readUploads(db, from, "knowledge_files", [...files]))];
  });
  // The bytes, outside both transactions: a stored object nothing points at is harmless, a row
  // pointing at bytes that aren't there is not.
  const brought: Upload[] = [];
  for (const u of uploads) if (await copyBytes(storage, u, cleanKeyIn(u.table, to, u.id, u.checksum))) brought.push(u);
  if (brought.length)
    await tenant(connect, to, async (db) => {
      for (const u of brought)
        await writeUpload(db, to, u, { id: u.id, cleanKey: cleanKeyIn(u.table, to, u.id, u.checksum), by: u.uploadedBy ?? by });
    });
  return brought.length;
}

/**
 * The made-up customers a test workspace starts with: a few people and the conversations they
 * began, written through the same `command` the messenger uses, so they are ordinary
 * conversations in every way — except that nobody is on the other end.
 *
 * Their addresses are at `example.invalid`, a name reserved so it can never be delivered to, and
 * their names say what they are.
 */
export const SAMPLE_PEOPLE = [
  { id: "sample-ada", name: "Ada (made up)", email: "ada@example.invalid", says: "Hello! How do I change my plan?" },
  { id: "sample-bo", name: "Bo (made up)", email: "bo@example.invalid", says: "My invoice looks wrong this month." },
  { id: "sample-cleo", name: "Cleo (made up)", email: "cleo@example.invalid", says: "Can you help me set up single sign-on?" },
];

export async function seedSampleCustomers(connect: Connect, w: string, brandId: string) {
  const started: string[] = [];
  for (const person of SAMPLE_PEOPLE) {
    const r = await tenant(connect, w, async (db) => {
      const who = await getIdentity(db, w, "user", person.id, { name: person.name, email: person.email });
      return (await command(
        db,
        w,
        { type: "contact", identityId: who.identityId, brandId },
        crypto.randomUUID(),
        { action: "start", text: person.says } as unknown as Parameters<typeof command>[4],
      )) as { conversationId: string };
    });
    started.push(r.conversationId);
  }
  return started;
}

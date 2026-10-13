import { assert, DomainError, type Sql } from "./db";
import { authorize } from "./policy";
import { buildFacts, evaluate, workflowsEnabled, type FactSources } from "./workflow-engine";
import { DefinitionError, FIELDS, validate, type Field, type Group } from "../lib/workflow-definition";
import type { Conversation } from "./conversations";

/**
 * The builder's live estimate (phase 11, step W2; docs/WORKFLOWS_STEP2.md): of the workspace's
 * latest conversations (at most `SAMPLE`, from the last 30 days), how many "who it runs for"
 * would let through. Each is judged by the engine's own `evaluate` on the same facts a run would
 * see, read in one query. What depends on the moment a run starts (the triggering message, office
 * hours, a team's availability, who made the change, a wait) can't be judged after the fact: those
 * conditions are taken to hold and named, so the figure is then at most.
 */
export const SAMPLE = 500;
export const DAYS = 30;
const MOMENT: Field[] = ["message.text", "office_hours", "team.available", "change.by", "wait.timed_out", "page.url", "trigger.data"];

type Row = Conversation & {
  ai_state: string | null;
  sla_breached: boolean;
  sla_overdue: boolean;
  channel: string;
  tags: string[];
  role: string | null;
  profile: Record<string, unknown> | null;
  kind: string | null;
  emails: string[];
  latest: string | null;
  locale: string | null;
};

export async function estimateWorkflow(db: Sql, w: string, principal: string, raw: string) {
  await authorize(db, w, principal, "workspace.manage");
  assert(await workflowsEnabled(db, w), "WORKFLOWS_DISABLED", "Workflows are not enabled for this workspace.", 404);
  let when: Group;
  try {
    const parsed: unknown = JSON.parse(raw || '{"match":"all","items":[]}');
    when = validate({ trigger: { type: "manual" }, when: parsed, paths: [{ id: "A", steps: [], next: { type: "end" } }] }).when;
  } catch (e) {
    if (e instanceof DefinitionError) throw new DomainError("INVALID_WORKFLOW", e.message, 400);
    throw new DomainError("INVALID_WORKFLOW", "The conditions couldn't be read.", 400);
  }
  const rows = (
    await db.query<Row>(
      `SELECT c.*,
         COALESCE((SELECT array_agg(t.tag_id) FROM conversation_tags t WHERE t.workspace_id=c.workspace_id AND t.conversation_id=c.id),'{}') AS tags,
         k.role,k.profile,i.kind,
         COALESCE((SELECT array_agg(e.email) FROM contact_emails e WHERE e.workspace_id=k.workspace_id AND e.contact_id=k.id AND e.verified),'{}') AS emails,
         (SELECT p.body FROM conversation_parts p WHERE p.workspace_id=c.workspace_id AND p.conversation_id=c.id AND p.kind='customer_message'
          ORDER BY p.seq DESC LIMIT 1) AS latest,
         b.settings->>'locale' AS locale
       FROM conversations c
       LEFT JOIN identities i ON i.workspace_id=c.workspace_id AND i.id=c.primary_identity_id
       LEFT JOIN LATERAL (SELECT m.contact_id FROM identity_contact_mappings m WHERE m.workspace_id=c.workspace_id AND m.identity_id=c.primary_identity_id LIMIT 1) m ON true
       LEFT JOIN contacts k ON k.workspace_id=c.workspace_id AND k.id=m.contact_id
       LEFT JOIN brands b ON b.workspace_id=c.workspace_id AND b.id=c.brand_id
       WHERE c.workspace_id=$1 AND c.merged_into_id IS NULL AND c.visibility='customer' AND c.created_at>now()-make_interval(days=>$2)
       ORDER BY c.created_at DESC,c.id DESC LIMIT $3`,
      [w, DAYS, SAMPLE],
    )
  ).rows;
  const used = new Set<string>();
  const walk = (g: Group) => g.items.forEach((x) => ("items" in x ? walk(x) : used.add(x.field)));
  walk(when);
  const assumed = MOMENT.filter((f) => used.has(f));
  let matched = 0;
  for (const r of rows) {
    const sources: FactSources = {
      conversation: r,
      tags: r.tags,
      contact: { role: r.role, profile: r.profile, kind: r.kind },
      emails: r.emails,
      latest: r.latest ?? "",
      brandLocale: r.locale ?? "en",
      message: "",
      officeHours: "open",
      source: "customer",
      timedOut: false,
    };
    if ((await evaluate(db, w, when, buildFacts(sources), new Set(assumed))).result) matched++;
  }
  return {
    sample: rows.length,
    matched,
    days: DAYS,
    limit: SAMPLE,
    /** Conditions taken to hold, by label: the figure is at most. */
    assumed: assumed.map((f) => FIELDS[f].label),
  };
}

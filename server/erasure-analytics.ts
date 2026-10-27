import { tenant } from "./db";
import type { AnalyticsStore } from "./analytics";

/**
 * Erasing one person from the analytical store (phase 16, step C5b; docs/SECURITY_STEP8.md). As
 * agreed, reports keep their counts and lose the person: each of their conversations takes a new
 * random id in every table at once (so a report's joins still hold), their contacts' ids are
 * replaced the same way, and their profiles, contact links and authorship are cleared. Nothing
 * leads back to them, and past reports don't change.
 *
 * Every table in `db/analytics` is a step here or in `ANALYTICS_NO_PERSONAL_DATA` with why
 * (`tests/erasure.test.ts` fails otherwise). It runs in one transaction on the analytical store,
 * after PostgreSQL's, from the ids the deletion kept; run again, it finds nothing left to change.
 *
 * Parameters: $1 workspace, $2 old conversation ids, $3 their new ids (same order), $4 old contact
 * ids, $5 their new ids, $6 their identity ids (authors of their messages).
 */
export type AnalyticsStep = { table: string; sql: string };
const REKEY = (table: string, extra = ""): AnalyticsStep => ({
  table,
  sql: `UPDATE ${table} t SET conversation_id=m.new${extra} FROM unnest($2::text[],$3::text[]) AS m(old,new) WHERE t.workspace_id=$1 AND t.conversation_id=m.old`,
});

export const ANALYTICS_ERASURE: AnalyticsStep[] = [
  REKEY("a_conversations"),
  // Their messages: who wrote them goes; the counts of who-wrote-what stay.
  {
    table: "a_parts",
    sql: `UPDATE a_parts t SET conversation_id=m.new,author_id=CASE WHEN t.author_type='contact' THEN 'erased' ELSE t.author_id END
          FROM unnest($2::text[],$3::text[]) AS m(old,new) WHERE t.workspace_id=$1 AND t.conversation_id=m.old`,
  },
  { table: "a_parts", sql: "UPDATE a_parts SET author_id='erased' WHERE workspace_id=$1 AND author_type='contact' AND author_id=ANY($6)" },
  REKEY("a_snapshots", ",contact_id=NULL,profile='{}'"),
  REKEY("a_states"),
  REKEY("a_responses"),
  REKEY("a_handling"),
  REKEY("a_sla"),
  REKEY("a_tickets"),
  REKEY("a_ai_answers"),
  REKEY("a_ai_resolutions"),
  REKEY("a_calls"),
  REKEY("a_deliveries"),
  // Their profile's history: still counted (by role, by when), under a new id, with nothing in it.
  {
    table: "a_contact_changes",
    sql: `UPDATE a_contact_changes t SET contact_id=m.new,profile='{}' FROM unnest($4::text[],$5::text[]) AS m(old,new) WHERE t.workspace_id=$1 AND t.contact_id=m.old`,
  },
];

export const ANALYTICS_NO_PERSONAL_DATA: Record<string, string> = {
  a_outbound: "outbound entries by their own id, message and variant: no contact or conversation",
  a_searches: "help center searches: a count of results and whether one was opened, no query or person",
  a_feedback: "article feedback: helpful or not, with no person",
  a_teammates: "teammates, not customers",
  a_presence_changes: "teammates' presence, not customers'",
  a_calendars: "office hours",
  a_projection: "the store's own bookkeeping",
  a_sources: "the store's own bookkeeping",
  relay_schema_migrations: "the store's own bookkeeping",
};

/** The analytical store's part of a deletion; rows changed per table. */
export async function eraseAnalytics(store: AnalyticsStore, w: string, ids: { conversations: string[]; contacts: string[]; identities: string[] }) {
  const fresh = (n: number) => Array.from({ length: n }, () => crypto.randomUUID());
  const values = [w, ids.conversations, fresh(ids.conversations.length), ids.contacts, fresh(ids.contacts.length), ids.identities];
  return tenant(store.connect, w, async (db) => {
    const counts: Record<string, number> = {};
    for (const step of ANALYTICS_ERASURE) {
      const used = [...new Set([...step.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
      const map = new Map(used.map((n, i) => [n, i + 1]));
      const r = await db.query(step.sql.replace(/\$(\d+)/g, (_, n) => "$" + map.get(Number(n))) + " RETURNING 1", used.map((n) => values[n - 1]));
      if (r.rows.length) counts[step.table] = (counts[step.table] ?? 0) + r.rows.length;
    }
    return counts;
  });
}

import { assert, tenant, type Sql, type Connect } from "./db";
import type { Job } from "./jobs";
export async function searchConversations(
  db: Sql,
  w: string,
  query: URLSearchParams,
) {
  const text = query.get("q") ?? "";
  assert(
    text.length >= 1 && text.length <= 300,
    "INVALID_SEARCH",
    "Enter between 1 and 300 characters.",
  );
  const values: unknown[] = [w, text];
  const where = [
    "c.workspace_id=$1",
    "c.merged_into_id IS NULL",
    "d.document @@ websearch_to_tsquery('simple',$2)",
  ];
  const param = (value: unknown) => {
    values.push(value);
    return "$" + values.length;
  };
  for (const [key, column] of [
    ["state", "status"],
    ["channel", "channel"],
    ["assignee", "assigned"],
    ["team", "team_id"],
  ] as const) {
    const value = query.get(key);
    if (value) where.push(`c.${column}=${param(value)}`);
  }
  if (query.get("tag"))
    where.push(
      `EXISTS(SELECT 1 FROM conversation_tags t WHERE t.workspace_id=$1 AND t.conversation_id=c.id AND t.tag_id=${param(query.get("tag"))})`,
    );
  if (query.get("contact"))
    where.push(
      `EXISTS(SELECT 1 FROM identity_contact_mappings m WHERE m.workspace_id=$1 AND m.identity_id=c.primary_identity_id AND m.contact_id=${param(query.get("contact"))})`,
    );
  for (const [key, op] of [
    ["from", ">="],
    ["to", "<="],
  ] as const) {
    const value = query.get(key);
    if (value) {
      assert(
        Number.isFinite(Date.parse(value)),
        "INVALID_DATE",
        "Use an ISO date range.",
      );
      where.push(`d.created_at ${op} ${param(value)}::timestamptz`);
    }
  }
  // Resolve merged source documents through their aliases before filtering the canonical conversation.
  const sql = `WITH RECURSIVE documents AS MATERIALIZED (
 SELECT d.*,p.created_at FROM conversation_search_documents d JOIN conversation_parts p ON p.workspace_id=d.workspace_id AND p.id=d.part_id
 WHERE d.workspace_id=$1 AND d.document @@ websearch_to_tsquery('simple',$2)
 ), aliases AS (
 SELECT id AS original,id,merged_into_id FROM conversations WHERE workspace_id=$1 AND id IN(SELECT conversation_id FROM documents)
 UNION ALL SELECT a.original,c.id,c.merged_into_id FROM aliases a JOIN conversations c ON c.workspace_id=$1 AND c.id=a.merged_into_id WHERE a.merged_into_id IS NOT NULL)
 SELECT c.id,c.title,c.status,c.channel,c.assigned,c.team_id,c.updated_at,max(ts_rank_cd(d.document,websearch_to_tsquery('simple',$2))) AS rank FROM documents d JOIN aliases a ON a.original=d.conversation_id AND a.merged_into_id IS NULL JOIN conversations c ON c.workspace_id=$1 AND c.id=a.id WHERE ${where.join(" AND ")} GROUP BY c.workspace_id,c.id ORDER BY rank DESC,c.updated_at DESC,c.id LIMIT 51`;
  const rows = (await db.query(sql, values)).rows;
  return { conversations: rows.slice(0, 50), hasMore: rows.length > 50 };
}
export async function reindexSearch(connect: Connect, job: Job) {
  return tenant(connect, job.workspace_id, async (db) => {
    const checkpoint = job.result ?? {},
      rows = (
        await db.query<{
          id: string;
          conversation_id: string;
          seq: string;
          audience: string;
          body: string;
        }>(
          `SELECT p.id,p.conversation_id,p.seq,p.audience,p.body FROM conversation_parts p WHERE p.workspace_id=$1 AND (p.conversation_id,p.seq)>($2,$3::bigint) ORDER BY p.conversation_id,p.seq LIMIT 100`,
          [
            job.workspace_id,
            checkpoint.conversationId ?? "",
            checkpoint.seq ?? "0",
          ],
        )
      ).rows;
    for (const p of rows) {
      const obsolete = (
        await db.query(
          "SELECT id FROM conversation_parts WHERE workspace_id=$1 AND supersedes_id=$2",
          [job.workspace_id, p.id],
        )
      ).rows.length;
      if (obsolete || !p.body) {
        await db.query(
          "DELETE FROM conversation_search_documents WHERE workspace_id=$1 AND part_id=$2",
          [job.workspace_id, p.id],
        );
        continue;
      }
      await db.query(
        "INSERT INTO conversation_search_documents(workspace_id,conversation_id,part_id,audience,document,revision) VALUES($1,$2,$3,$4,to_tsvector('simple',$5),$6) ON CONFLICT(workspace_id,part_id) DO UPDATE SET document=EXCLUDED.document,revision=EXCLUDED.revision WHERE conversation_search_documents.revision<=EXCLUDED.revision",
        [job.workspace_id, p.conversation_id, p.id, p.audience, p.body, p.seq],
      );
    }
    const last = rows.at(-1);
    return {
      done: rows.length < 100,
      result: {
        conversationId:
          last?.conversation_id ?? checkpoint.conversationId ?? "",
        seq: String(last?.seq ?? checkpoint.seq ?? 0),
        scanned: Number(checkpoint.scanned ?? 0) + rows.length,
      },
    };
  });
}

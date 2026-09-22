import { assert, tenant, type Connect, type Sql } from "./db";
import type { Job } from "./jobs";
/** Only the small customer read model is serialized, never ephemeral signals or parts. */
async function lockProjection(db: Sql, w: string) {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    w + ":customer-unread",
  ]);
}

export async function customerAudience(
  db: Sql,
  w: string,
  identity: string,
  verified: boolean,
) {
  if (!verified) return { type: "identity", id: identity };
  const row = (
    await db.query<{ id: string }>(
      `WITH RECURSIVE chain AS (
  SELECT contact_id AS id,0 AS depth FROM identity_contact_mappings WHERE workspace_id=$1 AND identity_id=$2
  UNION ALL SELECT c.merged_into_contact_id,chain.depth+1 FROM contacts c JOIN chain ON c.id=chain.id
  WHERE c.workspace_id=$1 AND c.merged_into_contact_id IS NOT NULL AND chain.depth<32
 ) SELECT chain.id FROM chain JOIN contacts c ON c.workspace_id=$1 AND c.id=chain.id WHERE c.merged_into_contact_id IS NULL`,
      [w, identity],
    )
  ).rows[0];
  assert(row, "IDENTITY_NOT_FOUND", "Identity unavailable.", 404);
  return { type: "contact", id: row.id };
}

type Audience = { audience_type: string; audience_id: string };
/** Recompute only affected original timelines; reads render a cached total, never COUNT(parts). */
export async function refreshCustomerUnread(db: Sql, w: string, ids: string[]) {
  if (!ids.length) return;
  await lockProjection(db, w);
  const roots = (
    await db.query<{ id: string; brand_id: string }>(
      `WITH RECURSIVE chain AS (
  SELECT id,merged_into_id,brand_id,0 AS depth FROM conversations WHERE workspace_id=$1 AND id=ANY($2::text[])
  UNION ALL SELECT c.id,c.merged_into_id,c.brand_id,x.depth+1 FROM conversations c JOIN chain x ON x.merged_into_id=c.id WHERE c.workspace_id=$1 AND x.depth<32
 ) SELECT DISTINCT id,brand_id FROM chain WHERE merged_into_id IS NULL ORDER BY id`,
      [w, ids],
    )
  ).rows;
  for (const root of roots) {
    const family = (
      await db.query<{ id: string }>(
        `WITH RECURSIVE family AS (SELECT id FROM conversations WHERE workspace_id=$1 AND id=$2 UNION ALL SELECT c.id FROM conversations c JOIN family f ON c.merged_into_id=f.id WHERE c.workspace_id=$1) SELECT id FROM family`,
        [w, root.id],
      )
    ).rows.map((r) => r.id);
    const before = (
      await db.query<Audience>(
        "SELECT audience_type,audience_id FROM customer_unread_threads WHERE workspace_id=$1 AND conversation_id=ANY($2::text[])",
        [w, family],
      )
    ).rows;
    const desired = (
      await db.query<Audience>(
        `WITH RECURSIVE recipients AS (
   SELECT primary_identity_id AS id FROM conversations WHERE workspace_id=$1 AND id=$2
   UNION SELECT identity_id FROM conversation_participants WHERE workspace_id=$1 AND conversation_id=$2
  ), unread AS (SELECT DISTINCT identity_id FROM customer_reads WHERE workspace_id=$1 AND conversation_id=ANY($3::text[]) AND latest_reply_seq>read_seq),
  mappings AS (
   SELECT m.identity_id,m.contact_id,0 AS depth FROM identity_contact_mappings m WHERE m.workspace_id=$1 AND (m.identity_id IN(SELECT id FROM recipients) OR m.identity_id IN(SELECT identity_id FROM unread))
   UNION ALL SELECT m.identity_id,c.merged_into_contact_id,m.depth+1 FROM mappings m JOIN contacts c ON c.workspace_id=$1 AND c.id=m.contact_id WHERE c.merged_into_contact_id IS NOT NULL AND m.depth<32
  ), resolved AS (SELECT m.identity_id,m.contact_id FROM mappings m JOIN contacts c ON c.workspace_id=$1 AND c.id=m.contact_id WHERE c.merged_into_contact_id IS NULL)
  SELECT 'identity' AS audience_type,u.identity_id AS audience_id FROM unread u WHERE u.identity_id IN(SELECT id FROM recipients)
  UNION SELECT 'contact',m.contact_id FROM unread u JOIN resolved m ON m.identity_id=u.identity_id WHERE m.contact_id IN(SELECT contact_id FROM resolved WHERE identity_id IN(SELECT id FROM recipients))`,
        [w, root.id, family],
      )
    ).rows;
    const deltas = new Map<
      string,
      { type: string; id: string; delta: number }
    >();
    for (const [rows, delta] of [
      [before, -1],
      [desired, 1],
    ] as const)
      for (const a of rows) {
        const key = a.audience_type + ":" + a.audience_id;
        const d = deltas.get(key) ?? {
          type: a.audience_type,
          id: a.audience_id,
          delta: 0,
        };
        d.delta += delta;
        deltas.set(key, d);
      }
    await db.query(
      "DELETE FROM customer_unread_threads WHERE workspace_id=$1 AND conversation_id=ANY($2::text[])",
      [w, family],
    );
    for (const a of desired)
      await db.query(
        "INSERT INTO customer_unread_threads(workspace_id,audience_type,identity_id,contact_id,conversation_id,brand_id) VALUES($1,$2,$3,$4,$5,$6)",
        [
          w,
          a.audience_type,
          a.audience_type === "identity" ? a.audience_id : null,
          a.audience_type === "contact" ? a.audience_id : null,
          root.id,
          root.brand_id,
        ],
      );
    for (const d of [...deltas.values()].sort((a, b) =>
      (a.type + a.id).localeCompare(b.type + b.id),
    )) {
      if (!d.delta) continue;
      await db.query(
        "INSERT INTO customer_unread_totals(workspace_id,audience_type,identity_id,contact_id,brand_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [
          w,
          d.type,
          d.type === "identity" ? d.id : null,
          d.type === "contact" ? d.id : null,
          root.brand_id,
        ],
      );
      await db.query(
        "UPDATE customer_unread_totals SET unread_count=unread_count+$5,version=version+1 WHERE workspace_id=$1 AND audience_type=$2 AND audience_id=$3 AND brand_id=$4",
        [w, d.type, d.id, root.brand_id, d.delta],
      );
    }
  }
}

export async function refreshIdentityUnread(
  db: Sql,
  w: string,
  identity: string,
) {
  const rows = (
    await db.query<{ conversation_id: string }>(
      "SELECT conversation_id FROM customer_reads WHERE workspace_id=$1 AND identity_id=$2",
      [w, identity],
    )
  ).rows;
  await refreshCustomerUnread(
    db,
    w,
    rows.map((r) => r.conversation_id),
  );
}

export async function customerUnreadSnapshots(
  db: Sql,
  w: string,
  sessions: {
    sessionId: string;
    identityId: string;
    brandId: string;
    verified: boolean;
  }[],
) {
  if (!sessions.length) return [];
  return (
    await db.query<{
      session_id: string;
      unread_count: number;
      version: string;
    }>(
      `WITH RECURSIVE requests AS (
  SELECT * FROM jsonb_to_recordset($2::jsonb) AS x("sessionId" text,"identityId" text,"brandId" text,verified boolean)
 ), chain AS (
  SELECT r."sessionId" AS session_id,m.contact_id AS id,0 AS depth FROM requests r JOIN identity_contact_mappings m ON m.workspace_id=$1 AND m.identity_id=r."identityId" WHERE r.verified
  UNION ALL SELECT chain.session_id,c.merged_into_contact_id,chain.depth+1 FROM chain JOIN contacts c ON c.workspace_id=$1 AND c.id=chain.id WHERE c.merged_into_contact_id IS NOT NULL AND chain.depth<32
 ), audience AS (
  SELECT r."sessionId" AS session_id,'identity' AS type,r."identityId" AS id,r."brandId" AS brand FROM requests r WHERE NOT r.verified
  UNION ALL SELECT chain.session_id,'contact',chain.id,r."brandId" FROM chain JOIN contacts c ON c.workspace_id=$1 AND c.id=chain.id JOIN requests r ON r."sessionId"=chain.session_id WHERE c.merged_into_contact_id IS NULL
 ) SELECT a.session_id,COALESCE(t.unread_count,0) AS unread_count,COALESCE(t.version,0)::text AS version FROM audience a LEFT JOIN customer_unread_totals t ON t.workspace_id=$1 AND t.audience_type=a.type AND t.audience_id=a.id AND t.brand_id=a.brand`,
      [w, JSON.stringify(sessions)],
    )
  ).rows;
}

/** Bounded, idempotent backfill before exposing an existing workspace on the new reader. */
export async function rebuildCustomerUnread(connect: Connect, job: Job) {
  return tenant(connect, job.workspace_id, async (db) => {
    const rows = (
      await db.query<{ id: string }>(
        "SELECT id FROM conversations WHERE workspace_id=$1 AND id>$2 AND merged_into_id IS NULL ORDER BY id LIMIT 25",
        [job.workspace_id, job.result?.after ?? ""],
      )
    ).rows;
    await refreshCustomerUnread(
      db,
      job.workspace_id,
      rows.map((r) => r.id),
    );
    return {
      done: rows.length < 25,
      result: {
        after: rows.at(-1)?.id ?? job.result?.after ?? "",
        scanned: Number(job.result?.scanned ?? 0) + rows.length,
      },
    };
  });
}

export async function customerReply(
  db: Sql,
  w: string,
  c: { id: string; brand_id: string; primary_identity_id: string },
  seq: string,
) {
  await lockProjection(db, w);
  const ids = [
    c.primary_identity_id,
    ...(
      await db.query<{ identity_id: string }>(
        "SELECT identity_id FROM conversation_participants WHERE workspace_id=$1 AND conversation_id=$2",
        [w, c.id],
      )
    ).rows.map((x) => x.identity_id),
  ];
  for (const identity of new Set(ids)) {
    const before = (
      await db.query<{ latest_reply_seq: string; read_seq: string }>(
        "SELECT latest_reply_seq,read_seq FROM customer_reads WHERE workspace_id=$1 AND identity_id=$2 AND conversation_id=$3 FOR UPDATE",
        [w, identity, c.id],
      )
    ).rows[0];
    const wasUnread =
      before && BigInt(before.latest_reply_seq) > BigInt(before.read_seq);
    await db.query(
      "INSERT INTO customer_reads(workspace_id,identity_id,conversation_id,latest_reply_seq) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,identity_id,conversation_id) DO UPDATE SET latest_reply_seq=GREATEST(customer_reads.latest_reply_seq,EXCLUDED.latest_reply_seq)",
      [w, identity, c.id, seq],
    );
    if (!wasUnread)
      await db.query(
        "INSERT INTO customer_counters(workspace_id,identity_id,brand_id,unread_count,version) VALUES($1,$2,$3,1,1) ON CONFLICT(workspace_id,identity_id,brand_id) DO UPDATE SET unread_count=customer_counters.unread_count+1,version=customer_counters.version+1",
        [w, identity, c.brand_id],
      );
  }
  await refreshCustomerUnread(db, w, [c.id]);
}
export async function customerRead(
  db: Sql,
  w: string,
  identity: string,
  brand: string,
  conversation: string,
  partId: string,
  verified = false,
) {
  await lockProjection(db, w);
  const part = (
    await db.query<{ seq: string }>(
      "SELECT seq FROM conversation_parts WHERE workspace_id=$1 AND conversation_id=$2 AND id=$3 AND audience='public'",
      [w, conversation, partId],
    )
  ).rows[0];
  assert(part, "PART_NOT_FOUND", "Message unavailable.", 404);
  const audience = await customerAudience(db, w, identity, verified);
  const identities = verified
    ? (
        await db.query<{ id: string }>(
          `WITH RECURSIVE related AS (SELECT id FROM contacts WHERE workspace_id=$1 AND id=$2 UNION ALL SELECT c.id FROM contacts c JOIN related r ON c.merged_into_contact_id=r.id WHERE c.workspace_id=$1) SELECT identity_id AS id FROM identity_contact_mappings WHERE workspace_id=$1 AND contact_id IN(SELECT id FROM related)`,
          [w, audience.id],
        )
      ).rows.map((r) => r.id)
    : [identity];
  for (const identity of identities) {
    const before = (
      await db.query<{ latest_reply_seq: string; read_seq: string }>(
        "SELECT latest_reply_seq,read_seq FROM customer_reads WHERE workspace_id=$1 AND identity_id=$2 AND conversation_id=$3 FOR UPDATE",
        [w, identity, conversation],
      )
    ).rows[0];
    if (!before) continue;
    await db.query(
      "UPDATE customer_reads SET read_seq=GREATEST(read_seq,$4) WHERE workspace_id=$1 AND identity_id=$2 AND conversation_id=$3",
      [w, identity, conversation, part.seq],
    );
    if (
      BigInt(before.latest_reply_seq) > BigInt(before.read_seq) &&
      BigInt(part.seq) >= BigInt(before.latest_reply_seq)
    )
      await db.query(
        "UPDATE customer_counters SET unread_count=unread_count-1,version=version+1 WHERE workspace_id=$1 AND identity_id=$2 AND brand_id=$3",
        [w, identity, brand],
      );
  }
  await refreshCustomerUnread(db, w, [conversation]);
}

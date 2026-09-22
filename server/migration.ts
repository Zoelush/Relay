import { assert, canonical, digest, type Sql } from "./db";

export interface LegacySnapshot {
  workspace: {
    id: string;
    owner_id: string;
    brand: string;
    greeting: string;
    color: string;
    availability: string;
  }[];
  conversations: {
    id: string;
    token_hash: string;
    name: string;
    email: string;
    title: string;
    status: string;
    assigned: string;
    priority: number;
    unread: number;
    sample: number;
    tag: string;
    created_at: number;
    updated_at: number;
  }[];
  messages: {
    id: string;
    conversation_id: string;
    kind: string;
    body: string;
    sender: string;
    created_at: number;
  }[];
}
export function normalizeSnapshot(snapshot: LegacySnapshot): LegacySnapshot {
  const sort = <T extends { id: string }>(items: T[]) =>
    [...items].sort((a, b) => a.id.localeCompare(b.id));
  return {
    workspace: sort(snapshot.workspace),
    conversations: sort(snapshot.conversations),
    messages: sort(snapshot.messages),
  };
}
export async function snapshotDigest(snapshot: LegacySnapshot) {
  return digest(normalizeSnapshot(snapshot));
}
export async function importSnapshot(
  db: Sql,
  workspace: string,
  snapshot: LegacySnapshot,
) {
  assert(
    snapshot.workspace.length === 1 && snapshot.workspace[0].id === workspace,
    "SOURCE_TENANCY",
    "The source must contain exactly the selected workspace.",
  );
  const ids = new Set(snapshot.conversations.map((c) => c.id));
  assert(
    snapshot.messages.every((m) => ids.has(m.conversation_id)),
    "SOURCE_ORPHAN",
    "Source contains orphan messages.",
  );
  const w = snapshot.workspace[0];
  await db.query(
    "INSERT INTO workspace(id,workspace_id,owner_id,brand,greeting,color,availability) VALUES($1,$1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING",
    [w.id, w.owner_id, w.brand, w.greeting, w.color, w.availability],
  );
  for (const c of snapshot.conversations)
    await db.query(
      `INSERT INTO conversations(workspace_id,id,token_hash,name,email,title,status,assigned,priority,unread,sample,tag,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(workspace_id,id) DO NOTHING`,
      [
        workspace,
        c.id,
        c.token_hash,
        c.name,
        c.email,
        c.title,
        c.status,
        c.assigned,
        !!c.priority,
        !!c.unread,
        !!c.sample,
        c.tag,
        new Date(c.created_at).toISOString(),
        new Date(c.updated_at).toISOString(),
      ],
    );
  for (const m of snapshot.messages)
    await db.query(
      "INSERT INTO messages(workspace_id,id,conversation_id,kind,body,sender,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(workspace_id,id) DO NOTHING",
      [
        workspace,
        m.id,
        m.conversation_id,
        m.kind,
        m.body,
        m.sender,
        new Date(m.created_at).toISOString(),
      ],
    );
  const actual = await exportSnapshot(db, workspace);
  assert(
    canonical(normalizeSnapshot(actual)) ===
      canonical(normalizeSnapshot(snapshot)),
    "COPY_MISMATCH",
    "Target differs from source. Cutover remains blocked.",
    409,
  );
  return {
    digest: await snapshotDigest(actual),
    counts: {
      workspace: actual.workspace.length,
      conversations: actual.conversations.length,
      messages: actual.messages.length,
    },
  };
}
export async function exportSnapshot(
  db: Sql,
  workspace: string,
): Promise<LegacySnapshot> {
  const w = await db.query<LegacySnapshot["workspace"][number]>(
    "SELECT id,owner_id,brand,greeting,color,availability FROM workspace WHERE workspace_id=$1",
    [workspace],
  );
  const c = await db.query<LegacySnapshot["conversations"][number]>(
    `SELECT id,token_hash,name,email,title,status,assigned,priority::int,unread::int,sample::int,tag,
    (extract(epoch from created_at)*1000)::float8 AS created_at,(extract(epoch from updated_at)*1000)::float8 AS updated_at FROM conversations WHERE workspace_id=$1`,
    [workspace],
  );
  const m = await db.query<LegacySnapshot["messages"][number]>(
    `SELECT id,conversation_id,kind,body,sender,(extract(epoch from created_at)*1000)::float8 AS created_at FROM messages WHERE workspace_id=$1`,
    [workspace],
  );
  return normalizeSnapshot({
    workspace: w.rows,
    conversations: c.rows,
    messages: m.rows,
  });
}

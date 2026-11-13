import { assert, DomainError, tenant, type Connect, type Sql } from "./db";
import { authorize } from "./policy";
import { recordAudit } from "./audit";
import { copyPlanInto, planRow } from "./plans";
import { COPIED, copyConfiguration, seedSampleCustomers } from "./test-copy";

/** What creating the pair copies after the workspace, its brands, roles and people exist. */
const MADE_WITH_THE_PAIR = ["workspace", "workspace_features", "workspace_plans", "brands", "roles", "role_capabilities", "teammates"];
const REST = COPIED.map((c) => c.table).filter((t) => !MADE_WITH_THE_PAIR.includes(t));

/**
 * The paired test workspace (docs/TEST_WORKSPACE_PLAN.md): a workspace of its own, owned by a
 * production one, where a team can try a workflow, a rule, a messenger change or Zoe's guidance
 * against their own setup without a real person ever seeing it.
 *
 * - **It is a tenant like any other.** Its own ids, its own rows, row-level security as everywhere
 *   else. Production never reads it and it never reads production: the pair (`workspace.test_of`)
 *   only decides who may switch into it.
 * - **Nothing it does reaches a real person.** Every outbound channel delivery ends in
 *   `test_deliveries` instead of a provider (`runDelivery`), and no email is sent on its behalf.
 * - **Nothing is billed.** No invoice is issued for it and its seats are never charged; its meters
 *   are still recorded, so what Zoe used can be seen.
 * - **One sign-in.** A teammate's production session may act in the pair, checked on every request
 *   (`server/api.ts`), and they are the same teammate there, with the same role.
 */
export const TEST_SUFFIX = "-test";

/** Whether this workspace is a test one (the question the rest of the code asks). */
export async function isTest(db: Sql, w: string) {
  return (
    (await db.query<{ test_of: string | null }>("SELECT test_of FROM workspace WHERE id=$1", [w])).rows[0]?.test_of != null
  );
}

/**
 * The pair this workspace is part of, read from its own row: which side you are on, and the id of
 * the other. A workspace never reads the other's row — the pair is written on both when it is made.
 */
export async function pairOf(db: Sql, w: string) {
  const row = (
    await db.query<{ id: string; brand: string; test_of: string | null; test_workspace_id: string | null }>(
      "SELECT id,brand,test_of,test_workspace_id FROM workspace WHERE id=$1",
      [w],
    )
  ).rows[0];
  if (!row) return null;
  return {
    here: row.test_of ? ("test" as const) : ("production" as const),
    current: { id: row.id, name: row.brand },
    // Only the id: the other workspace's name is its own to know, and it may change.
    counterpart: row.test_of ?? row.test_workspace_id ?? null,
  };
}

/**
 * Whether this teammate may act in `wanted` while signed in to `session`: their own workspace, or
 * its test pair, where they must be a teammate too. Read in the workspace being asked for, whose
 * own row says which production workspace it belongs to.
 */
export async function mayActIn(connect: Connect, session: string, wanted: string, principal: string) {
  if (wanted === session) return true;
  return tenant(connect, wanted, async (db) => {
    const paired = (await db.query("SELECT 1 FROM workspace WHERE id=$1 AND test_of=$2", [wanted, session])).rows.length > 0;
    if (!paired) return false;
    // The same person, with their own role there: a teammate removed from the test workspace
    // cannot reach it, even from a session in the workspace it belongs to.
    return (await db.query("SELECT 1 FROM teammates WHERE workspace_id=$1 AND principal_id=$2", [wanted, principal])).rows.length > 0;
  });
}

/** Where an outbound delivery goes in a test workspace: a record of what would have been sent. */
export async function recordTestDelivery(
  db: Sql,
  w: string,
  d: { channel: string; address: string; conversationId: string | null; partId: string | null; body: string },
) {
  await db.query(
    "INSERT INTO test_deliveries(workspace_id,id,channel,address,conversation_id,part_id,body) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [w, crypto.randomUUID(), d.channel, d.address.slice(0, 320), d.conversationId, d.partId, d.body.slice(0, 4000)],
  );
}

/** What a test workspace would have sent, newest first (Settings › Workspace › Test workspace). */
export async function readTestDeliveries(db: Sql, w: string, principal: string, limit = 50) {
  await authorize(db, w, principal, "workspace.manage");
  assert(await isTest(db, w), "NOT_A_TEST_WORKSPACE", "This is not a test workspace.", 404);
  const rows = (
    await db.query<{ id: string; channel: string; address: string; conversation_id: string | null; body: string; created_at: Date }>(
      "SELECT id,channel,address,conversation_id,body,created_at FROM test_deliveries WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT $2",
      [w, Math.min(Math.max(limit, 1), 200)],
    )
  ).rows;
  return {
    deliveries: rows.map((r) => ({
      id: r.id,
      channel: r.channel,
      address: r.address,
      conversationId: r.conversation_id,
      body: r.body,
      at: new Date(r.created_at).toISOString(),
    })),
  };
}

/**
 * Creates the test workspace for a production one: a workspace of its own, its teammates mirrored
 * with their roles, and the pair recorded. What is copied into it beyond that is T1b's.
 */
export async function createTestWorkspace(connect: Connect, w: string, principal: string, now = new Date()) {
  type Teammate = { id: string; principal_id: string; name: string; role_id: string; seat: string };
  type Workspace = { owner_id: string; brand: string; greeting: string; color: string; availability: string; timezone: string | null; locale: string | null; test_of: string | null; test_workspace_id: string | null };
  // Everything the test workspace starts from is read here, in the production workspace's own
  // transaction: a tenant can only see its own rows, so nothing can be copied across by SQL.
  const prepared = await tenant(connect, w, async (db) => {
    await authorize(db, w, principal, "workspace.manage");
    const here = (
      await db.query<Workspace>("SELECT owner_id,brand,greeting,color,availability,timezone,locale,test_of,test_workspace_id FROM workspace WHERE id=$1", [w])
    ).rows[0];
    assert(here, "NOT_FOUND", "This workspace is unavailable.", 404);
    if (here.test_of) throw new DomainError("ALREADY_A_TEST", "This is already a test workspace.", 409);
    if (here.test_workspace_id) throw new DomainError("TEST_EXISTS", "This workspace already has a test workspace.", 409);
    return {
      here,
      plan: await planRow(db, w),
      features: (await db.query<{ name: string; enabled: boolean }>("SELECT name,enabled FROM workspace_features WHERE workspace_id=$1", [w])).rows,
      // The brands come with it: without one there is nowhere for a conversation, a messenger or
      // a help centre to belong, so a test workspace without them could not be used at all.
      brands: (
        await db.query<{ id: string; name: string; settings: Record<string, unknown>; identity_enforced: boolean }>(
          "SELECT id,name,settings,identity_enforced FROM brands WHERE workspace_id=$1",
          [w],
        )
      ).rows,
      roles: (await db.query<{ id: string; name: string }>("SELECT id,name FROM roles WHERE workspace_id=$1", [w])).rows,
      capabilities: (await db.query<{ role_id: string; capability: string }>("SELECT role_id,capability FROM role_capabilities WHERE workspace_id=$1", [w])).rows,
      teammates: (await db.query<Teammate>("SELECT id,principal_id,name,role_id,seat FROM teammates WHERE workspace_id=$1", [w])).rows,
    };
  });
  const test = w + TEST_SUFFIX;
  const name = prepared.here.brand + " (test)";
  // The new workspace is built in its own transaction: it is a tenant of its own from the start.
  await tenant(connect, test, async (db) => {
    assert(
      (await db.query("SELECT 1 FROM workspace WHERE id=$1", [test])).rows.length === 0,
      "TEST_EXISTS",
      "A workspace with that name already exists.",
      409,
    );
    const h = prepared.here;
    await db.query(
      `INSERT INTO workspace(id,workspace_id,owner_id,brand,greeting,color,availability,timezone,locale,test_of,created_at)
       VALUES($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [test, h.owner_id, name, h.greeting, h.color, h.availability, h.timezone, h.locale, w, now],
    );
    // The same plan, so the features and limits a test proves are the ones production has.
    await copyPlanInto(db, test, { plan: prepared.plan?.plan ?? "enterprise", anchor: prepared.plan ? new Date(prepared.plan.period_anchor) : now });
    for (const f of prepared.features) await db.query("INSERT INTO workspace_features(workspace_id,name,enabled) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [test, f.name, f.enabled]);
    for (const b of prepared.brands)
      await db.query("INSERT INTO brands(workspace_id,id,name,settings,identity_enforced) VALUES($1,$2,$3,$4,$5)", [test, b.id, b.name, JSON.stringify(b.settings), b.identity_enforced]);
    for (const r of prepared.roles) await db.query("INSERT INTO roles(workspace_id,id,name) VALUES($1,$2,$3)", [test, r.id, r.name]);
    for (const c of prepared.capabilities)
      await db.query("INSERT INTO role_capabilities(workspace_id,role_id,capability) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [test, c.role_id, c.capability]);
    // The same people, with the same roles: they sign in once, in production, and switch.
    for (const t of prepared.teammates)
      await db.query("INSERT INTO teammates(workspace_id,id,principal_id,name,role_id,seat) VALUES($1,$2,$3,$4,$5,$6)", [test, t.id, t.principal_id, t.name, t.role_id, t.seat]);
  });
  await tenant(connect, w, async (db) => {
    // Both rows carry the pair, so each tenant answers "which pair am I in?" from its own.
    await db.query("UPDATE workspace SET test_workspace_id=$2 WHERE id=$1", [w, test]);
    await recordAudit(db, w, "workspace.test_created", { type: "workspace", id: test, name }, { teammates: prepared.teammates.length });
  });
  // T1b: the rest of the configuration, then made-up customers to work with. Each table is read
  // in one workspace's transaction and written in the other's; `server/test-copy.ts` says which.
  const copied = await copyConfiguration(connect, w, test, REST);
  const conversations = await seedSampleCustomers(connect, test, prepared.brands[0]?.id ?? "default").catch(() => []);
  return { id: test, name, copied, conversations: conversations.length };
}

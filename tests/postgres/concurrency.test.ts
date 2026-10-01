import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { tenant, type Connect } from "../../server/db";
import { hyperdriveConnection } from "../../server/postgres";
import { seedFoundation } from "../../server/people";
import { claim, drainTeam } from "../../server/routing";

/**
 * Assignment under real concurrency (phase 06 follow-up). The embedded test database runs one
 * transaction at a time, so this starts a real PostgreSQL 17 server (embedded-postgres, a dev
 * dependency), applies every migration as the owner, and connects the way production does: a
 * separate runtime role that cannot bypass row-level security, through `pg` (the Hyperdrive
 * path, with its role check). Each tenant transaction is its own connection, truly in parallel.
 *
 * Run: npm run test:postgres
 */
const ROUNDS = 200;

async function server() {
  const pg = new EmbeddedPostgres({
    databaseDir: mkdtempSync(join(tmpdir(), "relay-pg-")),
    user: "postgres",
    password: "postgres",
    port: 55000 + Math.floor(Math.random() * 1000),
    persistent: false,
    onLog: () => {},
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("relay");
  const owner = pg.getPgClient("relay");
  await owner.connect();
  for (const file of (await readdir("db/postgres"))
    .filter((x) => x.endsWith(".sql"))
    .sort())
    await owner.query(await readFile("db/postgres/" + file, "utf8"));
  await owner.query(
    "CREATE ROLE relay_runtime LOGIN PASSWORD 'runtime' NOBYPASSRLS; GRANT USAGE ON SCHEMA public TO relay_runtime; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO relay_runtime;",
  );
  await owner.end();
  // 127.0.0.1, not localhost: on macOS, resolving localhost to IPv6 first occasionally stalled a
  // connection attempt until the 5-second connect timeout (about half the runs).
  const connect: Connect = hyperdriveConnection({
    connectionString: `postgres://relay_runtime:runtime@127.0.0.1:${(pg as unknown as { options: { port: number } }).options.port}/relay`,
  });
  return { pg, connect };
}

test("real PostgreSQL: concurrent claims never both win; concurrent drains never exceed a limit or deadlock", async () => {
  const { pg, connect } = await server();
  const sql = (text: string, values: unknown[] = []) =>
    tenant(connect, "a", async (db) => (await db.query(text, values)).rows);
  try {
    await tenant(connect, "a", (db) =>
      seedFoundation(db, "a", "owner-a", {
        origins: ["https://shop.test"],
        master: "m".repeat(40),
        identitySecret: new TextEncoder().encode("i".repeat(32)),
        enable: true,
      }),
    );
    await sql(
      "UPDATE workspace_features SET enabled=true WHERE name='routing_v1'",
    );
    await sql(
      "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','ada','ada-a','Ada','agent'),('a','bo','bo-a','Bo','agent')",
    );
    await sql(
      "INSERT INTO teams(workspace_id,id,name,method) VALUES('a','one','One','balanced'),('a','two','Two','balanced')",
    );
    await sql(
      "INSERT INTO teammate_teams(workspace_id,teammate_id,team_id) VALUES('a','ada','one'),('a','bo','one'),('a','ada','two'),('a','bo','two')",
    );
    const queued = (prefix: string, count: number, team: string) =>
      sql(
        `INSERT INTO conversations(workspace_id,id,brand_id,token_hash,name,email,title,created_at,updated_at,team_id)
        SELECT 'a',$1||i,'default','','C','',$1||i,now(),now(),$3 FROM generate_series(1,$2::int) i`,
        [prefix, count, team],
      );

    // 1. Two connections claim the same conversation at the same moment, 200 times: one wins.
    await queued("race-", ROUNDS, "one");
    let doubles = 0;
    for (let i = 1; i <= ROUNDS; i++) {
      const results = await Promise.all(
        ["ada", "bo"].map((who) =>
          tenant(connect, "a", (db) =>
            claim(db, "a", "race-" + i, "one", who, "race"),
          ),
        ),
      );
      if (results.filter(Boolean).length !== 1) doubles++;
    }
    assert.equal(doubles, 0, "exactly one claim wins every race");
    const records = await sql(
      "SELECT conversation_id,count(*)::int AS n FROM conversation_parts WHERE kind='assignment_change' AND data->>'reason'='race' GROUP BY 1 HAVING count(*)<>1",
    );
    assert.deepEqual(records, [], "one assignment record per conversation");

    // 2. The last slot: Ada (limit 1) is the only one with room; two connections drain the same
    // inbox at once, 200 times. She never ends up with two.
    await sql(
      "UPDATE conversations SET status='closed' WHERE id LIKE 'race-%'",
    );
    await sql("UPDATE teammates SET conversation_limit=1 WHERE id='ada'");
    await sql("UPDATE teammates SET presence='away' WHERE id='bo'");
    let over = 0;
    for (let i = 1; i <= ROUNDS; i++) {
      await sql(
        "UPDATE conversations SET status='closed' WHERE assigned='ada' AND status='open'",
      );
      await queued(`slot-${i}-`, 2, "one");
      await Promise.all(
        [0, 1].map(() =>
          tenant(connect, "a", (db) => drainTeam(db, "a", "one")),
        ),
      );
      const [{ n }] = await sql(
        "SELECT count(*)::int AS n FROM conversations WHERE assigned='ada' AND status='open'",
      );
      if (n !== 1) over++;
    }
    assert.equal(
      over,
      0,
      "Ada always has exactly one: the limit held under concurrency",
    );

    // 3. Two teams sharing members drain at once, 200 times: no deadlock, no limit exceeded.
    await sql("UPDATE conversations SET status='closed' WHERE status='open'");
    await sql(
      "UPDATE teammates SET presence='active',conversation_limit=3 WHERE id IN ('ada','bo')",
    );
    const errors: string[] = [];
    for (let i = 1; i <= ROUNDS; i++) {
      await sql(
        "UPDATE conversations SET status='closed' WHERE status='open' AND assigned<>''",
      );
      await queued(`one-${i}-`, 4, "one");
      await queued(`two-${i}-`, 4, "two");
      await Promise.all(
        ["one", "two", "one", "two"].map((team) =>
          tenant(connect, "a", (db) => drainTeam(db, "a", team)).catch((e) =>
            errors.push(String(e?.code ?? e)),
          ),
        ),
      );
      const loads = await sql(
        "SELECT assigned,count(*)::int AS n FROM conversations WHERE status='open' AND assigned<>'' GROUP BY assigned",
      );
      for (const l of loads)
        assert(
          Number(l.n) <= 3,
          `${l.assigned} has ${l.n}, over the limit of 3 (round ${i})`,
        );
    }
    assert.deepEqual(errors, [], "no deadlocks or other errors");
  } finally {
    await pg.stop();
  }
});

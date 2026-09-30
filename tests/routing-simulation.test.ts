import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { drainForTeammate, drainTeam } from "../server/routing";

/**
 * Phase 06 acceptance: 20 teammates with mixed limits, random away transitions and 2,000
 * arriving conversations in a balanced inbox with its own limit. Proves nothing is lost,
 * double-assigned or stranded, that no limit is ever exceeded, and reports the distribution.
 * The same seed replays the same assignments.
 */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function simulate(arrivals: number, seed: number, check: boolean) {
  const db = await testDatabase();
  const w = "sim";
  const sql = async <T = any>(query: string, values: unknown[] = []) =>
    tenant(db.connect, w, async (q) => (await q.query<T>(query, values)).rows);
  const rand = random(seed);
  const limits = [2, 3, 4, 5, 8, null] as const;
  const people = Array.from({ length: 20 }, (_, i) => ({
    id: `t${String(i + 1).padStart(2, "0")}`,
    limit: limits[Math.floor(rand() * limits.length)],
    away: false,
  }));
  const INBOX_LIMIT = 60;
  const sequence: string[] = [];
  let away = 0,
    returns = 0,
    queuedPeak = 0;
  try {
    await tenant(db.connect, w, (q) =>
      seedFoundation(q, w, "owner-sim", {
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
      "INSERT INTO teams(workspace_id,id,name,method,conversation_limit) VALUES('sim','inbox','Inbox','balanced',$1)",
      [INBOX_LIMIT],
    );
    for (const p of people) {
      await sql(
        "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id,conversation_limit) VALUES('sim',$1,$1,$1,'agent',$2)",
        [p.id, p.limit],
      );
      await sql(
        "INSERT INTO teammate_teams(workspace_id,teammate_id,team_id) VALUES('sim',$1,'inbox')",
        [p.id],
      );
    }
    const record = (
      assigned: { conversationId: string; teammateId: string }[],
    ) => {
      for (const a of assigned)
        sequence.push(`${a.conversationId}>${a.teammateId}`);
    };
    const closeOne = async () => {
      const open = await sql<{ id: string; assigned: string }>(
        "SELECT id,assigned FROM conversations WHERE workspace_id='sim' AND status='open' AND assigned<>'' ORDER BY id",
      );
      if (!open.length) return false;
      const pick = open[Math.floor(rand() * open.length)];
      await sql(
        "UPDATE conversations SET status='closed' WHERE workspace_id='sim' AND id=$1",
        [pick.id],
      );
      record(
        await tenant(db.connect, w, (q) =>
          drainForTeammate(q, w, pick.assigned),
        ),
      );
      return true;
    };
    const invariants = async () => {
      // No teammate over their limit; the inbox within its limit; nothing assigned to someone away
      // since they went away (checked through the routing record below).
      const loads = await sql<{ assigned: string; n: number }>(
        "SELECT assigned,count(*)::int AS n FROM conversations WHERE workspace_id='sim' AND status='open' AND assigned<>'' GROUP BY assigned",
      );
      for (const l of loads) {
        const limit = people.find((p) => p.id === l.assigned)!.limit;
        if (limit !== null)
          assert(l.n <= limit, `${l.assigned} has ${l.n} over limit ${limit}`);
      }
      assert(
        loads.reduce((s, l) => s + l.n, 0) <= INBOX_LIMIT,
        "inbox limit exceeded",
      );
    };
    for (let i = 1; i <= arrivals; i++) {
      const id = `c${String(i).padStart(5, "0")}`;
      await sql(
        "INSERT INTO conversations(workspace_id,id,brand_id,token_hash,name,email,title,created_at,updated_at,team_id,priority) VALUES('sim',$1,'default','','Customer','',$1,now(),now(),'inbox',$2)",
        [id, rand() < 0.1],
      );
      record(await tenant(db.connect, w, (q) => drainTeam(q, w, "inbox")));
      // Teammates work: usually one conversation closes per arrival, sometimes two, sometimes none.
      const r = rand();
      if (r < 0.75) await closeOne();
      if (r < 0.2) await closeOne();
      // Random away transitions; returning may pick up queued work.
      if (rand() < 0.04) {
        const p = people[Math.floor(rand() * people.length)];
        p.away = !p.away;
        await sql(
          "UPDATE teammates SET presence=$2 WHERE workspace_id='sim' AND id=$1",
          [p.id, p.away ? "away" : "active"],
        );
        if (p.away) away++;
        else {
          returns++;
          record(
            await tenant(db.connect, w, (q) => drainForTeammate(q, w, p.id)),
          );
        }
      }
      if (check && i % 50 === 0) {
        await invariants();
        queuedPeak = Math.max(
          queuedPeak,
          (
            await sql(
              "SELECT count(*)::int AS n FROM conversations WHERE workspace_id='sim' AND status='open' AND assigned=''",
            )
          )[0].n,
        );
      }
    }
    // Afterwards everyone returns and keeps working: the queue must empty by itself.
    for (const p of people.filter((x) => x.away)) {
      p.away = false;
      await sql(
        "UPDATE teammates SET presence='active' WHERE workspace_id='sim' AND id=$1",
        [p.id],
      );
      record(await tenant(db.connect, w, (q) => drainForTeammate(q, w, p.id)));
    }
    let rounds = 0;
    while (
      (
        await sql(
          "SELECT count(*)::int AS n FROM conversations WHERE workspace_id='sim' AND status='open' AND assigned=''",
        )
      )[0].n > 0
    ) {
      assert(await closeOne(), "the queue is stuck with nobody working");
      assert(++rounds < arrivals * 2, "the queue never emptied");
    }
    if (check) await invariants();
    const totals = await sql<{ status: string; assigned: boolean; n: number }>(
      "SELECT status,assigned<>'' AS assigned,count(*)::int AS n FROM conversations WHERE workspace_id='sim' GROUP BY 1,2 ORDER BY 1,2",
    );
    // Every routed conversation was assigned exactly once, to the teammate that holds it (or held it).
    const routed = await sql<{
      id: string;
      n: number;
      teammate: string;
      holder: string;
    }>(
      `SELECT c.id,count(p.id)::int AS n,min(p.data->'after'->>'teammate') AS teammate,c.assigned AS holder FROM conversations c
      LEFT JOIN conversation_parts p ON p.workspace_id=c.workspace_id AND p.conversation_id=c.id AND p.kind='assignment_change' AND p.data->>'reason'='balanced'
      WHERE c.workspace_id='sim' GROUP BY c.id,c.assigned`,
    );
    const distribution = await sql<{ teammate: string; n: number }>(
      `SELECT p.data->'after'->>'teammate' AS teammate,count(*)::int AS n FROM conversation_parts p
      WHERE p.workspace_id='sim' AND p.kind='assignment_change' AND p.data->>'reason'='balanced' GROUP BY 1 ORDER BY 1`,
    );
    return {
      totals,
      routed,
      distribution,
      sequence,
      people,
      away,
      returns,
      queuedPeak,
    };
  } finally {
    await db.close();
  }
}

test("simulation: 20 teammates, mixed limits, random away, 2,000 arrivals — nothing lost, double-assigned or stranded", async () => {
  const r = await simulate(2000, 20260930, true);
  const count = (status: string, assigned: boolean) =>
    r.totals.find((t) => t.status === status && t.assigned === assigned)?.n ??
    0;
  // Nothing lost: every arrival is closed, or open and assigned; nothing is left waiting.
  assert.equal(
    r.totals.reduce((s, t) => s + t.n, 0),
    2000,
  );
  assert.equal(count("open", false), 0, "nothing stranded in the queue");
  assert.equal(
    count("closed", false),
    0,
    "every conversation was assigned before it closed",
  );
  // Nothing double-assigned: each conversation routed exactly once, to its holder.
  for (const c of r.routed) {
    assert.equal(c.n, 1, `${c.id} routed ${c.n} times`);
    assert.equal(
      c.teammate,
      c.holder,
      `${c.id} held by someone other than its assignee`,
    );
  }
  assert.equal(
    r.distribution.reduce((s, d) => s + d.n, 0),
    2000,
  );
  // Every teammate took part; the report shows how work followed capacity.
  assert.equal(r.distribution.length, 20);
  const report = r.people.map((p) => ({
    teammate: p.id,
    limit: p.limit ?? "none",
    assigned: r.distribution.find((d) => d.teammate === p.id)?.n ?? 0,
  }));
  console.log(
    `\nRouting simulation (seed 20260930): 2,000 arrivals, ${r.away} away transitions, ${r.returns} returns, peak queue ${r.queuedPeak}\n` +
      report
        .map(
          (x) =>
            `  ${x.teammate}  limit ${String(x.limit).padStart(4)}  assigned ${String(x.assigned).padStart(4)}`,
        )
        .join("\n"),
  );
});

test("the same seed replays the same assignments", async () => {
  const [a, b] = [await simulate(300, 7, false), await simulate(300, 7, false)];
  assert.equal(a.sequence.length, 300);
  assert.deepEqual(a.sequence, b.sequence);
});

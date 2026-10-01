/**
 * Command latency with SLAs and routing on versus off (maintenance follow-up to phase 05 B2 and
 * phase 06), local only. Each conversation command now recomputes SLA clocks and may route,
 * inside its own transaction, so this measures what that costs.
 *
 * For each setting: 200 customer conversations are started, put in the Billing team inbox
 * (balanced, so routing assigns or queues them), replied to by a teammate, and closed. Each
 * command's time is measured around its transaction, on the server.
 *
 * Run: node --import tsx scripts/measure-commands.ts
 * Uses embedded PostgreSQL (PGlite) on this machine. Not a hosted figure.
 */
import { cpus, platform, release } from "node:os";
import { startLocalRelay } from "./local-relay";
import { tenant } from "../server/db";
import { getIdentity } from "../server/people";
import { command } from "../server/conversations";

const N = 200;
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) =>
    Math.round(s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] * 10) /
    10;
  return {
    n: s.length,
    p50: q(0.5),
    p95: q(0.95),
    p99: q(0.99),
    max: Math.round(s[s.length - 1] * 10) / 10,
  };
};

async function run(on: boolean, port: number) {
  const relay = await startLocalRelay({
    apiPort: port,
    hostPort: port + 1,
    sla: on,
    routing: on,
  });
  const timings: Record<string, number[]> = {
    start: [],
    assign_team: [],
    reply: [],
    close: [],
  };
  const timed = async (name: string, work: () => Promise<unknown>) => {
    const t0 = performance.now();
    await work();
    timings[name].push(performance.now() - t0);
  };
  try {
    // Room for everyone: the measurement is of the work per command, not of queueing.
    await tenant(relay.db.connect, "demo", (db) =>
      db.query(
        "UPDATE teammates SET conversation_limit=1000,presence='active' WHERE workspace_id='demo'",
      ),
    );
    await tenant(relay.db.connect, "demo", (db) =>
      db.query(
        "UPDATE teams SET conversation_limit=NULL WHERE workspace_id='demo'",
      ),
    );
    const owner = { type: "teammate" as const, principal: "local-owner" };
    for (let i = 0; i < N; i++) {
      const key = `measure-${on}-${i}`;
      let id = "";
      await timed("start", () =>
        tenant(relay.db.connect, "demo", async (db) => {
          const identity = await getIdentity(db, "demo", "anonymous", key);
          id = (
            (await command(
              db,
              "demo",
              {
                type: "contact",
                identityId: identity.identityId,
                brandId: "default",
              },
              key,
              {
                action: "start",
                text: "Measure " + i,
              },
            )) as { conversationId: string }
          ).conversationId;
        }),
      );
      await timed("assign_team", () =>
        tenant(relay.db.connect, "demo", (db) =>
          command(db, "demo", owner, key + "-team", {
            action: "assign",
            conversationId: id,
            teamId: "billing",
          }),
        ),
      );
      await timed("reply", () =>
        tenant(relay.db.connect, "demo", (db) =>
          command(db, "demo", owner, key + "-reply", {
            action: "reply",
            conversationId: id,
            text: "Looking into it",
          }),
        ),
      );
      await timed("close", () =>
        tenant(relay.db.connect, "demo", (db) =>
          command(db, "demo", owner, key + "-close", {
            action: "close",
            conversationId: id,
          }),
        ),
      );
    }
    return Object.fromEntries(
      Object.entries(timings).map(([k, v]) => [k, stats(v)]),
    );
  } finally {
    await relay.close();
  }
}

const off = await run(false, 8940);
const on = await run(true, 8942);
console.log(
  JSON.stringify(
    {
      environment: {
        cpu: cpus()[0]?.model,
        cores: cpus().length,
        os: `${platform()} ${release()}`,
        database: "PGlite (embedded PostgreSQL, WebAssembly)",
      },
      conversations: N,
      slaAndRoutingOff: off,
      slaAndRoutingOn: on,
    },
    null,
    2,
  ),
);

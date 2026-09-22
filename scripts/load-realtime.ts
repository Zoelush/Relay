/** Local transport baseline, not a Neon/Hyperdrive capacity certification. */
import { chromium } from "@playwright/test";
import { SignJWT } from "jose";
import { mkdir, writeFile } from "node:fs/promises";
import { startLocalRelay } from "./local-relay";
import { tenant, digest } from "../server/db";
import { handleApi } from "../server/api";

const agentCount = 200,
  conversationCount = 5000,
  rate = 50,
  seconds = Number(process.env.RELAY_LOAD_SECONDS ?? 60);
const app = await startLocalRelay({ apiPort: 8808, hostPort: 8809 });
let browser;
try {
  const bootResponse = await handleApi(
    new Request(app.apiOrigin + "/v1/messenger/boot", {
      method: "POST",
      headers: {
        origin: app.hostOrigin,
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        workspaceId: "demo",
        brandId: "default",
        deviceToken: "load-device-".repeat(5),
        pageUrl: app.hostOrigin,
        locale: "en",
      }),
    }),
    app.env,
  );
  const boot = (await bootResponse.json()) as any;
  if (!bootResponse.ok) throw new Error("Load fixture boot failed.");
  await tenant(app.db.connect, "demo", async (db) => {
    await db.query(
      "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) SELECT $1,'agent-'||i,'load-agent-'||i,'Agent '||i,'agent' FROM generate_series(1,$2::int) AS i",
      ["demo", agentCount],
    );
    await db.query(
      "INSERT INTO conversations(workspace_id,id,brand_id,primary_identity_id,token_hash,name,email,title,status,assigned,created_at,updated_at) SELECT $1,'load-conversation-'||lpad(i::text,5,'0'),'default',$2,'','Load customer','','Load '||i,'open','agent-'||((i-1)%$4::int+1),now(),now() FROM generate_series(1,$3::int) AS i",
      ["demo", boot.session.identityId, conversationCount, agentCount],
    );
  });
  const sessions = [];
  for (let i = 1; i <= agentCount; i++) {
    const path = "/v1/agent/realtime-ticket",
      key = crypto.randomUUID(),
      p = {};
    const token = await new SignJWT({
      workspace: "demo",
      principal: "load-agent-" + i,
      method: "POST",
      path,
      key,
      digest: await digest(p),
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("relay-sites")
      .setAudience("relay-agent")
      .setIssuedAt()
      .setExpirationTime("1m")
      .sign(new TextEncoder().encode(app.env.bridgeSecret));
    const r = await handleApi(
      new Request(app.apiOrigin + path, {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "idempotency-key": key,
          "content-type": "application/json",
        },
        body: "{}",
      }),
      app.env,
    );
    if (!r.ok) throw new Error("Agent authorization failed.");
    const ticket = (await r.json()) as any;
    sessions.push({
      ...ticket,
      conversationId: "load-conversation-" + String(i).padStart(5, "0"),
    });
  }
  browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_CHANNEL,
    headless: true,
  });
  const page = await browser.newPage();
  await page.goto(app.hostOrigin + "/?baseline=1");
  await page.evaluate((config) => {
    const state = ((window as any).loadState = {
      ready: 0,
      synced: 0,
      latencies: [] as number[],
      rendered: 0,
      duplicateDeliveries: 0,
      errors: 0,
    });
    document.body.replaceChildren();
    for (const session of config) {
      const pane = document.createElement("section");
      document.body.appendChild(pane);
      const seen = new Set<string>();
      let initial = false;
      const socket = new WebSocket(session.url + "?workspace=demo");
      socket.onopen = () =>
        socket.send(
          JSON.stringify({ type: "authenticate", ticket: session.ticket }),
        );
      socket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === "ready") {
          state.ready++;
          socket.send(
            JSON.stringify({
              type: "subscribe",
              conversationId: session.conversationId,
            }),
          );
        }
        if (data.type === "error") state.errors++;
        if (data.type === "timeline" && !initial) {
          initial = true;
          state.synced++;
        }
        if (data.type === "timeline")
          for (const part of data.parts) {
            if (part.kind !== "customer_message") continue;
            if (seen.has(part.id)) {
              state.duplicateDeliveries++;
              continue;
            }
            seen.add(part.id);
            const row = document.createElement("p");
            row.dataset.partId = part.id;
            row.textContent = part.body;
            pane.appendChild(row);
            requestAnimationFrame(() => {
              state.latencies.push(Date.now() - Date.parse(part.created_at));
              state.rendered++;
            });
          }
      };
    }
  }, sessions);
  await page.waitForFunction(
    (count) => (window as any).loadState.synced === count,
    agentCount,
    { timeout: 45000 },
  );
  console.log(
    "Load clients ready: 200 agents with initial replay complete; 5,000 open conversations.",
  );
  app.db.resetMeasurements();
  const databaseTimes: Record<string, number[]> = {
    dbqueue: [],
    dbtransaction: [],
    dbsql: [],
  };
  const serverTimes: number[] = [],
    times: number[] = [],
    errors: { status: number; code?: string }[] = [],
    requests: Promise<void>[] = [],
    started = performance.now();
  let committed = 0;
  for (let i = 0; i < rate * seconds; i++) {
    const delay = started + (i * 1000) / rate - performance.now();
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    const body = {
        action: "reply",
        conversationId:
          "load-conversation-" + String((i % agentCount) + 1).padStart(5, "0"),
        text: "Load message " + i,
      },
      start = performance.now();
    requests.push(
      fetch(app.apiOrigin + "/v1/messenger/command", {
        method: "POST",
        headers: {
          authorization: "Bearer " + boot.token,
          origin: app.hostOrigin,
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify(body),
      })
        .then(async (r) => {
          times.push(performance.now() - start);
          const timing = r.headers.get("server-timing")?.match(/dur=([0-9.]+)/);
          if (timing) serverTimes.push(Number(timing[1]));
          for (const [name, values] of Object.entries(databaseTimes)) {
            const match = r.headers
              .get("server-timing")
              ?.match(new RegExp(name + ";dur=([0-9.]+)"));
            if (match) values.push(Number(match[1]));
          }
          if (r.ok) committed++;
          else {
            const data = (await r.json()) as any;
            errors.push({ status: r.status, code: data.error?.code });
          }
        })
        .catch(() => {
          errors.push({ status: 0, code: "NETWORK" });
        }),
    );
    if (i && i % (rate * 10) === 0)
      console.log(`Offered ${i} messages; ${committed} requests completed.`);
  }
  await Promise.all(requests);
  await page.waitForFunction(
    (expected) => (window as any).loadState.rendered >= expected,
    committed,
    { timeout: 60000 },
  );
  const state = await page.evaluate(() => (window as any).loadState),
    percentile = (values: number[], p: number) =>
      [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] ??
      null;
  const unreadQueryPlan = await tenant(app.db.connect, "demo", (db) =>
    db.query(
      "EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT teammate_id,views FROM conversation_unread WHERE workspace_id=$1 AND conversation_id=$2",
      ["demo", "load-conversation-00001"],
    ),
  );
  const result = {
    environment:
      "Local Chrome DOM render clients, Node HTTP/WebSocket adapter, embedded PostgreSQL (PGlite). No Neon, Hyperdrive, Cloudflare edge or internet hop. Minimal client panes, not 200 full React inboxes. Every connection completes its initial replay before the sustained-write interval.",
    agents: agentCount,
    openConversations: conversationCount,
    offeredMessages: rate * seconds,
    offeredRatePerSecond: rate,
    durationSeconds: seconds,
    committed,
    rendered: state.rendered,
    errors,
    duplicateDeliveries: state.duplicateDeliveries,
    websocketErrors: state.errors,
    writeToRenderMs: {
      p50: percentile(state.latencies, 0.5),
      p95: percentile(state.latencies, 0.95),
      p99: percentile(state.latencies, 0.99),
    },
    serverProcessingMs: {
      p50: percentile(serverTimes, 0.5),
      p95: percentile(serverTimes, 0.95),
      p99: percentile(serverTimes, 0.99),
    },
    databaseTimingsMs: Object.fromEntries(
      Object.entries(databaseTimes).map(([name, values]) => [
        name,
        {
          p50: percentile(values, 0.5),
          p95: percentile(values, 0.95),
          p99: percentile(values, 0.99),
        },
      ]),
    ),
    statementTimings: app.db.statementTimings(),
    unreadQueryPlan: unreadQueryPlan.rows[0]["QUERY PLAN"],
    httpRoundTripMs: {
      p50: percentile(times, 0.5),
      p95: percentile(times, 0.95),
      p99: percentile(times, 0.99),
    },
    fullDrainSeconds: (performance.now() - started) / 1000,
  };
  await mkdir("work/benchmarks", { recursive: true });
  await writeFile(
    "work/benchmarks/realtime-load.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
  if (
    committed !== rate * seconds ||
    state.rendered !== committed ||
    errors.length
  )
    process.exitCode = 1;
} finally {
  await browser?.close();
  await app.close();
}

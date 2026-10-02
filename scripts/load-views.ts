/**
 * Inbox views load harness: N agents, M conversations, every teammate initialising default views,
 * then steady-state projection of 100 changed conversations and view-page latency.
 * Run: node --import tsx scripts/load-views.ts [agents=200] [conversations=10000]
 * Local embedded PostgreSQL (PGlite); ANALYZE runs after seeding so plans match a live database.
 */
import { localDatabase as testDatabase } from "./local-db";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import {
  mutateView,
  rebuildViews,
  projectInboxChanges,
  viewPage,
} from "../server/inbox-views";
import { runJob } from "../server/jobs";
const agents = Number(process.argv[2] ?? 200),
  convs = Number(process.argv[3] ?? 10000);
const db = await testDatabase();
const w = "demo";
const handlers = {
  "inbox.views.rebuild": (j: any) => rebuildViews(db.connect, j),
};
const all: number[] = [];
const drain = async (jobId: string | null) => {
  let steps = 0,
    max = 0;
  if (!jobId) return { steps, max };
  for (;;) {
    const s = performance.now();
    const r = await runJob(db.connect, w, jobId, handlers);
    steps++;
    all.push(performance.now() - s);
    max = Math.max(max, performance.now() - s);
    if (r.state !== "queued") return { steps, max, state: r.state };
  }
};
await tenant(db.connect, w, async (sql) => {
  await seedFoundation(sql, w, "owner-demo", {
    origins: [],
    master: "m".repeat(40),
    identitySecret: new TextEncoder().encode("i".repeat(32)),
    enable: true,
  });
  await sql.query(
    "UPDATE workspace_features SET enabled=true WHERE workspace_id=$1 AND name='agent_inbox_views_v1'",
    [w],
  );
  await sql.query(
    "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) SELECT $1,'agent-'||i,'p-'||i,'Agent '||i,'agent' FROM generate_series(1,$2::int) i",
    [w, agents],
  );
  await sql.query(
    "INSERT INTO conversations(workspace_id,id,brand_id,token_hash,name,email,title,status,assigned,created_at,updated_at,last_contact_reply_at) SELECT $1,'c-'||lpad(i::text,6,'0'),'default','','C','','T'||i,(ARRAY['open','open','snoozed','closed'])[1+i%4],CASE WHEN i%3=0 THEN '' ELSE 'agent-'||(1+i%$3::int) END,now()-(i||' minutes')::interval,now(),now()-(i||' seconds')::interval FROM generate_series(1,$2::int) i",
    [w, convs, agents],
  );
  // Twenty messages each (replies, internal notes; every other conversation ends with a system
  // event), so view pages pay for their preview line as they would on a live inbox.
  await sql.query(
    `INSERT INTO conversation_parts(workspace_id,id,conversation_id,seq,kind,author_type,author_id,audience,channel,body)
     SELECT $1,'p-'||c.i||'-'||s,'c-'||lpad(c.i::text,6,'0'),s,
       CASE WHEN s=20 AND c.i%2=0 THEN 'state_change' WHEN s%5=0 THEN 'internal_note' WHEN s%2=0 THEN 'teammate_reply' ELSE 'customer_message' END,
       CASE WHEN s=20 AND c.i%2=0 THEN 'system' WHEN s%2=0 THEN 'teammate' ELSE 'contact' END,'x',
       CASE WHEN s%5=0 THEN 'internal' ELSE 'public' END,'messenger','Message '||s||' in conversation '||c.i
     FROM generate_series(1,$2::int) c(i),generate_series(1,20) s`,
    [w, convs],
  );
  await sql.query("DELETE FROM inbox_projection_dirty WHERE workspace_id=$1", [
    w,
  ]);
});
await db.pg.exec("ANALYZE");
// Every teammate opens the inbox: seeds five default views and rebuilds only sets not yet built.
let t0 = performance.now(),
  totalSteps = 0,
  maxStep = 0,
  first = 0;
const principals = [
  "owner-demo",
  ...Array.from({ length: agents }, (_, i) => "p-" + (i + 1)),
];
for (const [i, principal] of principals.entries()) {
  const r: any = await tenant(db.connect, w, (sql) =>
    mutateView(sql, w, principal, crypto.randomUUID(), {
      action: "initialize",
    }),
  );
  const d = await drain(r.jobId);
  totalSteps += d.steps;
  maxStep = Math.max(maxStep, d.max);
  if (i === 0) first = performance.now() - t0;
}
console.log(
  "initialize",
  principals.length,
  "teammates:",
  (performance.now() - t0).toFixed(0),
  "ms total; first teammate",
  first.toFixed(0),
  "ms; rebuild steps",
  totalSteps,
  "max step",
  maxStep.toFixed(0),
  "ms",
);
all.sort((a, b) => a - b);
const q = (x: number) => all[Math.floor(all.length * x)].toFixed(0);
console.log(
  "rebuild step ms p50",
  q(0.5),
  "p95",
  q(0.95),
  "p99",
  q(0.99),
  "max",
  all.at(-1)!.toFixed(0),
  "steps over 200ms:",
  all.filter((x) => x > 200).length,
);
const counts = await tenant(
  db.connect,
  w,
  async (sql) =>
    (
      await sql.query<any>(
        "SELECT (SELECT count(*) FROM inbox_views) views,(SELECT count(*) FROM inbox_filter_sets) sets,(SELECT count(*) FROM inbox_filter_members) members",
      )
    ).rows[0],
);
console.log(counts);
await db.pg.exec("ANALYZE");
// Steady state: 100 conversations change state (open -> closed and others), then one projection step.
for (const run of [1, 2, 3]) {
  await tenant(db.connect, w, (sql) =>
    sql.query(
      "UPDATE conversations SET status=CASE status WHEN 'open' THEN 'closed' WHEN 'closed' THEN 'open' ELSE 'open' END, assigned=CASE WHEN assigned='' THEN 'agent-1' ELSE '' END WHERE workspace_id=$1 AND id IN (SELECT id FROM conversations WHERE workspace_id=$1 ORDER BY random() LIMIT 100)",
      [w],
    ),
  );
  db.resetMeasurements();
  t0 = performance.now();
  await projectInboxChanges(db.connect, w);
  console.log(
    "project 100 changed conversations, run",
    run,
    ":",
    (performance.now() - t0).toFixed(0),
    "ms",
  );
}
const owner = { id: "owner" } as any;
const open = await tenant(
  db.connect,
  w,
  async (sql) =>
    (
      await sql.query<any>(
        "SELECT id FROM inbox_views WHERE owner_id='owner' AND builtin='all'",
      )
    ).rows[0],
);
// The "All" view's open conversations (the status picker's default), with their previews.
for (const sort of ["activity", "created", "waiting", "priority"]) {
  const times = [];
  for (let i = 0; i < 20; i++) {
    const s = performance.now();
    await tenant(db.connect, w, (sql) =>
      viewPage(
        sql,
        w,
        owner,
        "owner-demo",
        new URLSearchParams({ view: open.id, sort }),
      ),
    );
    times.push(performance.now() - s);
  }
  times.sort((a, b) => a - b);
  console.log(
    "viewPage",
    sort,
    "p50",
    times[10].toFixed(1),
    "p95",
    times[18].toFixed(1),
    "max",
    times[19].toFixed(1),
    "ms",
  );
}
const check = await tenant(
  db.connect,
  w,
  async (sql) =>
    (
      await sql.query<any>(
        "SELECT s.open_count::int AS stored,(SELECT count(*)::int FROM inbox_filter_members m WHERE m.set_id=s.id AND m.status='open') AS actual,(SELECT count(*)::int FROM conversations c WHERE c.status='open') AS expected FROM inbox_filter_sets s JOIN inbox_views v ON v.set_id=s.id WHERE v.owner_id='owner' AND v.builtin='all'",
      )
    ).rows[0],
);
console.log("open count stored/actual/expected", check);
await db.close();

/**
 * The reporting benchmark (phase 14, step R2; docs/REPORTING_STEP2.md): the analytical store on a
 * real PostgreSQL 17, filled with SQL to N conversation parts across W workspaces (sizes skewed, as
 * customers are: the largest holds about 6% of everything), then every pre-built report's charts run
 * through `runMetric` as the runtime role (row-level security on, as deployed). Each chart is one
 * call: the period, the previous period and the breakdown. Results go to docs/REPORTING_BENCHMARK.md.
 *
 * Run: node --import tsx scripts/reporting-benchmark.ts [parts=10000000] [workspaces=5000]
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { hyperdriveConnection } from "../server/postgres";
import { runMetric } from "../server/reports";
import { PREBUILT } from "../lib/reports";

const PARTS = Number(process.argv[2] ?? 10_000_000);
const WORKSPACES = Number(process.argv[3] ?? 5000);
const PER = 8; // parts per conversation
const CONVERSATIONS = Math.round(PARTS / PER);
const RUNS = 7;
const TARGET_MS = 200;
const now = new Date("2026-10-20T00:00:00Z");
const log = (...x: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...x);

const port = 56000 + Math.floor(Math.random() * 1000);
const pg = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), "relay-bench-")), user: "postgres", password: "postgres", port, persistent: false, onLog: () => {} });
await pg.initialise();
await pg.start();
try {
  await pg.createDatabase("analytics");
  const owner = pg.getPgClient("analytics");
  await owner.connect();
  for (const file of (await readdir("db/analytics")).filter((x) => x.endsWith(".sql")).sort()) await owner.query(await readFile("db/analytics/" + file, "utf8"));
  await owner.query("CREATE ROLE relay_runtime LOGIN PASSWORD 'runtime' NOBYPASSRLS; GRANT USAGE ON SCHEMA public TO relay_runtime; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO relay_runtime;");
  const q = async (label: string, text: string) => {
    const s = performance.now();
    const r = await owner.query(text);
    log(label, r.rowCount ?? "", `${Math.round(performance.now() - s)} ms`);
  };

  // A bulk load, as any would be done: the secondary indexes are dropped first and built again
  // afterwards from the migrations' own definitions, and rows go in sorted by their keys.
  const indexes = (await owner.query("SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND indexname NOT LIKE '%_pkey'")).rows as { indexname: string; indexdef: string }[];
  for (const i of indexes) await owner.query(`DROP INDEX ${i.indexname}`);
  await owner.query("SET maintenance_work_mem='1GB'; SET synchronous_commit=off; SET work_mem='256MB'");

  // Conversations over the last 120 days. Workspace w0 is the largest; power 3 skews the rest.
  log(`seeding ${CONVERSATIONS} conversations (${PARTS} parts) across ${WORKSPACES} workspaces`);
  await q(
    "conversations",
    `CREATE UNLOGGED TABLE seed AS SELECT g, 'w'||floor(${WORKSPACES}*power(random(),3))::int AS w, 'c'||g AS id,
       '${now.toISOString()}'::timestamptz - random()*interval '120 days' AS t,
       (ARRAY['messenger','messenger','messenger','email','whatsapp','sms'])[1+floor(random()*6)::int] AS channel,
       't'||floor(random()*10)::int AS tm, (ARRAY['billing','support','sales',NULL])[1+floor(random()*4)::int] AS team,
       (300+floor(random()*3600))::bigint*1000 AS fr, random()<0.3 AS ai, random()<0.85 AS closed, (1+floor(random()*5))::int AS rating
     FROM generate_series(1,${CONVERSATIONS}) g`,
  );
  await q("sorted", "CREATE UNLOGGED TABLE seed2 AS SELECT * FROM seed ORDER BY w,id; DROP TABLE seed; ALTER TABLE seed2 RENAME TO seed; ANALYZE seed");
  await q(
    "a_conversations",
    `INSERT INTO a_conversations(workspace_id,conversation_id,brand_id,channel,started_at,first_customer_at,first_response_at,first_response_ms,first_response_business_ms,
       first_closed_at,time_to_close_ms,time_to_close_business_ms,last_closed_at,customer_messages,teammate_replies,ai_replies,closes,assignments,ai_involved,rating,status,team_id,assignee,replies_before_first_close,first_ai_at,rated_at)
     SELECT w,id,'default',channel,t,t,t+fr*interval '1 ms',fr,fr/2,CASE WHEN closed THEN t+interval '2 hours' END,CASE WHEN closed THEN 7200000 END,CASE WHEN closed THEN 3600000 END,
       CASE WHEN closed THEN t+interval '2 hours' END,2,2,CASE WHEN ai THEN 1 ELSE 0 END,CASE WHEN closed THEN 1 ELSE 0 END,1,ai,CASE WHEN closed THEN rating END,
       CASE WHEN closed THEN 'closed' ELSE 'open' END,team,tm,2,CASE WHEN ai THEN t+(fr+1800000)*interval '1 ms' END,CASE WHEN closed THEN t+interval '7500 seconds' END FROM seed`,
  );
  // Eight parts each: opened, asked, assigned, replied, asked again, replied (or Zoe), closed (or a note), rated (or a note).
  await q(
    "a_parts",
    `INSERT INTO a_parts(workspace_id,conversation_id,seq,id,kind,author_type,author_id,audience,channel,at,data)
     SELECT w,id,n,id||'-'||n,
       CASE n WHEN 1 THEN 'state_change' WHEN 2 THEN 'customer_message' WHEN 3 THEN 'assignment_change' WHEN 4 THEN 'teammate_reply' WHEN 5 THEN 'customer_message'
         WHEN 6 THEN CASE WHEN ai THEN 'ai_reply' ELSE 'teammate_reply' END WHEN 7 THEN CASE WHEN closed THEN 'state_change' ELSE 'internal_note' END
         ELSE CASE WHEN closed THEN 'rating' ELSE 'internal_note' END END,
       CASE n WHEN 2 THEN 'contact' WHEN 5 THEN 'contact' WHEN 8 THEN CASE WHEN closed THEN 'contact' ELSE 'teammate' END
         WHEN 6 THEN CASE WHEN ai THEN 'ai' ELSE 'teammate' END WHEN 4 THEN 'teammate' ELSE 'system' END,
       CASE WHEN n IN (2,5,8) THEN 'contact-'||g ELSE tm END, CASE WHEN n=7 AND NOT closed THEN 'internal' WHEN n=8 AND NOT closed THEN 'internal' ELSE 'public' END, channel,
       t + (CASE n WHEN 1 THEN 0 WHEN 2 THEN 0 WHEN 3 THEN 60000 WHEN 4 THEN fr WHEN 5 THEN fr+600000 WHEN 6 THEN fr+1800000 WHEN 7 THEN 7200000 ELSE 7500000 END)*interval '1 ms',
       CASE n WHEN 1 THEN '{"from":null,"to":"open"}'::jsonb WHEN 3 THEN jsonb_build_object('before',jsonb_build_object('teammate',null),'after',jsonb_build_object('teammate',tm,'team',team))
         WHEN 7 THEN CASE WHEN closed THEN '{"from":"open","to":"closed"}'::jsonb ELSE '{}'::jsonb END WHEN 8 THEN CASE WHEN closed THEN jsonb_build_object('value',rating) ELSE '{}'::jsonb END ELSE '{}'::jsonb END
     FROM seed, generate_series(1,${PER}) n ORDER BY w,id,n`,
  );
  await q(
    "a_states",
    `INSERT INTO a_states SELECT w,id,1,'open',t,CASE WHEN closed THEN t+interval '2 hours' END FROM seed
     UNION ALL SELECT w,id,7,'closed',t+interval '2 hours',NULL FROM seed WHERE closed`,
  );
  await q(
    "a_responses",
    `INSERT INTO a_responses SELECT w,id,2,true,t,t+fr*interval '1 ms',tm,fr,fr/2 FROM seed
     UNION ALL SELECT w,id,5,false,t+(fr+600000)*interval '1 ms',t+(fr+1800000)*interval '1 ms',tm,1200000,600000 FROM seed WHERE NOT ai`,
  );
  await q("a_handling", `INSERT INTO a_handling SELECT w,id,3,tm,t+interval '1 minute',t+interval '2 hours',7140000,3600000,1800000 FROM seed WHERE closed`);
  await q("a_snapshots", `INSERT INTO a_snapshots SELECT w,id,'contact-'||g,'user',jsonb_build_object('plan',(ARRAY['free','pro','enterprise'])[1+g%3]),t FROM seed`);
  await q(
    "a_sla",
    `INSERT INTO a_sla(workspace_id,conversation_id,metric,cycle,target_ms,state,due_at,breached_at,updated_at)
     SELECT w,id,'first_response',0,1800000,'stopped',t+interval '30 minutes',CASE WHEN fr>1800000 THEN t+interval '30 minutes' END,t+fr*interval '1 ms' FROM seed WHERE g%2=0`,
  );
  await q("a_tickets", `INSERT INTO a_tickets SELECT w,id,g,(ARRAY['bug','refund'])[1+g%2],'customer',CASE WHEN closed THEN 'resolved' ELSE 'in_progress' END,t,t+interval '1 day' FROM seed WHERE g%20=0`);
  await q("a_ai_answers", `INSERT INTO a_ai_answers SELECT w,'a'||g,id,(ARRAY['answered','answered','no_answer'])[1+g%3],t+interval '5 seconds' FROM seed WHERE ai`);
  await q("a_ai_resolutions", `INSERT INTO a_ai_resolutions SELECT w,'r'||g,'resolution',NULL,id,'confirmed',t+interval '2 hours' FROM seed WHERE ai AND closed AND g%2=0`);
  await q("a_deliveries", `INSERT INTO a_deliveries SELECT w,'d'||g,id,channel,(ARRAY['delivered','delivered','delivered','failed','suppressed'])[1+g%5],'reply',true,t+fr*interval '1 ms',t+fr*interval '1 ms' FROM seed WHERE channel<>'messenger'`);
  await q("a_calls", `INSERT INTO a_calls SELECT w,'k'||g,id,'completed',g%4=0,g%4<>0,g%3,30+g%600,t,t+(30+g%600)*interval '1 second' FROM seed WHERE g%25=0`);
  await q("a_outbound", `INSERT INTO a_outbound SELECT w,'o'||g,'m'||(g%5),'chat',CASE WHEN g%10=0 THEN 'control' ELSE 'test' END,CASE WHEN g%10=0 THEN 'held_out' ELSE 'sent' END,t,CASE WHEN g%2=0 THEN t END,CASE WHEN g%7=0 THEN t END,NULL,CASE WHEN g%9=0 THEN t END FROM seed WHERE g%4=0`);
  await q("a_searches", `INSERT INTO a_searches SELECT w,'s'||g,'help_center',g%4,g%3=0,t FROM seed WHERE g%3=0`);
  await q("a_feedback", `INSERT INTO a_feedback SELECT w,'f'||g,'article-'||(g%20),g%3<>0,t FROM seed WHERE g%10=0`);
  await q("a_teammates", `INSERT INTO a_teammates SELECT DISTINCT w,'t'||n,'Teammate '||n,'active','{}'::text[] FROM seed, generate_series(0,9) n`);
  await q("a_presence_changes", `INSERT INTO a_presence_changes SELECT w,'p'||w||n,'t'||n,'active','away','${now.toISOString()}'::timestamptz - interval '10 days' FROM (SELECT DISTINCT w FROM seed) s, generate_series(0,9) n`);
  for (const i of indexes) await q(`index ${i.indexname}`, i.indexdef);
  await q("analyze", "VACUUM ANALYZE");

  const sizes = (await owner.query("SELECT workspace_id AS w,count(*)::int AS n FROM a_parts GROUP BY 1 ORDER BY 2 DESC")).rows as { w: string; n: number }[];
  const total = sizes.reduce((s, x) => s + x.n, 0);
  const picks = [
    { role: "largest", ...sizes[0] },
    { role: "99th percentile", ...sizes[Math.floor(sizes.length * 0.01)] },
    { role: "median", ...sizes[Math.floor(sizes.length / 2)] },
  ];
  const counts = (await owner.query(
    "SELECT 'a_conversations' t,count(*)::int n FROM a_conversations UNION ALL SELECT 'a_parts',count(*) FROM a_parts UNION ALL SELECT 'a_states',count(*) FROM a_states UNION ALL SELECT 'a_responses',count(*) FROM a_responses UNION ALL SELECT 'a_handling',count(*) FROM a_handling",
  )).rows as { t: string; n: number }[];
  const version = (await owner.query("SHOW server_version")).rows[0].server_version as string;
  await owner.end();

  const store = { connect: hyperdriveConnection({ connectionString: `postgres://relay_runtime:runtime@127.0.0.1:${port}/analytics` }) };
  const periods = [
    { name: "30 days", from: new Date(now.getTime() - 30 * 86_400_000) },
    { name: "365 days", from: new Date(now.getTime() - 365 * 86_400_000) },
  ];
  type Row = { workspace: string; parts: number; period: string; report: string; charts: number; p50: number; p95: number; slowest: string; slowestP95: number };
  const results: Row[] = [];
  const pctl = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];
  for (const pick of picks)
    for (const period of periods) {
      if (pick.role !== "largest" && period.name !== "30 days") continue;
      for (const report of PREBUILT) {
        const perChart = report.charts.map(() => [] as number[]);
        const perReport: number[] = [];
        for (let run = 0; run <= RUNS; run++) {
          const s0 = performance.now();
          for (const [i, c] of report.charts.entries()) {
            const s = performance.now();
            await runMetric(store, pick.w, { metric: c.metric, from: period.from, to: now, timezone: "Europe/London", breakdown: c.breakdown });
            if (run > 0) perChart[i].push(performance.now() - s); // run 0 warms the cache
          }
          if (run > 0) perReport.push(performance.now() - s0);
        }
        const chartP95 = perChart.map((xs) => pctl(xs, 95));
        const worst = chartP95.indexOf(Math.max(...chartP95));
        const c = report.charts[worst];
        results.push({
          workspace: pick.role,
          parts: pick.n,
          period: period.name,
          report: report.name,
          charts: report.charts.length,
          p50: pctl(perReport, 50),
          p95: pctl(perReport, 95),
          slowest: c.metric + (c.breakdown ? ` by ${c.breakdown}` : ""),
          slowestP95: chartP95[worst],
        });
        log(pick.role, period.name, report.name, `report p95 ${Math.round(pctl(perReport, 95))} ms`, `slowest chart ${c.metric} ${Math.round(chartP95[worst])} ms`);
      }
    }

  const ms = (x: number) => `${Math.round(x)} ms`;
  const over = results.filter((r) => r.slowestP95 > TARGET_MS);
  const doc = `# Reporting benchmark

Generated by \`node --import tsx scripts/reporting-benchmark.ts ${PARTS} ${WORKSPACES}\` (phase 14, step R2; see
\`docs/REPORTING_STEP2.md\`). Don't edit by hand: rerun the script.

**Machine:** ${cpus()[0]?.model ?? "unknown"}, ${cpus().length} cores, ${Math.round(totalmem() / 2 ** 30)} GB; PostgreSQL ${version} (embedded, default settings), on the same machine.
**Data:** ${total.toLocaleString("en-GB")} parts in ${sizes.length.toLocaleString("en-GB")} workspaces (${CONVERSATIONS.toLocaleString("en-GB")} conversations over 120 days). Sizes are skewed:
${picks.map((p) => `the ${p.role} workspace has ${p.n.toLocaleString("en-GB")} parts`).join(", ")}.
${counts.map((c) => `\`${c.t}\` ${c.n.toLocaleString("en-GB")}`).join(", ")} rows.
**Method:** each chart is one \`runMetric\` call (the period, the previous period and the breakdown, three queries) as the runtime
role with row-level security on, timezone Europe/London. Each report's charts run one after another; one warm-up run, then ${RUNS} timed.
A report's time is all its charts in sequence (R3 can run them in parallel). The target is the codebase's rule, 200 ms at p95, per chart.

**Result:** ${over.length ? `${over.length} report${over.length > 1 ? "s" : ""} had a chart over ${TARGET_MS} ms at p95 (below).` : `every chart of every pre-built report answered within ${TARGET_MS} ms at p95.`}

| Workspace | Parts | Period | Report | Charts | Report p50 | Report p95 | Slowest chart | Its p95 |
|---|---:|---|---|---:|---:|---:|---|---:|
${results.map((r) => `| ${r.workspace} | ${r.parts.toLocaleString("en-GB")} | ${r.period} | ${r.report} | ${r.charts} | ${ms(r.p50)} | ${ms(r.p95)} | ${r.slowest} | ${r.slowestP95 > TARGET_MS ? "**" + ms(r.slowestP95) + "**" : ms(r.slowestP95)} |`).join("\n")}
`;
  writeFileSync("docs/REPORTING_BENCHMARK.md", doc);
  log("wrote docs/REPORTING_BENCHMARK.md");
} finally {
  await pg.stop();
}
process.exit(0);

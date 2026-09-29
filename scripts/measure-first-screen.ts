/**
 * Agent inbox acceptance measurements (phase 4, plan §2.5 items 1 and 2), local only.
 *
 * 1. First screen: time from selecting a conversation to the animation frame after its first
 *    screen renders, from the app's `relay:first-screen` performance measures. 100 warm
 *    selections (each conversation opened once before) and 100 cold ones in a fresh page.
 *    Half are made by click and half by keyboard (focus, then Enter).
 * 2. Virtualisation: scroll the full 10,000-row "All open" view and record mounted rows,
 *    long tasks and frame intervals.
 *
 * Run after building bundles: npm run messenger:build && npm run agent:build &&
 *   node --import tsx scripts/measure-first-screen.ts
 * Uses embedded PostgreSQL (PGlite) and headless Chromium on this machine. Not a hosted figure.
 */
import { chromium, type Page } from "@playwright/test";
import { cpus, totalmem, platform, release } from "node:os";
import { startLocalRelay } from "./local-relay";
import { tenant } from "../server/db";
import { mutateView, rebuildViews } from "../server/inbox-views";
import { runJob } from "../server/jobs";

const ROWS = 10_000,
  TARGETS = 100,
  LONG = 20,
  LONG_PARTS = 500,
  MERGED = 10;

const relay = await startLocalRelay({
  apiPort: 8904,
  hostPort: 8905,
  inboxViews: true,
});
const sql = (text: string, values: unknown[] = []) =>
  tenant(relay.db.connect, "demo", (db) => db.query(text, values));
const id = (i: number) => "fs-" + String(i).padStart(5, "0");

// 10,000 open conversations; the newest 100 are the selection targets. Of those, 20 have
// 500 parts each and 10 have another conversation merged into them.
await sql(
  `INSERT INTO conversations(workspace_id,id,brand_id,token_hash,name,email,title,status,assigned,created_at,updated_at)
  SELECT 'demo','fs-'||lpad(i::text,5,'0'),'default','','Customer '||i,'','First screen '||i,'open','',
  timestamptz '2026-09-01T00:00:00Z'+(i||' seconds')::interval,now() FROM generate_series(1,$1::int) i`,
  [ROWS],
);
const targets = Array.from({ length: TARGETS }, (_, i) => id(ROWS - i));
const parts = (conversation: string, count: number, label: string) =>
  sql(
    `INSERT INTO conversation_parts(workspace_id,id,conversation_id,seq,kind,author_type,author_id,audience,channel,body,created_at)
    SELECT 'demo',$1||'-p'||i,$1,i,CASE WHEN i%7=0 THEN 'internal_note' WHEN i%2=0 THEN 'teammate_reply' ELSE 'customer_message' END,
    CASE WHEN i%2=0 THEN 'teammate' ELSE 'contact' END,'x',CASE WHEN i%7=0 THEN 'internal' ELSE 'public' END,'messenger',
    $3||' message '||i,timestamptz '2026-09-10T00:00:00Z'+(i||' seconds')::interval FROM generate_series(1,$2::int) i`,
    [conversation, count, label],
  );
for (const [i, t] of targets.entries())
  await parts(t, i < LONG ? LONG_PARTS : 12, t);
for (let i = 0; i < MERGED; i++) {
  const target = targets[LONG + i],
    source = id(ROWS - TARGETS - 1 - i);
  await parts(source, 30, source);
  await sql(
    "UPDATE conversations SET merged_into_id=$2 WHERE workspace_id='demo' AND id=$1",
    [source, target],
  );
  await sql(
    "UPDATE conversations SET timeline_revision=timeline_revision+1 WHERE workspace_id='demo' AND id=$1",
    [target],
  );
}
// Rebuild the view lists once instead of projecting 10,000 inserts in 100-row batches.
await sql("DELETE FROM inbox_projection_dirty WHERE workspace_id='demo'");
await sql("UPDATE inbox_filter_sets SET ready=false WHERE workspace_id='demo'");
const { jobId } = (await tenant(relay.db.connect, "demo", (db) =>
  mutateView(db, "demo", "local-owner", "measure-rebuild", {
    action: "initialize",
  }),
)) as { jobId: string | null };
while (
  jobId &&
  (
    await runJob(relay.db.connect, "demo", jobId, {
      "inbox.views.rebuild": (job) => rebuildViews(relay.db.connect, job),
    })
  ).state === "queued"
);
await relay.db.pg.exec("ANALYZE");

const browser = await chromium.launch();
const quantile = (xs: number[], q: number) =>
  [...xs].sort((a, b) => a - b)[
    Math.min(xs.length - 1, Math.floor(xs.length * q))
  ];
const summary = (xs: number[]) => ({
  n: xs.length,
  p50: +quantile(xs, 0.5).toFixed(1),
  p95: +quantile(xs, 0.95).toFixed(1),
  p99: +quantile(xs, 0.99).toFixed(1),
  max: +Math.max(...xs).toFixed(1),
});

async function openInbox() {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  await page.goto(relay.hostOrigin + "/agent");
  await page.getByRole("status").filter({ hasText: "● Live" }).waitFor();
  await page
    .getByRole("navigation", { name: "Inbox views" })
    // Merged conversations are excluded from lists, so the open count is ROWS - MERGED.
    .getByRole("button", { name: new RegExp(`^All open.*${ROWS - MERGED}`) })
    .click({ timeout: 60_000 });
  await page
    .getByTestId("virtual-conversations")
    .getByRole("button")
    .first()
    .waitFor();
  return page;
}
/** Scrolls the virtual list to target row `index` and selects it by click or keyboard. */
async function select(page: Page, index: number, keyboard: boolean) {
  const list = page.getByTestId("virtual-conversations");
  await list.evaluate((el, top) => el.scrollTo(0, top), index * 86);
  const row = list.getByRole("button", {
    name: new RegExp(`First screen ${ROWS - index}\\b`),
  });
  await row.waitFor();
  const before = await page.evaluate(
    () => performance.getEntriesByName("relay:first-screen").length,
  );
  if (keyboard) {
    await row.focus();
    await page.keyboard.press("Enter");
  } else await row.click();
  await page.waitForFunction(
    (n) => performance.getEntriesByName("relay:first-screen").length > n,
    before,
  );
  return page.evaluate(() => {
    const e = performance.getEntriesByName("relay:first-screen").at(-1)!;
    return {
      ms: e.duration,
      cached: (e as PerformanceMeasure).detail.cached as boolean,
    };
  });
}
async function run(page: Page) {
  const out = [];
  for (let i = 0; i < TARGETS; i++)
    out.push(await select(page, i, i % 2 === 1));
  return out;
}

// Warm: open every target once, then measure a second pass. The cache holds 50, so the warm
// pass walks the targets in blocks of 50: warm a block, then measure that block.
const warmPage = await openInbox();
const warm: { ms: number; cached: boolean }[] = [];
for (let block = 0; block < TARGETS; block += 50) {
  for (let i = block; i < block + 50; i++) await select(warmPage, i, false);
  for (let i = block; i < block + 50; i++)
    warm.push(await select(warmPage, i, i % 2 === 1));
}
await warmPage.close();

// Cold: a fresh page, so an empty cache. The mouse is not left hovering, so no prefetch.
relay.db.resetMeasurements();
const coldPage = await openInbox();
const cold = await run(coldPage);
const serverStatements = relay.db.statementTimings().slice(0, 5);
await coldPage.close();

// Report selection timing now, so a later failure does not lose it.
console.error(
  "first screen",
  JSON.stringify({
    warm: summary(warm.map((w) => w.ms)),
    cold: summary(cold.map((c) => c.ms)),
  }),
);

// Virtualisation. Phase 1: load all pages by jumping to the bottom until no cursor remains.
const scrollPage = await openInbox();
const list = scrollPage.getByTestId("virtual-conversations");
const loaded = () =>
  list.evaluate(
    (el) => (el.firstElementChild as HTMLElement).offsetHeight / 86,
  );
const more = list.getByRole("button", { name: "Load more conversations" });
// Scroll events that land while a page is loading are ignored by the list, so use its
// explicit "Load more" control until no cursor remains.
while (await more.count()) {
  const before = await loaded();
  await more.click();
  await scrollPage.waitForFunction(
    ([n]) =>
      (
        document.querySelector('[data-testid="virtual-conversations"]')!
          .firstElementChild as HTMLElement
      ).offsetHeight /
        86 >
      n,
    [before],
    { timeout: 30_000 },
  ).catch(async (e) => {
    console.error(
      "paging stalled at",
      before,
      "rows; alerts:",
      await scrollPage.getByRole("alert").allTextContents(),
      "more:",
      await more.count(),
    );
    throw e;
  });
}
const loadedRows = await loaded();
// Phase 2: scroll top to bottom one screen per frame inside the page, recording frame
// intervals, long tasks and the most rows mounted at once. Passed as a string: tsx adds a
// __name helper to named functions, which the page lacks.
const scrollStats = (await scrollPage.evaluate(`new Promise((done) => {
  const el = document.querySelector('[data-testid="virtual-conversations"]');
  const longTasks = [], frames = [];
  let mounted = 0, last = performance.now();
  new PerformanceObserver((l) => l.getEntries().forEach((e) => longTasks.push(e.duration)))
    .observe({ type: "longtask" });
  el.scrollTo(0, 0);
  const step = (now) => {
    frames.push(now - last);
    last = now;
    mounted = Math.max(mounted, el.querySelectorAll(".pg-row").length);
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2)
      return done({ longTasks, frames: frames.slice(1), mounted });
    el.scrollBy(0, el.clientHeight);
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
})`)) as { longTasks: number[]; frames: number[]; mounted: number };
await scrollPage.close();

const result = {
  environment: {
    cpu: cpus()[0]?.model,
    cores: cpus().length,
    memoryGb: Math.round(totalmem() / 2 ** 30),
    os: platform() + " " + release(),
    browser: "Chromium " + browser.version(),
    database: "PGlite (embedded PostgreSQL, WebAssembly)",
  },
  fixture: {
    rows: ROWS,
    targets: TARGETS,
    longConversations: `${LONG} × ${LONG_PARTS} parts`,
    mergedConversations: MERGED,
  },
  warm: {
    ...summary(warm.map((w) => w.ms)),
    cacheHitRate: warm.filter((w) => w.cached).length / warm.length,
  },
  cold: {
    ...summary(cold.map((c) => c.ms)),
    cacheHitRate: cold.filter((c) => c.cached).length / cold.length,
  },
  coldServerTopStatements: serverStatements.map((s) => ({
    statement: s.statement,
    calls: s.calls,
    totalMs: +s.totalMs.toFixed(1),
    maxMs: +s.maxMs.toFixed(1),
  })),
  virtualisation: {
    loadedRows,
    maxMountedRows: scrollStats.mounted,
    longTasks: scrollStats.longTasks.length,
    longestTaskMs: +Math.max(0, ...scrollStats.longTasks).toFixed(1),
    frameMs: summary(scrollStats.frames),
  },
};
console.log(JSON.stringify(result, null, 2));
await browser.close();
await relay.close();

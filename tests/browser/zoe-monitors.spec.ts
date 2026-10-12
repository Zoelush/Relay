import { test, expect } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { getIdentity } from "../../server/people";
import { command } from "../../server/conversations";

/** Zoe's monitors and incidents (phase 08, C2b; docs/AI_STEP12.md). */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9018, hostPort: 9019, inboxViews: true });
});
test.afterAll(async () => {
  await relay?.close();
});
const sql = <T = any>(text: string, values: unknown[] = []) =>
  tenant(relay.db.connect, "demo", async (db) => (await db.query<T>(text, values)).rows);
let n = 0;
/** Answers Zoe gave this many hours ago, each in its own conversation. */
async function answers(count: number, outcome: string, hoursAgo: number) {
  for (let i = 0; i < count; i++)
    await tenant(relay.db.connect, "demo", async (q) => {
      const identity = await getIdentity(q, "demo", "anonymous", `monitor-customer-${++n}`);
      const { conversationId } = (await command(
        q,
        "demo",
        { type: "contact", identityId: identity.identityId, brandId: "default" },
        `monitor-start-${n}`,
        { action: "start", text: `Monitor question ${n}` },
      )) as { conversationId: string };
      const part = (
        await q.query<{ id: string }>(
          "SELECT id FROM conversation_parts WHERE workspace_id='demo' AND conversation_id=$1 ORDER BY created_at LIMIT 1",
          [conversationId],
        )
      ).rows[0];
      await q.query(
        `INSERT INTO ai_answers(workspace_id,id,agent_id,conversation_id,question_part_id,outcome,reason,threshold,prompt_version,created_at)
         SELECT 'demo',$1,id,$2,$3,$4,'test',0.5,'test',now()-make_interval(hours=>$5) FROM ai_agents WHERE workspace_id='demo'
         ON CONFLICT DO NOTHING`,
        [`monitor-answer-${n}`, conversationId, part.id, outcome, hoursAgo],
      );
    });
}
/** A usual week, then a day of "I don't know"; the next sweep checks again and opens an incident. */
async function sharpChange() {
  await sql("INSERT INTO ai_agents(workspace_id,id,name) VALUES('demo','default','Zoe') ON CONFLICT DO NOTHING");
  // The agent's flag is off while these are written, so Zoe doesn't answer them herself; the
  // answers written here stand in for hers.
  await sql("UPDATE workspace_features SET enabled=false WHERE name='ai_agent_v1'");
  await answers(30, "answered", 60);
  await answers(15, "answered", 3);
  await answers(10, "unknown", 2);
  await sql("UPDATE workspace_features SET enabled=true WHERE name='ai_agent_v1'");
  await sql("DELETE FROM ai_monitor_checks");
  await sql("DELETE FROM ai_monitor_runs");
  await expect
    .poll(async () => (await sql("SELECT 1 FROM ai_incidents WHERE status<>'resolved'")).length, { timeout: 15000 })
    .toBe(1);
}

test("a sharp rise in “I don't know” opens an incident: her managers are notified, see why on the Overview and Incidents, acknowledge it and resolve it", async ({
  page,
}) => {
  await sharpChange();
  await page.goto(relay.hostOrigin + "/agent");
  const bell = page.getByRole("button", { name: /^Notifications, \d+ unread$/ });
  await expect(bell).toHaveAccessibleName("Notifications, 1 unread", { timeout: 15000 });
  await bell.click();
  const item = page
    .getByRole("dialog", { name: "Notifications" })
    .getByRole("button", { name: /Incident: Zoe's behaviour changed sharply/ });
  await expect(item).toContainText("“I don't know” rate rose from");
  await item.click();

  // Incidents: the numbers, examples and what changed; acknowledged, then resolved.
  const incident = page.getByRole("listitem", { name: /^“I don't know” rate rose from/ });
  await expect(incident).toContainText("Open");
  await expect(incident.getByRole("region", { name: "Example conversations" }).getByRole("button")).toHaveCount(5);
  await expect(incident.getByRole("region", { name: "What changed shortly before" })).toBeVisible();
  await incident.getByLabel("Note (optional)").fill("Checking the new returns article.");
  await incident.getByRole("button", { name: "Acknowledge" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Acknowledged." })).toBeVisible();
  await expect(incident).toContainText("Acknowledged by Support teammate");
  await expect(incident).toContainText("“Checking the new returns article.”");

  // The Overview's banner, and Monitors showing the change.
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  const banner = page.getByRole("status", { name: "Open incidents" });
  await expect(banner).toContainText("1 open incident");
  await page.getByRole("button", { name: "Monitors", exact: true }).click();
  const monitor = page.getByRole("listitem", { name: "“I don't know” rate" });
  await expect(monitor).toContainText("Incident open");
  await expect(monitor).toContainText("40%");
  await monitor.getByRole("button", { name: "View the incident" }).click();

  await page.getByRole("listitem", { name: /^“I don't know” rate rose from/ }).getByRole("button", { name: "Resolve" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Resolved." })).toBeVisible();
  await expect(page.getByText("No open incidents.", { exact: false })).toBeVisible();
  await expect(page.getByRole("list", { name: "Resolved incidents" })).toContainText("resolved by Support teammate");
  expect(await sql("SELECT status,resolution FROM ai_incidents")).toEqual([{ status: "resolved", resolution: "manual" }]);
});

test("acknowledging an incident someone else just resolved: told it changed, and shown it resolved", async ({
  browser,
}) => {
  await sql("DELETE FROM ai_monitor_checks");
  await sql("DELETE FROM ai_monitor_runs");
  await expect
    .poll(async () => (await sql("SELECT 1 FROM ai_incidents WHERE status<>'resolved'")).length, { timeout: 15000 })
    .toBe(1);
  const open = async () => {
    const page = await (await browser.newContext()).newPage();
    await page.goto(relay.hostOrigin + "/agent#zoe/incidents");
    await expect(page.getByRole("list", { name: "Open incidents" }).getByRole("listitem", { name: /rate rose/ })).toHaveCount(1, {
      timeout: 15000,
    });
    return page;
  };
  const first = await open();
  const second = await open();
  await first.getByRole("button", { name: "Resolve" }).click();
  await expect(first.getByRole("status").filter({ hasText: "Resolved." })).toBeVisible();

  await second.getByRole("button", { name: "Acknowledge" }).click();
  await expect(second.getByRole("alert")).toHaveText("This incident changed. Reload to see it.");
  await expect(second.getByText("No open incidents.", { exact: false })).toBeVisible();
  expect(await sql("SELECT count(*)::int AS n FROM ai_incidents WHERE status='acknowledged'")).toEqual([{ n: 0 }]);
});

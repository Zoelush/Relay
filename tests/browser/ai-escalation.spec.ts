import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";

/** Escalation rules, never-handle topics and guidance (phase 08, A2b; docs/AI_STEP3.md). */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({
    apiPort: 9002,
    hostPort: 9003,
    inboxViews: true,
  });
  // No office hours, so the outcome doesn't depend on the day the test runs.
  await sql("DELETE FROM calendar_assignments");
  await sql("UPDATE brands SET settings=settings-'calendarId'-'calendarVersion'");
});
test.afterAll(async () => {
  await relay?.close();
});
const sql = <T = any>(text: string, values: unknown[] = []) =>
  tenant(
    relay.db.connect,
    "demo",
    async (db) => (await db.query<T>(text, values)).rows,
  );
async function settings(page: Page) {
  await page.goto(relay.hostOrigin + "/agent#settings/ai-agent");
  await expect(page.getByRole("heading", { name: "Never-handle topics" })).toBeVisible({
    timeout: 15000,
  });
}
async function messenger(page: Page) {
  await expect
    .poll(
      async () =>
        (
          await sql(
            "SELECT 1 FROM knowledge_index_generations WHERE status='active'",
          )
        ).length,
      { timeout: 30000 },
    )
    .toBe(1);
  await page.goto(relay.hostOrigin);
  await page.getByRole("button", { name: "Open support", exact: true }).click();
  await expect
    .poll(() =>
      page.frames().some((f) => f.url().includes("/messenger/frame.html")),
    )
    .toBe(true);
  return page.frames().find((f) => f.url().includes("/messenger/frame.html"))!;
}

test("a never-handle topic added in Settings sends a customer's question straight to the team, with the topic in the teammate's summary", async ({
  page,
  browser,
}) => {
  const manager = await (await browser.newContext()).newPage();
  await settings(manager);
  await manager.getByRole("button", { name: "Add topic" }).click();
  await manager.getByLabel("Topic 1 name").fill("Legal");
  await manager
    .getByLabel("Topic 1 description")
    .fill("Complaints that mention lawyers or legal action");
  await manager.getByLabel("Topic 1 keywords").fill("lawyer, solicitor");
  await manager.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    manager.getByRole("status").filter({ hasText: "Saved" }),
  ).toBeVisible();
  expect(
    (await sql("SELECT never_handle FROM ai_agents WHERE id='default'"))[0]
      .never_handle,
  ).toEqual([
    {
      name: "Legal",
      description: "Complaints that mention lawyers or legal action",
      keywords: ["lawyer", "solicitor"],
    },
  ]);

  // The customer: no answer from content, straight to the team.
  const frame = await messenger(page);
  await frame.getByRole("button", { name: "Start a conversation" }).click();
  await frame
    .getByRole("textbox", { name: "Write your message" })
    .fill("My lawyer asks when replies usually arrive");
  await frame.getByRole("button", { name: "Send message" }).click();
  await expect(
    frame.getByText(
      "I'm connecting you with someone from the team. They'll reply here.",
    ),
  ).toBeVisible({ timeout: 20000 });
  await expect(frame.getByText(/Replies usually arrive within an hour/)).toHaveCount(0);

  // The teammate: the summary names the topic.
  const inbox = await (await browser.newContext()).newPage();
  await inbox.goto(relay.hostOrigin + "/agent");
  await inbox
    .getByRole("navigation", { name: "Inbox views" })
    .getByRole("button", { name: /Escalated by AI/ })
    .click();
  await inbox
    .locator(".pg-card", { hasText: "My lawyer asks when replies usually arrive" })
    .click();
  await expect(
    inbox
      .locator(".pg-message")
      .filter({ hasText: "AI handover summary · Team only" }),
  ).toContainText(
    "Handed over by the AI agent. The message is about a never-handle topic: “Legal”.",
  );
});

test("an escalation rule without an email domain is refused with the reason, and nothing is saved", async ({
  page,
}) => {
  await settings(page);
  await page.getByRole("button", { name: "Add rule" }).click();
  await page.getByLabel("Rule 1 name").fill("Big Corp");
  await page
    .getByLabel("Rule 1 condition 1 field")
    .selectOption({ label: "Email domain" });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "“Big Corp”: give an email domain such as example.com.",
  );
  expect(
    (await sql("SELECT count(*)::int AS n FROM ai_escalation_rules"))[0].n,
  ).toBe(0);
  // Fixed, it saves.
  await page.getByLabel("Rule 1 condition 1 value").fill("bigcorp.com");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  expect(
    (await sql("SELECT name FROM ai_escalation_rules"))[0].name,
  ).toBe("Big Corp");
});

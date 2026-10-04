import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";

/** Zoe in the agent app (phase 08, Z1; docs/AI_STEP5.md). */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({
    apiPort: 9006,
    hostPort: 9007,
    inboxViews: true,
  });
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
async function indexReady() {
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
}
/** A customer asks in the messenger; returns the frame. */
async function ask(page: Page, text: string) {
  await indexReady();
  await page.goto(relay.hostOrigin);
  await page.getByRole("button", { name: "Open support", exact: true }).click();
  await expect
    .poll(() =>
      page.frames().some((f) => f.url().includes("/messenger/frame.html")),
    )
    .toBe(true);
  const frame = page
    .frames()
    .find((f) => f.url().includes("/messenger/frame.html"))!;
  await frame.getByRole("button", { name: "Start a conversation" }).click();
  await frame.getByRole("textbox", { name: "Write your message" }).fill(text);
  await frame.getByRole("button", { name: "Send message" }).click();
  return frame;
}

test("Zoe has her own place between Inbox and Knowledge: an overview with what she couldn't answer, a playground that answers like she would, and an identity customers see", async ({
  page,
  browser,
}) => {
  // A customer asks something she can't answer: it shows as a knowledge gap.
  const frame = await ask(page, "Can I pay for my plan with bitcoin?");
  await expect(
    frame.locator(".message").filter({ hasText: "couldn't find an answer" }),
  ).toBeVisible({ timeout: 20000 });

  const agent = await (await browser.newContext()).newPage();
  await agent.goto(relay.hostOrigin + "/agent");
  // The strip: Inbox, Zoe, Knowledge, each in its own colour.
  const rail = agent.getByRole("navigation", { name: "Main" });
  const items = rail.locator(".pg-rail-items .pg-rail-item");
  await expect(items).toHaveCount(3, { timeout: 15000 });
  await expect(items.nth(0)).toHaveAttribute("data-hue", "blue");
  await expect(items.nth(1)).toHaveAttribute("data-hue", "zoe");
  await expect(items.nth(1)).toHaveAccessibleName("Zoe, AI agent");
  await expect(items.nth(2)).toHaveAttribute("data-hue", "amber");
  await items.nth(1).click();
  await expect(agent).toHaveURL(/#zoe$/);

  // Overview: live, her numbers, and the gap.
  const overview = agent.getByRole("region", { name: "Overview" });
  await expect(overview.getByRole("heading", { level: 2 })).toContainText("Zoe");
  await expect(overview.getByRole("switch", { name: /Answering customers/ })).toBeChecked();
  await expect(overview.getByText("Resolution rate")).toBeVisible();
  await expect(
    overview.getByRole("list", { name: "Knowledge gaps" }),
  ).toContainText("Can I pay for my plan with bitcoin?");

  // Playground: an answer from the help center, with her confidence and source.
  await agent
    .getByRole("navigation", { name: "Zoe's pages" })
    .getByRole("button", { name: "Playground" })
    .click();
  await expect(agent).toHaveURL(/#zoe\/playground$/);
  await agent
    .getByLabel("Question", { exact: true })
    .fill("When do replies usually arrive?");
  await agent.getByRole("button", { name: "Ask", exact: true }).click();
  const reply = agent.getByRole("region", { name: "Zoe's reply" });
  await expect(reply).toContainText("Replies usually arrive within an hour", {
    timeout: 15000,
  });
  await expect(reply).toContainText("Answered from content");
  await expect(reply.getByRole("list", { name: "Sources" })).toContainText(
    "Getting started with Relay",
  );
  await expect(reply.getByRole("meter", { name: "Confidence" })).toBeVisible();
  // Nothing was sent or recorded.
  expect(
    (
      await sql(
        "SELECT 1 FROM conversation_parts WHERE body='When do replies usually arrive?'",
      )
    ).length,
  ).toBe(0);

  // Settings: she becomes Ada on the default brand; customers see Ada on her replies.
  await agent
    .getByRole("navigation", { name: "Zoe's pages" })
    .getByRole("button", { name: "Settings" })
    .click();
  const name = agent.getByLabel(/^Name on /);
  await name.fill("Ada");
  await agent
    .getByLabel(/^AI disclosure on /)
    .fill("I'm Ada, an AI agent. I'll bring in the team when I can't help.");
  await agent.getByRole("button", { name: /^Save identity on / }).click();
  await expect(agent.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  // The app relabels her at once.
  await expect(items.nth(1)).toHaveAccessibleName("Ada, AI agent");

  const customer = await (await browser.newContext()).newPage();
  const second = await ask(customer, "When do replies usually arrive?");
  const answer = second
    .locator(".message")
    .filter({ hasText: "Replies usually arrive within an hour" });
  await expect(answer).toBeVisible({ timeout: 20000 });
  await expect(answer.locator("small.ai-from")).toContainText("Ada");
  await expect(answer.locator("small.ai-from")).toContainText("AI agent");
  await expect(answer.locator("small.ai-disclosure")).toHaveText(
    "I'm Ada, an AI agent. I'll bring in the team when I can't help.",
  );
});

test("an identity without a name is refused with the reason, and her name doesn't change", async ({
  page,
}) => {
  await page.goto(relay.hostOrigin + "/agent#zoe/settings");
  const name = page.getByLabel(/^Name on /);
  await expect(name).toBeVisible({ timeout: 15000 });
  const before = (await sql<{ name: string }>("SELECT name FROM ai_agents WHERE id='default'"))[0].name;
  await name.fill("");
  await page.getByRole("button", { name: /^Save identity on / }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Keep the name to 40 characters, and give it one.",
  );
  expect(
    (await sql<{ name: string }>("SELECT name FROM ai_agents WHERE id='default'"))[0].name,
  ).toBe(before);
});

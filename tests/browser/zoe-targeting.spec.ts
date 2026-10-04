import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";

/** Content targeting: who Zoe uses content for (phase 08, Z3b; docs/AI_STEP8.md). */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({
    apiPort: 9012,
    hostPort: 9013,
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
async function openArticle(page: Page) {
  await page.goto(relay.hostOrigin + "/agent");
  await page.getByRole("button", { name: "Knowledge" }).click();
  await page.getByRole("button", { name: /Getting started with Relay/ }).click();
  return page.getByRole("region", { name: "Settings" });
}

test("an article targeted at signed-in customers: Zoe skips it for a visitor and says so, uses it for a signed-in customer, and teammates see why", async ({
  page,
  browser,
}) => {
  await indexReady();
  const settings = await openArticle(page);
  const targeting = settings.getByRole("group", { name: "Who Zoe uses it for" });
  await targeting.getByRole("radio", { name: /^Only customers and conversations that match/ }).check();
  // The first condition starts as "signed in: yes".
  await expect(targeting.getByLabel("Targeting condition 1 field")).toHaveValue("signed_in");
  await settings.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Settings saved.")).toBeVisible();

  // The Playground: a visitor doesn't get it, and she says what she skipped; a signed-in customer does.
  await page.goto(relay.hostOrigin + "/agent#zoe/playground");
  await page.getByLabel("Question", { exact: true }).fill("When do replies usually arrive?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  const reply = page.getByRole("region", { name: "Zoe's reply" });
  await expect(reply).toContainText("Said she didn't know", { timeout: 15000 });
  await expect(reply).toContainText("Skipped for this customer: Getting started with Relay.");
  await page.getByLabel("Customer", { exact: true }).selectOption("user");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(reply).toContainText("Replies usually arrive within an hour", { timeout: 15000 });
  await expect(reply).not.toContainText("Skipped for this customer");

  // Her Content page marks it, with its conditions in words.
  await page.goto(relay.hostOrigin + "/agent#zoe/content");
  await expect(
    page.getByRole("list", { name: "Content she can use" }).getByRole("listitem").filter({ hasText: "Getting started with Relay" }),
  ).toContainText(/Targeted\s*Only when Signed in/);

  // A visitor in the messenger: she doesn't use it, and the teammate sees why.
  const customer = await (await browser.newContext()).newPage();
  await customer.goto(relay.hostOrigin);
  await customer.getByRole("button", { name: "Open support", exact: true }).click();
  await expect
    .poll(() => customer.frames().some((f) => f.url().includes("/messenger/frame.html")))
    .toBe(true);
  const frame = customer.frames().find((f) => f.url().includes("/messenger/frame.html"))!;
  await frame.getByRole("button", { name: "Start a conversation" }).click();
  await frame.getByRole("textbox", { name: "Write your message" }).fill("When do replies usually arrive?");
  await frame.getByRole("button", { name: "Send message" }).click();
  await expect(frame.locator(".message").filter({ hasText: "couldn't find an answer" })).toBeVisible({
    timeout: 20000,
  });
  const inbox = await (await browser.newContext()).newPage();
  await inbox.goto(relay.hostOrigin + "/agent");
  await inbox.locator(".pg-card", { hasText: "When do replies usually arrive?" }).click();
  const message = inbox.locator(".pg-message").filter({ hasText: "couldn't find an answer" });
  await message.getByRole("button", { name: "Why this reply" }).click();
  await expect(message.locator(".pg-ai-why")).toContainText(
    "Kept 1 item from her for this customer: Getting started with Relay",
  );
});

test("a targeting condition without its value is refused with the reason, and nothing changes", async ({
  page,
}) => {
  const settings = await openArticle(page);
  const before = (
    await sql<{ ai_conditions: unknown[] }>(
      "SELECT r.ai_conditions FROM knowledge_records r JOIN knowledge_locales l ON l.workspace_id=r.workspace_id AND l.record_id=r.id WHERE l.published_title='Getting started with Relay'",
    )
  )[0].ai_conditions;
  const targeting = settings.getByRole("group", { name: "Who Zoe uses it for" });
  await targeting.getByRole("radio", { name: /^Only customers and conversations that match/ }).check();
  await targeting.getByLabel("Targeting condition 1 field").selectOption("email_domain");
  await settings.getByRole("button", { name: "Save settings" }).click();
  await expect(settings.getByRole("status")).toContainText(
    "“Getting started with Relay”: give an email domain such as example.com.",
  );
  expect(
    (
      await sql<{ ai_conditions: unknown[] }>(
        "SELECT r.ai_conditions FROM knowledge_records r JOIN knowledge_locales l ON l.workspace_id=r.workspace_id AND l.record_id=r.id WHERE l.published_title='Getting started with Relay'",
      )
    )[0].ai_conditions,
  ).toEqual(before);
});

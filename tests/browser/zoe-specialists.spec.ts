import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";

/** Zoe's specialists: Train › Specialists (phase 08, Z3a; docs/AI_STEP7.md). */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({
    apiPort: 9010,
    hostPort: 9011,
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

test("a Billing specialist: tried unsaved, added, takes a refund question by keyword from her own knowledge; customers still see Zoe, teammates see Billing", async ({
  page,
  browser,
}) => {
  await indexReady();
  await page.goto(relay.hostOrigin + "/agent#zoe");
  await page
    .getByRole("navigation", { name: "Zoe's pages" })
    .getByRole("button", { name: "Specialists" })
    .click();
  await expect(page).toHaveURL(/#zoe\/specialists$/);

  // A new specialist: her job, keywords, only the Billing collection, the Billing team.
  await page.getByRole("button", { name: "New specialist" }).click();
  const editor = page.getByRole("region", { name: "New specialist" });
  await editor.getByLabel("Name").fill("Billing");
  await editor.getByLabel("What she handles").fill("Invoices, payments, refunds and plan changes.");
  await editor.getByLabel("Keywords").fill("refund, invoice");
  await editor.getByRole("radio", { name: /^Only these/ }).check();
  await editor.getByRole("group", { name: /^Collections in / }).getByLabel("Billing").check();
  await editor.getByLabel("Hands over to").selectOption({ label: "Billing" });

  // Try it, unsaved: as Billing she can't use the getting-started article.
  const tryIt = page.getByRole("complementary", { name: "Try it" });
  await expect(tryIt).toContainText("As Billing, unsaved");
  await tryIt.getByLabel("Question to try").fill("When do replies usually arrive?");
  await tryIt.getByRole("button", { name: "Ask", exact: true }).click();
  const answer = tryIt.getByRole("region", { name: "Zoe's answer" });
  await expect(answer).toContainText("couldn't find an answer", { timeout: 15000 });
  await expect(answer).toContainText("Answered as Billing");
  expect(
    (await sql("SELECT 1 FROM conversation_parts WHERE body='When do replies usually arrive?'")).length,
  ).toBe(0);

  await editor.getByRole("button", { name: "Add specialist" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Billing is ready." })).toBeVisible();
  const card = page.getByRole("list", { name: "Specialists" }).getByRole("listitem").filter({ hasText: "Billing" });
  await expect(card).toContainText("“refund”, “invoice”");
  await expect(card).toContainText(/Hands over to\s*Billing/);

  // Let Zoe pick: the same question is hers; a refund question is Billing's, by keyword.
  await tryIt.getByLabel("Question to try").fill("When do replies usually arrive?");
  await tryIt.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(answer).toContainText("Replies usually arrive within an hour", { timeout: 15000 });
  await expect(answer).toContainText("Zoe herself: no specialist took it.");

  // A customer asks about a refund: Billing takes it, and the customer sees Zoe.
  const customer = await (await browser.newContext()).newPage();
  const frame = await ask(customer, "Can I get a refund for my last invoice?");
  const reply = frame.locator(".message").filter({ hasText: "couldn't find an answer" });
  await expect(reply).toBeVisible({ timeout: 20000 });
  await expect(reply.locator("small.ai-from")).toContainText("Zoe");
  await expect(reply.locator("small.ai-from")).not.toContainText("Billing");

  // The teammate sees which specialist answered, and why.
  const inbox = await (await browser.newContext()).newPage();
  await inbox.goto(relay.hostOrigin + "/agent");
  await inbox.locator(".pg-card", { hasText: "Can I get a refund for my last invoice?" }).click();
  const message = inbox.locator(".pg-message").filter({ hasText: "couldn't find an answer" });
  await expect(message).toContainText("Zoe · Billing · AI agent");
  await message.getByRole("button", { name: "Why this reply" }).click();
  await expect(message.locator(".pg-ai-why")).toContainText("Billing: The keyword “refund”");

  // Switched off: she shows as Off, and Zoe answers herself again.
  await card.getByRole("button", { name: "Switch off Billing" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Billing is off." })).toBeVisible();
  await expect(card).toContainText("Off");
});

test("a specialist with chosen knowledge but none chosen is refused with the reason, and isn't added", async ({
  page,
}) => {
  await page.goto(relay.hostOrigin + "/agent#zoe/specialists");
  await page.getByRole("button", { name: "New specialist" }).click();
  const editor = page.getByRole("region", { name: "New specialist" });
  await editor.getByLabel("Name").fill("Sales");
  await editor.getByLabel("What she handles").fill("Plans and pricing.");
  await editor.getByRole("radio", { name: /^Only these/ }).check();
  await editor.getByRole("button", { name: "Add specialist" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Choose what “Sales” may answer from, or all of Zoe's content.",
  );
  expect((await sql("SELECT 1 FROM ai_specialists WHERE name='Sales'")).length).toBe(0);
});

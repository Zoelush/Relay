import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";

/** Zoe's review queue and content gaps (phase 08, C2a; docs/AI_STEP11.md). */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9016, hostPort: 9017, inboxViews: true });
  await sql("DELETE FROM calendar_assignments");
  await sql("UPDATE brands SET settings=settings-'calendarId'-'calendarVersion'");
});
test.afterAll(async () => {
  await relay?.close();
});
const sql = <T = any>(text: string, values: unknown[] = []) =>
  tenant(relay.db.connect, "demo", async (db) => (await db.query<T>(text, values)).rows);
const QUESTION = "When do replies usually arrive?";

/** A visitor asks, gets Zoe's answer, and asks for a person straight after. */
async function pushBack(page: Page) {
  await expect
    .poll(async () => (await sql("SELECT 1 FROM knowledge_index_generations WHERE status='active'")).length, {
      timeout: 30000,
    })
    .toBe(1);
  await page.goto(relay.hostOrigin);
  await page.getByRole("button", { name: "Open support", exact: true }).click();
  await expect.poll(() => page.frames().some((f) => f.url().includes("/messenger/frame.html"))).toBe(true);
  const frame = page.frames().find((f) => f.url().includes("/messenger/frame.html"))!;
  await frame.getByRole("button", { name: "Start a conversation" }).click();
  await frame.getByRole("textbox", { name: "Write your message" }).fill(QUESTION);
  await frame.getByRole("button", { name: "Send message" }).click();
  await expect(frame.locator(".message").filter({ hasText: "Replies usually arrive within an hour" })).toBeVisible({
    timeout: 20000,
  });
  await frame.getByRole("button", { name: "Talk to a person" }).click();
  await expect(frame.getByText("I'm connecting you with someone from the team.", { exact: false })).toBeVisible({
    timeout: 20000,
  });
}

test("an answer the customer pushed back on reaches the queue; rated bad for missing content, it becomes a knowledge gap that's then fixed", async ({
  page,
  browser,
}) => {
  await pushBack(await (await browser.newContext()).newPage());

  // The sweep adds it within seconds; the Overview says so.
  await page.goto(relay.hostOrigin + "/agent#zoe/overview");
  const card = page.locator(".pg-zoe-action", { hasText: "Rate a sample of her answers" });
  await expect(card).toContainText("1 answer to review", { timeout: 15000 });
  await card.click();

  const queue = page.getByRole("list", { name: "Answers to review" });
  const item = queue.getByRole("listitem", { name: `Answer to “${QUESTION}”` });
  await expect(item).toContainText("Customer asked for a person next");
  await expect(item).toContainText("Replies usually arrive within an hour");
  await item.getByRole("button", { name: "Bad" }).click();
  const save = item.getByRole("button", { name: "Save rating" });
  await expect(save).toBeDisabled();
  await item.getByRole("radio", { name: /^Content missing/ }).check();
  await item.getByLabel("Note (optional)").fill("Nothing covers replies at weekends.");
  await save.click();
  await expect(page.getByRole("status").filter({ hasText: "Rated bad." })).toBeVisible();
  await expect(page.getByText("Nothing to review.", { exact: false })).toBeVisible();
  await page.getByRole("tab", { name: "Rated" }).click();
  const rated = page.getByRole("list", { name: "Rated answers" }).getByRole("listitem", { name: /^Answer to/ }).first();
  await expect(rated).toContainText("Rated bad: content missing by");
  await expect(page.getByRole("list", { name: "What was wrong" })).toContainText("Content missing");

  // Knowledge gaps: found in review, then fixed by naming the content.
  await rated.getByRole("button", { name: "In knowledge gaps" }).click();
  const gaps = page.getByRole("list", { name: "Content gaps from review" });
  const gap = gaps.getByRole("listitem").filter({ hasText: QUESTION });
  await expect(gap).toContainText("“Nothing covers replies at weekends.”");
  await gap.getByRole("button", { name: "Fixed…" }).click();
  await gap.getByLabel("Content that fixes it (optional)").selectOption({ index: 1 });
  await gap.getByRole("button", { name: "Mark fixed" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Marked fixed." })).toBeVisible();
  await expect(page.getByText("No open gaps from review.")).toBeVisible();
  expect(await sql("SELECT status FROM ai_content_gaps")).toEqual([{ status: "fixed" }]);
  // The customer's conversation has nothing a reviewer wrote.
  expect(await sql("SELECT 1 FROM conversation_parts WHERE body LIKE '%weekends%'")).toEqual([]);
});

test("two people rate the same answer: the second is told it's already rated, and sees the first rating", async ({
  browser,
}) => {
  // Only this test's answer waits (earlier ones are marked rated).
  await sql("UPDATE ai_reviews SET rating='good',rated_by='owner',rated_at=now()-interval '1 hour' WHERE rating IS NULL");
  await pushBack(await (await browser.newContext()).newPage());
  const open = async () => {
    const page = await (await browser.newContext()).newPage();
    await page.goto(relay.hostOrigin + "/agent#zoe/review");
    await expect(page.getByRole("list", { name: "Answers to review" }).getByRole("listitem", { name: /^Answer to/ })).toHaveCount(1, {
      timeout: 15000,
    });
    return page;
  };
  const first = await open();
  const second = await open();
  await first.getByRole("button", { name: "Good" }).click();
  await expect(first.getByRole("status").filter({ hasText: "Rated good." })).toBeVisible();

  await second.getByRole("button", { name: "Bad" }).click();
  await second.getByRole("radio", { name: /^Wrong/ }).check();
  await second.getByRole("button", { name: "Save rating" }).click();
  await expect(second.getByRole("alert")).toHaveText("Someone has already rated this answer.");
  await expect(second.getByText("Nothing to review.", { exact: false })).toBeVisible();
  await second.getByRole("tab", { name: "Rated" }).click();
  await expect(second.getByRole("list", { name: "Rated answers" }).getByRole("listitem", { name: /^Answer to/ }).first()).toContainText(
    "Rated good by",
  );
  expect(await sql("SELECT rating,problem FROM ai_reviews ORDER BY created_at DESC LIMIT 1")).toEqual([
    { rating: "good", problem: null },
  ]);
});

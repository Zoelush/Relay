import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { resolveQuiet } from "../../server/ai-resolutions";

/** The resolution ledger (phase 08, A3; docs/AI_STEP4.md). */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({
    apiPort: 9004,
    hostPort: 9005,
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
async function ask(page: Page, text: string) {
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
  const frame = page
    .frames()
    .find((f) => f.url().includes("/messenger/frame.html"))!;
  await frame.getByRole("button", { name: "Start a conversation" }).click();
  await frame.getByRole("textbox", { name: "Write your message" }).fill(text);
  await frame.getByRole("button", { name: "Send message" }).click();
  return frame;
}
const ledgerFor = (question: string) =>
  sql<{ kind: string; rule: string; answers: number }>(
    `SELECT r.kind,r.rule,cardinality(r.answer_ids) AS answers FROM ai_resolutions r
     JOIN conversation_parts p ON p.workspace_id=r.workspace_id AND p.conversation_id=r.conversation_id
     WHERE p.body=$1`,
    [question],
  );

test("the customer taps “That helped”: one ledger row, the conversation shows as resolved, and Settings lists it", async ({
  page,
  browser,
}) => {
  const frame = await ask(page, "When do replies usually arrive?");
  const helped = frame.getByRole("button", { name: /That helped/ });
  await expect(helped).toBeVisible({ timeout: 20000 });
  await expect(frame.getByRole("button", { name: "Talk to a person" })).toBeVisible();
  await helped.click();
  await expect(
    frame.getByText(
      "Glad that helped! If you need anything else, just write here.",
    ),
  ).toBeVisible({ timeout: 15000 });
  await expect(helped).toHaveCount(0);
  expect(await ledgerFor("When do replies usually arrive?")).toEqual([
    { kind: "resolution", rule: "confirmed", answers: 1 },
  ]);

  // The teammate: the card's state and the timeline's line.
  const inbox = await (await browser.newContext()).newPage();
  await inbox.goto(relay.hostOrigin + "/agent");
  await inbox
    .getByRole("navigation", { name: "Inbox views" })
    .getByRole("button", { name: /^All/ })
    .click();
  const card = inbox.locator(".pg-card", {
    hasText: "When do replies usually arrive?",
  });
  await expect(card.locator(".pg-card-ai")).toHaveText("Zoe · resolved", {
    timeout: 15000,
  });
  await card.click();
  await expect(
    inbox.getByText(
      "Resolved by Zoe: the customer said the answer helped",
    ),
  ).toBeVisible();

  // Zoe › Resolutions: the count and the row.
  await inbox.goto(relay.hostOrigin + "/agent#zoe/resolutions");
  await expect(inbox.getByTestId("resolution-count")).toContainText(
    "Last 30 days: 1 resolution.",
    { timeout: 15000 },
  );
  await expect(
    inbox.getByRole("list", { name: "Latest resolutions" }),
  ).toContainText("Confirmed by the customer");
});

test("a customer who gets “I don't know” and goes quiet isn't counted as resolved", async ({
  page,
}) => {
  const frame = await ask(page, "Can I pay for my plan with bitcoin?");
  await expect(
    frame.locator(".message").filter({ hasText: "couldn't find an answer" }),
  ).toBeVisible({ timeout: 20000 });
  // No "That helped" under a refusal.
  await expect(frame.getByRole("button", { name: /That helped/ })).toHaveCount(0);
  // Days later, the sweep still doesn't count it.
  await resolveQuiet(relay.db.connect, "demo", Date.now() + 100 * 3_600_000);
  expect(await ledgerFor("Can I pay for my plan with bitcoin?")).toEqual([]);
  const [c] = await sql<{ ai_state: string }>(
    "SELECT c.ai_state FROM conversations c JOIN conversation_parts p ON p.workspace_id=c.workspace_id AND p.conversation_id=c.id WHERE p.body=$1",
    ["Can I pay for my plan with bitcoin?"],
  );
  expect(c.ai_state).toBe("pending");
});

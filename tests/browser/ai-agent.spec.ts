import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";

/** The AI agent answering in the messenger (phase 08, A1; docs/AI_STEP1.md). */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 8974, hostPort: 8975 });
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
/** Opens the messenger on the customer's site, once the AI index has been built. */
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
async function send(
  frame: Awaited<ReturnType<typeof messenger>>,
  text: string,
) {
  await frame.getByRole("button", { name: "Start a conversation" }).click();
  await frame.getByRole("textbox", { name: "Write your message" }).fill(text);
  await frame.getByRole("button", { name: "Send message" }).click();
}
const answerOf = (question: string) =>
  sql<{ outcome: string; model: string | null; cited: string[] }>(
    `SELECT a.outcome,a.model,a.cited FROM ai_answers a JOIN conversation_parts p ON p.workspace_id=a.workspace_id AND p.id=a.question_part_id
     WHERE p.body=$1`,
    [question],
  );

test("a customer's question is answered from the help center with its source, and the teammate sees why", async ({
  page,
  browser,
}) => {
  const frame = await messenger(page);
  await send(frame, "When do replies usually arrive?");
  const reply = frame
    .locator(".message")
    .filter({ hasText: "Replies usually arrive within an hour" });
  await expect(reply).toBeVisible({ timeout: 20000 });
  // Zoe (Z1): her name and the AI label on her reply.
  await expect(reply.locator("small.ai-from")).toContainText("Zoe");
  await expect(reply.locator("small.ai-from")).toContainText("AI agent");
  // The source opens the article in the help center.
  const source = reply
    .getByRole("list", { name: "Sources" })
    .getByRole("link", { name: "Getting started with Relay" });
  await expect(source).toHaveAttribute(
    "href",
    `${relay.apiOrigin}/help/demo/relay-help/en/articles/getting-started-with-relay`,
  );
  await expect(source).toHaveAttribute("target", "_blank");
  expect(await answerOf("When do replies usually arrive?")).toEqual([
    {
      outcome: "answered",
      model: "stand-in",
      cited: ["00000000-0000-4000-8000-00000000a001"],
    },
  ]);

  // The teammate sees the AI's reply, its source, and why.
  const agent = await (await browser.newContext()).newPage();
  await agent.goto(relay.hostOrigin + "/agent");
  await agent
    .locator(".pg-card", { hasText: "When do replies usually arrive?" })
    .click();
  const message = agent
    .locator(".pg-message")
    .filter({ hasText: "Replies usually arrive within an hour" });
  await expect(message).toContainText("AI agent");
  await expect(message).toContainText("Sources: Getting started with Relay");
  await message.getByRole("button", { name: "Why this reply" }).click();
  await expect(message.locator(".pg-ai-why")).toContainText(
    "Answered from content",
  );
  await expect(message.locator(".pg-ai-why")).toContainText(
    "(answers need 0.50)",
  );
  await expect(message.locator(".pg-ai-why")).toContainText("stand-in");
});

test("a question the help content can't answer gets an honest refusal and an offer of a person, without asking the model", async ({
  page,
}) => {
  const frame = await messenger(page);
  await send(frame, "Can I pay for my plan with bitcoin?");
  const reply = frame
    .locator(".message")
    .filter({ hasText: "couldn't find an answer" });
  await expect(reply).toBeVisible({ timeout: 20000 });
  await expect(reply).toContainText(
    "Would you like me to connect you with someone from the team?",
  );
  await expect(reply.getByRole("list", { name: "Sources" })).toHaveCount(0);
  const [answer] = await answerOf("Can I pay for my plan with bitcoin?");
  expect(answer).toMatchObject({ outcome: "unknown", model: null, cited: [] });
});

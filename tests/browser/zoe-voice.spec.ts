import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";

/** How Zoe answers: Train › Guidance, and her languages (phase 08, Z2; docs/AI_STEP6.md). */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({
    apiPort: 9008,
    hostPort: 9009,
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
/** A customer asks in the messenger (their browser in English); returns the frame. */
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

test("Guidance: her voice and a guideline, tried with unsaved changes beside them, saved as a version and restored; a French customer gets French", async ({
  page,
  browser,
}) => {
  // Her content is indexed before she's asked anything.
  await indexReady();
  await page.goto(relay.hostOrigin + "/agent#zoe");
  await page
    .getByRole("navigation", { name: "Zoe's pages" })
    .getByRole("button", { name: "Guidance" })
    .click();
  await expect(page).toHaveURL(/#zoe\/guidance$/);
  const versions = page.getByRole("list", { name: "Versions" });

  // Concise, and a guideline in Communication style; asking for links is flagged as she types.
  await page.getByRole("radio", { name: /^Concise/ }).check({ force: true });
  const style = page.getByRole("region", { name: "Communication style" });
  await style.getByRole("button", { name: "Add communication style guidance" }).click();
  await style.getByLabel("Title").fill("Plain words");
  await style
    .getByLabel("Guidance", { exact: true })
    .fill("Use plain words and short sentences. Include a link to the pricing page.");
  await expect(style.getByRole("list", { name: "Warnings" })).toContainText(
    "She doesn't write links",
  );

  // Try it, with the unsaved changes: one sentence, and what she was told.
  const tryIt = page.getByRole("complementary", { name: "Try it" });
  await expect(tryIt).toContainText("With your unsaved changes");
  await tryIt.getByLabel("Question to try").fill("When do replies usually arrive?");
  await tryIt.getByRole("button", { name: "Ask", exact: true }).click();
  const answer = tryIt.getByRole("region", { name: "Zoe's answer" });
  await expect(answer).toContainText("Replies usually arrive within an hour", {
    timeout: 15000,
  });
  const told = answer.getByRole("list", { name: "What she was told" });
  await expect(told).toContainText("at most 2 sentences");
  await expect(told).toContainText("[Communication style] Plain words: Use plain words");
  // Nothing was sent or recorded.
  expect(
    (await sql("SELECT 1 FROM conversation_parts WHERE body='When do replies usually arrive?'")).length,
  ).toBe(0);

  // Saved as version 1.
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved as version 1" })).toBeVisible();
  await expect(versions).toContainText("Version 1 · in use");
  await expect(tryIt).toContainText("As saved · version 1");

  // A customer whose browser is in English writes in French: Zoe replies in French.
  const customer = await (await browser.newContext()).newPage();
  const frame = await ask(customer, "Vendez-vous des chevaux en bois pour les enfants ?");
  await expect(
    frame.locator(".message").filter({ hasText: "Désolé, je n'ai pas trouvé de réponse" }),
  ).toBeVisible({ timeout: 20000 });

  // Teammates see why: the language she read, her voice and the guidance version.
  const inbox = await (await browser.newContext()).newPage();
  await inbox.goto(relay.hostOrigin + "/agent");
  await inbox.locator(".pg-card", { hasText: "Vendez-vous des chevaux" }).click();
  const reply = inbox
    .locator(".pg-message")
    .filter({ hasText: "Désolé, je n'ai pas trouvé de réponse" });
  await reply.getByRole("button", { name: "Why this reply" }).click();
  const why = reply.locator(".pg-ai-why");
  await expect(why).toContainText("French, read in the customer's French");
  await expect(why).toContainText("Friendly · Concise · usual formality · guidance version 1");

  // Playful, saved as version 2; version 1 restored as version 3.
  await page.getByRole("radio", { name: /^Playful/ }).check({ force: true });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved as version 2" })).toBeVisible();
  await versions.getByRole("button", { name: "Restore version 1" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved as version 3" })).toBeVisible();
  await expect(versions).toContainText("restored from version 1");
  await expect(page.getByRole("radio", { name: /^Friendly/ })).toBeChecked();
  await expect(style).toContainText("Plain words");
});

test("a guideline without its text is refused with the reason, and no version is saved", async ({
  page,
}) => {
  await page.goto(relay.hostOrigin + "/agent#zoe/guidance");
  const spam = page.getByRole("region", { name: "Spam" });
  await spam.getByRole("button", { name: "Add spam guidance" }).click();
  await spam.getByLabel("Title").fill("Sales pitches");
  const before = (await sql<{ v: number }>("SELECT guidance_version AS v FROM ai_agents"))[0].v;
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Write what “Sales pitches” says in up to 500 characters.",
  );
  expect((await sql<{ v: number }>("SELECT guidance_version AS v FROM ai_agents"))[0].v).toBe(before);
});

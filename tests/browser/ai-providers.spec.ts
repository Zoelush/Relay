import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";

/**
 * AI providers (phase 16, C9d; docs/SECURITY_STEP19.md), end to end, with stub providers (never the
 * network). Happy path: a manager connects OpenAI with a key and model, saves and tests it, makes it
 * Zoe's primary, and a customer's question is answered by it (Relay's AI isn't asked); "Why this
 * reply" says who answered. Failure path: a key the provider refuses is told plainly on Save and
 * test, a custom endpoint at an http address is refused, and the key never reaches the page.
 */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sent: { url: string; body: string }[] = [];
test.beforeAll(async () => {
  relay = await startLocalRelay({
    apiPort: 9195,
    hostPort: 9196,
    inboxViews: true,
    aiProviders: {
      policy: {
        fetch: (async (url: string, init: RequestInit) => {
          const body = String(init.body);
          sent.push({ url: String(url), body });
          // Gemini refuses the key; OpenAI answers, citing the first passage it was given.
          if (String(url).includes("generativelanguage.googleapis.com")) return json({ error: { message: "API key not valid." } }, 403);
          const request = JSON.parse(body) as { messages: { content: string }[] };
          const system = request.messages[0].content;
          if (/You classify/.test(system)) return json({ model: "gpt-6-luna", choices: [{ message: { content: '{"wants_human":false,"sentiment":"neutral","topic":null,"guidance":null,"spam":null,"specialist":null}' } }] });
          const passage = /\[(p\d+)\]/.exec(request.messages[1].content)?.[1] ?? "p1";
          return json({
            model: "gpt-6-luna",
            choices: [{ message: { content: JSON.stringify({ kind: "answer", sentences: [{ text: "Replies usually arrive within an hour, from your own model.", sources: [passage] }] }) } }],
          });
        }) as typeof fetch,
      },
    },
  });
  await sql("DELETE FROM calendar_assignments");
  await sql("UPDATE brands SET settings=settings-'calendarId'-'calendarVersion'");
});
test.afterAll(async () => {
  await relay?.close();
});
const sql = <T = any>(text: string, values: unknown[] = []) => tenant(relay.db.connect, "demo", async (db) => (await db.query<T>(text, values)).rows);
const card = (page: Page, name: string) => page.getByRole("list", { name: "AI providers" }).getByRole("listitem", { name, exact: true });

test("a manager connects OpenAI with their key, tests it and makes it Zoe's primary; a customer is answered by it and teammates see who answered", async ({ page, browser }) => {
  await page.goto(relay.hostOrigin + "/agent#settings/ai-providers");
  await expect(page.getByRole("combobox", { name: "Primary" })).toHaveValue("");
  await expect(page.getByRole("combobox", { name: "Primary" }).locator("option").first()).toHaveText("Relay's AI (stand-in)");
  await expect(card(page, "OpenAI")).toContainText("Not connected");

  await card(page, "OpenAI").getByRole("button", { name: "Connect OpenAI" }).click();
  const dialog = page.getByRole("dialog", { name: "Connect OpenAI" });
  await expect(dialog).toContainText("Keys are encrypted on the server and never sent back to the browser.");
  await expect(dialog.getByLabel("Model", { exact: true })).toHaveValue("gpt-6-luna");
  await dialog.getByLabel("API key").fill("sk-test-openai-secret-1234");
  await dialog.getByRole("button", { name: "Save and test" }).click();
  await expect(dialog.getByRole("status")).toContainText(/Answered a test question with gpt-6-luna in \d+\.\d s\./, { timeout: 20000 });
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(card(page, "OpenAI")).toContainText("•••• 1234");
  await expect(card(page, "OpenAI")).toContainText("Passed");
  expect(await page.content()).not.toContain("sk-test-openai-secret");
  // The test sent its fixed question, never a customer's.
  expect(sent.at(-1)!.body).toContain("Support hours");

  const form = page.getByRole("form", { name: "Zoe's providers" });
  await form.getByRole("combobox", { name: "Primary" }).selectOption("openai");
  await form.getByRole("button", { name: "Save choice" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Zoe now answers with your own provider." })).toBeVisible();
  await expect(card(page, "OpenAI")).toContainText("Primary");

  // A customer asks in the messenger: OpenAI answers.
  await expect.poll(async () => (await sql("SELECT 1 FROM knowledge_index_generations WHERE status='active'")).length, { timeout: 30000 }).toBe(1);
  const customer = await (await browser.newContext()).newPage();
  await customer.goto(relay.hostOrigin);
  await customer.getByRole("button", { name: "Open support", exact: true }).click();
  await expect.poll(() => customer.frames().some((f) => f.url().includes("/messenger/frame.html"))).toBe(true);
  const frame = customer.frames().find((f) => f.url().includes("/messenger/frame.html"))!;
  await frame.getByRole("button", { name: "Start a conversation" }).click();
  await frame.getByRole("textbox", { name: "Write your message" }).fill("When do replies usually arrive?");
  await frame.getByRole("button", { name: "Send message" }).click();
  await expect(frame.locator(".message").filter({ hasText: "from your own model" })).toBeVisible({ timeout: 20000 });
  expect(await sql("SELECT provider,key_source FROM ai_model_calls WHERE kind='answer' ORDER BY created_at DESC LIMIT 1")).toEqual([{ provider: "openai", key_source: "workspace" }]);

  // "Why this reply" says who answered.
  await page.goto(relay.hostOrigin + "/agent");
  await page.locator(".pg-card", { hasText: "When do replies usually arrive?" }).click();
  const message = page.locator(".pg-message").filter({ hasText: "from your own model" });
  await message.getByRole("button", { name: "Why this reply" }).click();
  await expect(message.locator(".pg-ai-why")).toContainText("Answered with your own OpenAI key (gpt-6-luna).");
});

test("a key the provider refuses is told plainly on Save and test, and a custom endpoint at an http address is refused", async ({ page }) => {
  await page.goto(relay.hostOrigin + "/agent#settings/ai-providers");
  await card(page, "Gemini").getByRole("button", { name: "Connect Gemini" }).click();
  const dialog = page.getByRole("dialog", { name: "Connect Gemini" });
  await dialog.getByLabel("API key").fill("AIza-test-not-valid-9999");
  await dialog.getByRole("button", { name: "Save and test" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Test failed: The provider refused the key (403). Check the key, and that it may use this model.", { timeout: 20000 });
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(card(page, "Gemini")).toContainText("Failed");
  expect(await page.content()).not.toContain("AIza-test-not-valid");

  await card(page, "OpenAI-compatible").getByRole("button", { name: "Connect OpenAI-compatible" }).click();
  const custom = page.getByRole("dialog", { name: "Connect OpenAI-compatible" });
  await custom.getByRole("textbox", { name: "Base URL" }).fill("http://gateway.example/v1");
  await custom.getByLabel("API key").fill("gw-key-secret-0000");
  await custom.getByLabel("Model", { exact: true }).fill("openai/gpt-6-luna");
  await custom.getByRole("button", { name: "Save", exact: true }).click();
  await expect(custom.getByRole("alert")).toContainText("Enter the endpoint's https base URL, such as https://api.example.com/v1.");
  await custom.getByRole("button", { name: "Cancel" }).click();
  await expect(card(page, "OpenAI-compatible")).toContainText("Not connected");
  expect(await sql("SELECT provider FROM ai_providers WHERE provider='custom'")).toEqual([]);
});

import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { getIdentity } from "../../server/people";
import { command } from "../../server/conversations";

let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 8910, hostPort: 8911 });
});
test.afterAll(async () => {
  await relay?.close();
});
const editor = (page: Page) =>
  page.getByRole("textbox", { name: "Reply message", exact: true });
const draftRows = () =>
  tenant(
    relay.db.connect,
    "demo",
    async (db) =>
      (
        await db.query<{ body: string; version: string }>(
          "SELECT body,version::text AS version FROM conversation_drafts WHERE workspace_id='demo' AND mode='reply'",
        )
      ).rows,
  );
async function openInbox(page: Page, row: RegExp) {
  await page.goto(relay.hostOrigin + "/agent");
  await expect(page.getByRole("status")).toHaveText("● Live");
  await page.getByRole("button", { name: row }).click();
  await expect(editor(page)).toBeVisible();
}

test("a formatted reply survives a refresh as a draft, then renders in the inbox and the messenger", async ({
  browser,
}) => {
  const customer = await (await browser.newContext()).newPage();
  const agent = await (await browser.newContext()).newPage();
  await customer.goto(relay.hostOrigin);
  await expect(customer.locator("relay-launcher")).toHaveAttribute(
    "data-ready",
    "true",
  );
  await customer
    .getByRole("button", { name: "Open support", exact: true })
    .click();
  await expect
    .poll(
      () =>
        !!customer
          .frames()
          .find((f) => f.url().includes("/messenger/frame.html")),
    )
    .toBe(true);
  const widget = customer
    .frames()
    .find((f) => f.url().includes("/messenger/frame.html"))!;
  await widget.getByRole("button", { name: "Start a conversation" }).click();
  await widget
    .getByRole("textbox", { name: "Write your message" })
    .fill("Where is the setup guide?");
  await widget.getByRole("button", { name: "Send message" }).click();

  await openInbox(agent, /Where is the setup guide\?/);
  await editor(agent).click();
  await agent.getByRole("button", { name: "Bulleted list" }).click();
  await agent.keyboard.type("Install the app");
  await agent.keyboard.press("Enter");
  await agent.keyboard.type("Sign in");
  await agent.keyboard.press("Enter");
  await agent.keyboard.press("Enter");
  await agent.keyboard.type("Read the guide");
  for (let i = 0; i < 5; i++) await agent.keyboard.press("Shift+ArrowLeft");
  await agent.getByRole("button", { name: "Link", exact: true }).click();
  await agent
    .getByRole("textbox", { name: "Link address" })
    .fill("https://example.com/guide");
  await agent.keyboard.press("Enter");
  await expect
    .poll(async () => (await draftRows())[0]?.body, { timeout: 10000 })
    .toBe(
      "- Install the app\n- Sign in\n\nRead the guide (https://example.com/guide)",
    );
  await expect(agent.getByText("Draft saved")).toBeVisible();

  // A refresh restores the server-backed draft, formatting included.
  await openInbox(agent, /Where is the setup guide\?/);
  await expect(editor(agent).locator("li")).toHaveText([
    "Install the app",
    "Sign in",
  ]);
  await expect(
    editor(agent).locator('a[href="https://example.com/guide"]'),
  ).toHaveText("guide");

  await editor(agent).click();
  await agent.keyboard.press("ControlOrMeta+Enter");
  const sent = agent
    .locator("[data-part-id]")
    .filter({ hasText: "Install the app" });
  await expect(sent.locator("li")).toHaveText(["Install the app", "Sign in"]);
  await expect(
    sent.locator('a[href="https://example.com/guide"]'),
  ).toHaveAttribute("rel", /noopener/);
  await expect(editor(agent)).toHaveText("");
  await expect.poll(async () => (await draftRows()).length).toBe(0);

  // The customer sees the same structure, rendered without HTML parsing.
  const reply = widget
    .locator(".message")
    .filter({ hasText: "Install the app" });
  await expect(reply.locator("li")).toHaveText(["Install the app", "Sign in"]);
  await expect(
    reply.locator('a[href="https://example.com/guide"]'),
  ).toHaveAttribute("target", "_blank");
});

test("a draft edited in two tabs conflicts, and either choice resolves without losing text", async ({
  browser,
}) => {
  await tenant(relay.db.connect, "demo", async (db) => {
    const identity = await getIdentity(
      db,
      "demo",
      "anonymous",
      "conflict-device",
    );
    await command(
      db,
      "demo",
      { type: "contact", identityId: identity.identityId, brandId: "default" },
      "conflict-start",
      { action: "start", text: "Draft conflict fixture" },
    );
  });
  const context = await browser.newContext();
  const tabA = await context.newPage();
  const tabB = await context.newPage();
  // Both tabs load the (empty) draft before either saves.
  await openInbox(tabB, /Draft conflict fixture/);
  await openInbox(tabA, /Draft conflict fixture/);
  await editor(tabA).click();
  await tabA.keyboard.type("Written in tab A");
  await expect(tabA.getByText("Draft saved")).toBeVisible({ timeout: 10000 });

  await editor(tabB).click();
  await tabB.keyboard.type("Written in tab B");
  const conflictB = tabB
    .getByRole("alert")
    .filter({ hasText: "This draft changed in another tab or device." });
  await expect(conflictB).toBeVisible({ timeout: 10000 });
  await expect(editor(tabB)).toHaveText("Written in tab B", {
    useInnerText: true,
  });
  await conflictB.getByRole("button", { name: "Keep mine" }).click();
  await expect(tabB.getByText("Draft saved")).toBeVisible({ timeout: 10000 });
  await expect
    .poll(async () => (await draftRows()).map((r) => [r.body, r.version]))
    .toEqual([["Written in tab B", "2"]]);

  // Tab A is now behind; its next edit conflicts and it takes the other version.
  await editor(tabA).click();
  await tabA.keyboard.type(" and more");
  const conflictA = tabA
    .getByRole("alert")
    .filter({ hasText: "This draft changed in another tab or device." });
  await expect(conflictA).toBeVisible({ timeout: 10000 });
  await conflictA
    .getByRole("button", { name: "Use the other version" })
    .click();
  await expect(editor(tabA)).toHaveText("Written in tab B");
  await expect(conflictA).toHaveCount(0);
  expect((await draftRows()).map((r) => [r.body, r.version])).toEqual([
    ["Written in tab B", "2"],
  ]);
  await context.close();
});

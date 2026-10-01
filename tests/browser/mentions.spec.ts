import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { getIdentity } from "../../server/people";
import { command } from "../../server/conversations";

let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.beforeAll(async () => {
  relay = await startLocalRelay({
    apiPort: 8916,
    hostPort: 8917,
    inboxViews: true,
  });
});
test.afterAll(async () => {
  await relay?.close();
});
const sql = (text: string, values: unknown[] = []) =>
  tenant(
    relay.db.connect,
    "demo",
    async (db) => (await db.query(text, values)).rows,
  );
async function start(title: string) {
  await tenant(relay.db.connect, "demo", async (db) => {
    const identity = await getIdentity(db, "demo", "anonymous", title);
    await command(
      db,
      "demo",
      { type: "contact", identityId: identity.identityId, brandId: "default" },
      title + "-start",
      { action: "start", text: title },
    );
  });
}
async function signIn(page: Page, as?: string) {
  await page.goto(relay.hostOrigin + "/agent" + (as ? "?as=" + as : ""));
  await expect(page.getByRole("status")).toHaveText("● Live");
}
const noteEditor = (page: Page) =>
  page.getByRole("textbox", { name: "Internal note", exact: true });

test("mentioning a teammate in a note notifies them live and lists the conversation in their Mentions view", async ({
  browser,
}) => {
  await start("Mention fixture");
  const owner = await (await browser.newContext()).newPage();
  const grace = await (await browser.newContext()).newPage();
  await signIn(grace, "grace");
  const bell = grace.getByRole("button", {
    name: /^Notifications, \d+ unread$/,
  });
  await expect(bell).toHaveAccessibleName("Notifications, 0 unread");

  await signIn(owner);
  await owner.getByRole("button", { name: /Mention fixture/ }).click();
  await owner
    .getByRole("button", { name: "Internal note", exact: true })
    .click();
  await noteEditor(owner).click();
  await owner.keyboard.type("Could ");
  await owner.keyboard.type("@gra");
  const picker = owner.getByRole("listbox", {
    name: "Mention a teammate or team",
  });
  await expect(picker.getByRole("option", { name: /Grace/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await owner.keyboard.press("Enter");
  await expect(picker).toHaveCount(0);
  await owner.keyboard.type("check the refund?");
  await expect(noteEditor(owner).locator(".rich-mention")).toHaveText("@Grace");
  await owner.keyboard.press("ControlOrMeta+Enter");
  const sent = owner
    .locator("[data-part-id].pg-note")
    .filter({ hasText: "check the refund?" });
  await expect(
    sent.locator('.rich-mention[data-mention-id="grace"]'),
  ).toHaveText("@Grace");

  // Grace's bell updates without a refresh; the notification opens the conversation.
  await expect(bell).toHaveAccessibleName("Notifications, 1 unread", {
    timeout: 15000,
  });
  await bell.click();
  const panel = grace.getByRole("dialog", { name: "Notifications" });
  const item = panel.getByRole("button", {
    name: /Support teammate mentioned you in Mention fixture/,
  });
  await expect(item).toContainText("Could @Grace check the refund?");
  await item.click();
  await expect(panel).toHaveCount(0);
  await expect(
    grace
      .getByRole("region", { name: "Conversation timeline" })
      .getByRole("heading", { name: "Mention fixture" }),
  ).toBeVisible();
  await expect(bell).toHaveAccessibleName("Notifications, 0 unread", {
    timeout: 15000,
  });

  // Grace already sees a shared view, so her missing default views (including Mentions) are
  // added automatically, as for any teammate set up before Mentions existed.
  const mentionsView = grace
    .getByRole("navigation", { name: "Inbox views" })
    .getByRole("button", { name: /^Mentions/ });
  await expect(mentionsView).toContainText("1", { timeout: 15000 });
  await mentionsView.click();
  await expect(
    grace
      .getByTestId("virtual-conversations")
      .getByRole("button", { name: /Mention fixture/ }),
  ).toBeVisible();
});

test("a mention of someone removed before sending is refused and the note is kept; replies offer no mentions", async ({
  browser,
}) => {
  await start("Removed teammate fixture");
  await sql(
    "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('demo','temp','local-temp','Temporary Tess','agent') ON CONFLICT DO NOTHING",
  );
  const owner = await (await browser.newContext()).newPage();
  await signIn(owner);
  await owner.getByRole("button", { name: /Removed teammate fixture/ }).click();

  // In reply mode, @ is just text.
  const reply = owner.getByRole("textbox", {
    name: "Reply message",
    exact: true,
  });
  await reply.click();
  await owner.keyboard.type("@tes");
  await expect(
    owner.getByRole("listbox", { name: "Mention a teammate or team" }),
  ).toHaveCount(0);
  await owner.keyboard.press("ControlOrMeta+a");
  await owner.keyboard.press("Backspace");

  await owner
    .getByRole("button", { name: "Internal note", exact: true })
    .click();
  await noteEditor(owner).click();
  await owner.keyboard.type("Over to @tes");
  await owner.keyboard.press("Enter");
  await expect(noteEditor(owner).locator(".rich-mention")).toHaveText(
    "@Temporary Tess",
  );
  await sql("DELETE FROM teammates WHERE workspace_id='demo' AND id='temp'");
  await owner.keyboard.press("ControlOrMeta+Enter");
  await expect(owner.locator(".pg-error")).toContainText(
    "Someone you mentioned is not in this workspace",
  );
  await expect(noteEditor(owner)).toContainText("Over to");
  await expect(noteEditor(owner).locator(".rich-mention")).toHaveText(
    "@Temporary Tess",
  );
  expect(
    await sql(
      "SELECT id FROM conversation_parts WHERE workspace_id='demo' AND body LIKE 'Over to%'",
    ),
  ).toHaveLength(0);
});

test("Escape closes the @-picker and keeps the note focused; the picker does not follow the teammate into Knowledge", async ({
  page,
}) => {
  await start("Picker escape fixture");
  await signIn(page);
  await page.getByRole("button", { name: /Picker escape fixture/ }).click();
  await page
    .getByRole("button", { name: "Internal note", exact: true })
    .click();
  const editor = noteEditor(page);
  await editor.click();
  await page.keyboard.type("Ask @");
  const picker = page.getByRole("listbox", {
    name: "Mention a teammate or team",
  });
  await expect(picker).toBeVisible();

  // The first Escape closes only the picker; the second leaves the editor, as before.
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(page.locator(".pg-mention-popup")).toHaveCount(0);
  await expect(editor).toBeFocused();
  await page.keyboard.type("gra");
  await expect(picker).toHaveCount(0);
  await expect(editor).toHaveText("Ask @gra");
  await page.keyboard.press("Escape");
  await expect(editor).not.toBeFocused();

  // An open picker closes when the teammate switches to Knowledge (the inbox stays mounted).
  await editor.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" @");
  await expect(picker).toBeVisible();
  await page.getByRole("button", { name: "Knowledge", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Knowledge", level: 1 }),
  ).toBeVisible();
  await expect(page.locator(".pg-mention-popup")).toHaveCount(0);
});

import { readFile } from "node:fs/promises";
import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { getIdentity } from "../../server/people";
import { command } from "../../server/conversations";

let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 900 } });
const sql = <T = any>(text: string, values: unknown[] = []) =>
  tenant(
    relay.db.connect,
    "demo",
    async (db) => (await db.query<T>(text, values)).rows,
  );
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 8956, hostPort: 8957 });
});
test.afterAll(async () => {
  await relay?.close();
});
/** A conversation with a customer message, a reply and an internal note. */
async function conversation(title: string) {
  return tenant(relay.db.connect, "demo", async (db) => {
    const identity = await getIdentity(db, "demo", "anonymous", "hdr-" + title);
    const { conversationId } = (await command(
      db,
      "demo",
      { type: "contact", identityId: identity.identityId, brandId: "default" },
      "hdr-start-" + title,
      { action: "start", text: title },
    )) as { conversationId: string };
    const teammate = { type: "teammate" as const, principal: "local-owner" };
    await command(db, "demo", teammate, "hdr-reply-" + title, {
      action: "reply",
      conversationId,
      text: "It ships today by courier.",
    });
    await command(db, "demo", teammate, "hdr-note-" + title, {
      action: "note",
      conversationId,
      text: "Private: refund approved by Ada.",
    });
    return conversationId;
  });
}
async function open(page: Page, title: string) {
  await page.goto(relay.hostOrigin + "/agent");
  await expect(page.getByRole("status")).toHaveText("● Live");
  await page
    .getByRole("button", { name: new RegExp(title) })
    .first()
    .click();
  await expect(page.getByText("It ships today by courier.")).toBeVisible();
}
const actions = (page: Page) =>
  page.getByRole("toolbar", { name: "Conversation actions" });
const row = async (id: string) =>
  (
    await sql(
      "SELECT priority,status,snooze_until FROM conversations WHERE id=$1",
      [id],
    )
  )[0];

test("the header: priority, the more-actions menu, export without notes, convert to ticket, and snooze presets with times", async ({
  page,
}) => {
  const id = await conversation("Header happy path");
  await open(page, "Header happy path");
  const bar = actions(page);
  // Icon actions carry their names (and tooltips); Close stays a labelled button.
  for (const name of [
    "Priority",
    "More actions",
    "Convert to ticket",
    "Snooze",
    "Close",
    "Details",
  ])
    await expect(bar.getByRole("button", { name, exact: true })).toBeVisible();
  await expect(bar.getByRole("button", { name: "Priority" })).toHaveAttribute(
    "title",
    "Mark as priority (P)",
  );

  // Priority.
  await bar.getByRole("button", { name: "Priority" }).click();
  await expect(bar.getByRole("button", { name: "Priority" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect.poll(async () => (await row(id)).priority).toBe(true);

  // The more-actions menu, by keyboard; Escape returns focus.
  await bar.getByRole("button", { name: "More actions" }).click();
  const more = page.getByRole("menu", { name: "More actions" });
  await expect(more.getByRole("menuitem")).toHaveText([
    /conversation details/,
    "Export conversation as text",
    "Command palette",
    "Keyboard shortcuts",
  ]);
  await page.keyboard.press("Escape");
  await expect(more).toBeHidden();
  await expect(bar.getByRole("button", { name: "More actions" })).toBeFocused();

  // Export: the conversation as the customer saw it, without the internal note.
  await bar.getByRole("button", { name: "More actions" }).click();
  const download = page.waitForEvent("download");
  await more
    .getByRole("menuitem", { name: "Export conversation as text" })
    .click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("header-happy-path.txt");
  const text = await readFile((await file.path())!, "utf8");
  expect(text).toContain("Header happy path");
  expect(text).toContain("It ships today by courier.");
  expect(text).toContain("Internal notes are not included.");
  expect(text).not.toContain("refund approved");

  // Convert to ticket from the header opens the form in the details sidebar, ready to use.
  await bar.getByRole("button", { name: "Convert to ticket" }).click();
  const form = page
    .getByRole("complementary", { name: "Conversation details" })
    .getByRole("group", { name: "Convert to ticket" });
  await expect(form).toBeVisible();
  await expect(form.getByLabel("Ticket type")).toBeFocused();

  // Snooze presets show when they wake; One week is seven days on.
  await bar.getByRole("button", { name: "Snooze" }).click();
  const snooze = page.getByRole("dialog", { name: "Snooze conversation" });
  for (const preset of [
    "Later today",
    "Tomorrow",
    "Next week",
    "One week",
    "One month",
  ])
    await expect(
      snooze.getByRole("button", { name: new RegExp("^" + preset + " .+") }),
    ).toBeVisible();
  const before = Date.now();
  await snooze.getByRole("button", { name: /^One week/ }).click();
  await expect.poll(async () => (await row(id)).status).toBe("snoozed");
  const wake = new Date((await row(id)).snooze_until).getTime();
  expect(Math.abs(wake - (before + 7 * 86_400_000))).toBeLessThan(120_000);
});

test("a refused priority change is put back and explained", async ({
  page,
}) => {
  const id = await conversation("Header refused priority");
  await page.route("**/api/agent/command", async (route) => {
    if (route.request().postDataJSON().action === "priority")
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "CONFLICT",
            message: "Priority could not be changed for this test.",
          },
        }),
      });
    else await route.continue();
  });
  await open(page, "Header refused priority");
  const priority = actions(page).getByRole("button", { name: "Priority" });
  await priority.click();
  await expect(page.locator(".pg-error")).toContainText(
    "Priority could not be changed for this test.",
  );
  await expect(priority).toHaveAttribute("aria-pressed", "false");
  expect((await row(id)).priority).toBe(false);
});

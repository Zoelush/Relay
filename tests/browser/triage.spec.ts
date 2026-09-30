import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { getIdentity } from "../../server/people";
import { command, conversation } from "../../server/conversations";
import { resolveWake } from "../../server/snooze";

let relay: Awaited<ReturnType<typeof startLocalRelay>>;
// Snooze presets must resolve in the teammate's zone, which the browser reports.
test.use({ timezoneId: "Europe/London" });

async function start(label: string) {
  return tenant(relay.db.connect, "demo", async (db) => {
    const identity = await getIdentity(db, "demo", "anonymous", label);
    const { conversationId } = (await command(
      db,
      "demo",
      { type: "contact", identityId: identity.identityId, brandId: "default" },
      label + "-start",
      { action: "start", text: label },
    )) as { conversationId: string };
    return conversationId;
  });
}
const row = (id: string) =>
  tenant(relay.db.connect, "demo", (db) => conversation(db, "demo", id));
const state = (page: Page) => page.getByTestId("conversation-state");

test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 8908, hostPort: 8909 });
});
test.afterAll(async () => {
  await relay?.close();
});

test("keyboard-only triage: navigate, read collapsed events, reply, snooze, reopen, close and assign", async ({
  page,
}) => {
  const id = await start("Keyboard triage fixture");
  // Three consecutive system events collapse into one expandable line.
  await tenant(relay.db.connect, "demo", async (db) => {
    const owner = { type: "teammate" as const, principal: "local-owner" };
    await command(db, "demo", owner, "triage-assign", {
      action: "assign",
      conversationId: id,
      teammateId: "owner",
    });
    await command(db, "demo", owner, "triage-priority", {
      action: "priority",
      conversationId: id,
      value: true,
    });
  });
  await page.goto(relay.hostOrigin + "/agent");
  await expect(page.getByRole("status")).toHaveText("● Live");
  const thread = page.getByRole("region", { name: "Conversation timeline" });

  await page.keyboard.press("j");
  await expect(thread.getByRole("heading", { name: "Keyboard triage fixture" })).toBeVisible();
  const run = thread.getByRole("button", { name: "Show 3 updates" });
  await run.focus();
  await page.keyboard.press("Enter");
  await expect(thread.getByText("assigned this to Support teammate")).toBeVisible();
  await expect(thread.getByText("marked this as priority")).toBeVisible();

  // R focuses the reply composer; Ctrl+Enter sends; Escape returns to shortcuts.
  await page.keyboard.press("r");
  await expect(page.getByRole("textbox", { name: "Reply message" })).toBeFocused();
  await page.keyboard.type("Sent from the keyboard");
  await page.keyboard.press("Control+Enter");
  await expect(
    thread.locator("[data-part-id]").filter({ hasText: "Sent from the keyboard" }),
  ).toHaveCount(1);
  await page.keyboard.press("Escape");

  // S opens the snooze menu; "Tomorrow" resolves to 09:00 London time on the server.
  await page.keyboard.press("s");
  const menu = page.getByRole("dialog", { name: "Snooze conversation" });
  await expect(menu.getByRole("button", { name: /Later today/ })).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(state(page)).toContainText("snoozed");
  await expect.poll(async () => (await row(id)).status).toBe("snoozed");
  const snoozed = await row(id);
  expect(snoozed.snooze_timezone).toBe("Europe/London");
  expect(new Date(snoozed.snooze_until as string).toISOString()).toBe(
    resolveWake({ preset: "tomorrow", timezone: "Europe/London" }).wakeAt.toISOString(),
  );
  await expect(thread.getByText(/snoozed this until/)).toBeVisible();

  // Shift+E reopens, E closes, and the palette assigns.
  await page.keyboard.press("Shift+E");
  await expect.poll(async () => (await row(id)).status).toBe("open");
  await page.keyboard.press("e");
  await expect.poll(async () => (await row(id)).status).toBe("closed");
  await expect(state(page)).toContainText("closed");
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette.getByRole("combobox", { name: "Search commands" })).toBeFocused();
  await page.keyboard.type("unassign");
  await page.keyboard.press("Enter");
  await expect(palette).toHaveCount(0);
  await expect.poll(async () => (await row(id)).assigned).toBe("");

  // ? shows the shortcut sheet; Escape closes it.
  await page.keyboard.press("?");
  const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(sheet.getByText("Toggle priority")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
});

test("a rejected snooze reverts the optimistic state and shows the error", async ({
  page,
}) => {
  const id = await start("Rejected snooze fixture");
  let release!: () => void;
  const answer = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/agent/command", async (route) => {
    if (route.request().postDataJSON().action === "snooze") {
      await answer;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "CONFLICT", message: "The snooze was rejected for this test." },
        }),
      });
    } else await route.continue();
  });
  await page.goto(relay.hostOrigin + "/agent");
  await expect(page.getByRole("status")).toHaveText("● Live");
  await page.getByRole("button", { name: /Rejected snooze fixture/ }).click();
  await expect(state(page)).toContainText("open");
  await page.keyboard.press("s");
  await page
    .getByRole("dialog", { name: "Snooze conversation" })
    .getByRole("button", { name: /Later today/ })
    .click();
  // Optimistic first, then reverted when the server rejects it.
  await expect(state(page)).toContainText("snoozed");
  release();
  await expect(page.locator(".pg-error")).toContainText("The snooze was rejected for this test.");
  await expect(state(page)).toContainText("open");
  expect((await row(id)).status).toBe("open");
});

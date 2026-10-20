import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { changeOutboundMessage } from "../../server/outbound";

/**
 * Outbound's engine and in-app chat (phase 13, O2; docs/OUTBOUND_STEP2.md), with the demo's seeded
 * "Welcome to Pro" chat (live, to the Pro users segment): Ada, a pro user, visits the site and the
 * messenger opens on the chat; her reply continues into the team's inbox, and the ledger has it
 * seen and replied. Grace, who said no to product tips on her preference page, gets nothing of
 * that kind (the ledger says why), and the limits are checked in Settings.
 */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9056, hostPort: 9057, inboxViews: true, aiAgent: false, examplePeople: true, exampleOutbound: true });
});
test.afterAll(async () => {
  await relay?.close();
});
const sql = async <T = any>(text: string, values: unknown[] = []) => (await tenant(relay.db.connect, "demo", (db) => db.query<T>(text, values))).rows;
const messengerFrame = async (page: Page) => {
  await expect.poll(() => page.frames().some((f) => f.url().includes("/messenger/frame.html")), { timeout: 15000 }).toBe(true);
  return page.frames().find((f) => f.url().includes("/messenger/frame.html"))!;
};

test("a pro user's visit opens the messenger on the welcome chat; her reply reaches the inbox; the ledger has it seen and replied", async ({ browser, page }) => {
  const site = await (await browser.newContext()).newPage();
  await site.goto(relay.hostOrigin + "/?user=ada-demo");
  const frame = await messengerFrame(site);
  await expect(frame.getByText("Hi! Thanks for upgrading to Pro. Want a quick tour of what's new?")).toBeVisible({ timeout: 15000 });
  await frame.getByRole("textbox", { name: "Write your message" }).fill("Yes please, show me around");
  await frame.getByRole("button", { name: "Send message" }).click();
  await expect(frame.getByText("Yes please, show me around")).toBeVisible();
  await expect
    .poll(async () => (await sql("SELECT seen_at IS NOT NULL AS seen,replied_at IS NOT NULL AS replied,status FROM outbound_entries WHERE message_id='welcome-pro'"))[0], { timeout: 15000 })
    .toEqual({ seen: true, replied: true, status: "sent" });
  // Reloading doesn't send it again (once ever).
  await site.reload();
  await site.waitForTimeout(1500);
  expect((await sql("SELECT count(*)::int AS n FROM outbound_entries WHERE message_id='welcome-pro'"))[0].n).toBe(1);

  // The team: her reply opened the conversation, which starts with the chat from its sender.
  await page.goto(relay.hostOrigin + "/agent");
  await page.locator(".pg-card", { hasText: "show me around" }).click();
  const timeline = page.getByRole("region", { name: "Conversation timeline" });
  await expect(timeline.locator(".pg-message", { hasText: "Thanks for upgrading to Pro" })).toBeVisible();
  await expect(timeline.locator(".pg-message", { hasText: "Yes please, show me around" })).toBeVisible();
});

test("someone who said no to a subscription type gets nothing of it, and the ledger says why; the limits are checked", async ({ browser, page }) => {
  // A tip to all users, in-app, of "Product tips".
  await tenant(relay.db.connect, "demo", async (db) => {
    const made = (await changeOutboundMessage(db, "demo", "local-owner", crypto.randomUUID(), { action: "create", type: "chat", title: "A tip" })) as { message: { id: string }; draft: Record<string, unknown> };
    await changeOutboundMessage(db, "demo", "local-owner", crypto.randomUUID(), {
      action: "save",
      id: made.message.id,
      definition: { ...made.draft, content: { text: "Tip: export reports as CSV.", senderId: "owner" }, subscriptionTypeId: "product-tips", delivery: { mode: "ongoing" }, quietHours: false },
    });
    await changeOutboundMessage(db, "demo", "local-owner", crypto.randomUUID(), { action: "publish", id: made.message.id });
  });
  // Grace says no to product tips on her preference page.
  const grace = (await sql<{ id: string }>("SELECT id FROM contacts WHERE external_id='grace-demo'"))[0].id;
  await page.goto(`${relay.apiOrigin}/dev/preferences/${grace}`);
  await page.getByRole("checkbox", { name: /Product tips/ }).uncheck();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved.");

  const site = await (await browser.newContext()).newPage();
  await site.goto(relay.hostOrigin + "/?user=grace-demo");
  await expect(site.locator("[data-launcher]")).toHaveCount(1, { timeout: 15000 });
  await expect
    .poll(async () => (await sql("SELECT e.status,e.reason FROM outbound_entries e JOIN outbound_messages m ON m.workspace_id=e.workspace_id AND m.id=e.message_id WHERE m.title='A tip' AND e.contact_id=$1", [grace]))[0], {
      timeout: 15000,
    })
    .toEqual({ status: "suppressed", reason: "Not subscribed to Product tips." });
  expect(site.frames().some((f) => f.url().includes("/messenger/frame.html"))).toBe(false);
  expect((await sql("SELECT count(*)::int AS n FROM conversations c JOIN identity_contact_mappings x ON x.workspace_id=c.workspace_id AND x.identity_id=c.primary_identity_id WHERE x.contact_id=$1 AND c.outbound_message_id IS NOT NULL", [grace]))[0].n).toBe(0);

  // Settings › Outbound › Limits: checked (the browser keeps the numbers in range; the server, the timezone).
  await page.goto(relay.hostOrigin + "/agent#settings/outbound");
  const form = page.getByRole("form", { name: "Outbound limits" });
  await form.getByLabel("Timezone when theirs isn't known").fill("Mars/Base");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("alert")).toHaveText("Choose a timezone (Europe/London).");
  await form.getByLabel("Timezone when theirs isn't known").fill("Europe/London");
  await form.getByLabel("At most (messages)").fill("2");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status")).toHaveText("Limits saved.");
});

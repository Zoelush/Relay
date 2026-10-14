import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { whatsappClock } from "../../server/whatsapp";

/**
 * WhatsApp (phase 12, E5; docs/OMNICHANNEL_STEP5.md), with the demo's seeded number and approved
 * template: a customer's message becomes a conversation, the reply goes inside the 24-hour window
 * and is read; once the window has closed only the template goes; STOP suppresses the number; a
 * number with a bad token isn't connected, and says why.
 */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9044, hostPort: 9045, inboxViews: true, aiAgent: false, exampleWhatsApp: true });
});
test.afterAll(async () => {
  whatsappClock.now = () => Date.now();
  await relay?.close();
});

/** A webhook call, signed as Meta signs it, to the demo's address. */
async function hook(payload: unknown) {
  const call = await relay.whatsapp.signed(payload);
  const r = await fetch(relay.apiOrigin + "/v1/hooks/whatsapp/demo", { method: "POST", headers: { "x-hub-signature-256": call.signature }, body: call.body });
  expect(r.status).toBe(200);
  await expect
    .poll(async () => (await tenant(relay.db.connect, "demo", (db) => db.query("SELECT count(*)::int AS n FROM whatsapp_inbound WHERE status='received'"))).rows[0].n, { timeout: 15000 })
    .toBe(0);
}
const say = (from: string, body: string, name = "Ada") => hook(relay.whatsapp.message({ from, name, message: { type: "text", text: { body } } }));
async function open(page: Page, card: string) {
  await page.goto(relay.hostOrigin + "/agent");
  await page.locator(".pg-card", { hasText: card }).click();
}
const timeline = (page: Page) => page.getByRole("region", { name: "Conversation timeline" });

test("a WhatsApp message becomes a conversation, and the reply in the window is sent and read", async ({ page }) => {
  await say("447700900456", "Hi, where is my order #4411?");
  await open(page, "where is my order");
  await expect(timeline(page).locator(".pg-message", { hasText: "where is my order" })).toContainText("via WhatsApp");
  await expect(page.getByLabel("Where this reply goes")).toContainText("Sent by WhatsApp to +447700900456 · window open until");
  await page.getByRole("textbox", { name: "Reply message" }).fill("It ships today.");
  await page.getByRole("button", { name: "Send reply", exact: true }).click();
  await expect.poll(() => relay.whatsapp.sent.length, { timeout: 15000 }).toBe(1);
  expect(relay.whatsapp.sent[0].message).toMatchObject({ to: "447700900456", type: "text", text: { body: "It ships today." } });
  await hook(relay.whatsapp.status(relay.whatsapp.sent[0].messageId, "read"));
  await page.reload();
  await page.locator(".pg-card", { hasText: "where is my order" }).click();
  await expect(timeline(page).locator(".pg-message", { hasText: "It ships today." }).locator(".pg-delivery")).toHaveText("Read");

  // Settings › WhatsApp: the number connected, the webhook to set up, the approved template, opt-ins.
  await page.goto(relay.hostOrigin + "/agent#settings/whatsapp");
  await expect(page.getByLabel("Status of +44 7700 900123")).toContainText("Connected");
  await expect(page.getByRole("table", { name: "Webhook to set up at Meta" })).toContainText(`${relay.apiOrigin}/v1/hooks/whatsapp/demo`);
  await expect(page.getByRole("list", { name: "Templates" })).toContainText("order_update");
  await expect(page.getByRole("list", { name: "Templates" })).toContainText("Approved");
  await expect(page.getByRole("list", { name: "Opted-in numbers" })).toContainText("+447700900456");
  await expect(page.getByRole("list", { name: "Opted-in numbers" })).toContainText("They wrote to you");
});

test("once the window has closed only a template goes; STOP suppresses the number; a bad token doesn't connect", async ({ page }) => {
  await say("447700900789", "Can I change my address?", "Sam");
  // A day and an hour later.
  whatsappClock.now = () => Date.now() + 25 * 3_600_000;
  try {
    await open(page, "change my address");
    await expect(page.getByText("The 24-hour window has closed: send an approved template.")).toBeVisible();
    await page.getByRole("textbox", { name: "Reply message" }).fill("Sure, what's the new one?");
    await page.getByRole("button", { name: "Send reply", exact: true }).click();
    await expect(page.getByText("The 24-hour window has closed: send an approved template instead.")).toBeVisible();
    const before = relay.whatsapp.sent.length;
    await page.getByRole("button", { name: "Send a template" }).click();
    const picker = page.getByRole("group", { name: "Send a template" });
    await picker.getByLabel("{{1}}").fill("Sam");
    await picker.getByLabel("{{2}}").fill("#5520");
    await expect(picker.locator(".pg-template-preview")).toHaveText("Hi Sam, your order #5520 has shipped. Reply here if you need anything.");
    await picker.getByRole("button", { name: "Send template" }).click();
    await expect.poll(() => relay.whatsapp.sent.length, { timeout: 15000 }).toBe(before + 1);
    expect(relay.whatsapp.sent.at(-1)!.message).toMatchObject({ to: "447700900789", type: "template", template: { name: "order_update" } });
    await expect(timeline(page).locator(".pg-message", { hasText: "Hi Sam, your order #5520 has shipped." })).toBeVisible();
  } finally {
    whatsappClock.now = () => Date.now();
  }

  // STOP: the number is suppressed, and the next reply isn't sent.
  await say("447700900789", "STOP", "Sam");
  await page.goto(relay.hostOrigin + "/agent#settings/suppressions");
  await expect(page.getByRole("list", { name: "Suppressed addresses" }).getByRole("listitem").filter({ hasText: "+447700900789" })).toContainText("Opted out");
  const before = relay.whatsapp.sent.length;
  await open(page, "change my address");
  await page.getByRole("textbox", { name: "Reply message" }).fill("Noted.");
  await page.getByRole("button", { name: "Send reply", exact: true }).click();
  await expect
    .poll(async () => (await tenant(relay.db.connect, "demo", (db) => db.query("SELECT status FROM channel_deliveries WHERE address='+447700900789' ORDER BY created_at DESC LIMIT 1"))).rows[0]?.status, {
      timeout: 15000,
    })
    .toBe("suppressed");
  expect(relay.whatsapp.sent.length).toBe(before);

  // A number connected with a token Meta refuses: not connected, with Meta's reason.
  await page.goto(relay.hostOrigin + "/agent#settings/whatsapp");
  await page.getByLabel("Phone number ID").fill("100000000000002");
  await page.getByLabel("WhatsApp Business account ID").fill("200000000000002");
  await page.getByLabel("Access token").fill("a-token-meta-will-refuse-000000");
  await page.getByLabel("App secret").fill("f".repeat(32));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("status").first()).toContainText("Checking with Meta");
  await expect
    .poll(async () => (await tenant(relay.db.connect, "demo", (db) => db.query("SELECT status FROM whatsapp_numbers WHERE phone_number_id='100000000000002'"))).rows[0]?.status, {
      timeout: 15000,
    })
    .toBe("failed");
  await page.reload();
  await expect(page.getByLabel("Status of 100000000000002")).toContainText("Not connected");
  await expect(page.getByText("Meta refused: Invalid OAuth access token.")).toBeVisible();
});

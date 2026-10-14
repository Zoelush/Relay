import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { LOCAL_TWILIO } from "../../scripts/local-sms";
import { tenant } from "../../server/db";

/**
 * SMS (phase 12, E6; docs/OMNICHANNEL_STEP6.md), with the demo's seeded Twilio account and UK
 * number: a customer's text becomes a conversation, the composer counts segments and estimates
 * the cost, the reply is texted and delivered; STOP opts the number out and the next reply is
 * refused at once; a number that isn't in the account fails with why.
 */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9046, hostPort: 9047, inboxViews: true, aiAgent: false, exampleSms: true });
});
test.afterAll(async () => {
  await relay?.close();
});

/** A call as Twilio makes it, signed over the exact URL and form. */
async function hook(kind: "message" | "status", params: Record<string, string>) {
  const url = `${relay.apiOrigin}/v1/hooks/sms/demo/${kind}`;
  const call = await relay.sms.signed(url, params);
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": call.signature }, body: call.body });
  expect([200, 204]).toContain(r.status);
  await expect
    .poll(async () => (await tenant(relay.db.connect, "demo", (db) => db.query("SELECT count(*)::int AS n FROM sms_inbound WHERE status='received'"))).rows[0].n, { timeout: 15000 })
    .toBe(0);
}
const text = (from: string, body: string) => hook("message", relay.sms.text({ from, to: LOCAL_TWILIO.numbers[0], body }));
async function open(page: Page, card: string) {
  await page.goto(relay.hostOrigin + "/agent");
  await page.locator(".pg-card", { hasText: card }).click();
}
const timeline = (page: Page) => page.getByRole("region", { name: "Conversation timeline" });

test("a text becomes a conversation; the composer counts segments and the cost; the reply is texted and delivered", async ({ page }) => {
  await text("+447700900456", "Hi, is my order on its way?");
  await open(page, "is my order on its way");
  await expect(timeline(page).locator(".pg-message", { hasText: "is my order on its way" })).toContainText("via SMS");
  await expect(page.getByLabel("Where this reply goes")).toHaveText("Sent by SMS from +447700900100 to +447700900456");
  const box = page.getByRole("textbox", { name: "Reply message" });
  await box.fill("Yes, it ships today.");
  await expect(page.getByLabel("Text length")).toHaveText("1 segment (20/160) · about 0.0524 USD");
  await box.fill("Yes, it ships today 🚚");
  await expect(page.getByLabel("Text length")).toContainText("1 segment (22/70, Unicode)");
  await page.getByRole("button", { name: "Send reply", exact: true }).click();
  await expect.poll(() => relay.sms.sent.length, { timeout: 15000 }).toBe(1);
  expect(relay.sms.sent[0]).toMatchObject({ from: "+447700900100", to: "+447700900456", body: "Yes, it ships today 🚚" });
  await hook("status", relay.sms.status(relay.sms.sent[0].sid, "delivered"));
  await page.reload();
  await page.locator(".pg-card", { hasText: "is my order on its way" }).click();
  await expect(timeline(page).locator(".pg-message", { hasText: "it ships today" }).locator(".pg-delivery")).toHaveText("Delivered");

  // Settings › SMS: the account, the number, and the consent the customer gave by texting.
  await page.goto(relay.hostOrigin + "/agent#settings/sms");
  await expect(page.getByLabel("Twilio account status")).toContainText("Connected");
  await expect(page.getByRole("list", { name: "SMS numbers" })).toContainText("+447700900100");
  await expect(page.getByRole("list", { name: "Numbers that agreed to texts" })).toContainText("They texted you");
});

test("STOP opts the number out and the next reply is refused at once; a long text is over the limit; a number not in the account fails", async ({ page }) => {
  await text("+447700900789", "Can I change my delivery address?");
  await text("+447700900789", "STOP");
  await page.goto(relay.hostOrigin + "/agent#settings/suppressions");
  await expect(page.getByRole("list", { name: "Suppressed addresses" }).getByRole("listitem").filter({ hasText: "+447700900789" })).toContainText("Opted out");

  const before = relay.sms.sent.length;
  await open(page, "change my delivery address");
  const box = page.getByRole("textbox", { name: "Reply message" });
  await box.fill("a".repeat(1600));
  await expect(page.getByLabel("Text length")).toContainText("11 segments");
  await expect(page.getByLabel("Text length")).toContainText("too long: 10 at most");
  await box.fill("Noted.");
  await page.getByRole("button", { name: "Send reply", exact: true }).click();
  await expect(page.getByText("This number opted out (STOP): nothing can be texted to it until it texts START.")).toBeVisible();
  expect(relay.sms.sent.length).toBe(before);

  await page.goto(relay.hostOrigin + "/agent#settings/sms");
  await page.getByLabel("Number (with country code)").fill("+44 7700 900999");
  await page.getByRole("button", { name: "Add number" }).click();
  await expect
    .poll(async () => (await tenant(relay.db.connect, "demo", (db) => db.query("SELECT status FROM sms_numbers WHERE phone='+447700900999'"))).rows[0]?.status, { timeout: 15000 })
    .toBe("failed");
  await page.reload();
  await expect(page.getByRole("list", { name: "SMS numbers" }).getByRole("listitem").filter({ hasText: "+447700900999" })).toContainText("That number isn't in the Twilio account.");
});

import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { metaClock } from "../../server/meta-messaging";

/**
 * Instagram and Facebook Messenger (phase 12, E7; docs/OMNICHANNEL_STEP7.md), with the demo's
 * seeded Page and Instagram account: a Messenger message becomes a conversation and the reply is
 * delivered; an Instagram story reply shows as one; a day on, a teammate may still reply (as a
 * person); a week on, nothing goes; a Page with a bad token isn't connected, and says why.
 */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9048, hostPort: 9049, inboxViews: true, aiAgent: false, exampleMeta: true });
});
test.afterAll(async () => {
  metaClock.now = () => Date.now();
  await relay?.close();
});

async function hook(payload: unknown) {
  const call = await relay.meta.signed(payload);
  const r = await fetch(relay.apiOrigin + "/v1/hooks/meta/demo", { method: "POST", headers: { "x-hub-signature-256": call.signature }, body: call.body });
  expect(r.status).toBe(200);
  await expect
    .poll(async () => (await tenant(relay.db.connect, "demo", (db) => db.query("SELECT count(*)::int AS n FROM meta_inbound WHERE status='received'"))).rows[0].n, { timeout: 15000 })
    .toBe(0);
}
async function open(page: Page, card: string) {
  await page.goto(relay.hostOrigin + "/agent");
  await page.locator(".pg-card", { hasText: card }).click();
}
const timeline = (page: Page) => page.getByRole("region", { name: "Conversation timeline" });

test("a Messenger message becomes a conversation and the reply is delivered; an Instagram story reply shows as one", async ({ page }) => {
  relay.meta.people.set("7000001", "Ada Lovelace");
  await hook(relay.meta.message("facebook", "7000001", { text: "Hi, where's my order?" }));
  await open(page, "where's my order");
  await expect(timeline(page).locator(".pg-message", { hasText: "where's my order" })).toContainText("via Facebook Messenger");
  await expect(page.getByLabel("Where this reply goes")).toContainText("Sent by Facebook Messenger to 7000001 · window open until");
  await page.getByRole("textbox", { name: "Reply message" }).fill("It ships today.");
  await page.getByRole("button", { name: "Send reply", exact: true }).click();
  await expect.poll(() => relay.meta.sent.length, { timeout: 15000 }).toBe(1);
  expect(relay.meta.sent[0].body).toEqual({ recipient: { id: "7000001" }, messaging_type: "RESPONSE", message: { text: "It ships today." } });
  await hook(relay.meta.receipt("facebook", "7000001", { delivery: { mids: [relay.meta.sent[0].messageId] } }));
  await page.reload();
  await page.locator(".pg-card", { hasText: "where's my order" }).click();
  await expect(timeline(page).locator(".pg-message", { hasText: "It ships today." }).locator(".pg-delivery")).toHaveText("Delivered");

  await hook(relay.meta.message("instagram", "17841400000000002", { text: "Love this!", reply_to: { story: { url: "https://lookaside.fbsbx.com/story/1", id: "s1" } } }));
  await open(page, "Replied to your story");
  await expect(timeline(page).locator(".pg-message", { hasText: "Replied to your story: Love this!" })).toContainText("via Instagram");

  // Settings › Instagram & Facebook: the Page connected with its Instagram account, and the webhook.
  await page.goto(relay.hostOrigin + "/agent#settings/meta");
  await expect(page.getByLabel("Status of Relay Demo")).toContainText("Connected");
  await expect(page.getByText("With Instagram @relay.demo.")).toBeVisible();
  await expect(page.getByRole("table", { name: "Webhook to set up at Meta" })).toContainText(`${relay.apiOrigin}/v1/hooks/meta/demo`);
});

test("a day on a teammate may still reply; a week on nothing goes; a Page with a bad token isn't connected", async ({ page }) => {
  await hook(relay.meta.message("facebook", "7000009", { text: "Can I change my address?" }));
  metaClock.now = () => Date.now() + 25 * 3_600_000;
  try {
    await open(page, "change my address");
    await expect(page.getByText(/Messenger's 24-hour window has closed: you can still reply until .+ \(as a person, not automation\)\./)).toBeVisible();
    await page.getByRole("textbox", { name: "Reply message" }).fill("Yes: what's the new one?");
    await page.getByRole("button", { name: "Send reply", exact: true }).click();
    await expect.poll(() => relay.meta.sent.at(-1)?.body.tag, { timeout: 15000 }).toBe("HUMAN_AGENT");

    metaClock.now = () => Date.now() + 8 * 86_400_000;
    const before = relay.meta.sent.length;
    await open(page, "change my address");
    await expect(page.getByText("Messenger's 7-day window has closed: they need to message you first.").first()).toBeVisible();
    await page.getByRole("textbox", { name: "Reply message" }).fill("Still there?");
    await page.getByRole("button", { name: "Send reply", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "7-day window has closed" })).toBeVisible();
    expect(relay.meta.sent.length).toBe(before);
  } finally {
    metaClock.now = () => Date.now();
  }

  await page.goto(relay.hostOrigin + "/agent#settings/meta");
  await page.getByLabel("Page ID").fill("300000000000002");
  await page.getByLabel("Page access token").fill("a-token-meta-will-refuse-00000000");
  await page.getByLabel("App secret").fill("a".repeat(32));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect
    .poll(async () => (await tenant(relay.db.connect, "demo", (db) => db.query("SELECT status FROM meta_pages WHERE page_id='300000000000002'"))).rows[0]?.status, { timeout: 15000 })
    .toBe("failed");
  await page.reload();
  await expect(page.getByLabel("Status of 300000000000002")).toContainText("Not connected");
  await expect(page.getByText("Meta refused: Invalid OAuth access token.")).toBeVisible();
});

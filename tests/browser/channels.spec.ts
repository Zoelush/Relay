import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { deliveryReport, receiveInbound, type ChannelAdapter, type Outbound } from "../../server/channels";

/**
 * The channel contract (phase 12, E1; docs/OMNICHANNEL_STEP1.md), with a stand-in channel shaped
 * like email: a message arrives on it, the inbox shows where it came from, and a reply is
 * delivered by the channel, or not, when its address is suppressed.
 */
const sent: Outbound[] = [];
const mail: ChannelAdapter = {
  id: "mail",
  capabilities: { richText: false, attachments: true, buttons: false, maxLength: 2000, windowHours: null, ai: false, receipts: "read", address: "email" },
  address: (raw) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.trim()) ? raw.trim().toLowerCase() : null),
  async send(out) {
    sent.push(out);
    return { status: "sent", providerId: "mail-" + sent.length };
  },
};
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9036, hostPort: 9037, inboxViews: true, aiAgent: false, channels: [mail] });
});
test.afterAll(async () => {
  await relay?.close();
});
const inbound = (externalId: string, address: string, text: string) =>
  tenant(relay.db.connect, "demo", (db) => receiveInbound(db, "demo", mail, { externalId, address, verified: false, text, threadKeys: [], brandId: "default" }));
async function reply(page: Page, card: string, text: string) {
  await page.goto(relay.hostOrigin + "/agent");
  await page.locator(".pg-card", { hasText: card }).click();
  await page.getByRole("textbox", { name: "Reply message" }).fill(text);
  await page.getByRole("button", { name: "Send reply", exact: true }).click();
}

test("a message on another channel shows where it came from, and the reply is delivered there with its status", async ({ page }) => {
  await inbound("e2e-1", "Robin@Example.com", "My parcel never arrived");
  await reply(page, "My parcel never arrived", "Sorry about that: we're sending another.");
  const timeline = page.getByRole("region", { name: "Conversation timeline" });
  await expect(timeline.locator(".pg-message", { hasText: "My parcel never arrived" })).toContainText("via Mail");
  const sentReply = timeline.locator(".pg-message", { hasText: "we're sending another" });
  await expect(sentReply).toContainText("via Mail");
  await expect.poll(() => sent.map((s) => [s.address, s.text]), { timeout: 15000 }).toEqual([["robin@example.com", "Sorry about that: we're sending another."]]);
  await page.reload();
  await page.locator(".pg-card", { hasText: "My parcel never arrived" }).click();
  await expect(timeline.locator(".pg-message", { hasText: "we're sending another" }).locator(".pg-delivery")).toHaveText("Sent");
  // The provider reports it read.
  await tenant(relay.db.connect, "demo", (db) => deliveryReport(db, "demo", "mail", "mail-1", { status: "read" }));
  await page.reload();
  await page.locator(".pg-card", { hasText: "My parcel never arrived" }).click();
  await expect(timeline.locator(".pg-message", { hasText: "we're sending another" }).locator(".pg-delivery")).toHaveText("Read");
});

test("a suppressed address is sent nothing: the reply says so; a manual block is lifted, an opt-out can't be", async ({ page }) => {
  await inbound("e2e-2", "casey@example.com", "Please stop emailing me");
  await page.goto(relay.hostOrigin + "/agent#settings/suppressions");
  await expect(page.getByRole("heading", { name: "Suppression list" })).toBeVisible();
  await page.getByLabel("Channel").selectOption("mail");
  await page.getByRole("textbox", { name: "Address", exact: true }).fill("CASEY@example.com");
  await page.getByLabel("Note (optional)").fill("Asked by phone");
  await page.getByRole("button", { name: "Block" }).click();
  const list = page.getByRole("list", { name: "Suppressed addresses" });
  await expect(list).toContainText("casey@example.com");
  await expect(list).toContainText("Blocked by a teammate");
  await expect(list).toContainText("“Asked by phone”");

  const before = sent.length;
  await reply(page, "Please stop emailing me", "Understood, we'll stop.");
  const timeline = page.getByRole("region", { name: "Conversation timeline" });
  await expect
    .poll(async () => (await tenant(relay.db.connect, "demo", (db) => db.query("SELECT status FROM channel_deliveries WHERE address='casey@example.com'"))).rows.map((r) => r.status), {
      timeout: 15000,
    })
    .toEqual(["suppressed"]);
  await page.reload();
  await page.locator(".pg-card", { hasText: "Please stop emailing me" }).click();
  await expect(timeline.locator(".pg-message", { hasText: "Understood" }).locator(".pg-delivery")).toHaveText("Not sent: the address is suppressed");
  expect(sent.length).toBe(before);

  // An opt-out stays; the manual block is lifted.
  await tenant(relay.db.connect, "demo", (db) =>
    db.query("INSERT INTO suppressions(workspace_id,id,channel,address,reason,source) VALUES('demo','e2e-opt','mail','sam@example.com','opt_out','keyword')"),
  );
  await page.goto(relay.hostOrigin + "/agent#settings/suppressions");
  const optOut = list.getByRole("listitem").filter({ hasText: "sam@example.com" });
  await expect(optOut).toContainText("Opted out");
  await expect(optOut.getByRole("button", { name: "Lift" })).toHaveCount(0);
  await list.getByRole("listitem").filter({ hasText: "casey@example.com" }).getByRole("button", { name: "Lift" }).click();
  await expect(page.getByRole("status")).toHaveText("Lifted casey@example.com.");
  await expect(list).not.toContainText("casey@example.com");
  await page.getByText("Lifted (1)").click();
  await expect(page.locator("details")).toContainText("casey@example.com");
});

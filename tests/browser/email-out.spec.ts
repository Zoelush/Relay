import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay, LOCAL_EMAIL_DOMAIN, LOCAL_SES_REGION } from "../../scripts/local-relay";
import { sesEvent } from "../../scripts/local-email";
import { tenant } from "../../server/db";
import { domainRecords } from "../../server/email-out";

/**
 * Email out (phase 12, E3; docs/OMNICHANNEL_STEP3.md): a teammate's reply on an email conversation
 * is emailed in its thread (the composer says where it goes), SES's signed reports move its
 * status, and the brand's own domain is proven in Settings; a hard bounce suppresses the address,
 * after which nothing is sent to it.
 */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9040, hostPort: 9041, inboxViews: true, aiAgent: false });
});
test.afterAll(async () => {
  await relay?.close();
});

const post = (o: { id: string; from: string; subject: string; text: string }) =>
  fetch(relay.apiOrigin + "/dev/email", {
    method: "POST",
    headers: { "X-Envelope-To": `demo+support@${LOCAL_EMAIL_DOMAIN}`, "X-Envelope-From": o.from },
    body: [`From: ${o.from}`, "To: help@acme.example", `Subject: ${o.subject}`, `Message-ID: <${o.id}>`, `Date: ${new Date().toUTCString()}`, "Content-Type: text/plain; charset=utf-8", "", o.text].join(
      "\r\n",
    ),
  });
const settled = () =>
  expect
    .poll(async () => (await tenant(relay.db.connect, "demo", (db) => db.query("SELECT count(*)::int AS n FROM email_inbound WHERE status='received'"))).rows[0].n, { timeout: 15000 })
    .toBe(0);
async function reply(page: Page, card: string, text: string) {
  await page.goto(relay.hostOrigin + "/agent");
  await page.locator(".pg-card", { hasText: card }).click();
  await page.getByRole("textbox", { name: "Reply message" }).fill(text);
  await page.getByRole("button", { name: "Send reply", exact: true }).click();
}
const report = async (kind: "Delivery" | "Bounce", index = -1) =>
  fetch(relay.apiOrigin + "/v1/hooks/ses", { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(await relay.sns.notification(sesEvent(kind, relay.email.outbox.at(index)!))) });
const status = (page: Page, text: string) => page.getByRole("region", { name: "Conversation timeline" }).locator(".pg-message", { hasText: text }).locator(".pg-delivery");

test("a reply is emailed in its thread from Relay's address, delivered, and then from the brand's own domain once proven", async ({ page }) => {
  await post({ id: "e3-1@customer.example", from: "Robin Hale <robin@customer.example>", subject: "Damaged order", text: "My order #4411 arrived damaged." });
  await settled();
  await page.goto(relay.hostOrigin + "/agent");
  await page.locator(".pg-card", { hasText: "arrived damaged" }).click();
  await expect(page.getByLabel("Where this reply goes")).toHaveText("Emailed to robin@customer.example · Re: Damaged order");
  await page.getByRole("textbox", { name: "Reply message" }).fill("Sorry about that: we're sending another.");
  await page.getByRole("button", { name: "Send reply", exact: true }).click();
  await expect.poll(() => relay.email.outbox.length, { timeout: 15000 }).toBe(1);
  const sent = await relay.email.read(relay.email.outbox[0]);
  expect([sent.from, sent.fromName, sent.to, sent.subject, sent.inReplyTo]).toEqual([
    `demo+support@${LOCAL_EMAIL_DOMAIN}`,
    "Support from Relay",
    "robin@customer.example",
    "Re: Damaged order",
    "<e3-1@customer.example>",
  ]);
  expect(sent.replyTo).toMatch(/^demo\+r-[a-z0-9]{20}@/);
  expect(sent.text).toContain("> My order #4411 arrived damaged.");
  await page.reload();
  await page.locator(".pg-card", { hasText: "arrived damaged" }).click();
  await expect(status(page, "sending another")).toHaveText("Sent");
  // SES reports it delivered, signed through SNS.
  expect((await report("Delivery")).status).toBe(200);
  await page.reload();
  await page.locator(".pg-card", { hasText: "arrived damaged" }).click();
  await expect(status(page, "sending another")).toHaveText("Delivered");

  // Settings › Email: the support address's domain, its records (missing), then published and proven.
  await page.goto(relay.hostOrigin + "/agent#settings/email");
  await page.getByLabel("Your support address").fill("help@acme.example");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const sending = page.getByRole("region", { name: "Sending for Relay" });
  await expect(sending).toContainText(`Replies go from demo+support@${LOCAL_EMAIL_DOMAIN}`);
  // The first check has run when its records are written.
  await expect
    .poll(async () => (await tenant(relay.db.connect, "demo", (db) => db.query("SELECT jsonb_array_length(records) AS n FROM email_domains WHERE domain='acme.example'"))).rows[0]?.n ?? 0, {
      timeout: 15000,
    })
    .toBe(7);
  await page.reload();
  await expect(sending.getByRole("table", { name: "DNS records for acme.example" })).toContainText("Not found");
  await expect(sending.locator(".pg-email-status")).toHaveText("Waiting for DNS");
  const d = (await tenant(relay.db.connect, "demo", (db) => db.query<{ ownership_token: string }>("SELECT ownership_token FROM email_domains WHERE domain='acme.example'"))).rows[0];
  relay.email.publishAll(domainRecords("acme.example", d.ownership_token, (await relay.email.sender.identity("acme.example")).dkimTokens, LOCAL_SES_REGION));
  await sending.getByRole("button", { name: "Check now" }).click();
  await expect(page.getByRole("status").first()).toHaveText("Checking acme.example: this takes a moment.");
  await expect
    .poll(async () => (await tenant(relay.db.connect, "demo", (db) => db.query("SELECT status FROM email_domains WHERE domain='acme.example'"))).rows[0].status, { timeout: 15000 })
    .toBe("verified");
  await page.reload();
  await expect(sending.locator(".pg-email-status")).toHaveText("Sending from your domain");
  await expect(sending).toContainText("Replies go from help@acme.example");
  await expect(sending.getByRole("table", { name: "DNS records for acme.example" }).locator("[data-status='ok']")).toHaveCount(7);
  await expect(page.getByRole("region", { name: `Reputation of ${LOCAL_EMAIL_DOMAIN}` })).toContainText("Too few emails to judge");

  await reply(page, "arrived damaged", "The new one ships today.");
  await expect.poll(() => relay.email.outbox.length, { timeout: 15000 }).toBe(2);
  expect((await relay.email.read(relay.email.outbox[1])).from).toBe("help@acme.example");

  // Away emails: the replies themselves included.
  await page.goto(relay.hostOrigin + "/agent#settings/email");
  const away = page.getByRole("form", { name: "Away emails for Relay" });
  await away.getByLabel("Include the replies themselves").check();
  await away.getByRole("button", { name: "Save away emails" }).click();
  await expect(page.getByRole("status").first()).toHaveText("Away emails saved.");
  await page.reload();
  await expect(page.getByRole("form", { name: "Away emails for Relay" }).getByLabel("Include the replies themselves")).toBeChecked();
});

test("a hard bounce fails the reply and suppresses the address; nothing more is sent to it, and forged reports change nothing", async ({ page }) => {
  await post({ id: "e3-10@customer.example", from: "Jo <jo@customer.example>", subject: "Cancel my plan", text: "Please cancel my plan." });
  await settled();
  const before = relay.email.outbox.length;
  await reply(page, "Please cancel my plan", "Done: your plan is cancelled.");
  await expect.poll(() => relay.email.outbox.length, { timeout: 15000 }).toBe(before + 1);

  // A forged report (a bad signature) is refused, and changes nothing.
  const forged = { ...(await relay.sns.notification(sesEvent("Bounce", relay.email.outbox.at(-1)!))), Signature: btoa("forged") };
  expect((await fetch(relay.apiOrigin + "/v1/hooks/ses", { method: "POST", body: JSON.stringify(forged) })).status).toBe(403);
  await page.reload();
  await page.locator(".pg-card", { hasText: "Please cancel my plan" }).click();
  await expect(status(page, "your plan is cancelled")).toHaveText("Sent");

  expect((await report("Bounce")).status).toBe(200);
  await page.reload();
  await page.locator(".pg-card", { hasText: "Please cancel my plan" }).click();
  await expect(status(page, "your plan is cancelled")).toHaveText("Not delivered: It couldn't be delivered: smtp; 550 5.1.1 user unknown");
  await page.goto(relay.hostOrigin + "/agent#settings/suppressions");
  await expect(page.getByRole("list", { name: "Suppressed addresses" }).getByRole("listitem").filter({ hasText: "jo@customer.example" })).toContainText("Hard bounce");

  await reply(page, "Please cancel my plan", "One more thing.");
  await expect
    .poll(async () => (await tenant(relay.db.connect, "demo", (db) => db.query("SELECT status FROM channel_deliveries WHERE address='jo@customer.example' ORDER BY created_at"))).rows.map((r) => r.status), {
      timeout: 15000,
    })
    .toEqual(["failed", "suppressed"]);
  await page.reload();
  await page.locator(".pg-card", { hasText: "Please cancel my plan" }).click();
  await expect(status(page, "One more thing")).toHaveText("Not sent: the address is suppressed");
  expect(relay.email.outbox.length).toBe(before + 1);

  // A free mailbox can't be a sending domain: replies keep going from Relay's address.
  await page.goto(relay.hostOrigin + "/agent#settings/email");
  await page.getByLabel("Your support address").fill("acme.help@gmail.com");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("region", { name: "Sending for Relay" })).toContainText("Replies can't go from gmail.com");
});

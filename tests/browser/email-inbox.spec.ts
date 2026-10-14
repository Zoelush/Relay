import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay, LOCAL_EMAIL_DOMAIN } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { append, conversation } from "../../server/conversations";

/**
 * Email in the inbox (phase 12, E4; docs/OMNICHANNEL_STEP4.md): an email's recipients on the
 * message, Cc carried into the reply, a side conversation with a supplier and its answer in the
 * timeline (team only), and Zoe's draft held for a teammate, who discards it.
 */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  // Zoe on (her settings page), answering no one here: email is hers only as the setting allows.
  relay = await startLocalRelay({ apiPort: 9042, hostPort: 9043, inboxViews: true });
});
test.afterAll(async () => {
  await relay?.close();
});

const post = (o: { id: string; from: string; subject: string; text: string; cc?: string }, to = `demo+support@${LOCAL_EMAIL_DOMAIN}`) =>
  fetch(relay.apiOrigin + "/dev/email", {
    method: "POST",
    headers: { "X-Envelope-To": to, "X-Envelope-From": "x@mail.example.net" },
    body: [
      `From: ${o.from}`,
      "To: help@acme.example",
      ...(o.cc ? [`Cc: ${o.cc}`] : []),
      `Subject: ${o.subject}`,
      `Message-ID: <${o.id}>`,
      `Date: ${new Date().toUTCString()}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      o.text,
    ].join("\r\n"),
  });
const settled = () =>
  expect
    .poll(async () => (await tenant(relay.db.connect, "demo", (db) => db.query("SELECT count(*)::int AS n FROM email_inbound WHERE status='received'"))).rows[0].n, { timeout: 15000 })
    .toBe(0);
async function open(page: Page, card: string) {
  await page.goto(relay.hostOrigin + "/agent");
  await page.locator(".pg-card", { hasText: card }).click();
}
const timeline = (page: Page) => page.getByRole("region", { name: "Conversation timeline" });

test("an email's copies carry into the reply, and a side conversation with a supplier stays in the timeline for the team", async ({ page }) => {
  await post({ id: "e4-1@customer.example", from: "Robin <robin@customer.example>", cc: "Lee <lee@customer.example>", subject: "Damaged order", text: "My order #4411 arrived damaged." });
  await settled();
  await open(page, "arrived damaged");
  await expect(timeline(page).locator(".pg-message", { hasText: "arrived damaged" }).locator(".pg-email-recipients")).toHaveText("To help@acme.example · Cc lee@customer.example");
  // Reply all: Cc starts with who the customer copied in.
  await expect(page.getByLabel("Cc", { exact: true })).toHaveValue("lee@customer.example");
  await page.getByLabel("Bcc", { exact: true }).fill("manager@acme.example");
  await page.getByRole("textbox", { name: "Reply message" }).fill("Sorry: we're sending another.");
  await page.getByRole("button", { name: "Send reply", exact: true }).click();
  await expect.poll(() => relay.email.outbox.length, { timeout: 15000 }).toBe(1);
  expect([relay.email.outbox[0].cc, relay.email.outbox[0].bcc]).toEqual([["lee@customer.example"], ["manager@acme.example"]]);
  await expect(timeline(page).locator(".pg-message", { hasText: "sending another" }).locator(".pg-email-recipients")).toHaveText(
    "Cc lee@customer.example · Bcc manager@acme.example",
  );

  // A side conversation: emailed to the supplier, shown for the team only, never to the customer.
  await page.getByRole("button", { name: /^Side conversation/ }).click();
  const dialog = page.getByRole("dialog", { name: "New side conversation" });
  await dialog.getByLabel("To").fill("orders@supplier.example");
  await dialog.getByLabel("Subject").fill("Replacement for order 4411");
  await dialog.getByLabel("Message").fill("Can you ship a replacement today?");
  await dialog.getByRole("button", { name: "Send" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => relay.email.outbox.length, { timeout: 15000 }).toBe(2);
  const toSupplier = await relay.email.read(relay.email.outbox[1]);
  expect([toSupplier.to, toSupplier.subject]).toEqual(["orders@supplier.example", "Replacement for order 4411"]);
  const sideOut = timeline(page).locator(".pg-message", { hasText: "ship a replacement today" });
  await expect(sideOut).toContainText("Side conversation · Support teammate to orders@supplier.example · Team only");
  await expect(page.getByRole("button", { name: "Side conversation (1)" })).toBeVisible();

  // The supplier answers to the side conversation's address: in the timeline, from them, team only.
  expect((await post({ id: "e4-s1@supplier.example", from: "Orders <orders@supplier.example>", subject: "Re: Replacement for order 4411", text: "Shipping today." }, toSupplier.replyTo)).status).toBe(202);
  await settled();
  await page.reload();
  await page.locator(".pg-card", { hasText: "arrived damaged" }).click();
  const sideIn = timeline(page).locator(".pg-message", { hasText: "Shipping today." });
  await expect(sideIn).toContainText("Side conversation · from Orders <orders@supplier.example> · Team only");
  await sideIn.getByRole("button", { name: "Reply in the side conversation" }).click();
  await sideIn.getByLabel("Side conversation reply").fill("Thanks!");
  await sideIn.getByRole("button", { name: "Send to the side conversation" }).click();
  await expect.poll(() => relay.email.outbox.length, { timeout: 15000 }).toBe(3);
  const back = await relay.email.read(relay.email.outbox[2]);
  expect([back.to, back.subject, back.inReplyTo]).toEqual(["orders@supplier.example", "Re: Replacement for order 4411", "<e4-s1@supplier.example>"]);
  expect(relay.email.outbox.filter((m) => m.to === "robin@customer.example").length).toBe(1);
});

test("Zoe's draft on email waits for a teammate, who discards it: nothing is sent, and the team has the conversation", async ({ page }) => {
  // Zoe drafts on email (Zoe › Answering › Email), and her reply is held.
  await page.goto(relay.hostOrigin + "/agent#zoe/settings");
  await page.getByRole("radio", { name: /Draft replies for a teammate to approve/ }).check();
  await page.getByRole("button", { name: "Save" }).first().click();
  await expect.poll(async () => (await tenant(relay.db.connect, "demo", (db) => db.query("SELECT email_mode FROM ai_agents"))).rows[0].email_mode, { timeout: 10000 }).toBe("approve");

  await post({ id: "e4-z1@customer.example", from: "Sam <sam@customer.example>", subject: "Returns", text: "How do returns work?" });
  await settled();
  const c = (await tenant(relay.db.connect, "demo", (db) => db.query<{ conversation_id: string }>("SELECT conversation_id FROM email_inbound ORDER BY received_at DESC LIMIT 1"))).rows[0].conversation_id;
  await tenant(relay.db.connect, "demo", async (db) => append(db, "demo", await conversation(db, "demo", c), { type: "ai", id: "default" }, "ai_reply", "Returns are free within 30 days.", {}));
  const before = relay.email.outbox.length;
  await open(page, "How do returns work?");
  const draft = timeline(page).locator(".pg-message", { hasText: "Returns are free" });
  await expect(draft.locator(".pg-delivery")).toHaveText("Waiting for a teammate's approval");
  await draft.getByRole("button", { name: "Discard" }).click();
  await expect(draft.locator(".pg-delivery")).toContainText("Not delivered: Discarded by");
  expect(relay.email.outbox.length).toBe(before);
  expect((await tenant(relay.db.connect, "demo", (db) => db.query("SELECT ai_state FROM conversations WHERE id=$1", [c]))).rows[0].ai_state).toBe("escalated");

  // A side conversation needs an address: refused with the reason.
  await page.getByRole("button", { name: /^Side conversation/ }).click();
  const dialog = page.getByRole("dialog", { name: "New side conversation" });
  await dialog.getByLabel("To").fill("not an address");
  await dialog.getByLabel("Subject").fill("Hi");
  await dialog.getByLabel("Message").fill("Hello");
  await dialog.getByRole("button", { name: "Send" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Send it to one to ten email addresses.");
});

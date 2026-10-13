import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay, LOCAL_EMAIL_DOMAIN } from "../../scripts/local-relay";
import { tenant } from "../../server/db";

/**
 * Email in (phase 12, E2; docs/OMNICHANNEL_STEP2.md): mail at a brand's inbound address becomes a
 * conversation, its reply joins the thread, and the full email opens safely; automatic replies and
 * bounces stay internal (a hard bounce suppresses the address), and mail to an unknown address is
 * refused.
 */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
const ADDRESS = `demo+support@${LOCAL_EMAIL_DOMAIN}`;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9038, hostPort: 9039, inboxViews: true, aiAgent: false });
});
test.afterAll(async () => {
  await relay?.close();
});

const eml = (headers: Record<string, string>, body: string, type = "text/plain; charset=utf-8") =>
  [
    ...Object.entries({ Date: new Date().toUTCString(), "MIME-Version": "1.0", "Content-Type": type, ...headers }).map(([k, v]) => `${k}: ${v}`),
    "",
    body,
  ].join("\r\n");
const post = (raw: string, to = ADDRESS, from = "sender@customer.example") =>
  fetch(relay.apiOrigin + "/dev/email", { method: "POST", headers: { "X-Envelope-To": to, "X-Envelope-From": from }, body: raw });
const settled = () =>
  expect
    .poll(async () => (await tenant(relay.db.connect, "demo", (db) => db.query("SELECT count(*)::int AS n FROM email_inbound WHERE status='received'"))).rows[0].n, {
      timeout: 15000,
    })
    .toBe(0);
async function open(page: Page, card: string) {
  await page.goto(relay.hostOrigin + "/agent");
  await page.locator(".pg-card", { hasText: card }).click();
}

test("an email becomes a conversation, its reply joins the thread, and the full email opens with remote images blocked", async ({ page }) => {
  const html = `<div>Hello, my order #4411 arrived damaged. <img src="https://tracker.example/p.gif" alt=""></div>
<div class="gmail_quote"><blockquote>Thanks for your order!</blockquote></div><script>alert(1)</script>`;
  expect(
    (
      await post(
        eml(
          { From: "Robin Hale <robin@customer.example>", To: "help@acme.example", Subject: "Damaged order", "Message-ID": "<e2e-1@customer.example>" },
          html,
          "text/html; charset=utf-8",
        ),
      )
    ).status,
  ).toBe(202);
  await settled();
  await open(page, "arrived damaged");
  const timeline = page.getByRole("region", { name: "Conversation timeline" });
  const first = timeline.locator(".pg-message", { hasText: "arrived damaged" });
  await expect(first).toContainText("via Email");
  await expect(first.locator(".pg-email-subject")).toHaveText("Damaged order");
  await expect(first).not.toContainText("Thanks for your order!");

  // The customer's reply, quoting the first, threads by In-Reply-To and loses the quote.
  await post(
    eml(
      { From: "Robin Hale <robin@customer.example>", To: "help@acme.example", Subject: "Re: Damaged order", "Message-ID": "<e2e-2@customer.example>", "In-Reply-To": "<e2e-1@customer.example>" },
      "Photos are attached to the courier claim.\r\n\r\nOn Mon, 12 Oct 2026 at 09:00, Robin Hale <robin@customer.example> wrote:\r\n> Hello, my order #4411 arrived damaged.",
    ),
  );
  await settled();
  await page.reload();
  await page.locator(".pg-card", { hasText: "courier claim" }).click();
  await expect(timeline.locator(".pg-message")).toHaveCount(2);
  await expect(timeline.locator(".pg-message", { hasText: "courier claim" })).not.toContainText("wrote:");

  // The full email: unverified sender, the tracker blocked, scripts gone, quoted history kept.
  await first.getByRole("button", { name: "Show the full email" }).click();
  const dialog = page.getByRole("dialog", { name: "Full email" });
  await expect(dialog.getByRole("heading", { name: "Damaged order" })).toBeVisible();
  await expect(dialog).toContainText("Robin Hale <robin@customer.example>");
  await expect(dialog).toContainText("Sender not verified");
  await expect(dialog).toContainText("1 remote image is blocked");
  const frame = dialog.locator("iframe[title='Email content']");
  await expect(frame).toHaveAttribute("sandbox", "allow-popups allow-popups-to-escape-sandbox");
  const doc = (await frame.getAttribute("srcdoc")) ?? "";
  expect(doc).toContain("Thanks for your order!");
  expect(doc).not.toContain("<script");
  expect(doc).not.toMatch(/ src="https:\/\/tracker/);
  await dialog.getByRole("button", { name: "Load images" }).click();
  expect(await frame.getAttribute("srcdoc")).toMatch(/ src="https:\/\/tracker/);
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);

  // Settings › Email: the inbound address, and forwarding confirmed by a forwarded message.
  await page.goto(relay.hostOrigin + "/agent#settings/email");
  await expect(page.getByLabel("Relay's inbound address")).toHaveValue(ADDRESS);
  await page.getByLabel("Your support address").fill("help@acme.example");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status").first()).toHaveText("Saved help@acme.example.");
  await expect(page.getByLabel("Forwarding for Relay")).toContainText("Waiting for an email forwarded from help@acme.example");
  await post(eml({ From: "Jo <jo@customer.example>", To: "help@acme.example", Subject: "Opening hours?", "Message-ID": "<e2e-3@customer.example>" }, "When are you open?"));
  await settled();
  await page.reload();
  await expect(page.getByLabel("Forwarding for Relay")).toContainText("Forwarding from help@acme.example is working");
  await expect(page.getByRole("list", { name: "Latest mail" })).toContainText("Message");
});

test("automatic replies and bounces stay internal, a hard bounce suppresses the address, and unknown addresses are refused", async ({ page }) => {
  await post(eml({ From: "Casey <casey@customer.example>", To: "help@acme.example", Subject: "Cancel my plan", "Message-ID": "<e2e-10@customer.example>" }, "Please cancel my plan."));
  await settled();
  const before = (await tenant(relay.db.connect, "demo", (db) => db.query("SELECT count(*)::int AS n FROM conversations"))).rows[0].n;

  // An out-of-office in the thread, and a hard bounce for the customer's address.
  await post(
    eml(
      {
        From: "Casey <casey@customer.example>",
        To: "help@acme.example",
        Subject: "Automatic reply: Cancel my plan",
        "Message-ID": "<e2e-11@customer.example>",
        "In-Reply-To": "<e2e-10@customer.example>",
        "Auto-Submitted": "auto-replied",
      },
      "I'm away until Monday.",
    ),
  );
  const boundary = "dsn-e2e";
  await post(
    eml(
      {
        From: "Mail Delivery System <MAILER-DAEMON@mx.customer.example>",
        To: "help@acme.example",
        Subject: "Delivery Status Notification (Failure)",
        "Message-ID": "<e2e-12@mx.customer.example>",
        References: "<e2e-10@customer.example>",
        "Auto-Submitted": "auto-replied",
      },
      [
        `--${boundary}`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Your message couldn't be delivered.",
        `--${boundary}`,
        "Content-Type: message/delivery-status",
        "",
        "Reporting-MTA: dns; mx.customer.example",
        "",
        "Final-Recipient: rfc822; casey@customer.example",
        "Action: failed",
        "Status: 5.1.1",
        "Diagnostic-Code: smtp; 550 5.1.1 User unknown",
        `--${boundary}--`,
      ].join("\r\n"),
      `multipart/report; report-type=delivery-status; boundary="${boundary}"`,
    ),
  );
  await settled();
  expect((await tenant(relay.db.connect, "demo", (db) => db.query("SELECT count(*)::int AS n FROM conversations"))).rows[0].n).toBe(before);

  await open(page, "Please cancel my plan");
  const timeline = page.getByRole("region", { name: "Conversation timeline" });
  await expect(timeline.locator(".pg-message")).toHaveCount(1);
  await timeline.getByRole("button", { name: /^Show \d+ updates$/ }).click();
  await expect(timeline).toContainText("An automatic reply arrived by email (“Automatic reply: Cancel my plan”)");
  await expect(timeline).toContainText("A delivery problem was reported by email");
  await expect(timeline).not.toContainText("I'm away until Monday.");

  await page.goto(relay.hostOrigin + "/agent#settings/suppressions");
  const list = page.getByRole("list", { name: "Suppressed addresses" });
  await expect(list.getByRole("listitem").filter({ hasText: "casey@customer.example" })).toContainText("Hard bounce");

  // A reply can't be sent by email yet (E3): the teammate is told, nothing is sent.
  await open(page, "Please cancel my plan");
  await page.getByRole("textbox", { name: "Reply message" }).fill("Done: your plan is cancelled.");
  await page.getByRole("button", { name: "Send reply", exact: true }).click();
  await expect
    .poll(async () => (await tenant(relay.db.connect, "demo", (db) => db.query("SELECT status FROM channel_deliveries WHERE address='casey@customer.example'"))).rows.map((r) => r.status), {
      timeout: 15000,
    })
    .toEqual(["suppressed"]);

  // Unknown address, a retired one, and Relay's own domain as a support address are refused.
  const unknown = await post(eml({ From: "x@customer.example", Subject: "Hi", "Message-ID": "<e2e-20@customer.example>" }, "Hi"), `demo+nope1234@${LOCAL_EMAIL_DOMAIN}`);
  expect(unknown.status).toBe(550);
  expect(await unknown.json()).toEqual({ accepted: false, reason: "No such address." });
  await page.goto(relay.hostOrigin + "/agent#settings/email");
  await page.getByLabel("Your support address").fill(`help@${LOCAL_EMAIL_DOMAIN}`);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Use your own support address, not Relay's.");
  await page.getByRole("button", { name: "New inbound address" }).click();
  await page.getByRole("button", { name: "Make a new address" }).click();
  await expect(page.getByRole("status").first()).toHaveText("A new inbound address is ready: update your forwarding.");
  await expect(page.getByLabel("Relay's inbound address")).not.toHaveValue(ADDRESS);
  const retired = await post(eml({ From: "x@customer.example", Subject: "Hi", "Message-ID": "<e2e-21@customer.example>" }, "Hi"));
  expect(retired.status).toBe(550);
});

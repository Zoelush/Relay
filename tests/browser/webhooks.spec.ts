import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { startLocalRelay } from "../../scripts/local-relay";
import { verifyWebhook } from "../../sdk/javascript/relay.mjs";

/**
 * Webhooks (phase 15, D3; docs/DEVELOPER_PLATFORM_STEP3.md), end to end: a receiver on this machine
 * (the only address the relay is allowed to reach over http); a webhook made in Settings ›
 * Developers › Webhooks (its secret shown once); a customer's message arrives at the receiver,
 * signed so the SDK's check accepts it. When the receiver fails, the log shows the attempt and
 * its answer, and a replay delivers once it's fixed.
 */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
let receiver: Server;
let port = 0;
let answer = 200;
const got: { headers: Record<string, string>; body: string }[] = [];
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      got.push({ headers: req.headers as Record<string, string>, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(answer);
      res.end(answer === 200 ? "thanks" : "receiver is down");
    });
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
  port = (receiver.address() as { port: number }).port;
  relay = await startLocalRelay({ apiPort: 9068, hostPort: 9069, inboxViews: true, aiAgent: false, webhooks: { policy: { allowHosts: [`127.0.0.1:${port}`] } } });
});
test.afterAll(async () => {
  await relay?.close();
  receiver?.close();
});

test("a webhook made in Settings receives a customer's message, signed", async ({ page, browser }) => {
  await page.goto(relay.hostOrigin + "/agent#settings/webhooks");
  const form = page.locator("section", { hasText: "New webhook" }).last();
  await form.getByLabel("Address").fill(`http://127.0.0.1:${port}/relay`);
  await form.getByRole("checkbox", { name: "conversation.customer_replied" }).check();
  await form.getByRole("button", { name: "Create webhook" }).click();
  const shown = page.getByLabel("Your webhook secret");
  await expect(shown).toContainText("whsec_", { timeout: 15000 });
  const secret = (await shown.textContent())!.trim();
  await expect(page.getByRole("listitem", { name: `http://127.0.0.1:${port}/relay` })).toContainText("Active");

  const site = await (await browser.newContext()).newPage();
  await site.goto(relay.hostOrigin + "/");
  await site.getByRole("button", { name: "Open support", exact: true }).click();
  await expect.poll(() => site.frames().some((f) => f.url().includes("/messenger/frame.html")), { timeout: 15000 }).toBe(true);
  const frame = site.frames().find((f) => f.url().includes("/messenger/frame.html"))!;
  await frame.getByRole("button", { name: "Start a conversation" }).click();
  await frame.getByRole("textbox", { name: "Write your message" }).fill("Webhook me please");
  await frame.getByRole("button", { name: "Send message" }).click();

  await expect.poll(() => got.find((g) => g.body.includes("Webhook me please")), { timeout: 30000 }).toBeTruthy();
  const delivery = got.find((g) => g.body.includes("Webhook me please"))!;
  const event = await verifyWebhook(secret, delivery.body, delivery.headers["relay-signature"]);
  expect(event.topic).toBe("conversation.customer_replied");
  expect((event.data as { part: { body: string } }).part.body).toBe("Webhook me please");
  expect(delivery.headers["relay-event-id"]).toBe(event.id);
});

test("a failing receiver is retried and logged, and a replay delivers once it's fixed", async ({ page }) => {
  answer = 500;
  await page.goto(relay.hostOrigin + "/agent#settings/webhooks");
  const hook = page.getByRole("listitem", { name: `http://127.0.0.1:${port}/relay` });
  await hook.getByRole("button", { name: "Send test" }).click();
  const log = hook.getByRole("table", { name: "Deliveries" });
  await expect
    .poll(
      async () => {
        await hook.getByRole("button", { name: "Refresh" }).click();
        return (await log.getByRole("row").nth(1).textContent()) ?? "";
      },
      { timeout: 30000 },
    )
    .toContain("500");
  const ping = log.getByRole("row").nth(1);
  await expect(ping).toContainText("ping");
  await expect(ping).toContainText("Retrying");
  await ping.getByRole("button").first().click();
  await expect(page.getByRole("region", { name: "Delivery" })).toContainText("receiver is down");

  answer = 200;
  const before = got.length;
  await ping.getByRole("button", { name: "Replay" }).click();
  await expect.poll(() => got.length, { timeout: 30000 }).toBeGreaterThan(before);
  expect(JSON.parse(got.at(-1)!.body).topic).toBe("ping");
  await expect
    .poll(
      async () => {
        await hook.getByRole("button", { name: "Refresh" }).click();
        return (await log.getByRole("row").nth(1).textContent()) ?? "";
      },
      { timeout: 30000 },
    )
    .toContain("Delivered");
});

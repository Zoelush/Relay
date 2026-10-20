import { test, expect, type Page } from "@playwright/test";
import type { Server } from "node:http";
import { startLocalRelay } from "../../scripts/local-relay";
import { orderLookupApp } from "../../demo/order-lookup/app";
import { ordersFor, orderService } from "../../demo/order-lookup/orders";
import { listen } from "../../demo/order-lookup/serve";

/**
 * Canvas apps (phase 15, D5; docs/DEVELOPER_PLATFORM_STEP5.md), end to end, with the order-lookup
 * example app and its order service running on this machine: registered with a canvas in
 * Settings, installed through its own install page and Relay's consent screen, set up in Settings
 * (drawn by the app), then its card in the inbox sidebar lists the customer's orders and its
 * composer card puts an order's status into the reply. Stopped, it's a clear failure card with
 * Try again, and the failures show in Settings.
 */
const APP_PORT = 9084;
const ORDERS_PORT = 9085;
const APP = `http://127.0.0.1:${APP_PORT}`;
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
let app: ReturnType<typeof orderLookupApp>;
let servers: Server[] = [];
let appServer: Server;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9082, hostPort: 9083, aiAgent: false, canvas: { policy: { allowHosts: [`127.0.0.1:${APP_PORT}`] } } });
  app = orderLookupApp({ relayHost: relay.hostOrigin, relayApi: relay.apiOrigin, publicUrl: APP, orderService: `http://127.0.0.1:${ORDERS_PORT}` });
  appServer = await listen(app.handle, APP_PORT);
  servers = [await listen(orderService(), ORDERS_PORT), appServer];
});
test.afterAll(async () => {
  for (const s of servers) {
    s.closeAllConnections();
    s.close();
  }
  await relay?.close();
});

/** Asks the agent API from inside the page, as the app does. */
const ask = <T,>(page: Page, path: string, body: Record<string, unknown>) =>
  page.evaluate(
    async ([path, body]) => {
      const r = await fetch("/api/agent/" + path, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify(body) });
      return (await r.json()) as T;
    },
    [path, body] as const,
  );
let conversation = "";
async function setUp(page: Page) {
  if (conversation) return;
  // Registered in Settings › Developers › Apps, with a canvas in all three placements.
  await page.goto(relay.hostOrigin + "/agent#settings/apps");
  const form = page.locator("section", { hasText: "Register an app" }).last();
  await form.getByLabel("Name").fill("Order lookup");
  await form.getByLabel("Description").fill("A customer's orders beside their conversations.");
  await form.getByLabel("Redirect addresses (one per line)").fill(APP + "/oauth/callback");
  await form.getByRole("checkbox", { name: "conversations.read" }).check();
  await form.getByRole("checkbox", { name: "contacts.personal_data" }).check();
  await form.getByLabel("Canvas address").fill(APP + "/canvas");
  for (const placement of ["Inbox sidebar", "Composer", "Settings (configure at install)"]) await form.getByRole("checkbox", { name: new RegExp("^" + placement.replace(/[()]/g, "\\$&")) }).check();
  await form.getByRole("button", { name: "Register app" }).click();
  await expect(page.getByLabel("Canvas signing secret")).toContainText("relay_cvs_", { timeout: 15000 });
  const read = async (label: string) => (await page.getByLabel(label).textContent())!.trim();
  app.setCredentials({ clientId: await read("Client id"), clientSecret: await read("Client secret"), canvasSecret: await read("Canvas signing secret") });

  // Installed from the app's own page, through Relay's consent screen.
  await page.goto(APP + "/install");
  await page.getByRole("region", { name: "Install an app" }).getByRole("button", { name: "Allow" }).click();
  await expect(page.getByRole("heading", { name: "Order lookup is installed" })).toBeVisible({ timeout: 15000 });

  // A customer with an email writes in (made through the API, with a personal token).
  await page.goto(relay.hostOrigin + "/agent#settings/apps");
  const { token } = await ask<{ token: string }>(page, "developer-token", { action: "create", name: "e2e", scopes: ["contacts.personal_data", "conversations.reply"] });
  const post = async (path: string, body: unknown) =>
    (await (await fetch(relay.apiOrigin + "/rest" + path, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify(body) })).json()) as { id: string };
  const contact = await post("/contacts", { email: "ada@example.test", name: "Ada Lovelace" });
  conversation = (await post("/conversations", { contact_id: contact.id, body: "Where is my order?" })).id;
}
async function openConversation(page: Page) {
  await page.goto(relay.hostOrigin + "/agent");
  await page.getByRole("button", { name: /Where is my order\?/ }).first().click();
  return page.getByRole("complementary", { name: "Conversation details" }).getByRole("article", { name: "Order lookup" });
}

test("the order-lookup app: set up in Settings, its orders in the sidebar, an order's status into the reply", async ({ page }) => {
  await setUp(page);
  // Settings: where it shows, and its set-up step, drawn by the app.
  const installed = page.getByRole("table", { name: "Installed apps" }).getByRole("row", { name: /Order lookup/ });
  await expect(installed).toContainText("Inbox sidebar, Composer");
  await expect(installed).toContainText("Needs setting up");
  await installed.getByRole("button", { name: "Configure" }).click();
  const setup = page.locator("section", { hasText: "Set up Order lookup" }).last();
  await setup.getByLabel("Shop").selectOption({ label: "Acme US" });
  await setup.getByRole("checkbox", { name: "Show refunded orders" }).check();
  await setup.getByRole("button", { name: "Save" }).click();
  await expect(setup.getByRole("status")).toHaveText("Order lookup is set up.");
  await expect(installed).not.toContainText("Needs setting up");

  // The sidebar: the customer's orders at the chosen shop; one opens its details.
  const card = await openConversation(page);
  const orders = ordersFor("us", "ada@example.test");
  await expect(card).toContainText("ada@example.test · Acme US", { timeout: 15000 });
  await expect(card.getByRole("listitem")).toHaveCount(orders.length);
  await card.getByRole("button", { name: new RegExp(`#${orders[0].number}`) }).click();
  await expect(card.getByText(`Order #${orders[0].number}`)).toBeVisible();
  await expect(card.locator("dt", { hasText: "Status" })).toBeVisible();
  await expect(card.getByRole("link", { name: /Open in Acme US admin/ })).toHaveAttribute("href", `https://admin.acme.example/us/orders/${orders[0].number}`);
  await card.getByRole("button", { name: "Back to orders" }).click();
  await expect(card.getByRole("listitem")).toHaveCount(orders.length);

  // The composer: pick an order, add a line, and its status goes into the reply to review.
  await page.getByRole("button", { name: "Apps" }).click();
  const pop = page.getByRole("dialog", { name: "Order lookup" });
  await pop.getByRole("button", { name: new RegExp(`#${orders[0].number}`) }).click();
  await pop.getByLabel("Add a line (optional)").fill("Thanks for your patience!");
  await pop.getByRole("button", { name: "Insert into reply" }).click();
  await expect(pop).toHaveCount(0);
  const reply = page.getByRole("textbox", { name: "Reply message" });
  await expect(reply).toContainText(`Your order #${orders[0].number}`);
  await expect(reply).toContainText("Thanks for your patience!");
  await expect(page.getByRole("status").filter({ hasText: "Added from Order lookup" })).toBeVisible();
});

test("the app stopped: a clear failure card with Try again, counted in Settings; back, it draws again", async ({ page }) => {
  await setUp(page);
  appServer.closeAllConnections();
  await new Promise<void>((r) => appServer.close(() => r()));
  const card = await openConversation(page);
  await expect(card.getByRole("alert")).toContainText("Order lookup couldn't be reached.", { timeout: 15000 });
  await expect(card.getByRole("alert")).toContainText("Its canvas address couldn't be reached.");

  // Back up: Try again draws it.
  appServer = await listen(app.handle, APP_PORT);
  servers.push(appServer);
  await card.getByRole("button", { name: "Try again" }).click();
  await expect(card.getByRole("listitem").first()).toBeVisible({ timeout: 15000 });

  // The failure is counted for the workspace (this installation) and for the developer (this app).
  await page.goto(relay.hostOrigin + "/agent#settings/apps");
  const installed = page.getByRole("table", { name: "Installed apps" }).getByRole("row", { name: /Order lookup/ });
  await expect(installed).toContainText(/[1-9]\d* failed/);
  await expect(page.getByLabel("Order lookup canvas requests")).toContainText(/[1-9]\d* failed/);
});

import { test, expect } from "@playwright/test";
import type { Server } from "node:http";
import { startLocalRelay } from "../../scripts/local-relay";
import { orderLookupApp } from "../../demo/order-lookup/app";
import { orderService } from "../../demo/order-lookup/orders";
import { listen } from "../../demo/order-lookup/serve";
import { approveSubmission, pendingReviews, suspendApp } from "../../server/directory-review";

/**
 * Review and the App directory (docs/TEST_WORKSPACE_STEP6.md, T3b), end to end, with the
 * order-lookup example app running on this machine. Happy path: registered with an install address,
 * submitted from Settings › Apps, approved by an operator, found in Settings › App directory and
 * installed through its own install page and Relay's consent screen. Failure path: suspended by
 * Relay, it leaves the directory and its installation says why.
 */
const APP_PORT = 9224;
const ORDERS_PORT = 9225;
const APP = `http://127.0.0.1:${APP_PORT}`;
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
let app: ReturnType<typeof orderLookupApp>;
let servers: Server[] = [];
test.use({ viewport: { width: 1440, height: 1000 } });
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9222, hostPort: 9223, aiAgent: false, canvas: { policy: { allowHosts: [`127.0.0.1:${APP_PORT}`] } } });
  app = orderLookupApp({ relayHost: relay.hostOrigin, relayApi: relay.apiOrigin, publicUrl: APP, orderService: `http://127.0.0.1:${ORDERS_PORT}` });
  servers = [await listen(orderService(), ORDERS_PORT), await listen(app.handle, APP_PORT)];
});
test.afterAll(async () => {
  for (const s of servers) {
    s.closeAllConnections();
    s.close();
  }
  await relay?.close();
});

let clientId = "";
test("an app reviewed by Relay is found in the App directory and installed from it", async ({ page }) => {
  // Registered with its install page, and submitted from its versions.
  await page.goto(relay.hostOrigin + "/agent#settings/apps");
  const form = page.locator("section", { hasText: "Register an app" }).last();
  await form.getByLabel("Name").fill("Order lookup");
  await form.getByLabel("Description").fill("A customer's orders beside their conversations.");
  await form.getByLabel("Redirect addresses (one per line)").fill(APP + "/oauth/callback");
  await form.getByRole("checkbox", { name: "conversations.read" }).check();
  await form.getByRole("checkbox", { name: "contacts.personal_data" }).check();
  await form.getByLabel("Canvas address").fill(APP + "/canvas");
  await form.getByRole("checkbox", { name: /^Inbox sidebar/ }).check();
  await form.getByLabel("Install address (optional)").fill(APP + "/install");
  await form.getByRole("button", { name: "Register app" }).click();
  await expect(page.getByLabel("Canvas signing secret")).toContainText("relay_cvs_", { timeout: 15000 });
  const read = async (label: string) => (await page.getByLabel(label).textContent())!.trim();
  clientId = await read("Client id");
  app.setCredentials({ clientId, clientSecret: await read("Client secret"), canvasSecret: await read("Canvas signing secret") });

  // Not in the directory until it's reviewed.
  await page.goto(relay.hostOrigin + "/agent#settings/app-directory");
  await expect(page.getByRole("heading", { name: "No apps yet" })).toBeVisible({ timeout: 20000 });

  await page.goto(relay.hostOrigin + "/agent#settings/apps");
  const mine = page.getByRole("listitem", { name: "Order lookup" });
  await mine.getByRole("button", { name: "Submit version 1 to the App directory" }).click();
  await expect(mine.getByRole("status")).toContainText("waiting for Relay's review", { timeout: 15000 });

  // An operator approves it (`npm run directory -- approve`), with their name in the developer's log.
  const [waiting] = await pendingReviews(relay.db.connect);
  expect(waiting.card.name).toBe("Order lookup");
  await approveSubmission(relay.db.connect, waiting.id, "Ada");

  // In the directory: what it does, who built it, what it may do; Install goes to its own page.
  await page.goto(relay.hostOrigin + "/agent#settings/app-directory");
  const card = page.getByRole("list", { name: "App directory" }).getByRole("listitem", { name: "Order lookup" });
  await expect(card).toContainText("A customer's orders beside their conversations.", { timeout: 20000 });
  await expect(card).toContainText("Inbox sidebar");
  await card.getByRole("link", { name: "Install Order lookup" }).click();
  await page.getByRole("region", { name: "Install an app" }).getByRole("button", { name: "Allow" }).click();
  await expect(page.getByRole("heading", { name: "Order lookup is installed" })).toBeVisible({ timeout: 15000 });

  await page.goto(relay.hostOrigin + "/agent#settings/app-directory");
  await expect(page.getByRole("list", { name: "App directory" }).getByRole("listitem", { name: "Order lookup" })).toContainText("Installed", { timeout: 20000 });
});

test("suspended by Relay, an app leaves the directory and its installation says why", async ({ page }) => {
  expect(clientId).not.toBe("");
  await suspendApp(relay.db.connect, clientId, "Ada", "It sent customer data to an undisclosed address.");

  await page.goto(relay.hostOrigin + "/agent#settings/app-directory");
  await expect(page.getByRole("heading", { name: "No apps yet" })).toBeVisible({ timeout: 20000 });

  await page.goto(relay.hostOrigin + "/agent#settings/apps");
  const row = page.getByRole("table", { name: "Installed apps" }).getByRole("row", { name: /Order lookup/ });
  await expect(row.getByRole("alert")).toContainText("Suspended by Relay: It sent customer data to an undisclosed address.", { timeout: 20000 });
  await expect(page.getByRole("listitem", { name: "Order lookup" }).getByRole("alert").first()).toContainText("Relay has suspended this app everywhere");
});

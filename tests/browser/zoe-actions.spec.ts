import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { SHOP_KEY, recordedFetch } from "../fixtures/connectors";

/** Data connectors (phase 09, D1; docs/ACTIONS_STEP1.md), against recorded responses. */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
const recorded = recordedFetch();
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({
    apiPort: 9020,
    hostPort: 9021,
    inboxViews: true,
    connectors: { policy: { fetch: recorded.fetch }, sleep: async () => {} },
  });
});
test.afterAll(async () => {
  await relay?.close();
});
const sql = <T = any>(text: string, values: unknown[] = []) =>
  tenant(relay.db.connect, "demo", async (db) => (await db.query<T>(text, values)).rows);

async function create(page: Page, name: string) {
  await page.goto(relay.hostOrigin + "/agent#zoe/actions");
  await page.getByLabel("New connector").fill(name);
  await page.getByRole("button", { name: "Create" }).click();
  return page.getByRole("region", { name: `Connector ${name}` });
}

test("a manager builds an order lookup, keeps its key secret, tests it against the service and publishes it", async ({ page }) => {
  const c = await create(page, "Order lookup");
  await c.getByLabel("Connector description").fill("Finds an order by its number.");

  // Inputs: what may be sent, and where each comes from.
  await c.getByRole("button", { name: "Add input" }).click();
  await c.getByRole("button", { name: "Add input" }).click();
  const inputs = c.getByRole("table", { name: "Inputs" });
  await inputs.getByLabel("Input name").nth(0).fill("order_id");
  await inputs.getByLabel("Input label").nth(0).fill("Order number");
  await inputs.getByLabel("Input pattern").nth(0).fill("[A-Z]\\d{4}");
  await inputs.getByLabel("Input name").nth(1).fill("email");
  await inputs.getByLabel("Input label").nth(1).fill("Email");
  await inputs.getByLabel("Input comes from").nth(1).selectOption("contact.email");
  await inputs.getByLabel("Input sensitive").nth(1).check();

  // The request.
  await c.getByLabel("Base address").fill("https://api.shop.example/v1");
  await c.getByLabel("Path").fill("/orders/{{order_id}}");
  await c.getByRole("button", { name: "Add query value" }).click();
  await c.getByLabel("Query values name").fill("email");
  await c.getByLabel("Query values value").fill("{{email}}");
  await c.getByRole("button", { name: "Add header" }).click();
  await c.getByLabel("Headers name").fill("X-Shop");
  await c.getByLabel("Headers value").fill("fernhill");
  await c.getByLabel("Authentication method").selectOption("api_key");

  // The values Zoe may use.
  await c.getByRole("button", { name: "Add output" }).click();
  await c.getByRole("button", { name: "Add output" }).click();
  const outputs = c.getByRole("table", { name: "Outputs" });
  await outputs.getByLabel("Output name").nth(0).fill("status");
  await outputs.getByLabel("Output label").nth(0).fill("Status");
  await outputs.getByLabel("Output path").nth(0).fill("order.status");
  await outputs.getByLabel("Output name").nth(1).fill("eta");
  await outputs.getByLabel("Output label").nth(1).fill("Delivery date");
  await outputs.getByLabel("Output path").nth(1).fill("order.eta");
  await c.getByRole("spinbutton", { name: "Timeout (ms)" }).fill("1000");
  await c.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Draft saved." })).toBeVisible();

  // Publishing needs the key; the key is saved, then never shown.
  await c.getByRole("button", { name: "Publish" }).click();
  await expect(c.getByRole("alert")).toHaveText("Set its credential before publishing.");
  await c.getByLabel("API key", { exact: true }).fill(SHOP_KEY);
  await c.getByRole("button", { name: "Save API key" }).click();
  await expect(page.getByRole("status").filter({ hasText: "API key saved." })).toBeVisible();
  await expect(c.getByLabel("API key", { exact: true })).toHaveAttribute("placeholder", "Set, ending d4e5. Paste to replace.");

  // The test console: the exact request (key masked), the response, the values.
  const sample = c.getByRole("form", { name: "Sample values" });
  await sample.getByLabel("Order number").fill("A1001");
  await sample.getByLabel("Email").fill("ada@example.com");
  await sample.getByRole("button", { name: "Run test" }).click();
  const result = c.getByRole("region", { name: "Test result" });
  await expect(result).toContainText("Worked", { timeout: 15000 });
  const request = result.getByLabel("Request");
  await expect(request).toContainText("GET https://api.shop.example/v1/orders/A1001?email=ada%40example.com");
  await expect(request).toContainText("X-Api-Key: ••••");
  await expect(request).not.toContainText(SHOP_KEY);
  await expect(result.getByLabel(/^Response/)).toContainText('"status": "shipped"');
  const values = result.getByRole("table", { name: "Values Zoe would get" });
  await expect(values).toContainText("Status");
  await expect(values).toContainText('"shipped"');
  await expect(values).toContainText('"2026-10-15"');
  expect(recorded.sent.at(-1)!.headers["x-api-key"]).toBe(SHOP_KEY);

  // Published; the audit shows the call with the email redacted.
  await c.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Published." })).toBeVisible();
  await expect(c.getByText("Live, version 1")).toBeVisible();
  const calls = c.getByRole("table", { name: "Recent calls" });
  await expect(calls).toContainText('"email":"[redacted]"');
  await expect(calls).not.toContainText("ada@example.com");
  await c.getByRole("button", { name: "All connectors" }).click();
  await expect(page.getByRole("listitem", { name: "Order lookup" })).toContainText("Live, version 1");
  expect(recorded.unmatched).toEqual([]);
});

test("what can't be sent is refused before saving, and a service that doesn't answer shows why", async ({ page }) => {
  const c = await create(page, "Slow lookup");
  await c.getByLabel("Base address").fill("https://api.shop.example/v1");
  await c.getByLabel("Path").fill("/orders/{{order_id}}");
  await c.getByRole("button", { name: "Save draft" }).click();
  await expect(c.getByRole("alert")).toHaveText("{{order_id}} isn't one of the inputs. Add it as an input first.");

  await c.getByLabel("Base address").fill("https://localhost/v1");
  await c.getByRole("button", { name: "Add input" }).click();
  await c.getByLabel("Input name").fill("order_id");
  await c.getByLabel("Input label").fill("Order number");
  await c.getByRole("button", { name: "Save draft" }).click();
  await expect(c.getByRole("alert")).toHaveText("Relay only calls public https addresses; the base address isn't one.");

  await c.getByLabel("Base address").fill("https://api.shop.example/v1");
  await c.getByLabel("Path").fill("/orders/{{order_id}}");
  await c.getByRole("button", { name: "Add query value" }).click();
  await c.getByLabel("Query values name").fill("email");
  await c.getByLabel("Query values value").fill("ada@example.com");
  await c.getByLabel("Authentication method").selectOption("api_key");
  await c.getByRole("spinbutton", { name: "Retries" }).fill("0");
  await c.getByRole("spinbutton", { name: "Timeout (ms)" }).fill("1000");
  await c.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Draft saved." })).toBeVisible();
  await c.getByLabel("API key", { exact: true }).fill(SHOP_KEY);
  await c.getByRole("button", { name: "Save API key" }).click();
  await expect(page.getByRole("status").filter({ hasText: "API key saved." })).toBeVisible();

  const sample = c.getByRole("form", { name: "Sample values" });
  await sample.getByLabel("Order number").fill("A9999");
  await sample.getByRole("button", { name: "Run test" }).click();
  const result = c.getByRole("region", { name: "Test result" });
  await expect(result).toContainText("Timed out", { timeout: 15000 });
  await expect(result).toContainText("No answer within 1 seconds.");
  await expect(c.getByRole("table", { name: "Recent calls" })).toContainText("Timed out");
  expect(await sql("SELECT result FROM ai_connector_calls WHERE connector_id=(SELECT id FROM ai_connectors WHERE name='Slow lookup')")).toEqual([
    { result: "timeout" },
  ]);
});

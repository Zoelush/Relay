import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { getIdentity } from "../../server/people";
import { command } from "../../server/conversations";

let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 900 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 8924, hostPort: 8925 });
  await tenant(relay.db.connect, "demo", async (db) => {
    const identity = await getIdentity(
      db,
      "demo",
      "anonymous",
      "sidebar-customer",
    );
    for (const text of [
      "Where is my order?",
      "Change my plan",
      "Current question",
    ])
      await command(
        db,
        "demo",
        {
          type: "contact",
          identityId: identity.identityId,
          brandId: "default",
        },
        "sidebar-" + text,
        { action: "start", text },
      );
    await db.query(
      `UPDATE contacts SET name='Jo Bloggs',role='lead',origin_timezone='Europe/London'
      WHERE workspace_id='demo' AND id=(SELECT contact_id FROM identity_contact_mappings WHERE workspace_id='demo' AND identity_id=$1)`,
      [identity.identityId],
    );
    await db.query(
      `INSERT INTO contact_emails(workspace_id,contact_id,email,verified)
      SELECT 'demo',contact_id,'jo@example.test',true FROM identity_contact_mappings WHERE workspace_id='demo' AND identity_id=$1`,
      [identity.identityId],
    );
    await db.query(
      "INSERT INTO attribute_definitions(workspace_id,id,name,owner_type,value_type) VALUES('demo','items','Items','conversation','integer') ON CONFLICT DO NOTHING",
    );
  });
});
test.afterAll(async () => {
  await relay?.close();
});
const details = (page: Page) =>
  page.getByRole("complementary", { name: "Conversation details" });
async function open(page: Page, title: string) {
  await page.goto(relay.hostOrigin + "/agent");
  await expect(page.getByRole("status").filter({ hasText: "●" })).toHaveText(
    "● Live",
  );
  await page
    .getByRole("button", { name: new RegExp(title.replace("?", "\\?")) })
    .first()
    .click();
}
const attributeValue = async (id: string) =>
  tenant(
    relay.db.connect,
    "demo",
    async (db) =>
      (
        await db.query<{ attributes: Record<string, unknown> }>(
          "SELECT attributes FROM conversations c WHERE workspace_id='demo' AND title='Current question'",
        )
      ).rows[0].attributes[id] ?? null,
  );

test("the sidebar shows the customer, their local time and history, and saves an attribute inline", async ({
  page,
}) => {
  await open(page, "Current question");
  const panel = details(page);
  await expect(panel.getByText("Jo Bloggs")).toBeVisible();
  await expect(panel.getByText("jo@example.test · verified")).toBeVisible();
  await expect(panel.getByTestId("customer-local-time")).toContainText(
    "local · Europe/London",
  );

  // Edit an attribute inline: saved, and recorded in the timeline.
  const order = panel.getByLabel("Order number");
  await order.fill("A-100");
  await order.press("Enter");
  await expect.poll(() => attributeValue("order_number")).toBe("A-100");
  await expect(
    page
      .getByRole("log", { name: "Messages" })
      .getByText("updated a conversation attribute"),
  ).toBeVisible();
  await expect(panel.getByLabel("Order number")).toHaveValue("A-100");

  // Recent conversations open from the sidebar.
  const recent = panel.getByRole("region", { name: "Recent conversations" });
  await expect(recent.getByRole("button")).toHaveCount(2);
  await recent.getByRole("button", { name: /Where is my order\?/ }).click();
  await expect(
    page
      .getByRole("region", { name: "Conversation timeline" })
      .getByRole("heading", { name: "Where is my order?" }),
  ).toBeVisible();

  // I toggles the sidebar, and the choice is remembered after a reload.
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("i");
  await expect(details(page)).toHaveCount(0);
  await open(page, "Current question");
  await expect(details(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Details" }).click();
  await expect(details(page)).toBeVisible();
});

test("an invalid attribute value is rejected, reverted and explained", async ({
  page,
}) => {
  await open(page, "Current question");
  const items = details(page).getByLabel("Items");
  await items.fill("12.5");
  await items.press("Enter");
  await expect(details(page).getByRole("alert")).toHaveText(
    "Value does not match the attribute definition.",
  );
  await expect(items).toHaveValue("");
  expect(await attributeValue("items")).toBeNull();
});

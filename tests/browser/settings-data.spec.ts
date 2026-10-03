import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";

/** Settings › Helpdesk data (S2b; docs/SETTINGS_STEP3.md): tags, attributes, ticket types. */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 8962, hostPort: 8963 });
});
test.afterAll(async () => {
  await relay?.close();
});
const sql = <T = any>(text: string, values: unknown[] = []) =>
  tenant(
    relay.db.connect,
    "demo",
    async (db) => (await db.query<T>(text, values)).rows,
  );
async function open(page: Page, settingsPage: string) {
  await page.goto(relay.hostOrigin + "/agent#settings/" + settingsPage);
  await expect(page.locator("#settings-title")).toBeVisible({ timeout: 15000 });
}
const notice = (page: Page) => page.locator(".pg-settings-notice");

test("tags added, renamed and archived (and gone from pickers); a list attribute created and given a new option; a ticket type built with its states, moves and fields", async ({
  page,
}) => {
  // Tags: the seeded archived tag is listed apart.
  await open(page, "tags");
  await expect(page.getByRole("list", { name: "Archived tags" })).toContainText(
    "Legacy",
  );
  await page.getByLabel("Tag name").fill("Shipping delay");
  await page.getByRole("button", { name: "Add tag" }).click();
  await expect(notice(page)).toContainText("Added Shipping delay.");
  const tags = page.getByRole("list", { name: "Tags", exact: true });
  await expect(tags).toContainText("Shipping delay");
  // Renamed in place.
  await page.getByRole("button", { name: "Rename VIP" }).click();
  await page.getByLabel("New name for VIP").fill("Very important");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(notice(page)).toContainText("Renamed VIP to Very important.");
  // Archived: listed apart, kept in the database.
  await page.getByRole("button", { name: "Archive Refund" }).click();
  await expect(notice(page)).toContainText("Archived Refund.");
  await expect(page.getByRole("list", { name: "Archived tags" })).toContainText(
    "Refund",
  );
  expect(
    await sql(
      "SELECT id,name,archived_at IS NOT NULL AS archived FROM tags WHERE id IN ('vip','refund','shipping_delay') ORDER BY id",
    ),
  ).toEqual([
    { id: "refund", name: "Refund", archived: true },
    { id: "shipping_delay", name: "Shipping delay", archived: false },
    { id: "vip", name: "Very important", archived: false },
  ]);
  // A macro can add only active tags.
  await open(page, "macros");
  const manager = page.getByRole("region", { name: "Macros" });
  await manager.getByRole("button", { name: "New macro" }).click();
  await manager.getByRole("button", { name: "Add action" }).click();
  const options = manager.getByLabel("Action 1 tag").locator("option");
  await expect(options).toHaveText(["Shipping delay", "Very important"]);

  // Attributes: a list with two options.
  await open(page, "attributes");
  await page.getByRole("button", { name: "New attribute" }).click();
  let editor = page.getByRole("form", { name: "New attribute" });
  await editor.getByLabel("Attribute name").fill("Delivery method");
  await editor.getByLabel(/^List/).check();
  for (const o of ["Courier", "Pickup"]) {
    await editor.getByLabel("New option").fill(o);
    await editor.getByRole("button", { name: "Add option" }).click();
  }
  await editor.getByRole("button", { name: "Create attribute" }).click();
  await expect(notice(page)).toContainText("Saved Delivery method.");
  await expect(
    page.getByRole("list", { name: "Attributes", exact: true }),
  ).toContainText("List: Courier, Pickup");
  // Edited: the type is fixed, saved options can't be removed, a new one is added.
  await page.getByRole("button", { name: "Edit Delivery method" }).click();
  editor = page.getByRole("form", { name: "Edit Delivery method" });
  await expect(editor.getByLabel(/^Text/)).toBeDisabled();
  await expect(
    editor.getByRole("button", { name: "Remove option Courier" }),
  ).toHaveCount(0);
  await editor.getByLabel("New option").fill("Locker");
  await editor.getByLabel("New option").press("Enter");
  await editor.getByRole("button", { name: "Save attribute" }).click();
  await expect(notice(page)).toContainText("Saved Delivery method.");
  const [attribute] = await sql<{ id: string; options: string[] }>(
    "SELECT id,value_type,options FROM attribute_definitions WHERE name='Delivery method'",
  );
  expect(attribute).toMatchObject({
    value_type: "options",
    options: ["Courier", "Pickup", "Locker"],
  });
  // Archived, it's listed apart.
  await page.getByRole("button", { name: "Archive Order number" }).click();
  await expect(
    page.getByRole("list", { name: "Archived attributes" }),
  ).toContainText("Order number");

  // Ticket types: the seeded types are listed.
  await open(page, "ticket-types");
  await expect(page.getByRole("list", { name: "Ticket types" })).toContainText(
    "Bug report",
  );
  await page.getByRole("button", { name: "New ticket type" }).click();
  const type = page.getByRole("form", { name: "New ticket type" });
  await type.getByLabel("Type name").fill("Returns");
  await type.getByLabel(/^Customer/).check();
  // A fourth state, waiting on the customer, shown to them as "Send us the parcel".
  await type.getByRole("button", { name: "Add state" }).click();
  await type.getByLabel("State 4 name").fill("Awaiting parcel");
  await type.getByLabel("State 4 customer label").fill("Send us the parcel");
  await type
    .getByLabel("State 4 kind")
    .selectOption({ label: "Waiting on customer" });
  await type.getByRole("button", { name: "Move state 4 up" }).click();
  // Resolved can't go back to Submitted.
  await type
    .getByRole("group", { name: "From Resolved" })
    .getByLabel("Submitted")
    .uncheck();
  // The new attribute is a field, required to resolve.
  await type.getByLabel("Delivery method").check();
  await type.getByLabel("Required to resolve").check();
  await type.getByRole("button", { name: "Create ticket type" }).click();
  await expect(notice(page)).toContainText("Saved Returns.");
  const [saved] = await sql<{ id: string }>(
    "SELECT id,category,portal_visible FROM ticket_types WHERE name='Returns'",
  );
  expect(saved).toMatchObject({ category: "customer", portal_visible: true });
  expect(
    (
      await sql(
        "SELECT name,customer_label,kind FROM ticket_states WHERE type_id=$1 AND NOT archived ORDER BY position",
        [saved.id],
      )
    ).map((s) => [s.name, s.customer_label, s.kind]),
  ).toEqual([
    ["Submitted", "Submitted", "submitted"],
    ["In progress", "In progress", "in_progress"],
    ["Awaiting parcel", "Send us the parcel", "waiting_on_customer"],
    ["Resolved", "Resolved", "resolved"],
  ]);
  const moves = (
    await sql<{ from_state: string; to_state: string }>(
      "SELECT from_state,to_state FROM ticket_transitions WHERE type_id=$1",
      [saved.id],
    )
  ).map((m) => m.from_state + ">" + m.to_state);
  expect(moves).toHaveLength(11);
  expect(moves).not.toContain(`${saved.id}.resolved>${saved.id}.submitted`);
  expect(
    await sql(
      "SELECT attribute_id,required_to_close FROM ticket_type_attributes WHERE type_id=$1",
      [saved.id],
    ),
  ).toEqual([{ attribute_id: attribute.id, required_to_close: true }]);
  // Edited: a state renamed keeps its key, so tickets in it stay put.
  await page.getByRole("button", { name: "Edit Returns" }).click();
  const edit = page.getByRole("form", { name: "Edit Returns" });
  await edit.getByLabel("State 2 name").fill("Inspecting");
  await edit.getByRole("button", { name: "Save ticket type" }).click();
  await expect(notice(page)).toContainText("Saved Returns.");
  expect(
    (
      await sql("SELECT name FROM ticket_states WHERE id=$1", [
        `${saved.id}.in_progress`,
      ])
    )[0].name,
  ).toBe("Inspecting");
});

test("a duplicate tag and a ticket type with no way to resolve are refused, saying why, with nothing saved", async ({
  page,
}) => {
  await open(page, "tags");
  await page.getByLabel("Tag name").fill("Damaged");
  await page.getByRole("button", { name: "Add tag" }).click();
  await expect(notice(page)).toContainText("Added Damaged.");
  await page.getByLabel("Tag name").fill("DAMAGED");
  await page.getByRole("button", { name: "Add tag" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "There's already a tag called “Damaged”.",
  );
  // The typed name stays, to correct.
  await expect(page.getByLabel("Tag name")).toHaveValue("DAMAGED");
  expect(
    (
      await sql(
        "SELECT count(*)::int AS n FROM tags WHERE lower(name)='damaged'",
      )
    )[0].n,
  ).toBe(1);

  await open(page, "ticket-types");
  await page.getByRole("button", { name: "New ticket type" }).click();
  const type = page.getByRole("form", { name: "New ticket type" });
  await type.getByLabel("Type name").fill("Stuck");
  // In progress can go nowhere: it can never be resolved.
  const from = type.getByRole("group", { name: "From In progress" });
  await from.getByLabel("Submitted").uncheck();
  await from.getByLabel("Resolved").uncheck();
  await type.getByRole("button", { name: "Create ticket type" }).click();
  await expect(type.getByRole("alert")).toContainText(
    "“In progress” has no path to a resolved state.",
  );
  // The form keeps what was typed, and nothing was stored.
  await expect(type.getByLabel("Type name")).toHaveValue("Stuck");
  expect(
    (
      await sql(
        "SELECT count(*)::int AS n FROM ticket_types WHERE name='Stuck'",
      )
    )[0].n,
  ).toBe(0);
});

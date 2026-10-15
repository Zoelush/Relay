import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";

/**
 * Events, subscriptions and segments (phase 13, O1; docs/OUTBOUND_STEP1.md), with the demo's seeded
 * people (Ada upgraded, Grace didn't), subscription types and "Pro users" segment: a rule on an
 * event narrows the list live and is saved as a segment; a person shows their subscriptions and
 * events; their preference page changes what they get; Settings lists events and subscription
 * types. A forged preference link, a rule without its attribute, a taken segment name and an
 * unsigned event are refused with reasons.
 */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9054, hostPort: 9055, inboxViews: true, aiAgent: false, examplePeople: true });
});
test.afterAll(async () => {
  await relay?.close();
});

const people = (page: Page) => page.getByRole("table", { name: "People" });
const contactOf = async (externalId: string) => (await tenant(relay.db.connect, "demo", (db) => db.query<{ id: string }>("SELECT id FROM contacts WHERE external_id=$1", [externalId]))).rows[0].id;

test("a rule on an event narrows the list live and becomes a segment; a person's subscriptions change on their preference page", async ({ page }) => {
  await page.goto(relay.hostOrigin + "/agent#people");
  await expect(page.getByRole("heading", { name: "All users" })).toBeVisible();
  await expect(people(page)).toContainText("Ada Lovelace");
  await expect(people(page)).toContainText("Grace Hopper");
  await expect(page.getByRole("list", { name: "Your segments" })).toContainText("Pro users");

  // Users who upgraded: one rule more, counted as it's built.
  await page.getByRole("button", { name: "Add rule" }).click();
  await page.getByLabel("Rule 2: filter on").selectOption("event");
  await page.getByLabel("Rule 2: event").selectOption("upgraded plan");
  await expect(page.getByLabel("People matching")).toHaveText("1 person matches these rules");
  await expect(people(page)).toContainText("Ada Lovelace");
  await expect(people(page)).not.toContainText("Grace Hopper");
  await page.getByRole("button", { name: "Save as new segment" }).click();
  await page.getByLabel("Segment name").fill("Upgraded");
  await page.getByRole("form", { name: "Name the segment" }).getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: "Upgraded" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Your segments" }).getByRole("button", { name: /Upgraded/ })).toContainText("1");
  await expect(page).toHaveURL(/#people\/[0-9a-f-]{36}$/);

  // Ada: subscribed to product updates (opt-out), not to offers (opt-in); her events.
  await people(page).getByRole("button", { name: "Ada Lovelace" }).click();
  const about = page.getByRole("complementary", { name: "About Ada Lovelace" });
  const subs = about.getByRole("list", { name: "Subscriptions" });
  await expect(subs.getByRole("listitem").filter({ hasText: "Product updates" })).toContainText("Subscribed");
  await expect(subs.getByRole("listitem").filter({ hasText: "Offers by SMS" })).toContainText("Unsubscribed");
  await expect(about.getByRole("list", { name: "Latest events" })).toContainText("upgraded plan");

  // Her preference page (the link every unsubscribe opens): she stops product updates.
  await page.goto(`${relay.apiOrigin}/dev/preferences/${await contactOf("ada-demo")}`);
  await expect(page.getByRole("heading", { name: "Your subscriptions" })).toBeVisible();
  await page.getByRole("checkbox", { name: /Product updates/ }).uncheck();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved.");
  await page.goto(relay.hostOrigin + "/agent#people");
  await people(page).getByRole("button", { name: "Ada Lovelace" }).click();
  await expect(page.getByRole("complementary", { name: "About Ada Lovelace" }).getByRole("list", { name: "Subscriptions" }).getByRole("listitem").filter({ hasText: "Product updates" })).toContainText(
    "Unsubscribed",
  );

  // Settings: the events tracked, and the subscription types with who chose what.
  await page.goto(relay.hostOrigin + "/agent#settings/events");
  await expect(page.getByRole("list", { name: "Events" })).toContainText("upgraded plan");
  await page.goto(relay.hostOrigin + "/agent#settings/subscriptions");
  await expect(page.getByRole("list", { name: "Subscription types" }).getByRole("listitem").filter({ hasText: "Product updates" })).toContainText("0 chose in, 1 chose out");
});

test("a forged preference link, a rule without its attribute, a taken name and an unsigned event are refused with reasons", async ({ page, request }) => {
  const forged = await page.goto(`${relay.apiOrigin}/v1/preferences/${"e".repeat(40)}.${"f".repeat(43)}`);
  expect(forged?.status()).toBe(404);
  await expect(page.getByText("This link isn't valid.")).toBeVisible();

  await page.goto(relay.hostOrigin + "/agent#people/pro-users");
  await expect(page.getByRole("heading", { name: "Pro users" })).toBeVisible();
  await page.getByRole("button", { name: "Add rule" }).click();
  await page.getByLabel("Rule 3: attribute").fill("");
  await expect(page.getByRole("alert")).toHaveText("Rule 3: name the attribute (letters, digits, . _ : -).");
  await page.getByLabel("Rule 3: attribute").fill("seats");
  await page.getByLabel("Rule 3: how").selectOption("greater_than");
  await page.getByLabel("Rule 3: number").fill("5");
  await expect(page.getByLabel("People matching")).toHaveText("1 person matches these rules");
  await page.getByRole("button", { name: "Save as new segment" }).click();
  await page.getByLabel("Segment name").fill("pro USERS");
  await page.getByRole("form", { name: "Name the segment" }).getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("alert")).toHaveText("A segment with that name already exists.");

  const unsigned = await request.post(`${relay.apiOrigin}/v1/events`, { data: { events: [{ id: "x", name: "upgraded plan" }] } });
  expect(unsigned.status()).toBe(401);
  expect((await unsigned.json()).error.message).toBe("Sign the request with your workspace's identity key.");

  await page.goto(relay.hostOrigin + "/agent#settings/subscriptions");
  const form = page.getByRole("form", { name: "New subscription type" });
  await form.getByLabel("Name").fill("product updates");
  await form.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("alert")).toHaveText("A subscription with that name already exists.");
});

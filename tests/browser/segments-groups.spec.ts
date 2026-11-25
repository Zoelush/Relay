import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";

/**
 * Segments with groups, tags and companies, and segments of companies (docs/PEOPLE_STEP4.md, phase
 * 01 P2a), with the demo's people: Ada (VIP) at Analytical Engines Ltd (Pro), Grace at Navy
 * Computing Lab (Free). Happy path: users who are VIP or at a Free company, built with a group and
 * counted live, saved; then a segment of Pro companies, saved under Companies. Failure path: a
 * group left with no rules is refused in words, and nothing is saved.
 */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9236, hostPort: 9237, inboxViews: true, aiAgent: false, examplePeople: true });
});
test.afterAll(async () => {
  await relay?.close();
});

const matching = (page: Page) => page.getByLabel(/^(People|Companies) matching$/);

test("a group of a tag rule and a company rule makes a segment; a segment of companies is saved under Companies", async ({ page }) => {
  await page.goto(relay.hostOrigin + "/agent#people");
  await expect(page.getByRole("heading", { name: "All users" })).toBeVisible({ timeout: 20000 });
  await expect(matching(page)).toHaveText("2 people match");

  // All users, and (VIP, or at a Free company): a group of two rules, either one.
  await page.getByRole("button", { name: "Add group" }).click();
  const group = page.getByRole("group", { name: "Group 1" });
  await expect(group.getByLabel("Group 1: match")).toHaveValue("any");
  await page.getByLabel("Rule 2: filter on").selectOption("tag");
  await page.getByLabel("Rule 2: tag").selectOption({ label: "VIP" });
  await expect(matching(page)).toHaveText("1 person matches these rules");
  await group.getByRole("button", { name: "Group 1: add rule" }).click();
  await page.getByLabel("Rule 3: filter on").selectOption("company.plan");
  await page.getByLabel("Rule 3: value").fill("Free");
  await expect(matching(page)).toHaveText("2 people match these rules");
  // Both of the group, not either: nobody is VIP and at a Free company.
  await group.getByLabel("Group 1: match").selectOption("all");
  await expect(matching(page)).toHaveText("0 people match these rules");
  await group.getByLabel("Group 1: match").selectOption("any");
  await expect(matching(page)).toHaveText("2 people match these rules");
  await page.getByRole("button", { name: "Save as new segment" }).click();
  await page.getByLabel("Segment name").fill("VIP or free");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("list", { name: "Your segments" })).toContainText("VIP or free");

  // Companies: their own segments, rules and list.
  await page.getByRole("group", { name: "Show segments of" }).getByRole("button", { name: "Companies" }).click();
  await expect(page.getByRole("heading", { name: "All companies" })).toBeVisible();
  const companies = page.getByRole("table", { name: "Companies" });
  await expect(companies).toContainText("Analytical Engines Ltd");
  await expect(companies).toContainText("Navy Computing Lab");
  await expect(page.getByRole("list", { name: "Your segments" })).not.toContainText("VIP or free");
  await page.getByRole("button", { name: "Add rule" }).click();
  await page.getByLabel("Rule 1: filter on").selectOption("plan");
  await page.getByLabel("Rule 1: value").fill("pro");
  await expect(matching(page)).toHaveText("1 company matches these rules");
  await expect(companies).not.toContainText("Navy Computing Lab");
  await page.getByRole("button", { name: "Save as new segment" }).click();
  await page.getByLabel("Segment name").fill("Pro companies");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("list", { name: "Your segments" })).toContainText("Pro companies");
  await page.getByRole("group", { name: "Show segments of" }).getByRole("button", { name: "People" }).click();
  await expect(page.getByRole("list", { name: "Your segments" })).not.toContainText("Pro companies");
});

test("a group left with no rules is refused in words, and isn't saved", async ({ page }) => {
  await page.goto(relay.hostOrigin + "/agent#people");
  await expect(page.getByRole("heading", { name: "All users" })).toBeVisible({ timeout: 20000 });
  await page.getByRole("button", { name: "Add group" }).click();
  await page.getByRole("button", { name: "Remove rule 2" }).click();
  await expect(page.getByRole("alert")).toHaveText("A group needs at least one rule.");
  await page.getByRole("button", { name: "Save as new segment" }).click();
  await page.getByLabel("Segment name").fill("Broken");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("A group needs at least one rule.");
  await expect(page.getByRole("list", { name: "Your segments" })).not.toContainText("Broken");
  // Taking the empty group away puts things right.
  await page.getByRole("button", { name: "Remove group 1" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(matching(page)).toHaveText("2 people match");
});

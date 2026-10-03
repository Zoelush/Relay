import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";

/** Settings › Teammates and Roles (S3a; docs/SETTINGS_STEP4.md). */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1100 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 8964, hostPort: 8965 });
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
async function open(page: Page, settingsPage: string, as = "") {
  await page.goto(
    relay.hostOrigin +
      "/agent" +
      as +
      "#settings" +
      (settingsPage ? "/" + settingsPage : ""),
  );
  await expect(
    page.getByRole("navigation", { name: "Settings pages" }),
  ).toBeVisible({ timeout: 15000 });
}
const notice = (page: Page) => page.locator(".pg-settings-notice");
const caps = async (role: string) =>
  (
    await sql<{ capability: string }>(
      "SELECT capability FROM role_capabilities WHERE role_id=$1 ORDER BY capability",
      [role],
    )
  ).map((r) => r.capability);

test("a teammate moved to a custom role, a new role created, and a role's permissions changed, which the teammate sees on reload", async ({
  page,
  browser,
}) => {
  await open(page, "teammates");
  const list = page.getByRole("list", { name: "Teammates" });
  await expect(list).toContainText("Grace");
  // Your own role can't be changed here.
  await expect(page.getByLabel("Support teammate: role")).toBeDisabled();
  await page.getByLabel("Grace: role").selectOption({ label: "Team lead" });
  await page.getByRole("button", { name: "Save Grace's role" }).click();
  await expect(notice(page)).toContainText("Grace is now a team lead.");
  expect(
    (await sql("SELECT role_id FROM teammates WHERE id='grace'"))[0].role_id,
  ).toBe("team_lead");

  // Grace, as a team lead, can manage ticket types.
  const grace = await (await browser.newContext()).newPage();
  await open(grace, "", "?as=grace");
  const graceNav = grace.getByRole("navigation", { name: "Settings pages" });
  await expect(
    graceNav.getByRole("button", { name: "Ticket types" }),
  ).toBeVisible();

  // Roles: a new one, then Team lead without ticket types.
  await open(page, "roles");
  const roles = page.getByRole("list", { name: "Roles" });
  await expect(roles).toContainText("Team lead");
  await expect(roles).toContainText("1 teammate");
  await page.getByRole("button", { name: "New role" }).click();
  const editor = page.getByRole("form", { name: "New role" });
  await editor.getByLabel("Role name").fill("Billing specialist");
  await editor.getByLabel(/^Manage ticket types/).check();
  await editor.getByRole("button", { name: "Create role" }).click();
  await expect(notice(page)).toContainText("Saved Billing specialist.");
  expect(await caps("billing_specialist")).toEqual([
    "conversations.manage",
    "conversations.note",
    "conversations.read",
    "conversations.reply",
    "macros.use",
    "tickets.manage",
  ]);
  await page.getByRole("button", { name: "Edit Team lead" }).click();
  const lead = page.getByRole("form", { name: "Edit Team lead" });
  // Seeing conversations is part of every role.
  await expect(lead.getByLabel(/^See conversations/)).toBeDisabled();
  await lead.getByLabel(/^Manage ticket types/).uncheck();
  await lead.getByRole("button", { name: "Save role" }).click();
  await expect(notice(page)).toContainText("Saved Team lead.");
  expect(await caps("team_lead")).not.toContain("tickets.manage");
  // Grace's Settings no longer offers ticket types once her page reloads.
  await grace.reload();
  await expect(
    graceNav.getByRole("button", { name: "Your profile" }),
  ).toBeVisible();
  await expect(
    graceNav.getByRole("button", { name: "Ticket types" }),
  ).toHaveCount(0);
  // An unused custom role can be deleted.
  await page.getByRole("button", { name: "Delete Billing specialist" }).click();
  await expect(notice(page)).toContainText("Deleted Billing specialist.");
  await expect(roles).not.toContainText("Billing specialist");
});

test("a role someone holds can't be deleted, and the workspace's only owner can't be moved, each saying why with nothing changed", async ({
  page,
}) => {
  await sql("UPDATE teammates SET role_id='team_lead' WHERE id='grace'");
  await open(page, "roles");
  await page.getByRole("button", { name: "Delete Team lead" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Move everyone out of Team lead before deleting it.",
  );
  expect(
    (await sql("SELECT count(*)::int AS n FROM roles WHERE id='team_lead'"))[0]
      .n,
  ).toBe(1);

  // Grace, made an admin, tries to move the only owner.
  await sql("UPDATE teammates SET role_id='admin' WHERE id='grace'");
  await open(page, "teammates", "?as=grace");
  await page
    .getByLabel("Support teammate: role")
    .selectOption({ label: "Agent" });
  await page
    .getByRole("button", { name: "Save Support teammate's role" })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Support teammate is the workspace's only owner. Make someone else an owner first.",
  );
  expect(
    (await sql("SELECT role_id FROM teammates WHERE id='owner'"))[0].role_id,
  ).toBe("owner");
  // The choice stays, to try again once there's another owner.
  await expect(page.getByLabel("Support teammate: role")).toHaveValue("agent");
});

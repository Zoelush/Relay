import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";

/** Settings › Helpdesk (S2a; docs/SETTINGS_STEP2.md). */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 8960, hostPort: 8961 });
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

test("teams and limits, office hours and who uses them, SLAs created, ordered and archived; the Workload panel leads here", async ({
  page,
}) => {
  // Teams & assignment: a new team with a member, a method and a limit.
  await open(page, "teams");
  await page.getByRole("button", { name: "New team" }).click();
  const editor = page.getByRole("form", { name: "New team" });
  await editor.getByLabel("Team name").fill("Escalations");
  await editor.getByLabel("Grace").check();
  await editor.getByLabel(/^Balanced/).check();
  await editor.getByLabel("Inbox limit").fill("5");
  await editor.getByRole("button", { name: "Create team" }).click();
  await expect(notice(page)).toContainText("Saved Escalations.");
  await expect(page.getByRole("list", { name: "Teams" })).toContainText(
    "Escalations",
  );
  const [team] = await sql<{
    id: string;
    method: string;
    conversation_limit: number;
  }>("SELECT id,method,conversation_limit FROM teams WHERE name='Escalations'");
  expect(team).toMatchObject({ method: "balanced", conversation_limit: 5 });
  expect(
    await sql("SELECT teammate_id FROM teammate_teams WHERE team_id=$1", [
      team.id,
    ]),
  ).toEqual([{ teammate_id: "grace" }]);
  // A teammate's own limit.
  await page.getByLabel("Grace: conversation limit").fill("2");
  await page.getByRole("button", { name: "Save Grace's limits" }).click();
  await expect(notice(page)).toContainText("Saved Grace's limits.");
  expect(
    (await sql("SELECT conversation_limit FROM teammates WHERE id='grace'"))[0]
      .conversation_limit,
  ).toBe(2);

  // Office hours: a new calendar, a holiday, and a team that uses it.
  await page
    .getByRole("navigation", { name: "Settings pages" })
    .getByRole("button", { name: "Office hours" })
    .click();
  await page.getByRole("button", { name: "New calendar" }).click();
  const cal = page.getByRole("form", { name: "New calendar" });
  await cal.getByLabel("Calendar name").fill("Weekend cover");
  await cal.getByLabel("Timezone").selectOption("Europe/London");
  for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"])
    await cal.getByRole("group", { name: day }).getByRole("checkbox").uncheck();
  await cal
    .getByRole("group", { name: "Saturday" })
    .getByRole("checkbox")
    .check();
  await cal.getByLabel("Saturday opens").fill("10:00");
  await cal.getByLabel("Saturday closes").fill("14:00");
  await cal.getByLabel("Holiday date").fill("2026-12-26");
  await cal.getByRole("button", { name: "Add holiday" }).click();
  await cal.getByRole("button", { name: "Publish" }).click();
  await expect(notice(page)).toContainText("Published Weekend cover.");
  await expect(page.getByRole("list", { name: "Calendars" })).toContainText(
    "Europe/London · Sat 10:00–14:00 · 1 holiday",
  );
  await page
    .getByLabel("Team: Escalations")
    .selectOption({ label: "Weekend cover" });
  await expect(notice(page)).toContainText(
    "Saved Team: Escalations's office hours.",
  );
  expect(
    (
      await sql<{ name: string }>(
        "SELECT c.name FROM calendar_assignments a JOIN calendars c ON c.workspace_id=a.workspace_id AND c.id=a.calendar_id WHERE a.scope='team' AND a.scope_id=$1",
        [team.id],
      )
    )[0].name,
  ).toBe("Weekend cover");

  // SLAs: a new policy for priority conversations, moved to the top, then archived.
  await page
    .getByRole("navigation", { name: "Settings pages" })
    .getByRole("button", { name: "SLAs" })
    .click();
  await page.getByRole("button", { name: "New SLA" }).click();
  const sla = page.getByRole("form", { name: "New SLA" });
  await sla.getByLabel("Policy name").fill("Priority");
  await sla.getByLabel("First response target").fill("15");
  await sla.getByLabel("First response unit").selectOption("minutes");
  await sla.getByLabel("Only conversations that match").check();
  await sla.getByRole("button", { name: "Create SLA" }).click();
  await expect(notice(page)).toContainText("Saved Priority.");
  const policies = page.getByRole("list", { name: "SLA policies" });
  await expect(policies.getByRole("listitem").last()).toContainText(
    "first response 15m · business hours · matching conversations",
  );
  await page.getByRole("button", { name: "Move Priority up" }).click();
  await expect(policies.getByRole("listitem").first()).toContainText(
    "Priority",
  );
  const order = await sql<{ name: string }>(
    "SELECT name FROM sla_policies WHERE NOT archived ORDER BY position,name",
  );
  expect(order[0].name).toBe("Priority");
  await page.getByRole("button", { name: "Archive Priority" }).click();
  await expect(policies).not.toContainText("Priority");

  // The Workload panel's "Edit team settings" opens Settings › Teams & assignment.
  await page
    .getByTestId("rail")
    .getByRole("button", { name: /^Inbox/ })
    .click();
  await page.getByRole("button", { name: /^Your workload:/ }).click();
  await page
    .getByRole("dialog", { name: "Workload" })
    .getByRole("button", { name: "Edit team settings" })
    .first()
    .click();
  await expect(page).toHaveURL(/#settings\/teams$/);
  await expect(page.locator("#settings-title")).toHaveText(
    "Teams & assignment",
  );
});

test("a calendar with an impossible time isn't published, and a team changed elsewhere isn't overwritten", async ({
  page,
}) => {
  await open(page, "office-hours");
  await page.getByRole("button", { name: "New calendar" }).click();
  const cal = page.getByRole("form", { name: "New calendar" });
  await cal.getByLabel("Calendar name").fill("Broken hours");
  await cal.getByLabel("Monday closes").fill("25:00");
  await cal.getByRole("button", { name: "Publish" }).click();
  await expect(cal.getByRole("alert")).toContainText("Write times as HH:MM");
  expect(
    await sql("SELECT 1 FROM calendars WHERE name='Broken hours'"),
  ).toEqual([]);

  // Someone else saves Billing while it's open here: this save is refused with the reason.
  await open(page, "teams");
  await page.getByRole("button", { name: "Edit Billing" }).click();
  const editor = page.getByRole("form", { name: "Edit Billing" });
  await sql("UPDATE teams SET version=version+1 WHERE name='Billing'");
  await editor.getByLabel("Team name").fill("Billing and refunds");
  await editor.getByRole("button", { name: "Save team" }).click();
  await expect(editor.getByRole("alert")).toContainText(
    "This team changed elsewhere. Reload and try again.",
  );
  expect(
    await sql("SELECT 1 FROM teams WHERE name='Billing and refunds'"),
  ).toEqual([]);
});

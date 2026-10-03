import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";

let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 900 } });
test.beforeAll(async () => {
  // "Your profile" as the read-only dialog (without Settings); settings.spec.ts covers Settings.
  relay = await startLocalRelay({
    apiPort: 8958,
    hostPort: 8959,
    settings: false,
  });
});
test.afterAll(async () => {
  await relay?.close();
});
const sql = <T = any>(query: string, values: unknown[] = []) =>
  tenant(
    relay.db.connect,
    "demo",
    async (db) => (await db.query<T>(query, values)).rows,
  );
const presence = async () =>
  (await sql("SELECT presence FROM teammates WHERE id='owner'"))[0].presence;
async function open(page: Page) {
  await page.goto(relay.hostOrigin + "/agent");
  await expect(page.getByRole("status").filter({ hasText: "●" })).toHaveText(
    "● Live",
  );
}
const accountButton = (page: Page) =>
  page.getByRole("button", { name: /^Account:/ });
const menu = (page: Page) => page.getByRole("dialog", { name: "Account" });

test("the account menu: who you are, away and reassigning, your profile, from the keyboard", async ({
  page,
}) => {
  await sql("UPDATE teammates SET presence='active' WHERE id='owner'");
  const { role: stored, workspace } = (
    await sql<{ role: string; workspace: string }>(
      `SELECT r.name AS role,w.brand AS workspace FROM teammates t JOIN roles r ON r.workspace_id=t.workspace_id AND r.id=t.role_id
      JOIN workspace w ON w.id=t.workspace_id WHERE t.id='owner'`,
    )
  )[0];
  const role = stored.charAt(0).toUpperCase() + stored.slice(1);
  await open(page);
  // The status moved here from the top bar.
  await expect(page.getByLabel("Your status")).toHaveCount(0);
  await expect(accountButton(page)).toHaveAccessibleName(
    "Account: Support teammate, Active",
  );

  // Opened from the keyboard; focus moves into it.
  await accountButton(page).focus();
  await page.keyboard.press("Enter");
  await expect(menu(page)).toBeVisible();
  await expect(accountButton(page)).toHaveAttribute("aria-expanded", "true");
  const away = menu(page).getByRole("switch", { name: "Away" });
  const reassign = menu(page).getByRole("switch", {
    name: "Reassign replies",
  });
  await expect(away).toBeFocused();
  await expect(menu(page)).toContainText("Support teammate");
  await expect(menu(page)).toContainText(role);
  await expect(
    menu(page).getByRole("region", { name: "Workspace" }),
  ).toContainText(workspace);
  // Nothing to sign out of on the local relay (the hosting sign-in provides it when deployed).
  await expect(menu(page).getByRole("link", { name: "Sign out" })).toHaveCount(
    0,
  );

  // Reassigning only applies while away.
  await expect(away).toHaveAttribute("aria-checked", "false");
  await expect(reassign).toBeDisabled();
  await page.keyboard.press("Space");
  await expect(away).toHaveAttribute("aria-checked", "true");
  await expect.poll(presence).toBe("away");
  await reassign.click();
  await expect(reassign).toHaveAttribute("aria-checked", "true");
  await expect.poll(presence).toBe("away_reassigning");
  await expect(accountButton(page)).toHaveAccessibleName(
    "Account: Support teammate, Away, replies reassigned",
  );

  // Escape closes it and returns focus to the button.
  await page.keyboard.press("Escape");
  await expect(menu(page)).toBeHidden();
  await expect(accountButton(page)).toBeFocused();

  // Your profile, read only.
  await accountButton(page).click();
  await menu(page).getByRole("button", { name: "Your profile" }).click();
  const profile = page.getByRole("dialog", { name: "Your profile" });
  await expect(profile).toContainText(role);
  await expect(profile).toContainText(workspace);
  await expect(profile).toContainText("Away, replies reassigned");
  await expect(profile.getByRole("textbox")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(profile).toBeHidden();
  await expect(accountButton(page)).toBeFocused();

  // Back: turning Away off makes you active and switches reassigning off with it.
  await accountButton(page).click();
  await away.click();
  await expect.poll(presence).toBe("active");
  await expect(reassign).toHaveAttribute("aria-checked", "false");
  await expect(reassign).toBeDisabled();
  // A click outside closes it.
  await page.getByRole("heading", { name: "Inbox" }).click();
  await expect(menu(page)).toBeHidden();
});

test("a refused status change springs back and says why", async ({ page }) => {
  await sql("UPDATE teammates SET presence='active' WHERE id='owner'");
  await open(page);
  await page.route("**/api/agent/presence", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "PRESENCE_REFUSED",
          message: "Your status could not be changed right now.",
        },
      }),
    }),
  );
  await accountButton(page).click();
  const away = menu(page).getByRole("switch", { name: "Away" });
  await away.click();
  await expect(menu(page).getByRole("alert")).toHaveText(
    "Your status could not be changed right now.",
  );
  await expect(away).toHaveAttribute("aria-checked", "false");
  await expect(accountButton(page)).toHaveAccessibleName(
    "Account: Support teammate, Active",
  );
  expect(await presence()).toBe("active");
});

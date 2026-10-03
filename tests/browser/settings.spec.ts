import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { getIdentity } from "../../server/people";
import { command } from "../../server/conversations";

/** Settings (S1; docs/SETTINGS_STEP1.md). */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 900 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({
    apiPort: 8922,
    hostPort: 8923,
    inboxViews: true,
  });
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
async function open(page: Page, hash = "", as = "") {
  await page.goto(relay.hostOrigin + "/agent" + as + hash);
  // Opened straight into Settings, the inbox (and its connection status) stays hidden.
  if (hash.startsWith("#settings"))
    await expect(
      page.getByRole("navigation", { name: "Settings pages" }),
    ).toBeVisible({ timeout: 15000 });
  else
    await expect(page.getByRole("status").filter({ hasText: "●" })).toHaveText(
      "● Live",
    );
}
const rail = (page: Page) => page.getByTestId("rail");
const settingsNav = (page: Page) =>
  page.getByRole("navigation", { name: "Settings pages" });
const title = (page: Page) => page.locator("#settings-title");

test("settings: the gear opens a home of cards; your profile and signature, General, notifications, appearance; links to macros and knowledge; every page has an address", async ({
  page,
}) => {
  await open(page);
  // The gear in the icon strip opens Settings on its home page.
  await rail(page).getByRole("button", { name: "Settings" }).click();
  await expect(page).toHaveURL(/#settings$/);
  for (const group of ["Personal", "Workspace", "Inbox", "Knowledge & AI"])
    await expect(page.getByRole("region", { name: group })).toBeVisible();
  await page
    .getByRole("region", { name: "Personal" })
    .getByRole("button", { name: /Your profile/ })
    .click();
  await expect(page).toHaveURL(/#settings\/profile$/);
  await expect(title(page)).toHaveText("Your profile");

  // Your profile: Save lights up only with a change; the name shows at once in the account menu.
  const save = page.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeDisabled();
  await page.getByLabel("Name", { exact: true }).fill("Ada Lovelace");
  await page.getByLabel("Timezone").selectOption("Europe/London");
  await page
    .getByLabel("Signature", { exact: true })
    .fill("Best wishes,\nAda from support");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(
    page.getByRole("status").filter({ hasText: "Saved" }),
  ).toBeVisible();
  await expect(save).toBeDisabled();
  await expect(
    page.getByRole("button", { name: /^Account: Ada Lovelace/ }),
  ).toBeVisible();
  // The address opens the page directly, with what was saved.
  await open(page, "#settings/profile");
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    "Ada Lovelace",
  );
  await expect(page.getByLabel("Timezone")).toHaveValue("Europe/London");

  // The signature goes on replies, never on notes.
  const conversationId = await tenant(relay.db.connect, "demo", async (db) => {
    const identity = await getIdentity(db, "demo", "anonymous", "settings-sig");
    return (
      (await command(
        db,
        "demo",
        {
          type: "contact",
          identityId: identity.identityId,
          brandId: "default",
        },
        "settings-sig-start",
        { action: "start", text: "Signature fixture" },
      )) as { conversationId: string }
    ).conversationId;
  });
  await rail(page)
    .getByRole("button", { name: /^Inbox/ })
    .click();
  await expect(page).toHaveURL(/\/agent$/);
  await page
    .getByRole("navigation", { name: "Inbox views" })
    .getByRole("button", { name: /^All/ })
    .click();
  await page.locator(".pg-card", { hasText: "Signature fixture" }).click();
  const reply = page.getByRole("textbox", { name: "Reply message" });
  await reply.click();
  await page.keyboard.type("Your parcel left today.");
  await page.getByRole("button", { name: "Send reply" }).click();
  await page
    .getByRole("button", { name: "Internal note", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Internal note", exact: true })
    .click();
  await page.keyboard.type("Checked the courier.");
  await page.getByRole("button", { name: "Add internal note" }).click();
  await expect
    .poll(
      async () =>
        (
          await sql<{ kind: string; body: string }>(
            "SELECT kind,body FROM conversation_parts WHERE conversation_id=$1 AND kind IN ('teammate_reply','internal_note') ORDER BY seq",
            [conversationId],
          )
        ).map((p) => [p.kind, p.body]),
      { timeout: 15000 },
    )
    .toEqual([
      [
        "teammate_reply",
        "Your parcel left today.\n\nBest wishes,\n\nAda from support",
      ],
      ["internal_note", "Checked the courier."],
    ]);
  await expect(
    page.getByRole("log", { name: "Messages" }).getByText("Ada from support"),
  ).toBeVisible();

  // General: the workspace's name shows in the account menu.
  await open(page, "#settings/general");
  await expect(title(page)).toHaveText("General");
  await page.getByLabel("Workspace name").fill("TX3 Funding");
  await page.getByLabel("Team language").selectOption("fr");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Saved" }),
  ).toBeVisible();
  expect(
    (await sql("SELECT brand,locale FROM workspace WHERE id='demo'"))[0],
  ).toEqual({
    brand: "TX3 Funding",
    locale: "fr",
  });
  await page.getByRole("button", { name: /^Account:/ }).click();
  await expect(
    page
      .getByRole("dialog", { name: "Account" })
      .getByRole("region", { name: "Workspace" }),
  ).toContainText("TX3 Funding");
  await page.keyboard.press("Escape");

  // Notifications follow the account.
  await settingsNav(page)
    .getByRole("button", { name: "Notifications" })
    .click();
  await page.getByLabel(/Play a sound/).check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Saved" }),
  ).toBeVisible();
  expect(
    (await sql("SELECT notification_prefs FROM teammates WHERE id='owner'"))[0]
      .notification_prefs,
  ).toEqual({ desktop: false, sound: true });

  // Appearance switches the theme at once.
  await settingsNav(page).getByRole("button", { name: "Appearance" }).click();
  await page.getByRole("radio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-agent-theme",
    "dark",
  );
  await page.getByRole("radio", { name: "Light" }).click();

  // "Manage macros" in the command palette opens Settings › Macros.
  await rail(page)
    .getByRole("button", { name: /^Inbox/ })
    .click();
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("manage macros");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#settings\/macros$/);
  await expect(
    page
      .getByRole("region", { name: "Macros" })
      .getByRole("button", { name: "New macro" }),
  ).toBeVisible();

  // Knowledge links open Knowledge on the right page; Saved views opens the inbox menu.
  await settingsNav(page).getByRole("button", { name: "AI index" }).click();
  await expect(
    page
      .getByRole("navigation", { name: "Knowledge areas" })
      .getByRole("button", { name: "AI index" }),
  ).toHaveAttribute("aria-current", "page");
  await rail(page).getByRole("button", { name: "Settings" }).click();
  await settingsNav(page).getByRole("button", { name: "Saved views" }).click();
  await expect(
    page.getByRole("navigation", { name: "Inbox views" }),
  ).toBeVisible();
  // The account menu's "Your profile" opens Settings.
  await page.getByRole("button", { name: /^Account:/ }).click();
  await page.getByRole("button", { name: "Your profile" }).click();
  await expect(page).toHaveURL(/#settings\/profile$/);
});

test("a teammate without workspace rights sees only the pages they may use, and a refused save keeps the changes and says why", async ({
  page,
}) => {
  await open(page, "#settings", "?as=grace");
  await expect(
    settingsNav(page).getByRole("button", { name: "Your profile" }),
  ).toBeVisible();
  await expect(
    settingsNav(page).getByRole("button", { name: "General" }),
  ).toHaveCount(0);
  // A link to a page they can't use lands on the overview instead.
  await open(page, "#settings/general", "?as=grace");
  await expect(
    page.getByRole("heading", { name: "Settings", level: 2 }),
  ).toBeVisible();
  await expect(title(page)).toHaveCount(0);

  // A save the server refuses: the message shows, and the change stays to try again.
  await open(page, "#settings/profile", "?as=grace");
  await page.route("**/api/agent/settings", async (route) => {
    if (route.request().method() === "POST")
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "INVALID_SETTINGS",
            message: "Choose a timezone, such as Europe/London.",
          },
        }),
      });
    else await route.continue();
  });
  await page.getByLabel("Name", { exact: true }).fill("Grace Hopper");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Choose a timezone, such as Europe/London.",
  );
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    "Grace Hopper",
  );
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeEnabled();
  expect(
    (await sql("SELECT name FROM teammates WHERE id='grace'"))[0].name,
  ).toBe("Grace");
});

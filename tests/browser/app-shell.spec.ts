import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";

/**
 * The app shell (docs/AGENT_APP_SHELL.md): the icon strip that slides out on hover or keyboard
 * focus and can be pinned, and the inbox and knowledge side menus that hide and peek back.
 */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 900 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({
    apiPort: 8904,
    hostPort: 8905,
    inboxViews: true,
  });
});
test.afterAll(async () => {
  await relay?.close();
});

const rail = (page: Page) => page.getByTestId("rail");
const views = (page: Page) =>
  page.getByRole("navigation", { name: "Inbox views" });
const view = (page: Page, name: string) =>
  views(page).getByRole("button", { name: new RegExp("^" + name) });
async function open(page: Page) {
  await page.goto(relay.hostOrigin + "/agent");
  await expect(page.getByRole("status").filter({ hasText: "●" })).toHaveText(
    "● Live",
  );
  await expect(view(page, "All")).toBeVisible({ timeout: 15000 });
}

test("the strip slides out and pins; the inbox menu lists your inbox, team inboxes and views, hides, peeks and remembers", async ({
  page,
}) => {
  await open(page);
  // Collapsed: icons only, each still named; the Inbox badge is your inbox's open count.
  await expect(rail(page)).not.toHaveClass(/\bopen\b/);
  const width = async () =>
    (await rail(page).locator(".pg-rail-panel").boundingBox())!.width;
  expect(await width()).toBeLessThan(70);
  const yours = (await view(page, "Your inbox").innerText()).match(/\d+/)?.[0];
  if (yours)
    await expect(
      rail(page).getByRole("button", { name: /^Inbox/ }),
    ).toContainText(yours);

  // Hover slides it out over the page (the list does not move); leaving puts it back.
  const listBox = await page
    .getByRole("region", { name: "Conversations" })
    .boundingBox();
  await page.mouse.move(30, 400);
  await expect(rail(page)).toHaveClass(/\bopen\b/);
  await expect.poll(width).toBeGreaterThan(200);
  expect(
    (await page.getByRole("region", { name: "Conversations" }).boundingBox())!
      .x,
  ).toBe(listBox!.x);
  await page.mouse.move(900, 400);
  await expect(rail(page)).not.toHaveClass(/\bopen\b/);

  // Pinned, it stays open and takes its room; the choice survives a reload.
  await page.mouse.move(30, 400);
  await rail(page).getByRole("button", { name: "Pin navigation" }).click();
  await page.mouse.move(900, 400);
  await page.waitForTimeout(400);
  await expect(rail(page)).toHaveClass(/\bpinned\b/);
  await page.reload();
  await expect(rail(page)).toHaveClass(/\bpinned\b/);
  await rail(page).getByRole("button", { name: "Unpin navigation" }).click();
  await page.mouse.move(900, 400);
  await expect(rail(page)).not.toHaveClass(/\bopen\b/);

  // Keyboard focus opens it too, and Escape closes it.
  await rail(page)
    .getByRole("button", { name: /^Inbox/ })
    .focus();
  await page.keyboard.press("Tab");
  await expect(
    rail(page).getByRole("button", { name: "Knowledge", exact: true }),
  ).toBeFocused();
  await expect(rail(page)).toHaveClass(/\bopen\b/);
  await page.keyboard.press("Escape");
  await expect(rail(page)).not.toHaveClass(/\bopen\b/);

  // The inbox menu: your inbox and the defaults, then a team inbox for each of your teams.
  await expect(views(page).getByRole("button")).toContainText([
    "Your inbox",
    "Mentions",
    "Unassigned",
    "All",
    "Team inboxes",
    "Billing",
  ]);
  await view(page, "Billing").click();
  await expect(
    page
      .getByRole("region", { name: "Conversations" })
      .getByRole("heading", { name: "Billing" }),
  ).toBeVisible();
  // Sections fold.
  await views(page).getByRole("button", { name: "Team inboxes" }).click();
  await expect(view(page, "Billing")).toHaveCount(0);
  await views(page).getByRole("button", { name: "Team inboxes" }).click();
  await expect(view(page, "Billing")).toBeVisible();

  // Manage views holds the view actions; team inboxes cannot be moved or archived.
  await page.getByRole("button", { name: "Manage views" }).click();
  const manage = page.getByRole("menu", { name: "Manage views" });
  await expect(
    manage.getByRole("menuitem", { name: "Edit “Billing”" }),
  ).toBeEnabled();
  await expect(
    manage.getByRole("menuitem", { name: "Archive view" }),
  ).toBeDisabled();
  await manage.getByRole("menuitem", { name: "New view" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit inbox view" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // Hidden, the list takes its place; "Show menu" or the left edge brings it back over the
  // page while the mouse is there.
  await page.getByRole("button", { name: "Hide menu" }).click();
  await expect(views(page)).toBeHidden();
  const show = page.getByRole("button", { name: "Show menu" });
  await show.hover();
  await expect(views(page)).toBeVisible();
  await page.mouse.move(1200, 500);
  await expect(views(page)).toBeHidden();
  await page.getByTestId("Inbox menu edge").hover();
  await expect(views(page)).toBeVisible();
  await page.mouse.move(1200, 500);
  await expect(views(page)).toBeHidden();
  // The choice survives a reload; a click on "Show menu" keeps it open again.
  await page.reload();
  await expect(page.getByRole("button", { name: "Show menu" })).toBeVisible({
    timeout: 15000,
  });
  await expect(views(page)).toBeHidden();
  await page.getByRole("button", { name: "Show menu" }).click();
  await expect(views(page)).toBeVisible();
  await page.mouse.move(1200, 500);
  await page.waitForTimeout(400);
  await expect(views(page)).toBeVisible();

  // Knowledge has its own menu.
  await rail(page)
    .getByRole("button", { name: "Knowledge", exact: true })
    .click();
  // Choosing a destination closes the slid-out strip, so it never covers what opened.
  await expect(rail(page)).not.toHaveClass(/\bopen\b/);
  const areas = page.getByRole("navigation", { name: "Knowledge areas" });
  await expect(
    areas.getByRole("button", { name: "Content", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await areas.getByRole("button", { name: "Help centers" }).click();
  await expect(
    page.getByRole("heading", { name: "Help centers", level: 2 }),
  ).toBeVisible();
  await expect(
    rail(page).getByRole("button", { name: "Knowledge", exact: true }),
  ).toHaveAttribute("aria-current", "page");
});

test("with browser storage blocked, the strip and menus still work for the visit and start fresh after", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const refuse = () => {
      throw new DOMException("Blocked for this test", "SecurityError");
    };
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get: refuse,
    });
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page);
  await page.getByRole("button", { name: "Hide menu" }).click();
  await expect(views(page)).toBeHidden();
  await page.mouse.move(30, 400);
  await rail(page).getByRole("button", { name: "Pin navigation" }).click();
  await expect(rail(page)).toHaveClass(/\bpinned\b/);
  // Nothing was kept: a reload starts with the menu shown and the strip unpinned.
  await page.reload();
  await expect(view(page, "All")).toBeVisible({ timeout: 15000 });
  await expect(rail(page)).not.toHaveClass(/\bpinned\b/);
  expect(errors).toEqual([]);
});

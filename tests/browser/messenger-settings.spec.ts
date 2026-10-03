import { test, expect, type Page, type Browser } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";

/** Messenger settings M1 (docs/MESSENGER_SETTINGS_STEP1.md): drafts, audiences, Home, welcome. */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1100 } });
test.beforeAll(async () => {
  // The AI agent stays out of these conversations.
  relay = await startLocalRelay({
    apiPort: 8978,
    hostPort: 8979,
    aiAgent: false,
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
async function settings(page: Page) {
  await page.goto(relay.hostOrigin + "/agent#settings/messenger");
  await expect(page.getByTestId("publish-state")).toBeVisible({
    timeout: 15000,
  });
}
/** Opens the messenger on the customer's site (as a verified user with `user`) and returns its frame. */
async function messenger(browser: Browser, path = "/", user?: string) {
  const page = await (await browser.newContext()).newPage();
  await page.goto(
    relay.hostOrigin +
      path +
      (user ? (path.includes("?") ? "&" : "?") + "user=" + user : ""),
  );
  await expect(page.locator("[data-launcher]")).toHaveCount(1, {
    timeout: 15000,
  });
  await page.getByRole("button", { name: "Open support", exact: true }).click();
  await expect
    .poll(() =>
      page.frames().some((f) => f.url().includes("/messenger/frame.html")),
    )
    .toBe(true);
  return {
    page,
    frame: page
      .frames()
      .find((f) => f.url().includes("/messenger/frame.html"))!,
  };
}
const notice = (page: Page) => page.locator(".pg-settings-notice");

test("a draft of the Home screen, welcome, notice and audiences is saved, published, and seen by visitors and signed-in users differently", async ({
  page,
  browser,
}) => {
  await settings(page);
  await expect(page.getByTestId("publish-state")).toContainText(
    "as it was set up before drafts",
  );

  // Visitors: "Ask a question", and no launcher on checkout pages.
  await page.getByRole("radio", { name: "Ask a question" }).check();
  await page.getByLabel("Show the launcher").selectOption("except_matching");
  await page.getByRole("button", { name: "Add page rule" }).click();
  await page.getByLabel("Rule 1 text").fill("/checkout");
  // Users: Tickets as a space, and "Contact support".
  await page.getByRole("radio", { name: "Users" }).click();
  await page.getByRole("checkbox", { name: /^Tickets/ }).check();
  await page.getByRole("radio", { name: "Contact support" }).check();
  // Home: a status link for everyone.
  await page.getByLabel("New card kind").selectOption({ label: "Link" });
  await page.getByRole("button", { name: "Add card" }).click();
  await page.getByLabel("Link 3: title").fill("System status");
  await page.getByLabel("Link 3: text").fill("All systems normal");
  await page.getByLabel("Link 3: address").fill("https://status.example.com");
  // Welcome and a notice.
  await page.getByLabel("Greeting (English)").fill("Hello {first_name} 👋");
  await page
    .getByLabel("Introduction (English)")
    .fill("Ask us anything about your order.");
  await page.getByRole("checkbox", { name: "Show the notice" }).check();
  await page
    .getByLabel("Notice (English)", { exact: true })
    .fill("Replies are slower today.");

  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(notice(page)).toContainText(
    "Draft saved. Publish to put it live.",
  );
  await expect(page.getByTestId("publish-state")).toHaveText(
    "Draft saved, not published yet.",
  );

  // Not published yet: the customer still sees the messenger as it was.
  let visitor = await messenger(browser);
  await expect(
    visitor.frame.getByRole("heading", { name: "How can we help?" }),
  ).toBeVisible();
  await expect(visitor.frame.getByRole("note")).toHaveCount(0);
  await visitor.page.close();

  await page.getByRole("button", { name: "Publish" }).click();
  await expect(notice(page)).toContainText("Published version 1.");
  await expect(page.getByTestId("publish-state")).toHaveText(
    "Live: version 1, as published.",
  );
  expect((await sql("SELECT version FROM messenger_versions"))[0].version).toBe(
    1,
  );

  // A visitor: the welcome (no first name), notice, the link card and their start button.
  visitor = await messenger(browser);
  await expect(
    visitor.frame.getByRole("heading", { name: "Hello 👋" }),
  ).toBeVisible();
  await expect(
    visitor.frame.getByText("Ask us anything about your order."),
  ).toBeVisible();
  await expect(visitor.frame.getByRole("note", { name: "Notice" })).toHaveText(
    "Replies are slower today.",
  );
  await expect(
    visitor.frame.getByRole("link", { name: /System status/ }),
  ).toHaveAttribute("href", "https://status.example.com");
  await expect(
    visitor.frame.getByRole("button", { name: /^Ask a question/ }),
  ).toBeVisible();
  const nav = visitor.frame.getByRole("navigation");
  await expect(nav.getByRole("button")).toHaveText([
    "⌂Home",
    "▤Messages",
    "⌕Help",
  ]);
  await expect(visitor.page.locator("[data-launcher]")).toHaveAttribute(
    "data-launcher",
    "shown",
  );
  await visitor.page.close();
  // On a checkout page the visitor's launcher is hidden; the site's own button still opens it.
  const checkout = await messenger(browser, "/?page=/checkout");
  await expect(checkout.page.locator("[data-launcher]")).toHaveAttribute(
    "data-launcher",
    "hidden",
  );
  await checkout.page.close();

  // A signed-in user: Tickets among the spaces and their own start button.
  const user = await messenger(browser, "/", "ada");
  await expect(
    user.frame.getByRole("navigation").getByRole("button"),
  ).toHaveText(["⌂Home", "▤Messages", "⌕Help", "▣Tickets"]);
  await expect(
    user.frame.getByRole("button", { name: /^Contact support/ }),
  ).toBeVisible();
  await user.frame
    .getByRole("navigation")
    .getByRole("button", { name: /Tickets/ })
    .click();
  await expect(
    user.frame.getByRole("button", { name: "Your tickets and requests" }),
  ).toBeVisible();
});

test("an unusable draft is refused with the reason and nothing goes live; an earlier version can be restored", async ({
  page,
}) => {
  await settings(page);
  await page.getByLabel("New card kind").selectOption({ label: "Link" });
  await page.getByRole("button", { name: "Add card" }).click();
  const last = page
    .getByRole("list", { name: "Home cards" })
    .getByRole("listitem")
    .last();
  await last.getByPlaceholder("Title").fill("Insecure link");
  await last.getByPlaceholder("https://").fill("http://example.com");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "“Insecure link” needs an https:// address.",
  );
  await expect(page.getByRole("button", { name: "Save draft" })).toBeEnabled();
  const live = await sql("SELECT count(*)::int AS n FROM messenger_versions");
  // Fixed and published, then the earlier version is restored into the draft.
  await last.getByPlaceholder("https://").fill("https://example.com");
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(notice(page)).toContainText(/Published version \d+/);
  expect(
    (await sql("SELECT count(*)::int AS n FROM messenger_versions"))[0].n,
  ).toBe(live[0].n + 1);
  // A second version, then the first of the two restored.
  await page.getByLabel("Introduction (English)").fill("We're here to help.");
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(notice(page)).toContainText(/Published version \d+/);
  const versions = page.getByLabel("Earlier version");
  await versions.selectOption({ index: 2 });
  await page.getByRole("button", { name: "Restore into draft" }).click();
  await expect(notice(page)).toContainText(/restored into the draft/);
  await expect(page.getByTestId("publish-state")).toHaveText(
    "Draft saved, not published yet.",
  );
});

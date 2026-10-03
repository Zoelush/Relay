import { test, expect, type Page, type Browser } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { command } from "../../server/conversations";

/** Messenger settings M3 (docs/MESSENGER_SETTINGS_STEP3.md): rules, languages, privacy, install. */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1500, height: 1100 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({
    apiPort: 8990,
    hostPort: 8991,
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
async function messenger(browser: Browser, query = "") {
  const page = await (await browser.newContext()).newPage();
  await page.goto(relay.hostOrigin + "/" + query);
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

test("rules, a privacy notice and French are published; the customer continues their open conversation, can't reply once it's closed, and reads the messenger in French; Settings shows install guides and where it runs", async ({
  page,
  browser,
}) => {
  await settings(page);
  // Visitors: one conversation at a time, no replies once closed.
  await page
    .getByRole("checkbox", { name: /One open conversation at a time/ })
    .check();
  await page
    .getByRole("checkbox", { name: /No replies to closed conversations/ })
    .check();
  // Everyone: French, and a privacy notice.
  await page.getByRole("checkbox", { name: "French", exact: true }).check();
  await page.getByRole("checkbox", { name: /Show a privacy notice/ }).check();
  await page
    .getByLabel("Privacy policy address")
    .fill("https://example.com/privacy");
  await page
    .getByLabel("Privacy notice (English)")
    .fill("We use your messages to help you.");
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(notice(page)).toContainText("Published version 1.");

  // A visitor: the privacy notice when starting, then their open conversation is continued.
  const visitor = await messenger(browser);
  await visitor.frame
    .getByRole("button", { name: /^Start a conversation/ })
    .click();
  await expect(visitor.frame.locator(".privacy")).toContainText(
    "We use your messages to help you.",
  );
  await expect(
    visitor.frame.getByRole("link", { name: "Privacy policy" }),
  ).toHaveAttribute("href", "https://example.com/privacy");
  await visitor.frame
    .getByRole("textbox", { name: "Write your message" })
    .fill("Where is my order?");
  await visitor.frame.getByRole("button", { name: "Send message" }).click();
  await expect(
    visitor.frame.locator(".message", { hasText: "Where is my order?" }),
  ).toBeVisible();
  await visitor.frame
    .getByRole("navigation")
    .getByRole("button", { name: /Home/ })
    .click();
  await visitor.frame
    .getByRole("button", { name: /^Continue your conversation/ })
    .click();
  await expect(
    visitor.frame.locator(".message", { hasText: "Where is my order?" }),
  ).toBeVisible();

  // Closed by the team: the visitor can't reply there, and is offered a new conversation.
  const [conversation] = await sql<{ id: string }>(
    "SELECT c.id FROM conversations c JOIN conversation_parts p ON p.workspace_id=c.workspace_id AND p.conversation_id=c.id WHERE p.body='Where is my order?'",
  );
  await tenant(relay.db.connect, "demo", (q) =>
    command(
      q,
      "demo",
      { type: "teammate", principal: "local-owner" },
      "close-" + crypto.randomUUID(),
      {
        action: "close",
        conversationId: conversation.id,
      },
    ),
  );
  await visitor.page.reload();
  await visitor.page
    .getByRole("button", { name: "Open support", exact: true })
    .click();
  await expect
    .poll(() =>
      visitor.page
        .frames()
        .some((f) => f.url().includes("/messenger/frame.html")),
    )
    .toBe(true);
  const again = visitor.page
    .frames()
    .find((f) => f.url().includes("/messenger/frame.html"))!;
  await again
    .getByRole("navigation")
    .getByRole("button", { name: /Messages/ })
    .click();
  await again.getByRole("button", { name: /Where is my order\?/ }).click();
  await expect(
    again.getByText(
      "This conversation is closed. Start a new one if you need more help.",
    ),
  ).toBeVisible();
  await expect(
    again.getByRole("textbox", { name: "Write your message" }),
  ).toHaveCount(0);

  // A French visitor reads the messenger in French.
  const french = await messenger(browser, "?locale=fr");
  await expect(
    french.frame
      .getByRole("navigation")
      .getByRole("button", { name: /Accueil/ }),
  ).toBeVisible();
  await expect(
    french.frame.getByRole("button", { name: /^Démarrer une conversation/ }),
  ).toBeVisible();

  // Settings (reloaded): where the messenger ran, per-framework snippets, and the identity guide.
  await page.reload();
  await expect(page.getByTestId("publish-state")).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("list", { name: "Seen on" })).toContainText(
    relay.hostOrigin,
  );
  await page
    .getByRole("tablist", { name: "Framework" })
    .getByRole("tab", { name: "React" })
    .click();
  await page.getByRole("radio", { name: "Signed-in customers" }).check();
  const snippet = page.getByLabel("Install snippet");
  await expect(snippet).toContainText(
    "export function RelayMessenger({ user, relayToken })",
  );
  await expect(snippet).toContainText("jwt: relayToken");
  await page
    .getByRole("tablist", { name: "Server language" })
    .getByRole("tab", { name: "Python" })
    .click();
  await expect(page.getByLabel("Server example")).toContainText(
    '"iss": "relay-customer:demo"',
  );
});

test("an http privacy policy address is refused with the reason, and nothing is published", async ({
  page,
}) => {
  await settings(page);
  const before = (
    await sql("SELECT count(*)::int AS n FROM messenger_versions")
  )[0].n;
  await page.getByRole("checkbox", { name: /Show a privacy notice/ }).check();
  await page
    .getByLabel("Privacy policy address")
    .fill("http://example.com/privacy");
  await page
    .getByLabel("Privacy notice (English)")
    .fill("We use your messages to help you.");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "The privacy policy needs an https:// address.",
  );
  expect(
    (await sql("SELECT count(*)::int AS n FROM messenger_versions"))[0].n,
  ).toBe(before);
});

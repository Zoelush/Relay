import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { changeKnowledge } from "../../server/knowledge";
import { resolvePath } from "../../server/help-centers";

let relay: Awaited<ReturnType<typeof startLocalRelay>>;
let loginHelp = "";
let oldPolicy = "";
test.use({ viewport: { width: 1600, height: 1000 } });
/** A published English article, created the way the editor does. */
async function publish(title: string, forHelpCenter: boolean) {
  return tenant(relay.db.connect, "demo", async (db) => {
    const { id } = (await changeKnowledge(db, "demo", "local-owner", {
      op: "create",
      source: "article",
      locale: "en",
      title,
      forHelpCenter,
      body: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: title }] },
        ],
      },
    })) as { id: string };
    await changeKnowledge(db, "demo", "local-owner", {
      op: "publish",
      id,
      locale: "en",
      draftVersion: "1",
    });
    return id;
  });
}
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 8942, hostPort: 8943 });
  loginHelp = await publish("Can't sign in", true);
  oldPolicy = await publish("Old refund policy", false);
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
const resolve = (path: string) =>
  tenant(relay.db.connect, "demo", (db) => resolvePath(db, "demo", path));
async function open(page: Page, as = "") {
  await page.goto(relay.hostOrigin + "/agent" + as);
  await expect(page.getByRole("status").filter({ hasText: "●" })).toHaveText(
    "● Live",
  );
  await page.getByRole("button", { name: "Knowledge" }).click();
  await expect(page.getByRole("heading", { name: "Knowledge" })).toBeVisible();
}
/** The help center editor: Knowledge › Help centers. */
async function editor(page: Page) {
  await page
    .getByRole("navigation", { name: "Knowledge areas" })
    .getByRole("button", { name: "Help centers" })
    .click();
  await expect(page.getByRole("region", { name: "Collections" })).toBeVisible();
}
/** One collection or section in the manager, by the name shown on it. */
const row = (page: Page, name: string) =>
  page.getByRole("region", { name: "Collections" }).getByRole("article", { name });

test("the collections manager: collections, sections, articles, order, addresses and languages", async ({
  page,
}) => {
  await open(page);
  await editor(page);
  const tree = page.getByRole("region", { name: "Collections" });
  await expect(tree.getByRole("textbox", { name: "Name in en" }).first()).toHaveValue("Getting started");

  // A new collection, then a section inside it from the collection's own menu.
  await tree.getByRole("button", { name: "New collection" }).click();
  await tree.getByLabel("New collection name").fill("Troubleshooting");
  await tree.getByRole("button", { name: "Create" }).click();
  const trouble = row(page, "Collection Troubleshooting");
  await expect(trouble).toBeVisible();
  await trouble.getByRole("button", { name: "More for Troubleshooting" }).click();
  await trouble.getByRole("menuitem", { name: "Add section" }).click();
  await trouble.getByLabel("Section name in en").fill("Login problems");
  await trouble.getByRole("button", { name: "Add section" }).click();
  const login = row(page, "Section Login problems");
  await expect(login).toBeVisible();

  // An article placed in the section, from its menu.
  await login.getByRole("button", { name: "More for Login problems" }).click();
  await login.getByRole("menuitem", { name: "Add articles" }).click();
  await login
    .getByLabel("Article to add to Login problems")
    .selectOption({ label: "Can't sign in" });
  await login.getByRole("button", { name: "Add article" }).click();
  await expect(
    login.getByRole("list", { name: "Articles in Login problems" }),
  ).toContainText("Can't sign in");
  expect(await resolve("relay-help/en/articles/can-t-sign-in")).toMatchObject({
    type: "article",
    id: loginHelp,
  });

  // Reorder from the menu: Troubleshooting moves above Billing.
  await trouble.getByRole("button", { name: "More for Troubleshooting" }).click();
  await trouble.getByRole("menuitem", { name: "Move up" }).click();
  await expect
    .poll(async () =>
      (
        await sql(
          `SELECT l.name FROM help_nodes n JOIN help_node_locales l ON l.workspace_id=n.workspace_id AND l.node_id=n.id AND l.locale='en'
          WHERE n.parent_id IS NULL ORDER BY n.position`,
        )
      ).map((r) => r.name),
    )
    .toEqual(["Getting started", "Troubleshooting", "Billing"]);

  // Renaming in place, and the address: the old one redirects, and the row says so.
  const loginNow = row(page, "Section Login problems");
  await loginNow.getByLabel("Address in en").fill("sign-in-problems");
  await loginNow.getByRole("button", { name: "Save address" }).click();
  await expect(row(page, "Section Login problems")).toContainText(
    "Redirects from: login-problems",
  );
  expect(await resolve("relay-help/en/sections/login-problems")).toEqual({
    type: "redirect",
    path: "relay-help/en/sections/sign-in-problems",
  });

  // French: no name yet (English shows), then its own name, with its own address.
  await page.getByLabel("Language", { exact: true }).selectOption("fr");
  const troubleFr = row(page, "Collection Troubleshooting");
  await expect(troubleFr).toContainText("No fr name yet; shows en");
  await troubleFr.getByLabel("Name in fr").fill("Dépannage");
  await troubleFr.getByLabel("Name in fr").blur();
  await expect(row(page, "Collection Dépannage")).toBeVisible();
  expect((await resolve("relay-help/fr/collections/depannage")).type).toBe(
    "collection",
  );
  expect(await resolve("relay-help/fr/collections/troubleshooting")).toEqual({
    type: "redirect",
    path: "relay-help/fr/collections/depannage",
  });

  // The article's own address, from the Content tab.
  await page
    .getByRole("navigation", { name: "Knowledge areas" })
    .getByRole("button", { name: "Content", exact: true })
    .click();
  await page
    .getByRole("region", { name: "Knowledge records" })
    .getByRole("button", { name: /Can't sign in/ })
    .click();
  const address = page.getByRole("region", { name: "Public address" });
  await expect(address.getByLabel("Address")).toHaveValue("can-t-sign-in");
  await address.getByLabel("Address").fill("Cannot Sign In");
  await expect(address).toContainText("for example cannot-sign-in");
  await address.getByLabel("Address").fill("cannot-sign-in");
  await address.getByRole("button", { name: "Save address" }).click();
  await expect(
    page.getByRole("region", { name: "Public address" }).getByLabel("Address"),
  ).toHaveValue("cannot-sign-in");
  expect(await resolve("relay-help/en/articles/can-t-sign-in")).toEqual({
    type: "redirect",
    path: "relay-help/en/articles/cannot-sign-in",
  });
  // French has no version: shown in English, with the English page as canonical.
  const fr = await resolve("relay-help/fr/articles/cannot-sign-in");
  expect(fr.type === "article" && [fr.contentLocale, fr.canonical]).toEqual([
    "en",
    "relay-help/en/articles/cannot-sign-in",
  ]);
});

test("configure and style: the live preview follows the draft, and saving sets it live", async ({
  page,
}) => {
  await open(page);
  await editor(page);
  // The preview is the help center's own homepage, drawn by the server.
  const preview = page.getByRole("region", { name: "Preview" });
  const frame = page.frameLocator('iframe[title="Help center preview"]');
  await expect(frame.locator("h1.hero-line")).toContainText(
    "Advice and answers from the Relay team",
  );
  await expect(frame.locator("ul.grid li").first()).toContainText("Getting started");
  // A collection page and a phone's width.
  await preview.getByRole("radio", { name: "Collection" }).click();
  await expect(frame.locator("nav.crumbs")).toContainText("Getting started");
  await preview.getByRole("radio", { name: "Mobile" }).click();
  await expect(page.locator('iframe[title="Help center preview"]')).toHaveJSProperty(
    "offsetWidth",
    390,
  );
  await preview.getByRole("radio", { name: "Desktop" }).click();
  await preview.getByRole("radio", { name: "Homepage" }).click();

  // Configure and style: the welcome line and the action colour, with the preview following.
  await page.getByRole("button", { name: "Configure and style" }).click();
  const editorPane = page.getByRole("button", { name: "Save and set live" });
  await expect(editorPane).toBeVisible();
  await page.getByRole("button", { name: "Hero block" }).click();
  await page.getByLabel("Welcome message (en)").fill("How can we help?");
  await page.getByRole("button", { name: "Shared elements" }).click();
  await page.getByLabel("Action colour (hex)").fill("#7a0ba5");
  await page.getByRole("radio", { name: "Floating" }).click();
  await expect(frame.locator("h1.hero-line")).toContainText("How can we help?");
  await expect(frame.locator("body")).toHaveClass(/floating/);
  await expect
    .poll(() =>
      frame
        .locator("html")
        .evaluate((el) => getComputedStyle(el).getPropertyValue("--action").trim()),
    )
    .toBe("#7a0ba5");
  // Nothing is saved until it is.
  expect(
    (await sql("SELECT theme->>'actionColor' AS c FROM help_centers"))[0].c,
  ).not.toBe("#7a0ba5");

  // The article page: the table of contents and the author, switched on here.
  await page.getByRole("button", { name: "Article page" }).click();
  await page.getByLabel("Offer the article as Markdown").check();
  await page.getByRole("button", { name: "Shared elements" }).click();
  await page.getByLabel("Show article authors").check();
  await editorPane.click();
  await expect(
    page.getByRole("status").filter({ hasText: "Saved and set live." }),
  ).toBeVisible();
  await expect
    .poll(async () =>
      (await sql("SELECT theme->>'actionColor' AS c FROM help_centers"))[0].c,
    )
    .toBe("#7a0ba5");

  // The public pages carry it, and the article is offered as Markdown.
  const slug = (
    await sql<{ slug: string }>(
      "SELECT slug FROM knowledge_locales WHERE locale='en' AND slug IS NOT NULL AND published_title LIKE 'Getting started%'",
    )
  )[0].slug;
  const reader = await page.context().newPage();
  await reader.goto(relay.apiOrigin + "/help/demo/relay-help/en");
  await expect(reader.locator("h1.hero-line")).toHaveText("How can we help?");
  const article = `/help/demo/relay-help/en/articles/${slug}`;
  await reader.goto(relay.apiOrigin + article);
  await expect(reader.locator("p.byline")).toContainText("Written by");
  await expect(reader.getByRole("link", { name: "View as Markdown" })).toBeVisible();
  const markdown = await reader.request.get(relay.apiOrigin + article + ".md");
  expect(markdown.headers()["content-type"]).toBe("text/markdown; charset=utf-8");
  expect(await markdown.text()).toMatch(/^# /);
  await reader.close();
});

test("an article not switched on for the help center is refused with the reason, and teammates without knowledge.manage have no help center editor", async ({
  page,
  browser,
}) => {
  await open(page);
  await editor(page);
  const billing = row(page, "Collection Billing");
  await billing.getByRole("button", { name: "More for Billing" }).click();
  await billing.getByRole("menuitem", { name: "Add articles" }).click();
  await billing
    .getByLabel("Article to add to Billing")
    .selectOption({ label: "Old refund policy" });
  await billing.getByRole("button", { name: "Add article" }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: 'Turn on "Show in the help center" for this article first.' }),
  ).toBeVisible();
  await expect(
    billing.getByRole("list", { name: "Articles in Billing" }),
  ).not.toContainText("Old refund policy");
  expect(
    await sql("SELECT 1 FROM help_placements WHERE record_id=$1", [oldPolicy]),
  ).toEqual([]);

  // Grace (an agent) reads knowledge but cannot edit help centers.
  const grace = await browser.newPage();
  await open(grace, "?as=grace");
  await expect(
    grace
      .getByRole("navigation", { name: "Knowledge areas" })
      .getByRole("button", { name: "Help centers" }),
  ).toHaveCount(0);
  await grace.close();
});

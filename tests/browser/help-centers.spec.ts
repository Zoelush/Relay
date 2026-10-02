import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { changeKnowledge } from "../../server/knowledge";
import { resolvePath } from "../../server/help-centers";

let relay: Awaited<ReturnType<typeof startLocalRelay>>;
let loginHelp = "";
let oldPolicy = "";
test.use({ viewport: { width: 1440, height: 900 } });
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

test("build the help center tree, rename slugs, add a language, and old links redirect", async ({
  page,
}) => {
  await open(page);
  await page
    .getByRole("navigation", { name: "Knowledge areas" })
    .getByRole("button", { name: "Help centers" })
    .click();
  const tree = page.getByRole("region", { name: "Collections" });
  await expect(
    tree.getByRole("article", { name: "Collection Getting started" }),
  ).toBeVisible();
  await expect(
    tree.getByRole("article", { name: "Section Your first conversation" }),
  ).toContainText("Getting started with Relay");

  // A new collection with a section, and an article placed in it.
  await tree.getByLabel("Add collection").fill("Troubleshooting");
  await tree.getByRole("button", { name: "Add collection" }).click();
  const trouble = tree.getByRole("article", {
    name: "Collection Troubleshooting",
  });
  await expect(trouble).toBeVisible();
  await trouble
    .getByLabel("Add section to Troubleshooting")
    .fill("Login problems");
  await trouble.getByRole("button", { name: "Add section" }).click();
  const login = tree.getByRole("article", { name: "Section Login problems" });
  await expect(login).toBeVisible();
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

  // Reorder: Troubleshooting moves above Billing.
  await trouble
    .getByRole("button", { name: "Move Troubleshooting up" })
    .first()
    .click();
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

  // Rename the section's address: the old one redirects, and the editor says so.
  const loginNow = tree.getByRole("article", {
    name: "Section Login problems",
  });
  await loginNow.getByLabel("Address in en").fill("sign-in-problems");
  await loginNow.getByRole("button", { name: "Save" }).click();
  await expect(
    tree.getByRole("article", { name: "Section Login problems" }),
  ).toContainText("Redirects from: login-problems");
  expect(await resolve("relay-help/en/sections/login-problems")).toEqual({
    type: "redirect",
    path: "relay-help/en/sections/sign-in-problems",
  });

  // French: no name yet (English shows), then its own name and address.
  await page.getByLabel("Language for names").selectOption("fr");
  const troubleFr = tree.getByRole("article", {
    name: "Collection Troubleshooting",
  });
  await expect(troubleFr).toContainText("(no fr name yet; shows en)");
  await troubleFr.getByLabel("Name in fr").first().fill("Dépannage");
  await troubleFr.getByRole("button", { name: "Add fr name" }).first().click();
  await expect(
    tree.getByRole("article", { name: "Collection Dépannage" }),
  ).toBeVisible();
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
    .getByRole("button", { name: "Content" })
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

test("an article not switched on for the help center is refused with the reason, and teammates without knowledge.manage have no help center editor", async ({
  page,
  browser,
}) => {
  await open(page);
  await page
    .getByRole("navigation", { name: "Knowledge areas" })
    .getByRole("button", { name: "Help centers" })
    .click();
  const billing = page
    .getByRole("region", { name: "Collections" })
    .getByRole("article", { name: "Collection Billing" });
  await billing
    .getByLabel("Article to add to Billing")
    .selectOption({ label: "Old refund policy" });
  await billing.getByRole("button", { name: "Add article" }).click();
  await expect(
    page.getByRole("region", { name: "Collections" }).getByRole("alert"),
  ).toHaveText('Turn on "Show in the help center" for this article first.');
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

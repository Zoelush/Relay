import { test, expect, type Browser, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";

let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1280, height: 900 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 8944, hostPort: 8945 });
});
test.afterAll(async () => {
  await relay?.close();
});

async function knowledge(page: Page) {
  await page.goto(relay.hostOrigin + "/agent");
  await expect(page.getByRole("status").filter({ hasText: "●" })).toHaveText(
    "● Live",
  );
  await page.getByRole("button", { name: "Knowledge" }).click();
  await expect(page.getByRole("heading", { name: "Knowledge" })).toBeVisible();
}
const saved = (page: Page) =>
  expect(
    page.getByRole("status").filter({ hasText: /saved|Saving/ }),
  ).toHaveText("All changes saved");
/** A visitor with scripts off: what search engines and the first paint see. */
async function visitor(browser: Browser) {
  const context = await browser.newContext({ javaScriptEnabled: false });
  return context.newPage();
}
const head = (page: Page, selector: string, attribute: string) =>
  page
    .locator(selector)
    .evaluateAll((nodes, a) => nodes.map((n) => n.getAttribute(a)), attribute);

test("an article published in three languages is rendered by the server in each, with its metadata, and a changed address redirects", async ({
  page,
  browser,
}) => {
  await knowledge(page);
  // German joins the help center's languages.
  await page
    .getByRole("navigation", { name: "Knowledge areas" })
    .getByRole("button", { name: "Help centers" })
    .click();
  await page.getByLabel("Languages").fill("en, fr, de");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("alert")).toHaveText("Settings saved.");

  // Write and publish in English, then French and German, each on its own.
  await page
    .getByRole("navigation", { name: "Knowledge areas" })
    .getByRole("button", { name: "Content", exact: true })
    .click();
  await page.getByRole("button", { name: "New article" }).click();
  const title = page.getByLabel("Title");
  await title.fill("Change your plan");
  await page.getByLabel("Article body").click();
  await page.keyboard.type("Plans can be changed at any time.");
  await saved(page);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByRole("tab", { name: "en · Published" })).toBeVisible();
  for (const [locale, text] of [
    ["fr", "Changer de forfait"],
    ["de", "Tarif wechseln"],
  ]) {
    await page.getByLabel("New language").fill(locale);
    await page.getByRole("button", { name: "Add language" }).click();
    await expect(
      page.getByRole("tab", { name: `${locale} · Draft` }),
    ).toHaveAttribute("aria-selected", "true");
    await title.fill(text);
    await saved(page);
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(
      page.getByRole("tab", { name: `${locale} · Published` }),
    ).toBeVisible();
  }
  // Show it in the help center and place it in Billing.
  const settings = page.getByRole("region", { name: "Settings" });
  await settings.getByLabel("Show in the help center").check();
  await settings.getByRole("button", { name: "Save settings" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Settings saved." }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Knowledge areas" })
    .getByRole("button", { name: "Help centers" })
    .click();
  const billing = page.getByRole("article", { name: "Collection Billing" });
  await billing
    .getByLabel("Article to add to Billing")
    .selectOption({ label: "Change your plan" });
  await billing.getByRole("button", { name: "Add article" }).click();
  await expect(
    billing.getByRole("list", { name: "Articles in Billing" }),
  ).toContainText("Change your plan");

  // Each language, with scripts off: server-rendered, with its own metadata.
  const reader = await visitor(browser);
  const base = relay.apiOrigin + "/help/demo/relay-help";
  const pages = {
    en: ["/en/articles/change-your-plan", "Change your plan"],
    fr: ["/fr/articles/changer-de-forfait", "Changer de forfait"],
    de: ["/de/articles/tarif-wechseln", "Tarif wechseln"],
  } as const;
  for (const [locale, [path, heading]] of Object.entries(pages)) {
    const response = await reader.goto(base + path);
    expect(response!.status()).toBe(200);
    await expect(reader.locator("html")).toHaveAttribute("lang", locale);
    await expect(reader).toHaveTitle(`${heading} | Relay Help`);
    await expect(reader.getByRole("heading", { level: 1 })).toHaveText(heading);
    await expect(
      reader.getByText("Plans can be changed at any time."),
    ).toBeVisible();
    expect(await head(reader, 'link[rel="canonical"]', "href")).toEqual([
      base + path,
    ]);
    expect(await head(reader, 'link[rel="alternate"]', "hreflang")).toEqual([
      "en",
      "fr",
      "de",
      "x-default",
    ]);
    expect(await head(reader, 'meta[property="og:title"]', "content")).toEqual([
      heading,
    ]);
    const ld = JSON.parse(
      (await reader
        .locator('script[type="application/ld+json"]')
        .textContent())!,
    );
    expect(ld["@graph"][0]).toMatchObject({
      "@type": "Article",
      headline: heading,
      inLanguage: locale,
    });
    // The breadcrumb leads back to the collection.
    await expect(
      reader.getByRole("navigation", { name: "Breadcrumb" }),
    ).toContainText("Billing");
  }
  // The language switcher goes to the same article in another language.
  await reader.getByRole("link", { name: "Français" }).click();
  await expect(reader).toHaveURL(base + pages.fr[0]);

  // A changed address: the old link answers 301 and lands on the new page.
  await page
    .getByRole("navigation", { name: "Knowledge areas" })
    .getByRole("button", { name: "Content", exact: true })
    .click();
  await page
    .getByRole("region", { name: "Knowledge records" })
    .getByRole("button", { name: /Change your plan/ })
    .click();
  await page.getByRole("tab", { name: "en · Published" }).click();
  const address = page.getByRole("region", { name: "Public address" });
  await address.getByLabel("Address").fill("switch-plans");
  await address.getByRole("button", { name: "Save address" }).click();
  await expect(
    page.getByRole("region", { name: "Public address" }).getByLabel("Address"),
  ).toHaveValue("switch-plans");
  // A new visitor following the old link (a recent one may still have it cached for a minute).
  await reader.context().close();
  const fresh = await visitor(browser);
  const moved = await fresh.goto(base + pages.en[0]);
  expect(moved!.request().redirectedFrom()).not.toBeNull();
  expect((await moved!.request().redirectedFrom()!.response())!.status()).toBe(
    301,
  );
  await expect(fresh).toHaveURL(base + "/en/articles/switch-plans");
  await expect(fresh.getByRole("heading", { level: 1 })).toHaveText(
    "Change your plan",
  );
  await fresh.context().close();
});

test("a signed-in article asks an anonymous visitor to sign in without naming it, and opens after signing in through the portal", async ({
  page,
  browser,
}) => {
  await knowledge(page);
  await page.getByRole("button", { name: "New article" }).click();
  await page.getByLabel("Title").fill("Enterprise discounts");
  await page.getByLabel("Article body").click();
  await page.keyboard.type("Contact your account manager for volume pricing.");
  await saved(page);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByRole("tab", { name: "en · Published" })).toBeVisible();
  const settings = page.getByRole("region", { name: "Settings" });
  await settings.getByLabel("Audience").selectOption("signed_in");
  await settings.getByLabel("Show in the help center").check();
  await settings.getByRole("button", { name: "Save settings" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Settings saved." }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Knowledge areas" })
    .getByRole("button", { name: "Help centers" })
    .click();
  const billing = page.getByRole("article", { name: "Collection Billing" });
  await billing
    .getByLabel("Article to add to Billing")
    .selectOption({ label: "Enterprise discounts" });
  await billing.getByRole("button", { name: "Add article" }).click();
  await expect(
    billing.getByRole("list", { name: "Articles in Billing" }),
  ).toContainText("Enterprise discounts");

  const url =
    relay.apiOrigin + "/help/demo/relay-help/en/articles/enterprise-discounts";
  const anonymous = await visitor(browser);
  const refused = await anonymous.goto(url);
  expect(refused!.status()).toBe(401);
  await expect(anonymous.getByRole("heading", { level: 1 })).toHaveText(
    "Sign in to continue",
  );
  await expect(anonymous.locator("body")).not.toContainText("Enterprise");
  await expect(anonymous.locator("body")).not.toContainText("volume pricing");
  expect(await head(anonymous, 'meta[name="robots"]', "content")).toEqual([
    "noindex, nofollow",
  ]);
  // It isn't listed for them either.
  await anonymous.goto(
    relay.apiOrigin + "/help/demo/relay-help/en/collections/billing",
  );
  await expect(anonymous.locator("main")).not.toContainText("Enterprise");
  // An unknown page is a themed 404.
  const missing = await anonymous.goto(
    relay.apiOrigin + "/help/demo/relay-help/en/articles/no-such-page",
  );
  expect(missing!.status()).toBe(404);
  await expect(anonymous.getByRole("heading", { level: 1 })).toHaveText(
    "Page not found",
  );
  await anonymous.context().close();

  // Signed in through the portal (a signed link from the customer's site), the article opens.
  const customer = await (await browser.newContext()).newPage();
  await customer.goto(relay.hostOrigin + "/demo/portal-link?user=sam");
  await expect(
    customer.getByRole("heading", { name: "Your requests" }),
  ).toBeVisible();
  // The portal is a section of the help center: its link leads back.
  await customer.getByRole("link", { name: "Help center" }).click();
  await expect(customer.getByRole("heading", { level: 1 })).toHaveText(
    "Relay Help",
  );
  const opened = await customer.goto(url);
  expect(opened!.status()).toBe(200);
  await expect(customer.getByRole("heading", { level: 1 })).toHaveText(
    "Enterprise discounts",
  );
  await expect(
    customer.getByText("Contact your account manager for volume pricing."),
  ).toBeVisible();
  expect(opened!.headers()["cache-control"]).toBe("private, no-store");
  await customer.context().close();
});

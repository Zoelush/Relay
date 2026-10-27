import { test, expect, type Browser } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";

/**
 * SAML 2.0 single sign-on (phase 16, C4b; docs/SECURITY_STEP6.md), end to end with the stand-in
 * provider's SAML endpoints. Happy path: a manager picks SAML in Settings › Single sign-on, pastes
 * the provider's SSO URL, entity ID and certificate, sees what to give the provider (and its
 * metadata is served), verifies the domain and maps Support to Agent; Ada signs in through the
 * provider (its form posts back) and lands in a live inbox. Failure path: Sam, whose groups map to
 * nothing, and someone who cancels at the provider are each sent back with the reason.
 */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9144, hostPort: 9145, idpPort: 9146, aiAgent: false });
});
test.afterAll(async () => {
  await relay?.close();
});
async function throughProvider(browser: Browser, choice: string) {
  const page = await (await browser.newContext()).newPage();
  await page.goto(relay.hostOrigin + "/signin");
  await page.getByRole("link", { name: "Sign in with Test SAML" }).click();
  await expect(page.getByText("Choose who to sign in as (SAML).")).toBeVisible();
  await page.getByRole("link", { name: choice }).click();
  return page;
}

test("a manager connects a SAML provider; Ada signs in through it to a live inbox", async ({ browser, page, request }) => {
  await page.goto(relay.hostOrigin + "/agent#settings/sso");
  await page.getByRole("radio", { name: "SAML 2.0" }).check();
  const sp = page.getByRole("definition").filter({ hasText: "/auth/saml/" });
  await expect(sp.first()).toContainText(relay.hostOrigin + "/auth/saml/");
  const connection = page.getByRole("form", { name: "Single sign-on connection" });
  await connection.getByLabel("Name people see").fill("Test SAML");
  await connection.getByLabel("Identity provider’s SSO URL").fill(relay.idp!.saml.ssoUrl);
  await connection.getByLabel("Identity provider’s entity ID").fill(relay.idp!.saml.entityId);
  await connection.getByLabel("Signing certificate").fill(relay.idp!.saml.cert);
  await connection.getByRole("button", { name: "Save connection" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Connection saved." })).toBeVisible();
  const metadata = await request.get(relay.hostOrigin + "/auth/saml/metadata");
  expect(metadata.headers()["content-type"]).toBe("application/samlmetadata+xml");
  expect(await metadata.text()).toContain(`Location="${relay.hostOrigin}/auth/saml/acs"`);

  // The domain, the group, and on.
  const add = page.getByRole("form", { name: "Add a domain" });
  await add.getByLabel("Domain").fill("example.test");
  await add.getByRole("button", { name: "Add domain" }).click();
  const domains = page.getByRole("list", { name: "Domains" });
  const value = (await domains.locator("code").nth(1).textContent())!.trim();
  expect((await request.post(relay.apiOrigin + "/dev/dns", { data: { name: "_relay-verification.example.test", type: "TXT", value } })).ok()).toBe(true);
  await domains.getByRole("button", { name: "Check now" }).click();
  await expect
    .poll(
      async () => {
        await page.reload();
        return page.getByRole("list", { name: "Domains" }).textContent();
      },
      { timeout: 20000 },
    )
    .toContain("Verified");
  const groups = page.getByRole("form", { name: "Groups and roles" });
  await groups.getByRole("button", { name: "Add a group" }).click();
  await groups.getByRole("textbox", { name: "Group", exact: true }).fill("Support");
  await groups.getByRole("combobox", { name: "Role" }).selectOption({ label: "Agent" });
  await groups.getByRole("button", { name: "Save groups and roles" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Groups and roles saved." })).toBeVisible();
  await page.getByRole("checkbox", { name: "Offer “Sign in with Test SAML” on the sign-in page" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Single sign-on is on." })).toBeVisible();

  const ada = await throughProvider(browser, "Ada Lovelace (ada@example.test)");
  await expect(ada).toHaveURL(/\/agent$/, { timeout: 15000 });
  await expect(ada.getByRole("button", { name: /^Account: Ada Lovelace/ })).toBeVisible({ timeout: 15000 });
  await expect(ada.getByRole("status").filter({ hasText: "●" })).toHaveText("● Live", { timeout: 15000 });
});

test("SAML refusals: no mapped group, and cancelling at the provider, each come back with the reason", async ({ browser }) => {
  const sam = await throughProvider(browser, "Sam Okafor (sam@example.test)");
  await expect(sam).toHaveURL(/\/signin\?sso=SSO_NO_ROLE$/, { timeout: 15000 });
  await expect(sam.getByRole("alert")).toHaveText("Your groups don't give you access to this workspace. Ask someone who manages security.");
  const cancelled = await throughProvider(browser, "Cancel");
  await expect(cancelled).toHaveURL(/\/signin\?sso=SSO_DENIED$/, { timeout: 15000 });
  await expect(cancelled.getByRole("alert")).toHaveText("Your identity provider didn't let you sign in.");
});

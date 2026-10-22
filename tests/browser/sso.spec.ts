import { test, expect, type Browser } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { LOCAL_IDP_CLIENT } from "../../scripts/local-idp";

/**
 * Single sign-on (phase 16, C4a; docs/SECURITY_STEP5.md), end to end with the stand-in OIDC
 * provider. Happy path: a manager connects the provider in Settings › Single sign-on, verifies
 * example.test with a TXT record, maps the Support group to Agent and turns it on; Ada signs in
 * through the provider and lands in a live inbox as herself; the manager then requires it. Failure
 * path: Sam, whose groups map to nothing, is sent back with the reason and no account; cancelling
 * at the provider says so; and with SSO required, a non-owner signed in by the platform is sent to
 * sign in.
 */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9134, hostPort: 9135, idpPort: 9136, aiAgent: false });
});
test.afterAll(async () => {
  await relay?.close();
});
async function throughProvider(browser: Browser, person: string | null) {
  const page = await (await browser.newContext()).newPage();
  await page.goto(relay.hostOrigin + "/signin");
  await page.getByRole("link", { name: "Sign in with Test IdP" }).click();
  await expect(page.getByRole("heading", { name: "Test identity provider" })).toBeVisible();
  await page.getByRole("link", { name: person ?? "Cancel" }).click();
  return page;
}

test("a manager connects the provider, verifies the domain and maps a group; Ada signs in with it; then it's required", async ({ browser, page, request }) => {
  await page.goto(relay.hostOrigin + "/agent#settings/sso");
  await expect(page.getByLabel("Redirect address")).toHaveText(relay.hostOrigin + "/auth/sso/callback");
  const connection = page.getByRole("form", { name: "Single sign-on connection" });
  await connection.getByLabel("Name people see").fill("Test IdP");
  await connection.getByLabel("Issuer URL").fill(relay.idp!.origin);
  await connection.getByLabel("Client ID").fill(LOCAL_IDP_CLIENT.id);
  await connection.getByLabel("Client secret").fill(LOCAL_IDP_CLIENT.secret);
  await connection.getByRole("button", { name: "Save connection" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Connection saved." })).toBeVisible();
  await expect(connection.getByLabel("Client secret")).toHaveValue("");
  await expect(connection.getByLabel("Client secret")).toHaveAttribute("placeholder", "Saved. Leave empty to keep it.");

  // The domain: its TXT record published, then checked.
  const add = page.getByRole("form", { name: "Add a domain" });
  await add.getByLabel("Domain").fill("example.test");
  await add.getByRole("button", { name: "Add domain" }).click();
  const domains = page.getByRole("list", { name: "Domains" });
  await expect(domains).toContainText("Not verified");
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

  // The Support group signs in as Agent; then it's offered on the sign-in page.
  const groups = page.getByRole("form", { name: "Groups and roles" });
  await groups.getByRole("button", { name: "Add a group" }).click();
  await groups.getByRole("textbox", { name: "Group", exact: true }).fill("Support");
  await groups.getByRole("combobox", { name: "Role" }).selectOption({ label: "Agent" });
  await groups.getByRole("button", { name: "Save groups and roles" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Groups and roles saved." })).toBeVisible();
  const require = page.getByRole("checkbox", { name: "Require single sign-on for everyone but owners" });
  await expect(require).toBeDisabled();
  await page.getByRole("checkbox", { name: "Offer “Sign in with Test IdP” on the sign-in page" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Single sign-on is on." })).toBeVisible();

  // Ada signs in through the provider and lands in her inbox.
  const ada = await throughProvider(browser, "Ada Lovelace (ada@example.test)");
  await expect(ada).toHaveURL(/\/agent$/);
  await expect(ada.getByRole("button", { name: /^Account: Ada Lovelace/ })).toBeVisible({ timeout: 15000 });
  await expect(ada.getByRole("status").filter({ hasText: "●" })).toHaveText("● Live", { timeout: 15000 });

  // Now that it has worked once, the manager requires it.
  await page.reload();
  await expect(page.getByText(/1 person has signed in this way/)).toBeVisible();
  await require.click();
  await expect(page.getByRole("status").filter({ hasText: "Single sign-on is now required." })).toBeVisible();
  await expect(require).toBeChecked();
});

test("unmapped groups are refused with the reason and no account; cancelling says so; once required, platform sign-in is for owners", async ({ browser, page }) => {
  const sam = await throughProvider(browser, "Sam Okafor (sam@example.test)");
  await expect(sam).toHaveURL(/\/signin\?sso=SSO_NO_ROLE$/);
  await expect(sam.getByRole("alert")).toHaveText("Your groups don't give you access to this workspace. Ask someone who manages security.");
  await page.goto(relay.hostOrigin + "/agent#settings/teammates");
  await expect(page.getByRole("main")).toContainText("Ada Lovelace");
  await expect(page.getByRole("main")).not.toContainText("Sam Okafor");

  const cancelled = await throughProvider(browser, null);
  await expect(cancelled.getByRole("alert")).toHaveText("Your identity provider didn't let you sign in.");

  // Required: the sign-in page says so, and Grace (signed in by the platform, not an owner) is sent to sign in.
  await expect(cancelled.getByText("Your workspace signs in with Test IdP. Owners can still use a password below.")).toBeVisible();
  const grace = await (await browser.newContext()).newPage();
  await grace.goto(relay.hostOrigin + "/agent?as=grace");
  await expect(grace).toHaveURL(/\/signin\?next=/, { timeout: 15000 });
  // The owner, signed in the same way, keeps working (break-glass).
  await page.goto(relay.hostOrigin + "/agent");
  await expect(page.getByRole("status").filter({ hasText: "●" })).toHaveText("● Live", { timeout: 15000 });
});

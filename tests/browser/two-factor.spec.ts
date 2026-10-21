import { test, expect, type Browser, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { totp } from "../../server/totp";

/**
 * Two-factor and IP allowlists (phase 16, C3b; docs/SECURITY_STEP4.md), end to end. Happy path:
 * Ada, invited, turns on two-factor in Settings › Your sign-in (the test reads the key beside the QR
 * code, as an authenticator app would), saves her recovery codes, and signs back in with a code; the
 * manager turns on two-factor for themselves and then requires it; Lin, invited after, sets it up
 * before she reaches the inbox. Failure path: a wrong code is refused; a recovery code works once;
 * an app allowlist that leaves out the manager's own address is refused; the API's allowlist keeps
 * a token out until its address is added; and a manager turns off Ada's two-factor.
 */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9122, hostPort: 9123, aiAgent: false });
});
test.afterAll(async () => {
  await relay?.close();
});
const PASSWORD = "a long, varied passphrase";
let adaKey = "";
let adaCodes: string[] = [];
const keyOn = async (page: Page) => (await page.getByLabel("Setup key").textContent())!.replace(/\s/g, "");
/** The next code from the app: a step on from the last one used (each code works once). */
const nextCode = (key: string) => totp(key, Date.now() + 30_000);

async function invite(page: Page, email: string, name: string) {
  await page.goto(relay.hostOrigin + "/agent#settings/teammates");
  const form = page.getByRole("form", { name: "Invite a teammate" });
  await form.getByLabel("Email").fill(email);
  await form.getByLabel("Name (optional)").fill(name);
  await form.getByLabel("Role").selectOption({ label: "Agent" });
  await form.getByRole("button", { name: "Invite" }).click();
  await expect(page.getByLabel("Invitation link")).toContainText("/invite#relay_inv_", { timeout: 15000 });
  return (await page.getByLabel("Invitation link").textContent())!.trim();
}
async function join(browser: Browser, link: string, name: string) {
  const page = await (await browser.newContext()).newPage();
  await page.goto(link);
  const region = page.getByRole("region", { name: "Join a workspace" });
  await region.getByLabel("Your name").fill(name);
  await region.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await region.getByLabel("Password again").fill(PASSWORD);
  await region.getByRole("button", { name: "Join and sign in" }).click();
  return page;
}
async function signIn(page: Page, email: string) {
  await page.goto(relay.hostOrigin + "/signin");
  const signin = page.getByRole("region", { name: "Sign in" });
  await signin.getByLabel("Email").fill(email);
  await signin.getByLabel("Password").fill(PASSWORD);
  await signin.getByRole("button", { name: "Sign in" }).click();
  return page.getByRole("region", { name: "Two-factor sign-in" });
}

test("Ada turns on two-factor and signs in with a code; once required, Lin sets it up before reaching the inbox", async ({ browser, page }) => {
  const ada = await join(browser, await invite(page, "ada@example.test", "Ada"), "Ada Lovelace");
  await expect(ada.getByRole("button", { name: /^Account: Ada Lovelace/ })).toBeVisible({ timeout: 15000 });

  // Your sign-in: scan (here, the key beside the QR code), confirm a code, save the recovery codes.
  await ada.goto(relay.hostOrigin + "/agent#settings/sign-in");
  const card = ada.getByRole("region", { name: "Two-factor" });
  await card.getByRole("button", { name: "Set up two-factor" }).click();
  await expect(card.getByRole("img", { name: "QR code for your authenticator app" })).toBeVisible();
  adaKey = await keyOn(ada);
  await card.getByLabel("Code from your app").fill(await totp(adaKey));
  await card.getByRole("button", { name: "Turn on" }).click();
  const codes = card.getByRole("list", { name: "Recovery codes" });
  await expect(codes.getByRole("listitem")).toHaveCount(10);
  adaCodes = (await codes.getByRole("listitem").allTextContents()).map((c) => c.trim());
  await card.getByRole("button", { name: "I've saved them" }).click();
  await expect(card).toContainText("10 recovery codes left");

  // Signing out and back in: the password, then a code.
  await ada.goto(relay.hostOrigin + "/agent");
  await ada.getByRole("button", { name: /^Account: Ada Lovelace/ }).click();
  await ada.getByRole("button", { name: "Sign out" }).click();
  await expect(ada).toHaveURL(/\/signin$/);
  const second = await signIn(ada, "ada@example.test");
  await expect(second.getByRole("heading", { level: 1 })).toHaveText("Two-factor sign-in");
  await second.getByLabel("Code from your app").fill(await nextCode(adaKey));
  await second.getByRole("button", { name: "Sign in" }).click();
  await expect(ada).toHaveURL(/\/agent$/);
  await expect(ada.getByRole("button", { name: /^Account: Ada Lovelace/ })).toBeVisible({ timeout: 15000 });
  await expect(ada.getByRole("status").filter({ hasText: "●" })).toHaveText("● Live", { timeout: 15000 });

  // The manager can only require it once they have it: a password and two-factor of their own first.
  await page.goto(relay.hostOrigin + "/agent#settings/access");
  const require = page.getByRole("checkbox", { name: "Require two-factor for everyone who signs in with a password" });
  await expect(require).toBeDisabled();
  await expect(page.getByRole("table", { name: "Two-factor by teammate" })).toContainText("Ada Lovelace");
  await page.goto(relay.hostOrigin + "/agent#settings/sign-in");
  const password = page.getByRole("form", { name: "Set up password sign-in" });
  await password.getByLabel("Email to sign in with").fill("manager@example.test");
  await password.getByLabel("New password", { exact: true }).fill("a different, long passphrase");
  await password.getByLabel("New password again").fill("a different, long passphrase");
  await password.getByRole("button", { name: "Set password" }).click();
  const mine = page.getByRole("region", { name: "Two-factor" });
  await mine.getByRole("button", { name: "Set up two-factor" }).click();
  await mine.getByLabel("Code from your app").fill(await totp(await keyOn(page)));
  await mine.getByRole("button", { name: "Turn on" }).click();
  await mine.getByRole("button", { name: "I've saved them" }).click();
  await page.goto(relay.hostOrigin + "/agent#settings/access");
  await require.click();
  await expect(page.getByRole("status").filter({ hasText: "Two-factor is now required." })).toBeVisible();
  await expect(require).toBeChecked();

  // Lin, invited now, sets two-factor up as she joins.
  const lin = await join(browser, await invite(page, "lin@example.test", "Lin"), "Lin Chen");
  const setup = lin.getByRole("region", { name: "Two-factor sign-in" });
  await expect(setup.getByRole("heading", { level: 1 })).toHaveText("Set up two-factor");
  await setup.getByLabel("Code from your app").fill(await totp(await keyOn(lin)));
  await setup.getByRole("button", { name: "Turn on and sign in" }).click();
  await expect(setup.getByRole("list", { name: "Recovery codes" }).getByRole("listitem")).toHaveCount(10);
  await setup.getByRole("button", { name: "Continue to Relay" }).click();
  await expect(lin).toHaveURL(/\/agent$/);
  await expect(lin.getByRole("button", { name: /^Account: Lin Chen/ })).toBeVisible({ timeout: 15000 });
});

test("a wrong code is refused, a recovery code works once, allowlists can't shut out their maker, and the API's keeps a token out", async ({ browser, page, request }) => {
  const ada = await (await browser.newContext()).newPage();
  let second = await signIn(ada, "ada@example.test");
  await second.getByLabel("Code from your app").fill("000000");
  await second.getByRole("button", { name: "Sign in" }).click();
  await expect(second.getByRole("alert")).toHaveText("That code isn't right. Use the newest code from your app, or a recovery code.");
  // A recovery code instead: it works once.
  await second.getByRole("button", { name: "Use a recovery code instead" }).click();
  await second.getByLabel("Recovery code").fill(adaCodes[0]);
  await second.getByRole("button", { name: "Sign in" }).click();
  await expect(ada.getByRole("button", { name: /^Account: Ada Lovelace/ })).toBeVisible({ timeout: 15000 });
  const again = await (await browser.newContext()).newPage();
  second = await signIn(again, "ada@example.test");
  await second.getByRole("button", { name: "Use a recovery code instead" }).click();
  await second.getByLabel("Recovery code").fill(adaCodes[0]);
  await second.getByRole("button", { name: "Sign in" }).click();
  await expect(second.getByRole("alert")).toContainText("isn't right");

  // The app's allowlist can't leave out the address of whoever saves it.
  await page.goto(relay.hostOrigin + "/agent#settings/access");
  const lists = page.getByRole("form", { name: "IP allowlists" });
  await expect(lists).toContainText("Your address: 127.0.0.1");
  await lists.getByLabel("The app").fill("198.51.100.0/24");
  await lists.getByRole("button", { name: "Save allowlists" }).click();
  await expect(page.getByRole("alert")).toContainText("leaves out your own address (127.0.0.1)");

  // The API's allowlist keeps a token out until its address is listed.
  await page.goto(relay.hostOrigin + "/agent#settings/developers");
  const form = page.getByRole("region", { name: "New token" }).or(page.locator("section", { hasText: "New token" })).first();
  await form.getByLabel("Name").fill("Nightly sync");
  await form.getByRole("checkbox", { name: "conversations.read" }).check();
  await form.getByRole("button", { name: "Make token" }).click();
  await expect(page.getByLabel("Your new token")).toContainText("relay_pat_", { timeout: 15000 });
  const token = (await page.getByLabel("Your new token").textContent())!.trim();
  const me = () => request.get(relay.apiOrigin + "/rest/me", { headers: { authorization: "Bearer " + token } });
  expect((await me()).status()).toBe(200);
  await page.goto(relay.hostOrigin + "/agent#settings/access");
  await lists.getByLabel("The app").fill("");
  await lists.getByLabel("The REST API").fill("198.51.100.0/24");
  await lists.getByRole("button", { name: "Save allowlists" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Allowlists saved." })).toBeVisible();
  const refused = await me();
  expect(refused.status()).toBe(403);
  expect(((await refused.json()) as { errors: { code: string }[] }).errors[0].code).toBe("network_not_allowed");
  await lists.getByLabel("The REST API").fill("198.51.100.0/24\n127.0.0.1");
  await lists.getByRole("button", { name: "Save allowlists" }).click();
  await expect(lists.getByLabel("The REST API")).toHaveValue("127.0.0.1\n198.51.100.0/24");
  expect((await me()).status()).toBe(200);

  // Ada lost her phone: a manager turns her two-factor off, which ends her sessions.
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Turn off two-factor for Ada Lovelace" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Two-factor turned off for Ada Lovelace." })).toBeVisible();
  await expect(page.getByRole("table", { name: "Two-factor by teammate" }).getByRole("row", { name: /Ada Lovelace/ })).toContainText("Not set up");
  await ada.goto(relay.hostOrigin + "/agent#settings/sign-in");
  await expect(ada).toHaveURL(/\/signin\?next=/, { timeout: 15000 });
});

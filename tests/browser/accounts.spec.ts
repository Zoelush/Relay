import { test, expect, type Browser } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";

/**
 * Teammate accounts and sessions (phase 16, C3a; docs/SECURITY_STEP3.md), end to end: a manager
 * invites Ada in Settings › Teammates; Ada opens the link, chooses her name and password and lands
 * in the inbox; she sees this device in Settings › Your sign-in, signs out, and signs back in at
 * /signin. Failure path: a wrong password is refused without saying which part was wrong; the
 * used link can't be used again; and when a manager ends Ada's session in Security › Sessions,
 * her next step takes her back to sign-in, where a password reset the manager sends gets her back in.
 */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9112, hostPort: 9113, aiAgent: false });
});
test.afterAll(async () => {
  await relay?.close();
});
const PASSWORD = "a long, varied passphrase";
let link = "";
async function invited(browser: Browser) {
  if (link) return link;
  const page = await (await browser.newContext()).newPage();
  await page.goto(relay.hostOrigin + "/agent#settings/teammates");
  const form = page.getByRole("form", { name: "Invite a teammate" });
  await form.getByLabel("Email").fill("ada@example.test");
  await form.getByLabel("Name (optional)").fill("Ada");
  await form.getByLabel("Role").selectOption({ label: "Agent" });
  await form.getByRole("button", { name: "Invite" }).click();
  await expect(page.getByLabel("Invitation link")).toContainText("/invite#relay_inv_", { timeout: 15000 });
  link = (await page.getByLabel("Invitation link").textContent())!.trim();
  await expect(page.getByRole("list", { name: "Open invitations" })).toContainText("ada@example.test");
  return link;
}

test("invited, Ada chooses a password and lands in the inbox; she signs out and back in, and sees her device", async ({ browser }) => {
  const ada = await (await browser.newContext()).newPage();
  await ada.goto(await invited(browser));
  const join = ada.getByRole("region", { name: "Join a workspace" });
  await expect(join).toContainText("Support teammate invited ada@example.test as agent");
  await join.getByLabel("Your name").fill("Ada Lovelace");
  await join.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await join.getByLabel("Password again").fill(PASSWORD);
  await join.getByRole("button", { name: "Join and sign in" }).click();
  await expect(ada).toHaveURL(/\/agent$/);
  await expect(ada.getByRole("status").filter({ hasText: "●" })).toHaveText("● Live", { timeout: 15000 });
  await expect(ada.getByRole("button", { name: /^Account: Ada Lovelace/ })).toBeVisible();

  // Her device, in Settings › Your sign-in.
  await ada.goto(relay.hostOrigin + "/agent#settings/sign-in");
  const devices = ada.getByRole("list", { name: "Your devices" });
  await expect(devices).toContainText("This device");
  await expect(ada.getByRole("form", { name: "Change password" })).toBeVisible();

  // Signing out, then back in.
  await ada.goto(relay.hostOrigin + "/agent");
  await ada.getByRole("button", { name: /^Account: Ada Lovelace/ }).click();
  await ada.getByRole("button", { name: "Sign out" }).click();
  await expect(ada).toHaveURL(/\/signin$/);
  const signin = ada.getByRole("region", { name: "Sign in" });
  await signin.getByLabel("Email").fill("ADA@example.test");
  await signin.getByLabel("Password").fill(PASSWORD);
  await signin.getByRole("button", { name: "Sign in" }).click();
  await expect(ada).toHaveURL(/\/agent$/);
  await expect(ada.getByRole("button", { name: /^Account: Ada Lovelace/ })).toBeVisible({ timeout: 15000 });
});

test("a wrong password is refused plainly; a used link can't be reused; a session a manager ends sends Ada back to sign in", async ({ browser, page }) => {
  const ada = await (await browser.newContext()).newPage();
  await ada.goto(relay.hostOrigin + "/signin");
  const signin = ada.getByRole("region", { name: "Sign in" });
  await signin.getByLabel("Email").fill("ada@example.test");
  await signin.getByLabel("Password").fill("not the password");
  await signin.getByRole("button", { name: "Sign in" }).click();
  await expect(signin.getByRole("alert")).toHaveText("That email and password don't match an account here.");

  const reuse = await (await browser.newContext()).newPage();
  await reuse.goto(await invited(browser));
  await expect(reuse.getByRole("region", { name: "Join a workspace" }).getByRole("alert")).toHaveText("This invitation has already been used. Sign in instead.");

  await signin.getByLabel("Password").fill(PASSWORD);
  await signin.getByRole("button", { name: "Sign in" }).click();
  await expect(ada.getByRole("button", { name: /^Account: Ada Lovelace/ })).toBeVisible({ timeout: 15000 });

  // A manager ends her session; her next step goes to sign-in.
  await page.goto(relay.hostOrigin + "/agent#settings/sessions");
  const open = page.getByRole("table", { name: "Open sessions" });
  await expect(open).toContainText("Ada Lovelace");
  await open
    .getByRole("button", { name: /^End Ada Lovelace's session/ })
    .first()
    .click();
  await expect(page.getByRole("status").filter({ hasText: "Signed Ada Lovelace out" })).toBeVisible();
  await ada.goto(relay.hostOrigin + "/agent#settings/sign-in");
  await expect(ada).toHaveURL(/\/signin\?next=/, { timeout: 15000 });

  // Locked out of her password? A manager sends a reset; she chooses a new one and is back in.
  await page.goto(relay.hostOrigin + "/agent#settings/teammates");
  await page.getByRole("button", { name: "Send Ada Lovelace a password reset" }).click();
  const reset = (await page.getByLabel("Password reset link").textContent())!.trim();
  await ada.goto(reset);
  const choose = ada.getByRole("region", { name: "Join a workspace" });
  await expect(choose.getByRole("heading", { level: 1 })).toHaveText("Choose a new password");
  await choose.getByLabel("Password", { exact: true }).fill("a fresh, long passphrase");
  await choose.getByLabel("Password again").fill("a fresh, long passphrase");
  await choose.getByRole("button", { name: "Save and sign in" }).click();
  await expect(ada.getByRole("button", { name: /^Account: Ada Lovelace/ })).toBeVisible({ timeout: 15000 });
});

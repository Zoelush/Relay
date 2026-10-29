import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";

/**
 * Vendor support access (phase 16, C7b; docs/SECURITY_STEP12.md), end to end. Happy path: a manager
 * grants Relay support access for a day; Rae (on the staff list) signs in through the stand-in
 * provider, lands in the inbox under the read-only banner, can open settings but not change them;
 * the manager sees her session and revokes access, and her next request is signed out. Failure
 * path: with no grant, staff are sent back with the reason; someone off the staff list is refused;
 * an agent can't reach the page.
 */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9177, hostPort: 9178, idpPort: 9179, aiAgent: false });
});
test.afterAll(async () => {
  await relay?.close();
});
const staffSignIn = async (page: Page, person: RegExp) => {
  await page.goto(relay.hostOrigin + "/auth/support");
  await page.getByRole("navigation", { name: "People" }).getByRole("link", { name: person }).click();
};
const write = (page: Page) =>
  page.evaluate(async () => {
    const r = await fetch("/api/agent/links", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ action: "add", kind: "blocked", domain: "example.com" }),
    });
    return { status: r.status, body: (await r.json()) as { error?: { code?: string; message?: string } } };
  });

test("a manager grants Relay support read-only access, sees the staff session, and revokes it", async ({ page, browser }) => {
  await page.goto(relay.hostOrigin + "/agent#settings/support-access");
  const grant = page.getByRole("form", { name: "Grant support access" });
  await grant.getByRole("combobox", { name: "For" }).selectOption({ label: "1 day" });
  await grant.getByRole("button", { name: "Grant access" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Relay support has read-only access for 1 day." })).toBeVisible();
  await expect(page.getByLabel("Current access")).toContainText("Access is on");

  const staff = await (await browser.newContext()).newPage();
  await staffSignIn(staff, /Rae Support/);
  await expect(staff).toHaveURL(/\/agent$/);
  await expect(staff.getByRole("status").filter({ hasText: "Relay support · read-only access" })).toBeVisible({ timeout: 15000 });
  await staff.goto(relay.hostOrigin + "/agent#settings/links");
  await expect(staff.getByRole("form", { name: "Add a blocked domain" })).toBeVisible();
  const refused = await write(staff);
  expect(refused.status).toBe(403);
  expect(refused.body.error?.message).toBe("Relay support has read-only access to this workspace.");
  await expect
    .poll(async () => (await tenant(relay.db.connect, "demo", (db) => db.query("SELECT 1 FROM audit_events WHERE workspace_id='demo' AND action='support.viewed'"))).rows.length)
    .toBeGreaterThan(0);

  await page.reload();
  await expect(page.getByRole("list", { name: "Support access history" })).toContainText("rae@relay-staff.test");
  await page.getByRole("button", { name: "Revoke access" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Relay support's access was revoked" })).toBeVisible();
  await expect(page.getByRole("form", { name: "Grant support access" })).toBeVisible();
  expect(await staff.evaluate(async () => (await fetch("/api/agent/inbox", { credentials: "same-origin" })).status)).toBe(401);
});

test("without a grant, staff are turned away with the reason; someone off the staff list is refused; an agent can't reach the page", async ({ browser }) => {
  const staff = await (await browser.newContext()).newPage();
  await staff.goto(relay.hostOrigin + "/auth/support");
  await expect(staff).toHaveURL(/\/signin\?sso=SUPPORT_NOT_GRANTED$/);
  await expect(staff.getByRole("alert")).toContainText("This workspace hasn't given Relay support access.");

  await tenant(relay.db.connect, "demo", (db) =>
    db.query("INSERT INTO support_grants(workspace_id,id,granted_by,granted_by_name,expires_at) VALUES('demo',$1,'test','Test',now()+interval '1 day')", [crypto.randomUUID()]),
  );
  const outsider = await (await browser.newContext()).newPage();
  await staffSignIn(outsider, /Ada Lovelace/);
  await expect(outsider).toHaveURL(/\/signin\?sso=SUPPORT_NOT_STAFF$/);
  await expect(outsider.getByRole("alert")).toContainText("That account isn't on Relay's support staff list.");

  const grace = await (await browser.newContext()).newPage();
  await grace.goto(relay.hostOrigin + "/agent?as=grace#settings");
  await expect(grace.getByRole("navigation", { name: "Settings pages" })).toBeVisible({ timeout: 15000 });
  await expect(grace.getByRole("navigation", { name: "Settings pages" }).getByRole("button", { name: "Support access" })).toHaveCount(0);
  expect(await grace.evaluate(async () => (await fetch("/api/agent/support-access", { credentials: "same-origin" })).status)).toBe(403);
});

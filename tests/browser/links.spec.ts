import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { getIdentity } from "../../server/people";
import { command } from "../../server/conversations";

/**
 * Link safety (phase 16, C7a; docs/SECURITY_STEP11.md), end to end. Happy path: a manager blocks a
 * domain in Settings › Security › Links; a customer's message has an untrusted link, a known
 * malware link (the local stand-in flags malware.test) and a blocked one. In the inbox, the
 * untrusted link shows its address and opens; the malicious one opens only once the risk is
 * confirmed; the blocked one can't be opened. Failure path: a teammate's reply with a blocked link is
 * refused with the reason, an invalid domain is refused, and an agent can't reach the page.
 */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9175, hostPort: 9176, aiAgent: false });
  conversationId = await tenant(relay.db.connect, "demo", async (db) => {
    const who = await getIdentity(db, "demo", "anonymous", "links-visitor");
    const r = (await command(db, "demo", { type: "contact", identityId: who.identityId, brandId: "default" }, crypto.randomUUID(), {
      action: "start",
      text: "Is this real? https://untrusted.example/offer and https://prize.malware.test/claim and https://blocked.example/file",
    } as unknown as Parameters<typeof command>[4])) as { conversationId: string };
    await db.query("UPDATE conversations SET name='Suspicious links' WHERE workspace_id='demo' AND id=$1", [r.conversationId]);
    return r.conversationId;
  });
});
test.afterAll(async () => {
  await relay?.close();
});
const post = (page: Page, path: string, body: unknown) =>
  page.evaluate(
    async ({ path, body }) => {
      const r = await fetch("/api/agent/" + path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: (await r.json()) as { error?: { message?: string } } };
    },
    { path, body },
  );
let conversationId = "";

test("a manager blocks a domain; a customer's links are checked before they open", async ({ page, context }) => {
  await page.goto(relay.hostOrigin + "/agent#settings/links");
  const blocked = page.getByRole("form", { name: "Add a blocked domain" });
  await blocked.getByRole("textbox", { name: "Domain" }).fill("blocked.example");
  await blocked.getByRole("button", { name: "Block domain" }).click();
  await expect(page.getByRole("status").filter({ hasText: "blocked.example is now blocked." })).toBeVisible();
  await expect(page.getByRole("list", { name: "Blocked domains" })).toContainText("blocked.example");

  // The opened tabs never leave this machine: the customer's sites are answered here.
  await context.route(/^https:\/\/(untrusted\.example|prize\.malware\.test)\//, (route) => route.fulfill({ contentType: "text/plain", body: "A customer's site" }));
  await page.goto(relay.hostOrigin + "/agent");
  await expect(page.getByRole("status").filter({ hasText: "●" })).toHaveText("● Live");
  await page.getByRole("button", { name: /Suspicious links/ }).click();
  const messages = page.getByRole("log", { name: "Messages" });

  // Untrusted: the full address to review, then it opens in a new tab.
  await messages.getByRole("link", { name: "https://untrusted.example/offer" }).click();
  const gate = page.getByRole("dialog", { name: "Open link" });
  await expect(gate.getByRole("heading", { name: "Check this link" })).toBeVisible();
  await expect(gate).toContainText("untrusted.example");
  const [opened] = await Promise.all([context.waitForEvent("page"), gate.getByRole("button", { name: "Open link" }).click()]);
  expect(opened.url()).toContain("untrusted.example/offer");
  await opened.close();
  await expect(gate).toHaveCount(0);

  // Malicious (the reputation stand-in): the risk is confirmed before it opens.
  await expect.poll(async () => (await tenant(relay.db.connect, "demo", (db) => db.query("SELECT 1 FROM part_links WHERE workspace_id='demo' AND threat IS NOT NULL"))).rows.length, { timeout: 20000 }).toBe(1);
  await messages.getByRole("link", { name: "https://prize.malware.test/claim" }).click();
  await expect(gate.getByRole("heading", { name: "Dangerous link" })).toBeVisible();
  await expect(gate.getByRole("list", { name: "Why it was flagged" })).toContainText("known phishing or malware");
  await expect(gate.getByRole("button", { name: "Open link" })).toBeDisabled();
  await gate.getByRole("checkbox", { name: "I understand the risk and want to open it" }).check();
  const [risky] = await Promise.all([context.waitForEvent("page"), gate.getByRole("button", { name: "Open link" }).click()]);
  expect(risky.url()).toContain("prize.malware.test");
  await risky.close();
  await expect
    .poll(async () => (await tenant(relay.db.connect, "demo", (db) => db.query("SELECT 1 FROM audit_events WHERE workspace_id='demo' AND action='link.opened_despite_warning'"))).rows.length)
    .toBe(1);

  // Blocked: no way to open it.
  await messages.getByRole("link", { name: "https://blocked.example/file" }).click();
  await expect(gate.getByRole("heading", { name: "Link blocked" })).toBeVisible();
  await expect(gate.getByRole("button", { name: "Open link" })).toHaveCount(0);
  await gate.getByRole("button", { name: "Close" }).click();
});

test("a blocked link can't be sent, an invalid domain is refused, and an agent can't reach Links", async ({ page, browser }) => {
  await page.goto(relay.hostOrigin + "/agent#settings/links");
  await expect(page.getByRole("form", { name: "Add a blocked domain" })).toBeVisible();
  const sent = await post(page, "command", { action: "reply", conversationId, text: "Download it from https://cdn.blocked.example/x" });
  expect(sent.status).toBe(400);
  expect(sent.body.error?.message).toContain("Links to cdn.blocked.example are blocked in this workspace.");

  const trusted = page.getByRole("form", { name: "Add a trusted domain" });
  await trusted.getByRole("textbox", { name: "Domain" }).fill("not a domain");
  await trusted.getByRole("button", { name: "Trust domain" }).click();
  await expect(trusted.getByRole("alert")).toContainText("Enter a domain, like example.com.");

  const grace = await (await browser.newContext()).newPage();
  await grace.goto(relay.hostOrigin + "/agent?as=grace#settings");
  await expect(grace.getByRole("navigation", { name: "Settings pages" })).toBeVisible({ timeout: 15000 });
  await expect(grace.getByRole("navigation", { name: "Settings pages" }).getByRole("button", { name: "Links" })).toHaveCount(0);
  expect(await grace.evaluate(async () => (await fetch("/api/agent/links", { credentials: "same-origin" })).status)).toBe(403);
});

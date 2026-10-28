import { test, expect } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { getIdentity } from "../../server/people";
import { command } from "../../server/conversations";

/**
 * Retention (phase 16, C6a; docs/SECURITY_STEP9.md), end to end. Happy path: a manager sets
 * conversations to 30 days in Settings › Retention; before saving, the page warns that one old
 * closed conversation will be deleted; saved and run now, it's gone (a recent one stays), and the
 * last run shows what was deleted. Failure path: a period below 30 days is refused by the API with
 * the reason, and a teammate without security.manage can't reach the page or the API.
 */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
const conversations: Record<string, string> = {};
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9171, hostPort: 9172, aiAgent: false });
  for (const [who, days] of [["old", 60], ["recent", 5]] as const) {
    const id = await tenant(relay.db.connect, "demo", (x) => getIdentity(x, "demo", "user", `retention-${who}`, { name: `Retention ${who}`, email: `${who}@retention.example` }));
    const r = (await tenant(relay.db.connect, "demo", (x) =>
      command(x, "demo", { type: "contact", identityId: id.identityId, brandId: "default" }, crypto.randomUUID(), { action: "start", text: `A ${who} question` } as unknown as Parameters<typeof command>[4]),
    )) as { conversationId: string };
    conversations[who] = r.conversationId;
    await tenant(relay.db.connect, "demo", (x) => x.query("UPDATE conversations SET status='closed',updated_at=now()-make_interval(days=>$2) WHERE workspace_id='demo' AND id=$1", [r.conversationId, days]));
  }
});
test.afterAll(async () => {
  await relay?.close();
});
const exists = async (id: string) => (await tenant(relay.db.connect, "demo", (x) => x.query("SELECT 1 FROM conversations WHERE workspace_id='demo' AND id=$1", [id]))).rows.length > 0;

test("a manager shortens conversation retention, is warned what it deletes, saves and runs it", async ({ page }) => {
  await page.goto(relay.hostOrigin + "/agent#settings/retention");
  const form = page.getByRole("form", { name: "Retention policies" });
  await expect(form.getByRole("button", { name: "Save retention" })).toBeDisabled();
  await form.getByRole("combobox", { name: "Conversations" }).selectOption({ label: "30 days" });
  await expect(form.getByRole("alert")).toContainText("Saving this deletes, on the next run: Conversations: 1");
  await form.getByRole("button", { name: "Save retention" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Retention saved." })).toBeVisible();
  await expect(form.getByRole("combobox", { name: "Conversations" })).toHaveValue("30");

  await page.getByRole("button", { name: "Run now" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Running now." })).toBeVisible();
  await expect.poll(() => exists(conversations.old), { timeout: 20000 }).toBe(false);
  expect(await exists(conversations.recent)).toBe(true);
  await page.reload();
  await expect(page.getByRole("list", { name: "Deleted in the last run" })).toContainText("Conversations: 1");
});

test("a period below 30 days is refused with the reason; an agent can't reach retention", async ({ page, browser }) => {
  await page.goto(relay.hostOrigin + "/agent#settings/retention");
  await expect(page.getByRole("form", { name: "Retention policies" })).toBeVisible();
  const refused = await page.evaluate(async () => {
    const r = await fetch("/api/agent/retention", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ action: "policies", policies: { conversations: 7 } }),
    });
    return { status: r.status, body: (await r.json()) as { error?: { message?: string } } };
  });
  expect(refused.status).toBe(400);
  expect(refused.body.error?.message).toContain("30 days to 7 years");

  const grace = await (await browser.newContext()).newPage();
  await grace.goto(relay.hostOrigin + "/agent?as=grace#settings");
  await expect(grace.getByRole("navigation", { name: "Settings pages" })).toBeVisible({ timeout: 15000 });
  await expect(grace.getByRole("navigation", { name: "Settings pages" }).getByRole("button", { name: "Retention" })).toHaveCount(0);
  expect(await grace.evaluate(async () => (await fetch("/api/agent/retention", { credentials: "same-origin" })).status)).toBe(403);
});

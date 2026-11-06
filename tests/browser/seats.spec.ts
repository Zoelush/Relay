import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { getIdentity } from "../../server/people";
import { command } from "../../server/conversations";

/**
 * Seats (phase 16, C8b; docs/SECURITY_STEP15.md), end to end. Happy path: a manager gives Grace a
 * limited seat in Settings › Billing › Seats; Grace's inbox has no list and says why, but a link
 * opens a conversation, which she reads without a reply composer; back on a full seat, her list
 * returns. Failure path: the owner's seat can't be made limited (refused with the reason), and a
 * limited seat can't reach the Seats page or its API.
 */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
let conversationId = "";
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9187, hostPort: 9188, aiAgent: false });
  conversationId = await tenant(relay.db.connect, "demo", async (db) => {
    const who = await getIdentity(db, "demo", "user", "seats-ada", { name: "Seats Ada", email: "ada@seats.example" });
    const r = (await command(db, "demo", { type: "contact", identityId: who.identityId, brandId: "default" }, crypto.randomUUID(), {
      action: "start",
      text: "A question for the seats test",
    } as unknown as Parameters<typeof command>[4])) as { conversationId: string };
    return r.conversationId;
  });
});
test.afterAll(async () => {
  await relay?.close();
});
const seatSelect = (page: Page, name: string) => page.getByRole("combobox", { name: `Seat for ${name}` });

test("a manager gives Grace a limited seat: no lists, but a link opens a conversation to read; back on full, her list returns", async ({ page, browser }) => {
  await page.goto(relay.hostOrigin + "/agent#settings/seats");
  await seatSelect(page, "Grace").selectOption("limited");
  await expect(page.getByRole("status").filter({ hasText: "Grace has a limited seat." })).toBeVisible();
  await expect(page.getByRole("list", { name: "Seat summary" })).toContainText("Limited seats (free): 1");

  const grace = await (await browser.newContext()).newPage();
  await grace.goto(relay.hostOrigin + "/agent?as=grace");
  await expect(grace.getByRole("status").filter({ hasText: "Limited seat · open conversations from a link" })).toBeVisible({ timeout: 15000 });
  await expect(grace.getByRole("button", { name: /A question for the seats test/ })).toHaveCount(0);
  await grace.goto(relay.hostOrigin + `/agent?as=grace#conversation/${conversationId}`);
  await expect(grace.getByRole("log", { name: "Messages" })).toContainText("A question for the seats test", { timeout: 15000 });
  await expect(grace.getByRole("textbox", { name: "Reply message", exact: true })).toHaveCount(0);

  await page.reload();
  await seatSelect(page, "Grace").selectOption("full");
  await expect(page.getByRole("status").filter({ hasText: "Grace has a full seat." })).toBeVisible();
  await grace.goto(relay.hostOrigin + "/agent?as=grace");
  await expect(grace.getByRole("status").filter({ hasText: "Limited seat" })).toHaveCount(0);
  await expect(grace.getByRole("button", { name: /A question for the seats test/ })).toBeVisible({ timeout: 15000 });
});

test("the owner's seat can't be made limited; a limited seat can't reach the Seats page or API", async ({ page, browser }) => {
  await page.goto(relay.hostOrigin + "/agent#settings/seats");
  const owner = (await tenant(relay.db.connect, "demo", (db) => db.query<{ id: string; name: string }>("SELECT id,name FROM teammates WHERE workspace_id='demo' AND role_id='owner' LIMIT 1"))).rows[0];
  await expect(seatSelect(page, owner.name)).toBeDisabled();
  const refused = await page.evaluate(async (teammateId) => {
    const r = await fetch("/api/agent/seats", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ teammateId, seat: "limited" }),
    });
    return { status: r.status, body: (await r.json()) as { error?: { message?: string } } };
  }, owner.id);
  expect(refused.status).toBe(409);
  expect(refused.body.error?.message).toBe("The owner always has a full seat.");

  await tenant(relay.db.connect, "demo", (db) => db.query("UPDATE teammates SET seat='limited' WHERE workspace_id='demo' AND id='grace'"));
  try {
    const grace = await (await browser.newContext()).newPage();
    await grace.goto(relay.hostOrigin + "/agent?as=grace#settings");
    await expect(grace.getByRole("navigation", { name: "Settings pages" })).toBeVisible({ timeout: 15000 });
    await expect(grace.getByRole("navigation", { name: "Settings pages" }).getByRole("button", { name: "Seats" })).toHaveCount(0);
    expect(await grace.evaluate(async () => (await fetch("/api/agent/seats", { credentials: "same-origin" })).status)).toBe(403);
  } finally {
    await tenant(relay.db.connect, "demo", (db) => db.query("UPDATE teammates SET seat='full' WHERE workspace_id='demo' AND id='grace'"));
  }
});

import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";

/**
 * A customer's custom data, typed (docs/PEOPLE_STEP1.md, phase 01 P1a), end to end. Happy path:
 * a customer created through the API with their plan, seats and a yes-or-no fact, shown in the
 * inbox sidebar as typed values. Failure path: a mistyped update is refused with the attribute
 * named, and the sidebar still shows what was there.
 */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9230, hostPort: 9231, aiAgent: false });
});
test.afterAll(async () => {
  await relay?.close();
});

const ask = <T,>(page: Page, path: string, body: Record<string, unknown>) =>
  page.evaluate(
    async ([path, body]) =>
      (await (
        await fetch("/api/agent/" + path, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify(body) })
      ).json()) as T,
    [path, body] as const,
  );

test("a customer's typed attributes show in the sidebar, and a mistyped one is refused", async ({ page }) => {
  await page.goto(relay.hostOrigin + "/agent#settings/developers");
  await expect(page.locator("main")).toBeVisible({ timeout: 20000 });
  const { token } = await ask<{ token: string }>(page, "developer-token", { action: "create", name: "e2e", scopes: ["contacts.personal_data", "conversations.reply"] });
  const call = async (method: string, path: string, body: unknown) => {
    const r = await fetch(relay.apiOrigin + "/rest" + path, {
      method,
      headers: { authorization: "Bearer " + token, "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as any };
  };
  const contact = await call("POST", "/contacts", { email: "mei@example.test", name: "Mei Tanaka", custom_attributes: { plan_tier: "enterprise", seat_count: 40, trial_ended: true } });
  expect(contact.status).toBe(201);
  await call("POST", "/conversations", { contact_id: contact.body.id, body: "Can we add more seats?" });

  // Shown in the sidebar, as typed: the number as a number, the yes-or-no as Yes.
  await page.goto(relay.hostOrigin + "/agent");
  await page.getByRole("button", { name: /Can we add more seats\?/ }).first().click();
  const details = page.getByRole("complementary", { name: "Conversation details" });
  await expect(details).toContainText("plan_tier", { timeout: 20000 });
  await expect(details.locator(".pg-ctx-row", { hasText: "plan_tier" })).toContainText("enterprise");
  await expect(details.locator(".pg-ctx-row", { hasText: "seat_count" })).toContainText("40");
  await expect(details.locator(".pg-ctx-row", { hasText: "trial_ended" })).toContainText("Yes");

  // A number given as words is refused, naming the attribute; nothing changes.
  const refused = await call("PATCH", `/contacts/${contact.body.id}`, { custom_attributes: { seat_count: "forty" } });
  expect(refused.status).toBe(400);
  expect(refused.body.errors[0].field).toBe("custom_attributes.seat_count");
  await page.reload();
  await page.getByRole("button", { name: /Can we add more seats\?/ }).first().click();
  await expect(page.getByRole("complementary", { name: "Conversation details" }).locator(".pg-ctx-row", { hasText: "seat_count" })).toContainText("40", { timeout: 20000 });
});

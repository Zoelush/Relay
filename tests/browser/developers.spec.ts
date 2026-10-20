import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";

/**
 * The public API's foundation (phase 15, D1; docs/DEVELOPER_PLATFORM_STEP1.md): a teammate makes a
 * token in Settings › Developers (shown once), calls the API with it, sees the call counted, and
 * revokes it; a token without a scope is refused, and a bad request names its field.
 */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9066, hostPort: 9067, inboxViews: true, aiAgent: false });
});
test.afterAll(async () => {
  await relay?.close();
});

async function makeToken(page: Page, name: string, scopes: string[]) {
  await page.goto(relay.hostOrigin + "/agent#settings/developers");
  const form = page.getByRole("region", { name: "New token" }).or(page.locator("section", { hasText: "New token" })).first();
  await form.getByLabel("Name").fill(name);
  for (const s of scopes) await form.getByRole("checkbox", { name: s }).check();
  await form.getByRole("button", { name: "Make token" }).click();
  const shown = page.getByLabel("Your new token");
  await expect(shown).toContainText("relay_pat_", { timeout: 15000 });
  return (await shown.textContent())!.trim();
}

test("a token made in Settings calls the API, is counted, and stops working when revoked", async ({ page, request }) => {
  const token = await makeToken(page, "Order sync", ["conversations.read", "conversations.reply"]);
  const me = await request.get(relay.apiOrigin + "/rest/me", { headers: { authorization: "Bearer " + token } });
  expect(me.status()).toBe(200);
  expect((await me.json()).teammate.id).toBe("owner");
  expect(me.headers()["x-ratelimit-limit"]).toBe("600");
  const list = await request.get(relay.apiOrigin + "/rest/conversations?per_page=2", { headers: { authorization: "Bearer " + token } });
  expect(list.status()).toBe(200);
  expect((await list.json()).type).toBe("list");
  // The reference is generated from the spec, and served.
  const docs = await request.get(relay.apiOrigin + "/developers");
  expect(await docs.text()).toContain("List conversations");

  await page.reload();
  const row = page.getByRole("table", { name: "Tokens" }).getByRole("row", { name: /Order sync/ });
  await expect(row).toContainText("2 calls");
  await expect(row).not.toContainText("Never");
  await row.getByRole("button", { name: "Revoke" }).click();
  await expect(row).toContainText("Revoked");
  const after = await request.get(relay.apiOrigin + "/rest/me", { headers: { authorization: "Bearer " + token } });
  expect(after.status()).toBe(401);
  expect((await after.json()).errors[0].code).toBe("unauthorized");
});

test("a token without the scope is refused, and a bad request names its field", async ({ page, request }) => {
  const token = await makeToken(page, "Read only", ["conversations.read"]);
  const auth = { authorization: "Bearer " + token, "content-type": "application/json" };
  const list = await (await request.get(relay.apiOrigin + "/rest/conversations?per_page=1", { headers: auth })).json();
  const id = list.data[0]?.id ?? "missing";
  const reply = await request.post(relay.apiOrigin + `/rest/conversations/${id}/reply`, { headers: auth, data: { body: "Hi" } });
  expect(reply.status()).toBe(403);
  expect((await reply.json()).errors[0].code).toBe("forbidden");
  const bad = await request.get(relay.apiOrigin + "/rest/conversations?per_page=500", { headers: auth });
  expect(bad.status()).toBe(400);
  expect((await bad.json()).errors[0]).toEqual({ code: "invalid_field", message: "At most 100.", field: "per_page" });
});

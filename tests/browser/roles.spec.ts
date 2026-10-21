import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";

/**
 * Restricted roles and the permission editor (phase 16, C2; docs/SECURITY_STEP2.md), end to end:
 * a manager makes a restricted role in Settings › Roles (each permission explained, the ones a
 * restricted role can't have turned off, and a summary of what it can't do) and moves Grace to
 * it; Grace's inbox then holds only the conversation assigned to her. Another conversation can't
 * be opened by her, and a restricted role with personal data is refused with the reason.
 */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9102, hostPort: 9103, aiAgent: false });
});
test.afterAll(async () => {
  await relay?.close();
});
const sql = async <T = Record<string, unknown>>(query: string, values: unknown[] = []) => tenant(relay.db.connect, "demo", async (db) => (await db.query<T>(query, values)).rows);
async function settings(page: Page, at: string, as = "") {
  await page.goto(relay.hostOrigin + "/agent" + as + "#settings/" + at);
  await expect(page.getByRole("navigation", { name: "Settings pages" })).toBeVisible({ timeout: 15000 });
}
const ask = (page: Page, path: string, body?: unknown) =>
  page.evaluate(
    async ([path, body]) => {
      const r = await fetch("/api/agent/" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: r.status, body: (await r.json()) as any };
    },
    [path, body] as const,
  );

test("a restricted role, explained as it's made, keeps Grace to the conversation assigned to her", async ({ page, browser }) => {
  await settings(page, "roles");
  await page.getByRole("button", { name: "New role" }).click();
  const editor = page.getByRole("form", { name: "New role" });
  await editor.getByLabel("Role name").fill("Outsourced");
  // Each permission says what it means.
  await expect(editor).toContainText("Send messages customers see, on any channel.");
  await editor.getByLabel(/^Only conversations assigned to them or their teams/).check();
  await expect(editor.getByLabel(/^See customers' personal details/)).toBeDisabled();
  await expect(editor.getByLabel(/^See customers' personal details/).locator("..")).toContainText("Not for restricted roles.");
  const cannot = editor.getByRole("region", { name: "What this role can't do" });
  await expect(cannot).toContainText("Open conversations that aren't assigned to them or their teams.");
  await expect(cannot).toContainText("See customers' personal details");
  await editor.getByRole("button", { name: "Create role" }).click();
  await expect(page.locator(".pg-settings-notice")).toContainText("Saved Outsourced.");
  await expect(page.getByRole("list", { name: "Roles" })).toContainText("restricted to assigned conversations");

  await settings(page, "teammates");
  await page.getByLabel("Grace: role").selectOption({ label: "Outsourced" });
  await page.getByRole("button", { name: "Save Grace's role" }).click();
  await expect(page.locator(".pg-settings-notice")).toContainText("Grace is now");

  // Two customers write in (through the API); one conversation is Grace's, every other one the owner's.
  const { body } = await ask(page, "developer-token", { action: "create", name: "e2e", scopes: ["contacts.personal_data", "conversations.reply"] });
  const post = async (path: string, data: unknown) =>
    (await (
      await fetch(relay.apiOrigin + "/rest" + path, {
        method: "POST",
        headers: { authorization: "Bearer " + body.token, "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify(data),
      })
    ).json()) as { id: string };
  const write = async (email: string, text: string) => (await post("/conversations", { contact_id: (await post("/contacts", { email })).id, body: text })).id;
  const oursId = await write("ada@example.test", "Grace's customer needs a refund");
  await write("bob@example.test", "Someone else's customer has a question");
  await sql("UPDATE conversations SET assigned='owner',team_id=NULL WHERE id<>$1", [oursId]);
  await sql("UPDATE conversations SET assigned='grace',team_id=NULL WHERE id=$1", [oursId]);
  const [ours] = await sql<{ id: string; title: string }>("SELECT id,title FROM conversations WHERE id=$1", [oursId]);

  const grace = await (await browser.newContext()).newPage();
  await grace.goto(relay.hostOrigin + "/agent?as=grace");
  await expect(grace.getByRole("status").filter({ hasText: "●" })).toHaveText("● Live", { timeout: 15000 });
  await expect(grace.locator(".pg-card")).toHaveCount(1);
  await expect(grace.locator(".pg-card")).toContainText(ours.title);
});

test("Grace can't open a conversation that isn't hers, and a restricted role with personal data is refused", async ({ page }) => {
  await page.goto(relay.hostOrigin + "/agent?as=grace");
  await expect(page.getByRole("status").filter({ hasText: "●" })).toHaveText("● Live", { timeout: 15000 });
  const [other] = await sql<{ id: string }>("SELECT id FROM conversations WHERE assigned='owner' AND merged_into_id IS NULL LIMIT 1");
  for (const path of [`context?conversation=${other.id}&as=grace`, `history?conversation=${other.id}&as=grace`]) expect((await ask(page, path)).status).toBe(404);
  expect((await ask(page, "command?as=grace", { conversationId: other.id, action: "reply", text: "Not mine" })).status).toBe(404);

  const manager = page;
  await settings(manager, "roles");
  const role = (await sql<{ id: string }>("SELECT id FROM roles WHERE name='Outsourced'"))[0].id;
  const refused = await ask(manager, "roles", { id: role, name: "Outsourced", scope: "assigned", capabilities: ["conversations.read", "contacts.personal_data"] });
  expect(refused.status).toBe(400);
  expect(refused.body.error.message).toBe("A restricted role can't have: See customers' personal details.");
  expect(await sql("SELECT 1 FROM role_capabilities WHERE role_id=$1 AND capability='contacts.personal_data'", [role])).toHaveLength(0);
});

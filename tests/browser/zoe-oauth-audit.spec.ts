import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { BOOKINGS, CALENDAR_SECRET, recordedFetch } from "../fixtures/connectors";

/** OAuth on the workspace's behalf and one conversation's audit (phase 09, D4; docs/ACTIONS_STEP4.md). */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
const recorded = recordedFetch();
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({
    apiPort: 9026,
    hostPort: 9027,
    inboxViews: true,
    connectors: { policy: { fetch: recorded.fetch }, sleep: async () => {} },
  });
  await sql("DELETE FROM calendar_assignments");
  await sql("UPDATE brands SET settings=settings-'calendarId'-'calendarVersion'");
});
test.afterAll(async () => {
  await relay?.close();
});
const sql = <T = any>(text: string, values: unknown[] = []) =>
  tenant(relay.db.connect, "demo", async (db) => (await db.query<T>(text, values)).rows);
const call = (page: Page, path: string, body: unknown): Promise<any> =>
  page.evaluate(
    async ({ path, body }) => {
      const r = await fetch("/api/agent/" + path, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    { path, body },
  );
/** The provider's sign-in page, as the manager would see it: it sends them back with a code (or a refusal). */
async function provider(page: Page, answer: (state: string) => string) {
  await page.route("https://auth.calendar.example/authorize**", (route) => {
    const state = new URL(route.request().url()).searchParams.get("state")!;
    return route.fulfill({ status: 302, headers: { location: `${relay.hostOrigin}/agent?${answer(state)}` } });
  });
}

test("a manager connects a calendar on the workspace's behalf: refused once, then connected, with nothing left in the address", async ({ page }) => {
  await page.goto(relay.hostOrigin + "/agent#zoe/actions");
  const made = await call(page, "zoe-connector", { action: "create", name: "Bookings" });
  const id = made.connector.id;
  await call(page, "zoe-connector", { action: "save", id, version: made.connector.version, name: "Bookings", definition: BOOKINGS.definition });
  await call(page, "zoe-connector", { action: "secret", id, name: "client_secret", value: CALENDAR_SECRET });
  await page.reload();
  await page.getByRole("listitem", { name: "Bookings" }).getByRole("button", { name: "Open" }).click();
  const editor = page.getByRole("region", { name: "Connector Bookings" });
  const connection = editor.getByRole("group", { name: "Connection" });
  await expect(connection).toContainText("Not connected");
  await expect(connection).toContainText(`${relay.hostOrigin}/agent`);

  // The manager says no at the provider: told so, still not connected.
  await provider(page, (state) => `error=access_denied&state=${state}`);
  await connection.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByRole("alert")).toHaveText("The service didn't connect (access_denied).");
  expect(new URL(page.url()).search).toBe("");

  // Then yes: connected, by them, and the code never stays in the address.
  await page.unroute("https://auth.calendar.example/authorize**");
  await provider(page, (state) => `code=good-code&state=${state}`);
  await page.getByRole("listitem", { name: "Bookings" }).getByRole("button", { name: "Open" }).click();
  await editor.getByRole("group", { name: "Connection" }).getByRole("button", { name: "Connect" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Connected." })).toBeVisible({ timeout: 15000 });
  await expect(editor.getByRole("group", { name: "Connection" })).toContainText("Connected by Support teammate", { timeout: 15000 });
  expect(new URL(page.url()).search).toBe("");
  expect(new URL(page.url()).hash).toBe("#zoe/actions");
  const exchange = recorded.sent.find((s) => s.url === "https://auth.calendar.example/oauth/token" && s.body?.includes("good-code"))!;
  expect(exchange.body).toMatch(/code_verifier=[A-Za-z0-9_-]{43}/);
});

test("Zoe looks up a signed-in customer's booking; the conversation's audit shows what she did, readably, with what was sent kept to those allowed", async ({
  page,
  browser,
}) => {
  await page.goto(relay.hostOrigin + "/agent#zoe/actions");
  const list: { connectors: { id: string; name: string }[] } = await page.evaluate(async () => (await fetch("/api/agent/zoe?view=connectors")).json());
  const id = list.connectors.find((c) => c.name === "Bookings")!.id;
  const c: { connector: { version: string } } = await page.evaluate(async (id) => (await fetch(`/api/agent/zoe?view=connector&id=${id}`)).json(), id);
  await call(page, "zoe-connector", { action: "publish", id, version: c.connector.version });
  const p = await call(page, "zoe-procedure", { action: "create", name: "My booking" });
  const saved = await call(page, "zoe-procedure", {
    action: "save",
    id: p.procedure.id,
    version: p.procedure.version,
    name: "My booking",
    source: { description: "", keywords: ["my booking"], inputs: [], steps: '1. Look up Bookings.\n2. Say "Your next booking is {{next_booking}}."\n3. Resolve.', onFailure: "" },
  });
  await call(page, "zoe-procedure", { action: "publish", id: p.procedure.id, version: saved.procedure.version });

  const customer = await (await browser.newContext()).newPage();
  await customer.goto(relay.hostOrigin + "/?user=jo");
  await customer.getByRole("button", { name: "Open support", exact: true }).click();
  await expect.poll(() => customer.frames().some((f) => f.url().includes("/messenger/frame.html"))).toBe(true);
  const frame = customer.frames().find((f) => f.url().includes("/messenger/frame.html"))!;
  await frame.getByRole("button", { name: "Start a conversation" }).click();
  await frame.getByRole("textbox", { name: "Write your message" }).fill("When is my booking?");
  await frame.getByRole("button", { name: "Send message" }).click();
  await expect(frame.getByText("Your next booking is Tuesday 14 October, 10:00.")).toBeVisible({ timeout: 20000 });

  // The audit, beside the conversation.
  await page.goto(relay.hostOrigin + "/agent");
  await page.locator(".pg-card", { hasText: "When is my booking?" }).click();
  const audit = page.getByRole("list", { name: "Zoe's actions" });
  await expect(audit.getByRole("listitem")).toHaveCount(2);
  await expect(audit.getByRole("listitem").nth(0)).toContainText("Procedure “My booking” (version 1): resolved.");
  await expect(audit.getByRole("listitem").nth(1)).toContainText("Zoe looked up Bookings (version 1): worked (200)");
  await audit.getByText("What was sent and returned").click();
  await expect(audit).toContainText('Sent: {"email":"[redacted]"}');
  await expect(audit).toContainText('Got: {"next_booking":"Tuesday 14 October, 10:00"}');
  await expect(audit).not.toContainText("jo@example.test");
  // The same log as text, for keeping.
  const [conv] = await sql<{ id: string }>("SELECT conversation_id AS id FROM ai_procedure_runs ORDER BY started_at DESC LIMIT 1");
  const log = await page.evaluate(
    async (id) => ((await (await fetch(`/api/agent/ai-audit?conversation=${id}`)).json()) as { text: string }).text,
    conv.id,
  );
  expect(log).toMatch(/Zoe called Bookings \(version 1\): ok \(200\)/);
  expect(log).not.toContain("jo@example.test");
});

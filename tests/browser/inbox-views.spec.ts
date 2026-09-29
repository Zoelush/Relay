import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";

let relay: Awaited<ReturnType<typeof startLocalRelay>>;
const sql = <T = any>(text: string, values: unknown[] = []) =>
  tenant(
    relay.db.connect,
    "demo",
    async (db) => (await db.query<T>(text, values)).rows,
  );
const openCount = async () =>
  Number(
    (
      await sql(
        "SELECT count(*) FROM conversations WHERE workspace_id='demo' AND status='open' AND merged_into_id IS NULL",
      )
    )[0].count,
  );
const viewButton = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Inbox views" }).getByRole("button", {
    name: new RegExp("^" + name.replace(/[()]/g, "\\$&")),
  });

test.beforeAll(async () => {
  relay = await startLocalRelay({
    apiPort: 8900,
    hostPort: 8901,
    inboxViews: true,
  });
  // Enough open conversations for the list to span more than one 100-row page.
  await sql(
    "INSERT INTO conversations(workspace_id,id,brand_id,token_hash,name,email,title,status,assigned,created_at,updated_at) SELECT 'demo','views-e2e-'||lpad(i::text,3,'0'),'default','','Customer','','Views fixture '||i,'open','',now()-(i||' minutes')::interval,now() FROM generate_series(1,150) i",
  );
});
test.afterAll(async () => {
  await relay?.close();
});

test("default views load with live counts, a new view saves and pages through every row", async ({
  page,
}) => {
  await page.goto(relay.hostOrigin + "/agent");
  await expect(page.getByRole("status")).toHaveText("● Live");
  // The local seed initialises the owner's default views and one shared view.
  await expect(viewButton(page, "Open priority (shared)")).toBeVisible({
    timeout: 15000,
  });
  const expected = await openCount();
  await expect(viewButton(page, "All open")).toContainText(String(expected), {
    timeout: 15000,
  });
  for (const name of ["Mine", "Unassigned", "Snoozed", "Closed"])
    await expect(viewButton(page, name)).toBeVisible();

  // A custom view with the same filter as "All open" reuses its list: ready at once.
  await page.getByRole("button", { name: "Create view" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit inbox view" });
  await dialog.getByLabel("Name").fill("Everything open");
  await dialog.getByRole("button", { name: "Save view" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(viewButton(page, "Everything open")).toContainText(
    String(expected),
  );

  // Every row is reachable by scrolling; paging stops when the server has no cursor.
  await viewButton(page, "Everything open").click();
  const list = page.getByTestId("virtual-conversations");
  await expect(list.getByRole("button").first()).toBeVisible();
  // Rows are virtualised; the list's full height is rows loaded × 86px row height.
  const more = list.getByRole("button", { name: "Load more conversations" });
  for (let i = 0; i < 20 && (await more.count()); i++) {
    await list.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await page.waitForTimeout(200);
  }
  await expect(more).toHaveCount(0);
  const loaded = await list.evaluate(
    (el) => (el.firstElementChild as HTMLElement).offsetHeight / 86,
  );
  expect(loaded).toBe(expected);
  expect(await list.getByRole("button").count()).toBeLessThan(40);

  // Counts update live, without a refresh, when a conversation closes.
  await sql(
    "UPDATE conversations SET status='closed' WHERE workspace_id='demo' AND id='views-e2e-001'",
  );
  await expect(viewButton(page, "All open")).toContainText(
    String(expected - 1),
    { timeout: 15000 },
  );
  await expect(viewButton(page, "Everything open")).toContainText(
    String(expected - 1),
  );
});

test("a rejected view save removes the optimistic view and shows the error", async ({
  page,
}) => {
  await page.goto(relay.hostOrigin + "/agent");
  await expect(page.getByRole("status")).toHaveText("● Live");
  await expect(viewButton(page, "All open")).toBeVisible({ timeout: 15000 });
  // Hold the rejection until the optimistic view has been seen.
  let release!: () => void;
  const answer = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/agent/views", async (route) => {
    if (
      route.request().method() === "POST" &&
      route.request().postDataJSON().action === "save"
    ) {
      await answer;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "VIEW_CONFLICT",
            message: "The view was rejected for this test.",
          },
        }),
      });
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Create view" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit inbox view" });
  await dialog.getByLabel("Name").fill("Rejected view");
  await dialog.getByRole("button", { name: "Save view" }).click();
  // Optimistic: shown before the server answers, then removed on rejection.
  await expect(viewButton(page, "Rejected view")).toBeVisible();
  release();
  await expect(page.locator(".pg-views").getByRole("alert")).toContainText(
    "The view was rejected for this test.",
  );
  await expect(viewButton(page, "Rejected view")).toHaveCount(0);
  expect(
    await sql("SELECT id FROM inbox_views WHERE name='Rejected view'"),
  ).toHaveLength(0);
});

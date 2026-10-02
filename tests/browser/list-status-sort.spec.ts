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
test.use({ viewport: { width: 1440, height: 900 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({
    apiPort: 8954,
    hostPort: 8955,
    inboxViews: true,
  });
  // Conversations in each status, a priority one, and a ticket waiting on the customer.
  await sql(
    `INSERT INTO conversations(workspace_id,id,brand_id,token_hash,name,email,title,status,assigned,created_at,updated_at,priority,last_contact_reply_at,snooze_until)
    VALUES
    ('demo','ls-1','default','','Customer','','Quiet open one','open','',now()-interval '5 hours',now(),false,now()-interval '4 hours',NULL),
    ('demo','ls-2','default','','Customer','','Urgent refund','open','',now()-interval '6 hours',now(),true,now()-interval '5 hours',NULL),
    ('demo','ls-3','default','','Customer','','Busy open one','open','',now()-interval '3 hours',now(),false,now()-interval '1 minute',NULL),
    ('demo','ls-4','default','','Customer','','Snoozed till tomorrow','snoozed','',now()-interval '2 hours',now(),false,NULL,now()+interval '1 day'),
    ('demo','ls-5','default','','Customer','','Already closed','closed','',now()-interval '2 hours',now(),false,NULL,NULL)`,
  );
  await sql(
    "INSERT INTO ticket_types(workspace_id,id,name,category) VALUES('demo','ls-bug','List bug','customer') ON CONFLICT DO NOTHING",
  );
  await sql(
    "INSERT INTO ticket_states(workspace_id,id,type_id,name,customer_label,kind,position) VALUES('demo','ls-waiting','ls-bug','Waiting','Waiting on you','waiting_on_customer',0) ON CONFLICT DO NOTHING",
  );
  await sql(
    "INSERT INTO tickets(workspace_id,conversation_id,number,type_id,state_id,created_by) VALUES('demo','ls-1',99001,'ls-bug','ls-waiting','owner')",
  );
});
test.afterAll(async () => {
  await relay?.close();
});

const list = (page: Page) => page.getByTestId("virtual-conversations");
const titles = (page: Page) =>
  list(page)
    .locator(".pg-row-title")
    .allInnerTexts()
    .then((t) => t.filter((x) => x !== "Conversation"));
async function open(page: Page) {
  await page.goto(relay.hostOrigin + "/agent");
  await expect(page.getByRole("status")).toHaveText("● Live");
  const all = page
    .getByRole("navigation", { name: "Inbox views" })
    .getByRole("button", { name: /^All/ });
  await expect(all).toBeVisible({ timeout: 15000 });
  await all.click();
}
const statusButton = (page: Page) =>
  page.getByRole("button", { name: /^Status:/ });
const count = async (where: string) =>
  (
    await sql(
      `SELECT count(*)::int AS n FROM conversations WHERE merged_into_id IS NULL AND ${where}`,
    )
  )[0].n;

test("pick a status, including a ticket state, and sort the list: searchable, reversible, by keyboard", async ({
  page,
}) => {
  await open(page);
  const openCount = await count("status='open'");
  // Open by default, with its count on the button.
  await expect(statusButton(page)).toContainText(`${openCount} Open`, {
    timeout: 15000,
  });
  await statusButton(page).click();
  const menu = page.getByRole("menu", { name: "Status" });
  await expect(menu.getByRole("menuitemradio")).toHaveCount(7);
  await expect(
    menu.getByRole("menuitemradio", { name: /^Open/ }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    menu.getByRole("menuitemradio", { name: /Snoozed/ }),
  ).toContainText(String(await count("status='snoozed'")));
  await menu.getByRole("menuitemradio", { name: /Snoozed/ }).click();
  await expect(menu).toBeHidden();
  await expect(statusButton(page)).toContainText("Snoozed");
  await expect.poll(() => titles(page)).toContain("Snoozed till tomorrow");
  expect(await titles(page)).not.toContain("Urgent refund");

  // A ticket state lists tickets in it, whatever the conversation's own status.
  await statusButton(page).click();
  await menu
    .getByRole("menuitemradio", { name: /Waiting on customer/ })
    .click();
  await expect.poll(() => titles(page)).toEqual(["Quiet open one"]);

  // By keyboard: open with the down arrow, move, pick with Enter; focus returns to the button.
  await statusButton(page).focus();
  await page.keyboard.press("ArrowDown");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  await expect(statusButton(page)).toContainText("Open");
  await expect(statusButton(page)).toBeFocused();

  // Last activity first by default: the open conversation with the latest reply leads.
  const sortButton = page.getByRole("button", { name: /^Sort:/ });
  await expect(sortButton).toHaveAccessibleName("Sort: Last activity");
  await expect.poll(async () => (await titles(page))[0]).toBe("Busy open one");
  // The sort menu is searchable; Enter picks the first match.
  await sortButton.click();
  const sorts = page.getByRole("menu", { name: "Sort by" });
  await sorts.getByLabel("Search sort by").fill("prio");
  await expect(sorts.getByRole("menuitemradio")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(sortButton).toHaveAccessibleName("Sort: Priority");
  await expect.poll(async () => (await titles(page))[0]).toBe("Urgent refund");
  // The direction button reverses it.
  await page.getByRole("button", { name: /^Descending order/ }).click();
  await expect(
    page.getByRole("button", { name: /^Ascending order/ }),
  ).toBeVisible();
  await expect
    .poll(async () => (await titles(page)).at(-1))
    .toBe("Urgent refund");
});

test("a view still being prepared says so, and its counts wait", async ({
  page,
}) => {
  // As if the view's list were still being built (a new view, or after a rebuild).
  const sets = await sql<{ id: string }>(
    "SELECT s.id FROM inbox_filter_sets s JOIN inbox_views v ON v.workspace_id=s.workspace_id AND v.set_id=s.id WHERE v.builtin='all'",
  );
  await sql(
    "UPDATE inbox_filter_sets SET ready=false WHERE id=ANY($1::text[])",
    [sets.map((s) => s.id)],
  );
  try {
    await open(page);
    await expect(statusButton(page)).toContainText("… Open");
    await expect(
      page.getByText(
        "This view is being prepared. Its conversations and counts appear in a moment.",
      ),
    ).toBeVisible();
    await statusButton(page).click();
    await expect(
      page
        .getByRole("menu", { name: "Status" })
        .getByRole("menuitemradio", { name: /Closed/ }),
    ).toContainText("…");
  } finally {
    await sql(
      "UPDATE inbox_filter_sets SET ready=true WHERE id=ANY($1::text[])",
      [sets.map((s) => s.id)],
    );
  }
});

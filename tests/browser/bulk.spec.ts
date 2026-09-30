import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { getIdentity } from "../../server/people";
import { command } from "../../server/conversations";

let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 900 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({
    apiPort: 8926,
    hostPort: 8927,
    inboxViews: true,
  });
  await tenant(relay.db.connect, "demo", async (db) => {
    const identity = await getIdentity(
      db,
      "demo",
      "anonymous",
      "bulk-customer",
    );
    for (const text of ["Bulk one", "Bulk two", "Bulk three"])
      await command(
        db,
        "demo",
        {
          type: "contact",
          identityId: identity.identityId,
          brandId: "default",
        },
        "bulk-" + text,
        { action: "start", text },
      );
  });
});
test.afterAll(async () => {
  await relay?.close();
});
const sql = <T = any>(query: string, values: unknown[] = []) =>
  tenant(
    relay.db.connect,
    "demo",
    async (db) => (await db.query<T>(query, values)).rows,
  );
async function open(page: Page, as = "") {
  await page.goto(relay.hostOrigin + "/agent" + as);
  await expect(page.getByRole("status").filter({ hasText: "●" })).toHaveText(
    "● Live",
  );
}
const check = (page: Page, title: string) =>
  page.getByRole("checkbox", { name: new RegExp(": " + title + "$") });
const bar = (page: Page) => page.getByRole("region", { name: "Bulk actions" });
const progress = (page: Page) =>
  page.getByRole("status", { name: "Bulk progress" });
const tagged = async () =>
  (
    await sql<{ title: string }>(
      "SELECT c.title FROM conversation_tags t JOIN conversations c ON c.workspace_id=t.workspace_id AND c.id=t.conversation_id WHERE t.tag_id='vip' AND c.title LIKE 'Bulk %' ORDER BY c.title",
    )
  ).map((r) => r.title);

test("bulk tag with Shift-click, the server's count confirmed, then undone within ten seconds", async ({
  page,
}) => {
  await open(page);
  // Shift-click from the first of the three rows to the last checks every row between.
  await expect(check(page, "Bulk one")).toBeVisible();
  const order = (
    await page
      .getByRole("checkbox")
      .evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""))
  )
    .map((label) => label.replace(/^Select .*?: /, ""))
    .filter((title) => title.startsWith("Bulk "));
  expect(order).toHaveLength(3);
  await check(page, order[0]).click();
  await check(page, order[2]).click({ modifiers: ["Shift"] });
  await expect(check(page, order[1])).toBeChecked();
  await expect(bar(page).getByText("3 selected")).toBeVisible();

  await bar(page).getByLabel("Add tag").selectOption({ label: "VIP" });
  const dialog = page.getByRole("alertdialog", { name: "Confirm bulk action" });
  await expect(dialog).toContainText("Add tag “VIP” to 3 conversations?");
  await dialog
    .getByRole("button", { name: "Apply to 3 conversations" })
    .click();
  await expect(progress(page)).toContainText(
    "Add tag “VIP” to 3 conversations.",
  );
  expect(await tagged()).toEqual(["Bulk one", "Bulk three", "Bulk two"]);
  // The selection is cleared once the job starts.
  await expect(check(page, "Bulk two")).not.toBeChecked();

  await progress(page)
    .getByRole("button", { name: /^Undo \(\d+s\)$/ })
    .click();
  await expect(progress(page)).toContainText(
    "Undone: 3 conversations restored.",
  );
  await expect.poll(tagged).toEqual([]);
});

test("select all in view closes everything; undo leaves a conversation reopened since alone", async ({
  page,
}) => {
  await open(page);
  // X checks the open conversation's row.
  await page
    .getByRole("button", { name: /Bulk two/ })
    .first()
    .click();
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("x");
  await expect(check(page, "Bulk two")).toBeChecked();

  const openCount = Number(
    (
      await sql(
        "SELECT count(*)::int AS n FROM conversations WHERE status='open' AND merged_into_id IS NULL",
      )
    )[0].n,
  );
  await page
    .getByRole("button", { name: /^Select all .* in this view$/ })
    .click();
  await bar(page).getByRole("button", { name: "Close" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Confirm bulk action" });
  await expect(dialog).toContainText(`Close ${openCount} conversations?`);
  await dialog.getByRole("button", { name: /^Apply to/ }).click();
  await expect(progress(page)).toContainText(
    `Close ${openCount} conversations.`,
  );

  // Someone reopens one before the undo.
  await tenant(relay.db.connect, "demo", async (db) => {
    const [row] = (
      await db.query<{ id: string }>(
        "SELECT id FROM conversations WHERE title='Bulk one'",
      )
    ).rows;
    await command(
      db,
      "demo",
      { type: "teammate", principal: "local-grace" },
      "reopen-bulk-one",
      {
        action: "reopen",
        conversationId: row.id,
      },
    );
    await command(
      db,
      "demo",
      { type: "teammate", principal: "local-grace" },
      "snooze-bulk-one",
      {
        action: "snooze",
        preset: "tomorrow",
        timezone: "UTC",
        conversationId: row.id,
      },
    );
  });
  await progress(page).getByRole("button", { name: /^Undo/ }).click();
  await expect(progress(page)).toContainText(
    `Undone: ${openCount - 1} conversations restored. 1 conversation changed since and left alone.`,
  );
  await expect(
    progress(page).getByRole("list", { name: "Left alone" }),
  ).toHaveText("Bulk one");
  const statuses = await sql<{ title: string; status: string }>(
    "SELECT title,status FROM conversations WHERE title LIKE 'Bulk %' ORDER BY title",
  );
  expect(statuses).toEqual([
    { title: "Bulk one", status: "snoozed" },
    { title: "Bulk three", status: "open" },
    { title: "Bulk two", status: "open" },
  ]);
});

test("failures are reported per conversation, and undo after the window is refused", async ({
  page,
}) => {
  // Grace's role cannot assign conversations: each one fails and is reported.
  await open(page, "?as=grace");
  // Grace's views are built on her first visit; the list is loaded again once they are ready
  // (a known gap from step B: the first page is not refetched when a view becomes ready).
  await expect(page.locator(".pg-views nav")).not.toContainText("Updating…");
  await page.reload();
  await check(page, "Bulk two").click();
  await check(page, "Bulk three").click();
  await bar(page).getByLabel("Assign").selectOption({ label: "Support teammate" });
  await page
    .getByRole("alertdialog", { name: "Confirm bulk action" })
    .getByRole("button", { name: "Apply to 2 conversations" })
    .click();
  await expect(progress(page)).toContainText(
    "2 conversations could not be changed.",
  );

  // After the ten seconds, the server refuses the undo even if the button is still shown.
  await check(page, "Bulk two").click();
  await bar(page)
    .getByLabel("Priority")
    .selectOption({ label: "Mark as priority" });
  await page
    .getByRole("alertdialog", { name: "Confirm bulk action" })
    .getByRole("button", { name: "Apply to 1 conversation" })
    .click();
  await expect(progress(page)).toContainText(
    "Mark as priority 1 conversation.",
  );
  await sql(
    "UPDATE bulk_operations SET undo_until=now()-interval '1 second' WHERE action->>'type'='priority'",
  );
  await progress(page).getByRole("button", { name: /^Undo/ }).click();
  await expect(bar(page).getByRole("alert")).toContainText(
    "The undo window for this bulk action has passed.",
  );
  expect(
    (await sql("SELECT priority FROM conversations WHERE title='Bulk two'"))[0]
      .priority,
  ).toBe(true);
});

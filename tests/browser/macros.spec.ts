import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { getIdentity } from "../../server/people";
import { command } from "../../server/conversations";

let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 8920, hostPort: 8921 });
});
test.afterAll(async () => {
  await relay?.close();
});
const sql = (text: string, values: unknown[] = []) =>
  tenant(
    relay.db.connect,
    "demo",
    async (db) => (await db.query(text, values)).rows,
  );
async function start(title: string, name: string) {
  const id = await tenant(relay.db.connect, "demo", async (db) => {
    const identity = await getIdentity(db, "demo", "anonymous", title);
    return (
      (await command(
        db,
        "demo",
        {
          type: "contact",
          identityId: identity.identityId,
          brandId: "default",
        },
        title + "-start",
        { action: "start", text: title },
      )) as { conversationId: string }
    ).conversationId;
  });
  await sql(
    "UPDATE conversations SET name=$2 WHERE workspace_id='demo' AND id=$1",
    [id, name],
  );
  return id;
}
async function openConversation(page: Page, row: RegExp) {
  await page.goto(relay.hostOrigin + "/agent");
  await expect(page.getByRole("status").filter({ hasText: "●" })).toHaveText(
    "● Live",
  );
  await page.getByRole("button", { name: row }).click();
}
const reply = (page: Page) =>
  page.getByRole("textbox", { name: "Reply message", exact: true });

test("a shared macro with a variable and two actions is created, applied from the keyboard and sent", async ({
  page,
}) => {
  const id = await start("Macro fixture", "Jo Bloggs");
  await openConversation(page, /Macro fixture/);

  // Create the macro in the manager (opened from the palette).
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("manage macros");
  await page.keyboard.press("Enter");
  const manager = page.getByRole("dialog", { name: "Macros" });
  await manager.getByRole("button", { name: "New macro" }).click();
  await manager.getByLabel("Name").fill("Refund with priority");
  await manager.getByLabel("Shared with the workspace").check();
  await manager.getByRole("textbox", { name: "Macro text" }).click();
  await page.keyboard.type("Hi ");
  await manager
    .getByLabel("Variable")
    .selectOption({ label: "Customer first name" });
  await manager.getByRole("button", { name: "Insert variable" }).click();
  await page.keyboard.type(", this is sorted.");
  await expect(manager.locator(".rich-variable")).toHaveText(
    "{Customer first name}",
  );
  // Escape inside the macro text leaves the editor but keeps the dialog and the text.
  await page.keyboard.press("Escape");
  await expect(
    manager.getByRole("textbox", { name: "Macro text" }),
  ).toContainText("this is sorted.");
  await manager.getByRole("button", { name: "Add action" }).click();
  await manager.getByLabel("Action 1 tag").selectOption({ label: "VIP" });
  await manager.getByRole("button", { name: "Add action" }).click();
  await manager.getByLabel("Action 2 type").selectOption({ label: "Priority" });
  await manager.getByRole("button", { name: "Save macro" }).click();
  await expect(manager.getByText("Refund with priority")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(manager).toHaveCount(0);

  // Apply with M: the actions run at once; the filled text waits in the composer.
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("m");
  const picker = page.getByRole("dialog", { name: "Apply a macro" });
  await expect(
    picker.getByRole("combobox", { name: "Search macros" }),
  ).toBeFocused();
  await page.keyboard.type("priority");
  await page.keyboard.press("Enter");
  await expect(page.locator(".pg-macro-notice")).toHaveText(
    "Applied “Refund with priority” · 2 actions · review the text, then send",
  );
  await expect(page.getByTestId("conversation-state")).toContainText(
    "priority",
  );
  await expect(reply(page)).toHaveText("Hi Jo, this is sorted.");
  expect(
    await sql(
      "SELECT tag_id FROM conversation_tags WHERE workspace_id='demo' AND conversation_id=$1",
      [id],
    ),
  ).toEqual([{ tag_id: "vip" }]);

  await reply(page).click();
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(
    page
      .locator("[data-part-id]")
      .filter({ hasText: "Hi Jo, this is sorted." }),
  ).toHaveCount(1);
});

test("a macro whose assignee was removed is refused whole, with the error shown and nothing changed", async ({
  page,
}) => {
  const id = await start("Broken macro fixture", "Sam");
  await sql(
    "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('demo','temp','local-temp','Temporary','agent') ON CONFLICT DO NOTHING",
  );
  await sql(
    `INSERT INTO macros(workspace_id,id,owner_id,shared,name,mode,body,actions) VALUES
    ('demo','hand-to-temp','owner',true,'Hand to Temporary','note',NULL,$1) ON CONFLICT DO NOTHING`,
    [
      JSON.stringify([
        { type: "tag_add", tagId: "vip" },
        { type: "assign", teammateId: "temp" },
      ]),
    ],
  );
  await sql("DELETE FROM inbox_counters WHERE teammate_id='temp'");
  await sql("DELETE FROM conversation_unread WHERE teammate_id='temp'");
  await sql("DELETE FROM teammates WHERE workspace_id='demo' AND id='temp'");

  await openConversation(page, /Broken macro fixture/);
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("hand to temporary");
  await page.keyboard.press("Enter");
  await expect(page.locator(".pg-error")).toContainText(
    "Something this macro uses no longer exists",
  );
  await expect(page.locator(".pg-macro-notice")).toHaveCount(0);
  await expect(page.getByTestId("conversation-state")).toHaveText("open");
  expect(
    await sql(
      "SELECT tag_id FROM conversation_tags WHERE workspace_id='demo' AND conversation_id=$1",
      [id],
    ),
  ).toEqual([]);
});

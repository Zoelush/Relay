import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { getIdentity } from "../../server/people";
import { command } from "../../server/conversations";

let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 900 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 8928, hostPort: 8929 });
  await tenant(relay.db.connect, "demo", async (db) => {
    const identity = await getIdentity(
      db,
      "demo",
      "anonymous",
      "ticket-customer",
    );
    for (const text of [
      "App crashes on save",
      "Charged twice",
      "Export is slow",
    ])
      await command(
        db,
        "demo",
        {
          type: "contact",
          identityId: identity.identityId,
          brandId: "default",
        },
        "ticket-" + text,
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
async function open(page: Page, title: string) {
  await page.goto(relay.hostOrigin + "/agent");
  await expect(page.getByRole("status").filter({ hasText: "●" })).toHaveText(
    "● Live",
  );
  await page
    .getByRole("button", { name: new RegExp(title) })
    .first()
    .click();
  await expect(
    page
      .getByRole("region", { name: "Conversation timeline" })
      .getByRole("heading", { name: title }),
  ).toBeVisible();
}
const panel = (page: Page) =>
  page
    .getByRole("complementary", { name: "Conversation details" })
    .getByRole("region", { name: "Ticket" });
const timeline = (page: Page) => page.getByRole("log", { name: "Messages" });
/** Consecutive events fold into "Show N updates"; open the latest run to read them. */
async function expandUpdates(page: Page) {
  const run = timeline(page).getByRole("button", { name: /^Show \d+ updates$/ }).last();
  if (await run.count()) await run.click();
}
async function convert(page: Page, type: string) {
  await panel(page).getByRole("button", { name: "Convert to ticket" }).click();
  const form = panel(page).getByRole("group", { name: "Convert to ticket" });
  await form.getByLabel("Ticket type").selectOption({ label: type });
  await form.getByRole("button", { name: "Convert" }).click();
}

test("a conversation becomes a ticket, moves along its states, and resolves once required fields are filled", async ({
  page,
}) => {
  await open(page, "App crashes on save");
  await convert(page, "Bug report");
  await expect(panel(page).getByTestId("ticket-state")).toHaveText("New");
  await expect(panel(page)).toContainText("#1 · Bug report");
  await expect(
    timeline(page).getByText(/converted this to Bug report ticket #1 \(New\)/),
  ).toBeVisible();

  // Only the type's next states are offered.
  const moveTo = panel(page).getByLabel("Move to");
  await expect(moveTo.locator("option")).toHaveText([
    "Choose a state…",
    "Investigating",
  ]);
  await moveTo.selectOption({ label: "Investigating" });
  await expect(panel(page).getByTestId("ticket-state")).toHaveText(
    "Investigating",
  );

  // Resolving without the required field is refused with the field named.
  await panel(page).getByLabel("Move to").selectOption({ label: "Fixed" });
  await expect(panel(page).getByRole("alert")).toHaveText(
    "Fill in Severity before closing this ticket.",
  );
  await expect(panel(page).getByTestId("ticket-state")).toHaveText(
    "Investigating",
  );
  await expect(panel(page).getByText("· Required to close")).toBeVisible();

  await panel(page).getByRole("checkbox", { name: "High" }).check();
  await expect
    .poll(
      async () =>
        (
          await sql(
            "SELECT attributes FROM conversations WHERE title='App crashes on save'",
          )
        )[0].attributes.severity,
    )
    .toEqual(["High"]);
  await panel(page).getByLabel("Move to").selectOption({ label: "Fixed" });
  await expect(panel(page).getByTestId("ticket-state")).toHaveText("Fixed");
  await expandUpdates(page);
  await expect(
    timeline(page).getByText("moved the ticket to Fixed"),
  ).toBeVisible();
});

test("changing a ticket's type warns what will be cleared and moves a field when asked", async ({
  page,
}) => {
  await open(page, "Charged twice");
  await convert(page, "Bug report");
  await expect(panel(page).getByTestId("ticket-state")).toHaveText("New");
  const version = panel(page).getByLabel("Affected version");
  await version.fill("2.1");
  await version.press("Enter");
  await panel(page).getByRole("checkbox", { name: "Low" }).check();
  await expect
    .poll(
      async () =>
        (
          await sql(
            "SELECT attributes FROM conversations WHERE title='Charged twice'",
          )
        )[0].attributes,
    )
    .toEqual({ affected_version: "2.1", severity: ["Low"] });

  await panel(page).getByRole("button", { name: "Change type…" }).click();
  const dialog = page.getByRole("dialog", { name: "Change ticket type" });
  await expect(dialog.getByLabel("New type")).toHaveValue("refund-request");
  const cleared = dialog.getByRole("list", { name: "Cleared fields" });
  await expect(cleared.getByRole("listitem")).toHaveCount(2);
  await expect(cleared).toContainText("Severity: Low");
  await expect(cleared).toContainText("Affected version: 2.1");
  await dialog
    .getByLabel("Move Affected version to")
    .selectOption({ label: "Refund reason" });
  await expect(
    dialog.getByRole("list", { name: "Moved fields" }),
  ).toContainText("Affected version → Refund reason");
  await expect(cleared.getByRole("listitem")).toHaveCount(1);
  await dialog.getByRole("button", { name: "Change type" }).click();
  await expect(dialog).toHaveCount(0);

  await expect(panel(page)).toContainText("Refund request");
  await expect(panel(page).getByTestId("ticket-state")).toHaveText("Submitted");
  await expect(panel(page).getByLabel("Refund reason")).toHaveValue("2.1");
  await expandUpdates(page);
  await expect(
    timeline(page).getByText(
      /changed the ticket type to Refund request; cleared Severity/,
    ),
  ).toBeVisible();
  expect(
    (
      await sql(
        "SELECT attributes FROM conversations WHERE title='Charged twice'",
      )
    )[0].attributes,
  ).toEqual({
    refund_reason: "2.1",
  });
});

test("closing a ticket without its required field is refused and the ticket stays open", async ({
  page,
}) => {
  await open(page, "Export is slow");
  await convert(page, "Refund request");
  await expect(panel(page).getByTestId("ticket-state")).toHaveText("Submitted");
  // E closes the conversation; the ticket's required field blocks it.
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("e");
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Fill in Refund amount before closing this ticket." }),
  ).toBeVisible();
  expect(
    (
      await sql("SELECT status FROM conversations WHERE title='Export is slow'")
    )[0].status,
  ).toBe("open");
});

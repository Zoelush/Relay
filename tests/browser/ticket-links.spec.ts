import { test, expect, type Page, type Frame } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";

let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 900 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 8930, hostPort: 8931 });
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
async function customerConversation(page: Page, text: string): Promise<Frame> {
  await page.goto(relay.hostOrigin);
  await expect(page.locator("relay-launcher")).toHaveAttribute(
    "data-ready",
    "true",
  );
  await page.getByRole("button", { name: "Open support", exact: true }).click();
  await expect
    .poll(
      () =>
        !!page.frames().find((f) => f.url().includes("/messenger/frame.html")),
    )
    .toBe(true);
  const widget = page
    .frames()
    .find((f) => f.url().includes("/messenger/frame.html"))!;
  await widget.getByRole("button", { name: "Start a conversation" }).click();
  await widget.getByRole("textbox", { name: "Write your message" }).fill(text);
  await widget.getByRole("button", { name: "Send message" }).click();
  await expect(
    widget.locator(".message").filter({ hasText: text }),
  ).toHaveCount(1);
  return widget;
}
async function inbox(page: Page) {
  await page.goto(relay.hostOrigin + "/agent");
  await expect(page.getByRole("status").filter({ hasText: "●" })).toHaveText(
    "● Live",
  );
}
async function openRow(page: Page, title: string) {
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

test("a tracker linked to two customers broadcasts one update that reaches both messengers and closes them", async ({
  browser,
}) => {
  const first = await customerConversation(
    await (await browser.newContext()).newPage(),
    "Checkout fails for me",
  );
  const second = await customerConversation(
    await (await browser.newContext()).newPage(),
    "Cannot pay at checkout",
  );
  const page = await (
    await browser.newContext({ viewport: { width: 1440, height: 900 } })
  ).newPage();
  await inbox(page);

  // A standalone tracker, from the command palette.
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette
    .getByRole("combobox", { name: "Search commands" })
    .fill("tracker");
  await palette.getByRole("option", { name: /Create tracker ticket/ }).click();
  const create = page.getByRole("dialog", { name: "Create tracker ticket" });
  await create.getByLabel("Title").fill("Checkout outage");
  await create.getByLabel("Ticket type").selectOption({ label: "Incident" });
  await create.getByRole("button", { name: "Create" }).click();
  await expect(
    page
      .getByRole("region", { name: "Conversation timeline" })
      .getByRole("heading", { name: "Checkout outage" }),
  ).toBeVisible();
  await expect(panel(page).getByTestId("ticket-state")).toHaveText(
    "Investigating",
  );

  // Link both customers' conversations from their sidebars.
  for (const title of ["Checkout fails for me", "Cannot pay at checkout"]) {
    await openRow(page, title);
    await panel(page).getByRole("button", { name: "Link to tracker" }).click();
    const picker = panel(page).getByLabel("Tracker");
    const tracker = await picker
      .locator("option", { hasText: "Checkout outage" })
      .getAttribute("value");
    await picker.selectOption(tracker!);
    await expect(
      panel(page).getByRole("list", { name: "Linked tickets" }),
    ).toContainText("Checkout outage");
  }

  // Broadcast from the tracker, closing the conversations after.
  await panel(page)
    .getByRole("list", { name: "Linked tickets" })
    .getByRole("button", { name: /Checkout outage/ })
    .click();
  await expect(
    panel(page).getByRole("region", { name: "Linked conversations" }),
  ).toContainText("(2)");
  await panel(page).getByRole("button", { name: "Broadcast update…" }).click();
  const dialog = page.getByRole("dialog", { name: "Broadcast update" });
  await dialog
    .getByLabel("Message to every linked customer")
    .fill("Checkout is working again. Sorry for the trouble!");
  await dialog.getByLabel("Close linked conversations after sending").check();
  await dialog.getByRole("button", { name: "Review" }).click();
  await expect(dialog).toContainText(
    "Send this as a reply to 2 conversations? They will then be closed.",
  );
  await dialog.getByRole("button", { name: "Send to 2 conversations" }).click();
  await expect(
    dialog.getByRole("status", { name: "Broadcast progress" }),
  ).toContainText("Sent to 2 conversations. Closed 2 conversations.");

  // Each customer receives the update in their own messenger; nothing of the tracker leaks.
  for (const widget of [first, second]) {
    await expect(
      widget
        .locator(".message")
        .filter({ hasText: "Checkout is working again." }),
    ).toHaveCount(1);
    await expect(widget.getByText("Checkout outage")).toHaveCount(0);
  }
  expect(
    (
      await sql(
        "SELECT status FROM conversations WHERE title IN ('Checkout fails for me','Cannot pay at checkout')",
      )
    ).map((r) => r.status),
  ).toEqual(["closed", "closed"]);
});

test("the customer sees their ticket's status; a back-office ticket refuses replies and stays invisible to them", async ({
  browser,
}) => {
  const widget = await customerConversation(
    await (await browser.newContext()).newPage(),
    "Refund for order 77",
  );
  const page = await (
    await browser.newContext({ viewport: { width: 1440, height: 900 } })
  ).newPage();
  await inbox(page);
  await openRow(page, "Refund for order 77");

  // Converting tells the customer, with the customer label only.
  await panel(page).getByRole("button", { name: "Convert to ticket" }).click();
  const form = panel(page).getByRole("group", { name: "Convert to ticket" });
  await form
    .getByLabel("Ticket type")
    .selectOption({ label: "Refund request" });
  await form.getByRole("button", { name: "Convert" }).click();
  await expect(
    widget.getByText(/^Ticket #\d+ \(Refund request\): Submitted$/),
  ).toBeVisible();

  // A back-office ticket for finance, linked to this conversation.
  await panel(page)
    .getByRole("button", { name: "Create back-office ticket" })
    .click();
  const create = page.getByRole("dialog", {
    name: "Create back-office ticket",
  });
  await create.getByLabel("Title").fill("Approve refund for order 77");
  await create.getByRole("button", { name: "Create" }).click();
  await expect(
    panel(page).getByRole("list", { name: "Linked tickets" }),
  ).toContainText("Approve refund for order 77");
  await panel(page)
    .getByRole("list", { name: "Linked tickets" })
    .getByRole("button", { name: /Approve refund/ })
    .click();
  await expect(
    page
      .getByRole("region", { name: "Conversation timeline" })
      .getByRole("heading", { name: "Approve refund for order 77" }),
  ).toBeVisible();

  // Replying on it is refused: there is no customer.
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Reply message", exact: true })
    .click();
  await page.keyboard.type("Hello customer");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(
    page.getByRole("alert").filter({
      hasText:
        "This ticket has no customer to reply to. Add an internal note instead.",
    }),
  ).toBeVisible();

  // Finance approves; the original conversation notes it internally; the customer sees nothing.
  await panel(page).getByLabel("Move to").selectOption({ label: "Approved" });
  await expect(panel(page).getByTestId("ticket-state")).toHaveText("Approved");
  expect(
    (
      await sql(
        `SELECT p.audience FROM conversation_parts p JOIN conversations c ON c.id=p.conversation_id
        WHERE c.title='Refund for order 77' AND p.data->>'event'='linked_ticket_state'`,
      )
    ).map((r) => r.audience),
  ).toEqual(["internal"]);
  await widget.page().waitForTimeout(500);
  await expect(widget.getByText("Approve refund")).toHaveCount(0);
  await expect(widget.getByText("Approved")).toHaveCount(0);
  await expect(widget.getByText("Hello customer")).toHaveCount(0);
});

import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { getIdentity } from "../../server/people";
import { command } from "../../server/conversations";
import { savePolicy } from "../../server/sla";

let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 900 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({
    apiPort: 8932,
    hostPort: 8933,
    inboxViews: true,
  });
  await tenant(relay.db.connect, "demo", async (db) => {
    await db.query(
      "INSERT INTO tags(workspace_id,id,name) VALUES('demo','chat','Chat'),('demo','urgent','Urgent') ON CONFLICT DO NOTHING",
    );
    // Two all-hours policies ahead of the seeded business-hours one, so the tests do not
    // depend on the time of day they run at.
    await savePolicy(db, "demo", "local-owner", {
      name: "Chat",
      position: 0,
      hours: "always",
      conditions: { field: "tag", op: "eq", value: "chat" },
      targets: { first_response: 2 * 60 * 60_000 },
    });
    await savePolicy(db, "demo", "local-owner", {
      name: "Urgent",
      position: 1,
      hours: "always",
      conditions: { field: "tag", op: "eq", value: "urgent" },
      targets: { first_response: 4000 },
    });
  });
});
test.afterAll(async () => {
  await relay?.close();
});
/** A customer starts a conversation and a teammate tags it, as the server would record them. */
async function conversation(text: string, tag: string) {
  return tenant(relay.db.connect, "demo", async (db) => {
    const identity = await getIdentity(db, "demo", "anonymous", "sla-" + text);
    const { conversationId } = (await command(
      db,
      "demo",
      { type: "contact", identityId: identity.identityId, brandId: "default" },
      "sla-" + text,
      { action: "start", text },
    )) as { conversationId: string };
    await command(
      db,
      "demo",
      { type: "teammate", principal: "local-owner" },
      "sla-tag-" + text,
      {
        action: "tag_add",
        conversationId,
        tagId: tag,
      },
    );
    return conversationId;
  });
}
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
const sla = (page: Page) =>
  page
    .getByRole("complementary", { name: "Conversation details" })
    .getByRole("region", { name: "SLA" });

test("a first-response countdown shows in the sidebar and a reply meets it", async ({
  page,
}) => {
  await conversation("Where is my parcel?", "chat");
  await open(page, "Where is my parcel?");
  await expect(sla(page)).toContainText("Chat · all hours");
  await expect(sla(page).getByTestId("sla-first_response")).toContainText(
    /Due .* · in (1h 5\dm|2h 0m)/,
  );
  await expect(
    page.getByRole("button", { name: /Where is my parcel\?/ }).first(),
  ).toContainText(/SLA (1h 5\dm|2h 0m)/);

  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Reply message", exact: true })
    .click();
  await page.keyboard.type("It left the warehouse this morning.");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(sla(page).getByTestId("sla-first_response")).toContainText(
    "Met",
  );
  await expect(
    page.getByRole("button", { name: /Where is my parcel\?/ }).first(),
  ).not.toContainText("SLA");
});

test("a missed target breaches live: red in the sidebar, on the timeline and in the list, and sorted first", async ({
  page,
}) => {
  await conversation("Payment failed twice", "urgent");
  await open(page, "Payment failed twice");
  await expect(sla(page)).toContainText("Urgent · all hours");
  // The breach timer fires without anyone touching the conversation.
  const clock = sla(page).getByTestId("sla-first_response");
  await expect(clock).toContainText(/Overdue by/, { timeout: 15_000 });
  await expect(clock).toHaveClass(/pg-sla-overdue/);
  const run = page
    .getByRole("log", { name: "Messages" })
    .getByRole("button", { name: /^Show \d+ updates$/ });
  if (await run.count()) await run.last().click();
  await expect(
    page
      .getByRole("log", { name: "Messages" })
      .getByText("First response SLA breached (Urgent)"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Payment failed twice/ }).first(),
  ).toContainText("SLA overdue");
  expect(
    (
      await tenant(
        relay.db.connect,
        "demo",
        async (db) =>
          (
            await db.query<{ n: number }>(
              "SELECT count(*)::int AS n FROM outbox WHERE kind='event' AND payload->>'name'='sla.breached'",
            )
          ).rows,
      )
    )[0].n,
  ).toBe(1);

  // Sorting by next SLA puts the overdue conversation first.
  await page.getByRole("button", { name: /^Sort:/ }).click();
  await page
    .getByRole("menu", { name: "Sort by" })
    .getByRole("menuitemradio", { name: "Next SLA" })
    .click();
  await expect(
    page.getByTestId("virtual-conversations").getByRole("button").first(),
  ).toContainText("Payment failed twice");
});

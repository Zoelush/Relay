import { test, expect, type Page, type Frame } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { command } from "../../server/conversations";
import { assignCalendar, publishCalendar } from "../../server/calendars";
import { drainForTeammate } from "../../server/routing";

let relay: Awaited<ReturnType<typeof startLocalRelay>>;
const allWeek = (from: string, to: string) =>
  Object.fromEntries(
    ["0", "1", "2", "3", "4", "5", "6"].map((d) => [d, [[from, to]]]),
  );
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 8938, hostPort: 8939 });
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
/** The brand's calendar: published and assigned, as a manager would through the API. */
async function brandCalendar(name: string, calendar: Record<string, unknown>) {
  await tenant(relay.db.connect, "demo", async (db) => {
    const { id } = await publishCalendar(db, "demo", "local-owner", {
      name,
      ...calendar,
    });
    await assignCalendar(db, "demo", "local-owner", {
      scope: "brand",
      scopeId: "default",
      calendarId: id,
    });
  });
}
async function messenger(page: Page): Promise<Frame> {
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
  return page.frames().find((f) => f.url().includes("/messenger/frame.html"))!;
}
/** A customer writes in; a teammate puts the conversation in the Billing inbox. */
async function waitInBilling(widget: Frame, text: string) {
  await widget.getByRole("button", { name: "Start a conversation" }).click();
  await widget.getByRole("textbox", { name: "Write your message" }).fill(text);
  await widget.getByRole("button", { name: "Send message" }).click();
  await expect(
    widget.locator(".message").filter({ hasText: text }),
  ).toHaveCount(1);
  const [{ id }] = await sql<{ id: string }>(
    "SELECT id FROM conversations WHERE title=$1",
    [text],
  );
  await tenant(relay.db.connect, "demo", (db) =>
    command(
      db,
      "demo",
      { type: "teammate", principal: "local-owner" },
      "billing-" + id,
      {
        action: "assign",
        conversationId: id,
        teamId: "billing",
      },
    ),
  );
}
/** A teammate comes back with room for one more, and routing gives them the first in line. */
async function comesBack(teammate: string) {
  await sql("UPDATE teammates SET presence='active' WHERE id=$1", [teammate]);
  await tenant(relay.db.connect, "demo", (db) =>
    drainForTeammate(db, "demo", teammate),
  );
}

test("open all week: the reply time shows, and a waiting customer's place in line updates live", async ({
  browser,
}) => {
  await brandCalendar("Always", {
    timezone: "UTC",
    weekly: allWeek("00:00", "24:00"),
  });
  await sql(
    "UPDATE brands SET settings=settings||'{\"replyTime\":\"We usually reply within the hour\"}' WHERE id='default'",
  );
  // Nobody is available: the owner (limit 1) and Grace are away, so Billing's line builds.
  await sql(
    "UPDATE teammates SET presence='away',conversation_limit=1 WHERE id IN ('owner','grace')",
  );

  const first = await messenger(await (await browser.newContext()).newPage());
  await expect(
    first.getByText("The team is online during office hours."),
  ).toBeVisible();
  await expect(first.getByTestId("reply-time")).toHaveText(
    "We usually reply within the hour",
  );
  await waitInBilling(first, "First in the line");
  await expect(first.getByTestId("queue-position")).toHaveText(
    "You're 1st in line",
  );

  const second = await messenger(await (await browser.newContext()).newPage());
  await waitInBilling(second, "Second in the line");
  await expect(second.getByTestId("queue-position")).toHaveText(
    "You're 2nd in line",
  );

  // The owner returns and takes the first: the second moves up without reloading.
  await comesBack("owner");
  await expect(first.getByTestId("queue-position")).toHaveCount(0);
  await expect(second.getByTestId("queue-position")).toHaveText(
    "You're 1st in line",
  );
  // Grace returns and takes it: no more line.
  await comesBack("grace");
  await expect(second.getByTestId("queue-position")).toHaveCount(0);
});

test("on a holiday the messenger says when the team is back and promises no reply time", async ({
  page,
}) => {
  const today = new Date().toISOString().slice(0, 10);
  await brandCalendar("Holiday", {
    timezone: "UTC",
    weekly: allWeek("00:00", "24:00"),
    holidays: [today],
  });
  const widget = await messenger(page);
  await expect(
    widget.getByText(
      "We are away. Leave a message and we will reply when we return.",
    ),
  ).toBeVisible();
  await expect(widget.getByTestId("next-open")).toContainText(
    "We'll reply from",
  );
  await expect(widget.getByTestId("next-open")).toContainText(
    new Intl.DateTimeFormat("en", { timeZone: "UTC", weekday: "long" }).format(
      Date.now() + 86_400_000,
    ),
  );
  await expect(widget.getByTestId("reply-time")).toHaveCount(0);
});

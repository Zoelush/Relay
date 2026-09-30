import { test, expect, type Page, type Frame } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { command } from "../../server/conversations";

let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1280, height: 900 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 8934, hostPort: 8935 });
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
/** The host page as a signed-in (verified) customer, with the messenger open on a new conversation. */
async function signedInMessenger(
  page: Page,
  user: string,
  text: string,
): Promise<Frame> {
  await page.goto(relay.hostOrigin + "/?user=" + user);
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
const conversationId = async (title: string) =>
  (
    await sql<{ id: string }>("SELECT id FROM conversations WHERE title=$1", [
      title,
    ])
  )[0].id;

test("a verified customer opens their tickets from the messenger, sees the status and replies; the teammate sees it", async ({
  browser,
}) => {
  const customer = await (await browser.newContext()).newPage();
  const widget = await signedInMessenger(
    customer,
    "jo",
    "My order arrived broken",
  );
  // A teammate turns it into a customer ticket.
  const id = await conversationId("My order arrived broken");
  await tenant(relay.db.connect, "demo", (db) =>
    command(
      db,
      "demo",
      { type: "teammate", principal: "local-owner" },
      "portal-convert-1",
      {
        action: "ticket",
        conversationId: id,
        typeId: "refund-request",
      },
    ),
  );

  // "Your tickets and requests" opens the portal in a new tab, signed in by a one-time code.
  await widget.getByRole("button", { name: "Home" }).click();
  const [portal] = await Promise.all([
    customer.context().waitForEvent("page"),
    widget.getByRole("button", { name: "Your tickets and requests" }).click(),
  ]);
  await portal.waitForLoadState();
  await expect(
    portal.getByRole("heading", { name: "Your requests" }),
  ).toBeVisible();
  expect(
    new URL(portal.url()).hash,
    "the code is removed from the address bar",
  ).toBe("");
  const list = portal.getByRole("list", { name: "Your requests" });
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(list).toContainText(/Ticket #\d+ \(Refund request\): Submitted/);

  await list.getByRole("link", { name: /My order arrived broken/ }).click();
  await expect(portal.getByTestId("request-status")).toHaveText(
    /Ticket #\d+ \(Refund request\): Submitted/,
  );
  await portal
    .getByLabel("Write a reply")
    .fill("Photos are attached to my email.");
  await portal.getByRole("button", { name: "Send reply" }).click();
  await expect(portal.getByRole("list", { name: "Messages" })).toContainText(
    "Photos are attached to my email.",
  );

  // The teammate sees the reply in the inbox.
  const inbox = await (
    await browser.newContext({ viewport: { width: 1440, height: 900 } })
  ).newPage();
  await inbox.goto(relay.hostOrigin + "/agent");
  await expect(inbox.getByRole("status").filter({ hasText: "●" })).toHaveText(
    "● Live",
  );
  await inbox
    .getByRole("button", { name: /My order arrived broken/ })
    .first()
    .click();
  await expect(inbox.getByRole("log", { name: "Messages" })).toContainText(
    "Photos are attached to my email.",
  );

  // Signing out ends the session.
  await portal.getByRole("button", { name: "Sign out" }).click();
  await portal.reload();
  await expect(
    portal.getByText(
      "Sign in through our website or messenger to see your requests.",
    ),
  ).toBeVisible();
});

test("another customer, signed in with a link from the site, cannot see or open someone else's request", async ({
  browser,
}) => {
  const jo = await (await browser.newContext()).newPage();
  await signedInMessenger(jo, "jo2", "Jo's private request");
  const private_ = await conversationId("Jo's private request");

  const sam = await (await browser.newContext()).newPage();
  await sam.goto(relay.hostOrigin + "/demo/portal-link?user=sam");
  await expect(
    sam.getByRole("heading", { name: "Your requests" }),
  ).toBeVisible();
  await expect(sam.getByText("You have no requests yet.")).toBeVisible();
  await expect(sam.getByText("Jo's private request")).toHaveCount(0);

  // Typing the other request's address shows nothing of it.
  await sam.goto(
    `${new URL(sam.url()).origin}/portal/demo/default?request=${encodeURIComponent(private_)}`,
  );
  await expect(sam.getByRole("alert")).toHaveText("Conversation unavailable.");
  await expect(sam.getByText("Jo's private request")).toHaveCount(0);

  // An anonymous visitor has no portal button in the messenger.
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(relay.hostOrigin);
  await visitor
    .getByRole("button", { name: "Open support", exact: true })
    .click();
  await expect
    .poll(
      () =>
        !!visitor
          .frames()
          .find((f) => f.url().includes("/messenger/frame.html")),
    )
    .toBe(true);
  const frame = visitor
    .frames()
    .find((f) => f.url().includes("/messenger/frame.html"))!;
  await expect(
    frame.getByRole("button", { name: "Start a conversation" }),
  ).toBeVisible();
  await expect(
    frame.getByRole("button", { name: "Your tickets and requests" }),
  ).toHaveCount(0);
});

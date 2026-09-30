import { test, expect, type Page, type Frame } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";

let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 8918, hostPort: 8919 });
});
test.afterAll(async () => {
  await relay?.close();
});
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
async function open(page: Page, row: RegExp, as?: string) {
  await page.goto(relay.hostOrigin + "/agent" + (as ? "?as=" + as : ""));
  await expect(page.getByRole("status").filter({ hasText: "●" })).toHaveText(
    "● Live",
  );
  await page.getByRole("button", { name: row }).click();
}
const activity = (page: Page) => page.getByTestId("teammate-activity");

test("teammates see each other viewing and writing; note writing never reaches the customer; reply collisions warn", async ({
  browser,
}) => {
  const widget = await customerConversation(
    await (await browser.newContext()).newPage(),
    "Collision fixture",
  );
  const owner = await (await browser.newContext()).newPage();
  const grace = await (await browser.newContext()).newPage();
  await open(owner, /Collision fixture/);
  await open(grace, /Collision fixture/, "grace");

  // Each learns the other is here: Grace from the join announcement, the owner from her arrival.
  await expect(activity(owner)).toHaveText("Grace is viewing");
  await expect(activity(grace)).toHaveText("Support teammate is viewing");

  // Grace writes a note: the owner sees it; the customer's messenger shows nothing.
  await grace
    .getByRole("button", { name: "Internal note", exact: true })
    .click();
  await grace
    .getByRole("textbox", { name: "Internal note", exact: true })
    .click();
  await grace.keyboard.type("Checking the refund policy first");
  await expect(activity(owner)).toHaveText("Grace is writing a note");
  await expect(
    owner.getByRole("alert").filter({ hasText: "also replying" }),
  ).toHaveCount(0);
  await grace.waitForTimeout(1000);
  await expect(widget.getByText("Someone is typing…")).toHaveCount(0);

  // Grace switches to a reply: the customer sees typing, and the owner (in reply mode) is warned.
  await grace.getByRole("button", { name: "Reply", exact: true }).click();
  await grace
    .getByRole("textbox", { name: "Reply message", exact: true })
    .click();
  await grace.keyboard.type("Hello, looking into it");
  await expect(activity(owner)).toHaveText("Grace is writing a reply");
  await expect(
    owner.getByRole("alert").filter({ hasText: "Grace is also replying" }),
  ).toBeVisible();
  await expect(widget.getByText("Someone is typing…")).toBeVisible();
  // In note mode the owner is not writing a reply, so there is no collision warning.
  await owner
    .getByRole("button", { name: "Internal note", exact: true })
    .click();
  await expect(
    owner.getByRole("alert").filter({ hasText: "also replying" }),
  ).toHaveCount(0);
});

test("when a teammate's tab closes, their activity clears for everyone else", async ({
  browser,
}) => {
  await customerConversation(
    await (await browser.newContext()).newPage(),
    "Departure fixture",
  );
  const owner = await (await browser.newContext()).newPage();
  const graceContext = await browser.newContext();
  const grace = await graceContext.newPage();
  await open(owner, /Departure fixture/);
  await open(grace, /Departure fixture/, "grace");
  await grace
    .getByRole("textbox", { name: "Reply message", exact: true })
    .click();
  await grace.keyboard.type("Half a reply");
  await expect(activity(owner)).toHaveText("Grace is writing a reply");

  await graceContext.close();
  await expect(activity(owner)).toHaveText("");
  await expect(
    owner.getByRole("alert").filter({ hasText: "also replying" }),
  ).toHaveCount(0);
});

import { test, expect, type Page, type Frame } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";

let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.beforeAll(async () => {
  // Default local relay: in-memory loopback storage whose scanner flags the EICAR test string.
  relay = await startLocalRelay({ apiPort: 8914, hostPort: 8915 });
});
test.afterAll(async () => {
  await relay?.close();
});
// A real 1×1 PNG, so browsers actually decode it.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const EICAR = Buffer.concat([
  PNG,
  Buffer.from(
    "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*",
  ),
]);
const editor = (page: Page) =>
  page.getByRole("textbox", { name: "Reply message", exact: true });

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
  return widget;
}
async function openConversation(page: Page, row: RegExp) {
  await page.goto(relay.hostOrigin + "/agent");
  await expect(page.getByRole("status")).toHaveText("● Live");
  await page.getByRole("button", { name: row }).click();
  await expect(editor(page)).toBeVisible();
}
const chooseImage = (page: Page, name: string, buffer: Buffer) =>
  page
    .locator('input[type="file"][aria-label="Choose images"]')
    .setInputFiles({ name, mimeType: "image/png", buffer });

test("an image inserted into a reply is scanned, sent and shown to the customer", async ({
  browser,
}) => {
  const customer = await (await browser.newContext()).newPage();
  const agent = await (await browser.newContext()).newPage();
  const widget = await customerConversation(
    customer,
    "What does the screen look like?",
  );
  await openConversation(agent, /What does the screen look like\?/);

  await editor(agent).click();
  await agent.keyboard.type("Here is the setup screen:");
  await chooseImage(agent, "setup-screen.png", PNG);
  const inEditor = editor(agent).locator(
    '[data-image-status] img[alt="setup-screen"]',
  );
  await expect(inEditor).toBeVisible({ timeout: 15000 });
  await expect(
    editor(agent).locator('[data-image-status="clean"]'),
  ).toHaveCount(1);
  const send = agent.getByRole("button", { name: "Send reply" });
  await expect(send).toBeEnabled();
  await send.click();

  const part = agent
    .locator("[data-part-id]")
    .filter({ hasText: "Here is the setup screen:" });
  const shown = part.locator('img[alt="setup-screen"]');
  await expect(shown).toBeVisible();
  expect(
    await shown.evaluate((img: HTMLImageElement) => img.naturalWidth),
  ).toBe(1);

  const message = widget
    .locator(".message")
    .filter({ hasText: "Here is the setup screen:" });
  const customerImage = message.locator('img[alt="setup-screen"]');
  await expect(customerImage).toBeVisible({ timeout: 15000 });
  await expect
    .poll(() =>
      customerImage.evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBe(1);
});

test("a blocked image keeps Send disabled until it is removed", async ({
  browser,
}) => {
  const customer = await (await browser.newContext()).newPage();
  const agent = await (await browser.newContext()).newPage();
  await customerConversation(customer, "Please check this");
  await openConversation(agent, /Please check this/);

  await editor(agent).click();
  await agent.keyboard.type("Checking now");
  await chooseImage(agent, "suspicious.png", EICAR);
  await expect(editor(agent).getByRole("alert")).toHaveText(
    "Blocked by the scanner: suspicious",
    { timeout: 15000 },
  );
  const send = agent.getByRole("button", { name: "Send reply" });
  await expect(send).toBeDisabled();
  await expect(agent.getByText("Remove blocked images to send")).toBeVisible();
  // Ctrl+Enter is refused too.
  await editor(agent).click();
  await agent.keyboard.press("ControlOrMeta+Enter");
  await expect(
    agent.locator("[data-part-id]").filter({ hasText: "Checking now" }),
  ).toHaveCount(0);

  await agent.getByRole("button", { name: "Remove image suspicious" }).click();
  await expect(agent.getByText("Remove blocked images to send")).toHaveCount(0);
  await expect(send).toBeEnabled();
  await send.click();
  const part = agent
    .locator("[data-part-id]")
    .filter({ hasText: "Checking now" });
  await expect(part).toHaveCount(1);
  await expect(part.locator("img")).toHaveCount(0);
});

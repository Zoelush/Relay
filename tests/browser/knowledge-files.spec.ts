import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { EICAR_TEXT, PNG_PIXEL, textPdf } from "../fixtures/documents";

let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 900 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 8948, hostPort: 8949 });
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
async function open(page: Page) {
  await page.goto(relay.hostOrigin + "/agent");
  await expect(page.getByRole("status").filter({ hasText: "●" })).toHaveText(
    "● Live",
  );
  await page.getByRole("button", { name: "Knowledge" }).click();
  await expect(page.getByRole("heading", { name: "Knowledge" })).toBeVisible();
}
const uploadFile = (
  page: Page,
  name: string,
  mimeType: string,
  buffer: Uint8Array,
) =>
  page
    .getByLabel("File to upload")
    .setInputFiles({ name, mimeType, buffer: Buffer.from(buffer) });

test("upload a PDF, find it by its contents, and publish an article with a described image on the help center", async ({
  page,
  browser,
}) => {
  await open(page);
  await uploadFile(
    page,
    "Refund policy.pdf",
    "application/pdf",
    textPdf(["Refunds reach a wombat account\nwithin five days", "Page two"]),
  );
  const file = page.getByRole("region", { name: "File" });
  await expect(file.getByRole("status")).toHaveText("Ready");
  await expect(file).toContainText("Refund policy.pdf");
  await expect(file).toContainText("2 pages");
  await expect(file).toContainText("Refunds reach a wombat account");
  await expect(file.getByRole("link", { name: "Download" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Refund policy" }),
  ).toBeVisible();

  // Knowledge search finds it by a word only inside the file.
  const list = page.getByRole("region", { name: "Knowledge records" });
  await page.getByLabel("Search knowledge").fill("wombat");
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(list).toContainText("Refund policy");
  await expect(list).toContainText("File · en Published");
  await page.getByLabel("Search knowledge").fill("");

  // An image in the seeded help center article, with its description.
  await list
    .getByRole("button", { name: /Getting started with Relay/ })
    .click();
  await expect(page.getByLabel("Title")).toHaveValue(
    "Getting started with Relay",
  );
  await page.getByLabel("Article body").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Meta+ArrowDown");
  await page.getByRole("button", { name: "Image", exact: true }).click();
  const prompt = page.getByRole("group", { name: "Add image" });
  await prompt.getByLabel("Image file").setInputFiles({
    name: "inbox.png",
    mimeType: "image/png",
    buffer: Buffer.from(PNG_PIXEL),
  });
  // A description is required.
  await prompt.getByRole("button", { name: "Add image" }).click();
  await expect(prompt.getByRole("alert")).toHaveText(
    "Describe the image for people who cannot see it.",
  );
  await prompt.getByLabel("Image description").fill("The Relay inbox");
  await prompt.getByRole("button", { name: "Add image" }).click();
  await expect(prompt).toBeHidden();
  const placed = page
    .getByLabel("Article body")
    .getByRole("img", { name: "The Relay inbox" });
  await expect(placed).toBeVisible();
  await expect
    .poll(() => placed.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(1);
  await expect(
    page.getByRole("status").filter({ hasText: /saved|Saving/ }),
  ).toHaveText("All changes saved");
  await page.getByRole("button", { name: "Publish changes" }).click();
  await expect(page.getByRole("alert")).toHaveText("Published.");

  // The public page shows it from the help center, to a visitor with no session.
  const reader = await (await browser.newContext()).newPage();
  await reader.goto(
    relay.apiOrigin +
      "/help/demo/relay-help/en/articles/getting-started-with-relay",
  );
  const shown = reader.getByRole("img", { name: "The Relay inbox" });
  await expect(shown).toBeVisible();
  await expect
    .poll(() => shown.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(1);
  expect(await shown.getAttribute("src")).toMatch(
    /^\/help\/demo\/relay-help\/files\/[0-9a-f-]{36}$/,
  );
});

test("a file the virus scanner blocks, and a password-protected PDF, are explained", async ({
  page,
}) => {
  await open(page);
  await uploadFile(
    page,
    "notes.txt",
    "text/plain",
    new TextEncoder().encode("Notes " + EICAR_TEXT),
  );
  await expect(page.getByRole("alert").first()).toHaveText(
    "The virus scanner blocked this file.",
  );
  const file = page.getByRole("region", { name: "File" });
  await expect(file.getByRole("status")).toHaveText(
    "Blocked: The virus scanner blocked this file.",
  );
  // Nothing to download, and nothing searchable.
  await expect(file.getByRole("link", { name: "Download" })).toHaveCount(0);
  const blocked = await sql<{ status: string; failure_code: string }>(
    "SELECT status,failure_code FROM knowledge_files WHERE name='notes.txt'",
  );
  expect(blocked).toEqual([
    { status: "rejected", failure_code: "VIRUS_DETECTED" },
  ]);

  await uploadFile(
    page,
    "Payroll.pdf",
    "application/pdf",
    textPdf(["Salaries"], { encryptWith: "secret" }),
  );
  await expect(page.getByRole("heading", { name: "Payroll" })).toBeVisible();
  await expect(file.getByRole("status")).toHaveText(
    "Could not be read: This PDF is password-protected. Remove the password, then upload it again.",
  );
  // The original can still be downloaded, to fix it.
  await expect(file.getByRole("link", { name: "Download" })).toBeVisible();
});

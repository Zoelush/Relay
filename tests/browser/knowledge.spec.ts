import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";

let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 900 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 8940, hostPort: 8941 });
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
  await page.getByRole("button", { name: "Knowledge" }).click();
  await expect(page.getByRole("heading", { name: "Knowledge" })).toBeVisible();
}
const saved = (page: Page) =>
  expect(
    page.getByRole("status").filter({ hasText: /saved|Saving/ }),
  ).toHaveText("All changes saved");

test("write an article with autosave, publish it, publish a second language on its own, and restore a version", async ({
  page,
}) => {
  await open(page);
  // The seeded article is listed.
  const list = page.getByRole("region", { name: "Knowledge records" });
  await expect(list).toContainText("Getting started with Relay");

  await page.getByRole("button", { name: "New article" }).click();
  const title = page.getByLabel("Title");
  await expect(title).toBeVisible();
  await title.fill("Resetting your password");
  const body = page.getByLabel("Article body");
  await body.click();
  await page.getByRole("button", { name: "Heading 2" }).click();
  await page.keyboard.type("Before you start");
  await page.keyboard.press("Enter");
  await page.keyboard.type("You need access to your email.");
  // A callout, a video and a table: the article profile's own nodes.
  await page.getByRole("button", { name: "Callout" }).click();
  await page.getByLabel("Callout tone").selectOption("warning");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  // Out of the callout again.
  await page.getByRole("button", { name: "Callout" }).click();
  await page.getByRole("button", { name: "Video" }).click();
  await page.getByLabel("Video address").fill("https://vimeo.com/123");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(body).toContainText("Vimeo video · 123");
  await page.getByRole("button", { name: "Table", exact: true }).click();
  await page.keyboard.type("Plan");
  await page.getByRole("button", { name: "Add column" }).click();
  // A video address that is not YouTube or Vimeo is refused in place.
  await page.getByRole("button", { name: "Video" }).click();
  await page.getByLabel("Video address").fill("https://example.com/v");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(
    page.getByRole("group", { name: "Add video" }).getByRole("alert"),
  ).toHaveText("Paste a YouTube or Vimeo address.");
  await page.getByRole("button", { name: "Cancel" }).click();
  await saved(page);
  const record = (
    await sql<{ id: string; draft_body: any }>(
      "SELECT l.record_id AS id,l.draft_body FROM knowledge_locales l WHERE l.draft_title='Resetting your password'",
    )
  )[0];
  expect(record.draft_body.content[0]).toMatchObject({
    type: "heading",
    attrs: { level: 2 },
  });
  const types = record.draft_body.content.map((n: { type: string }) => n.type);
  expect(types).toEqual(
    expect.arrayContaining(["heading", "callout", "video", "table"]),
  );
  const callout = record.draft_body.content.find(
    (n: { type: string }) => n.type === "callout",
  );
  expect(callout.attrs).toEqual({ tone: "warning" });
  const table = record.draft_body.content.find(
    (n: { type: string }) => n.type === "table",
  );
  expect(table.content[0].content).toHaveLength(3);
  expect(table.content[0].content[0].content[0].content[0].text).toBe("Plan");

  // Publish English.
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Published.");
  await expect(page.getByRole("tab", { name: "en · Published" })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Version history" }),
  ).toContainText("Version 1: Resetting your password");

  // A French version starts from the English draft and is published on its own.
  await page.getByLabel("New language").fill("fr");
  await page.getByRole("button", { name: "Add language" }).click();
  await expect(page.getByRole("tab", { name: "fr · Draft" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(title).toHaveValue("Resetting your password");
  await title.fill("Réinitialiser votre mot de passe");
  await saved(page);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByRole("tab", { name: "fr · Published" })).toBeVisible();
  const published = await sql(
    "SELECT locale,published_title,published_revision FROM knowledge_locales WHERE record_id=$1 ORDER BY locale",
    [record.id],
  );
  expect(published).toEqual([
    {
      locale: "en",
      published_title: "Resetting your password",
      published_revision: 1,
    },
    {
      locale: "fr",
      published_title: "Réinitialiser votre mot de passe",
      published_revision: 1,
    },
  ]);

  // Back in English: change and publish, then restore version 1 into the draft.
  await page.getByRole("tab", { name: "en · Published" }).click();
  await expect(title).toHaveValue("Resetting your password");
  await title.fill("Reset your password");
  await saved(page);
  await expect(
    page.getByRole("tab", { name: "en · Published (changes)" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Publish changes" }).click();
  await expect(
    page.getByRole("region", { name: "Version history" }),
  ).toContainText("Version 2: Reset your password");
  await page.getByRole("button", { name: "Restore version 1" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Version 1 is now the draft",
  );
  await expect(title).toHaveValue("Resetting your password");
  // The live version is still 2 until the restored draft is published.
  const [en] = await sql(
    "SELECT draft_title,published_title FROM knowledge_locales WHERE record_id=$1 AND locale='en'",
    [record.id],
  );
  expect(en).toEqual({
    draft_title: "Resetting your password",
    published_title: "Reset your password",
  });
});

test("a draft changed elsewhere is not overwritten, internal content stays away from customers, and a teammate without knowledge.manage only reads", async ({
  page,
  browser,
}) => {
  await open(page);
  const list = page.getByRole("region", { name: "Knowledge records" });
  await list.getByRole("button", { name: /Refund approvals/ }).click();
  const title = page.getByLabel("Title");
  await expect(title).toHaveValue("Refund approvals");

  // Internal: the customer-facing switches are off and cannot be turned on.
  const settings = page.getByRole("region", { name: "Settings" });
  await expect(settings.getByLabel("Audience")).toHaveValue("internal");
  await expect(settings.getByLabel("AI agent can use it")).toBeDisabled();
  await expect(settings).toContainText(
    "Internal content is for teammates only",
  );

  // Another tab saves the draft first.
  await sql(
    "UPDATE knowledge_locales SET draft_title='Refund approvals (team leads)',draft_version=draft_version+1 WHERE record_id='00000000-0000-4000-8000-00000000a002'",
  );
  await title.fill("Refund approvals v2");
  await expect(
    page.getByRole("status").filter({ hasText: "changed" }),
  ).toHaveText("This draft changed in another tab or by another teammate.");
  await expect(
    page.getByRole("button", { name: "Publish", exact: true }),
  ).toBeDisabled();
  // Nothing was overwritten.
  const [l] = await sql(
    "SELECT draft_title FROM knowledge_locales WHERE record_id='00000000-0000-4000-8000-00000000a002'",
  );
  expect(l.draft_title).toBe("Refund approvals (team leads)");
  await page.getByRole("button", { name: "Reload the latest" }).click();
  await expect(title).toHaveValue("Refund approvals (team leads)");
  await saved(page);

  // Grace (an agent) sees only published content, with no editing.
  const grace = await browser.newPage();
  await open(grace, "?as=grace");
  await expect(grace.getByRole("button", { name: "New article" })).toHaveCount(
    0,
  );
  const graceList = grace.getByRole("region", { name: "Knowledge records" });
  await graceList
    .getByRole("button", { name: /Getting started with Relay/ })
    .click();
  await expect(
    grace.getByRole("heading", { name: "Getting started with Relay" }),
  ).toBeVisible();
  await expect(grace.getByLabel("Title")).toHaveCount(0);
  await expect(grace.getByRole("toolbar", { name: "Formatting" })).toHaveCount(
    0,
  );
  await grace.close();
});

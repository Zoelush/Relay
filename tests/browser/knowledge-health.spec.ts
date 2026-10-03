import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";

/** Content health (phase 07, C2b; docs/KNOWLEDGE_STEP8.md). */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 8968, hostPort: 8969 });
});
test.afterAll(async () => {
  await relay?.close();
});
const sql = <T = any>(text: string, values: unknown[] = []) =>
  tenant(
    relay.db.connect,
    "demo",
    async (db) => (await db.query<T>(text, values)).rows,
  );
const ARTICLE = "00000000-0000-4000-8000-00000000a001",
  SNIPPET = "00000000-0000-4000-8000-00000000a003";
/** Opens Content health from Settings, once the AI index has been built. */
async function open(page: Page) {
  await built();
  await go(page);
}
async function built() {
  await expect
    .poll(
      async () =>
        (
          await sql(
            "SELECT 1 FROM knowledge_index_generations WHERE status='active'",
          )
        ).length,
      { timeout: 30000 },
    )
    .toBe(1);
}
async function go(page: Page) {
  await page.goto(relay.hostOrigin + "/agent#settings");
  await page
    .getByRole("navigation", { name: "Settings pages" })
    .getByRole("button", { name: "Content health" })
    .click();
  await expect(
    page
      .getByRole("navigation", { name: "Knowledge areas" })
      .getByRole("button", { name: "Content health" }),
  ).toHaveAttribute("aria-current", "page");
}
const notice = (page: Page) => page.locator(".pg-settings-notice");

test("content health: a record marked reviewed, a near-duplicate found with Check now and dismissed, and a record opened from the report", async ({
  page,
}) => {
  await open(page);
  // Never reviewed: the seeded article, until marked.
  const reviewed = page.getByRole("list", { name: "Never reviewed" });
  await expect(reviewed).toContainText("Getting started with Relay");
  await page
    .getByRole("button", { name: "Mark Getting started with Relay reviewed" })
    .click();
  await expect(notice(page)).toContainText(
    "Marked Getting started with Relay reviewed.",
  );
  await expect(reviewed).not.toContainText("Getting started with Relay");
  expect(
    (
      await sql(
        "SELECT last_reviewed_at IS NOT NULL AS done FROM knowledge_records WHERE id=$1",
        [ARTICLE],
      )
    )[0].done,
  ).toBe(true);
  // Retrievals are counted from the first index, and the page says so.
  await expect(page.getByText(/Retrievals counted since/)).toBeVisible();

  // Near-duplicates: Check now finds the snippet that repeats the article's passage.
  await page.getByRole("button", { name: "Check now" }).click();
  const pairs = page.getByRole("list", { name: "Near-duplicates" });
  await expect(pairs).toContainText("Getting started with Relay", {
    timeout: 30000,
  });
  await expect(pairs).toContainText("Start a conversation");
  await expect(pairs).toContainText(/\d+% alike/);
  await expect(page.getByText(/Last checked/)).toBeVisible();
  // Dismissed: gone, and remembered.
  await page
    .getByRole("button", {
      name: /are not duplicates$/,
    })
    .click();
  await expect(notice(page)).toContainText(
    "Dismissed. They come back only if either one changes.",
  );
  await expect(pairs).toHaveCount(0);
  await expect(page.getByText("No near-duplicates.")).toBeVisible();
  const [a, b] = [ARTICLE, SNIPPET].sort();
  expect(
    await sql("SELECT record_a,record_b FROM knowledge_duplicate_dismissals"),
  ).toEqual([{ record_a: a, record_b: b }]);

  // A record opens from the report.
  await page
    .getByRole("button", { name: "Open Start a conversation" })
    .first()
    .click();
  await expect(
    page
      .getByRole("navigation", { name: "Knowledge areas" })
      .getByRole("button", { name: "Content", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
    "Start a conversation",
  );
});

test("with the AI index off, the near-duplicate check isn't offered and the report says why", async ({
  page,
}) => {
  await built();
  await sql(
    "UPDATE workspace_features SET enabled=false WHERE name='knowledge_index_v1'",
  );
  await go(page);
  await expect(page.getByRole("note")).toHaveText(
    "Near-duplicates are found with the AI index, which is off for this workspace.",
  );
  await expect(page.getByRole("button", { name: "Check now" })).toHaveCount(0);
  // The rest of the report still works.
  await expect(
    page.getByRole("region", { name: "Never reviewed" }),
  ).toBeVisible();
  await sql(
    "UPDATE workspace_features SET enabled=true WHERE name='knowledge_index_v1'",
  );
});

import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { getIdentity } from "../../server/people";
import { command } from "../../server/conversations";

let relay: Awaited<ReturnType<typeof startLocalRelay>>;
const PARTS = 180;

/** A conversation with one customer message and `PARTS` teammate replies "<label> 0..n". */
async function longConversation(label: string) {
  await tenant(relay.db.connect, "demo", async (db) => {
    const identity = await getIdentity(
      db,
      "demo",
      "anonymous",
      label + "-device",
    );
    const started = (await command(
      db,
      "demo",
      { type: "contact", identityId: identity.identityId, brandId: "default" },
      label + "-start",
      { action: "start", text: label + " fixture" },
    )) as { conversationId: string };
    for (let i = 0; i < PARTS; i++)
      await command(
        db,
        "demo",
        { type: "teammate", principal: "local-owner" },
        label + "-reply-" + i,
        {
          action: "reply",
          conversationId: started.conversationId,
          text: `${label} ${i}`,
        },
      );
  });
}
const timeline = (page: Page) => page.getByRole("log", { name: "Messages" });
const part = (page: Page, text: string) =>
  timeline(page)
    .locator("[data-part-id]")
    .filter({ has: page.getByText(text, { exact: true }) });
async function scrollToTop(page: Page) {
  await timeline(page).evaluate((el) => el.scrollTo(0, 0));
}
async function partIds(page: Page) {
  return timeline(page)
    .locator("[data-part-id]")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-part-id")));
}

test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 8902, hostPort: 8903 });
  await longConversation("Scrollback");
  await longConversation("Retry");
});
test.afterAll(async () => {
  await relay?.close();
});

test("a long conversation opens on its newest messages and scrolls back through all of them once", async ({
  page,
}) => {
  await page.goto(relay.hostOrigin + "/agent");
  await expect(page.getByRole("status")).toHaveText("● Live");
  await page.getByRole("button", { name: /Scrollback fixture/ }).click();
  await expect(part(page, `Scrollback ${PARTS - 1}`)).toBeVisible();
  // First screen: the newest 50 parts only.
  expect((await partIds(page)).length).toBeLessThanOrEqual(50);
  await expect(part(page, "Scrollback 100")).toHaveCount(0);
  await scrollToTop(page);
  await expect(part(page, "Scrollback 100")).toHaveCount(1);
  // Prepending keeps the reader's place instead of jumping to the new top.
  expect(await timeline(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(
    0,
  );
  await expect
    .poll(
      async () => {
        await scrollToTop(page);
        return part(page, "Scrollback 0").count();
      },
      { timeout: 15000 },
    )
    .toBe(1);
  const ids = await partIds(page);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.length).toBe(PARTS + 1);
  await expect(
    timeline(page).getByRole("button", { name: "Load older messages" }),
  ).toHaveCount(0);
});

test("a failed older page shows an error, and retrying loads it without duplicates", async ({
  page,
}) => {
  let fail = true;
  await page.route("**/api/agent/history?*", async (route) => {
    if (fail && new URL(route.request().url()).searchParams.has("before"))
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "UNAVAILABLE",
            message: "History failed for this test.",
          },
        }),
      });
    else await route.continue();
  });
  await page.goto(relay.hostOrigin + "/agent");
  await expect(page.getByRole("status")).toHaveText("● Live");
  await page.getByRole("button", { name: /Retry fixture/ }).click();
  await expect(part(page, `Retry ${PARTS - 1}`)).toBeVisible();
  await scrollToTop(page);
  await expect(timeline(page).getByRole("alert")).toHaveText(
    "Older messages could not be loaded.",
  );
  const before = await partIds(page);
  fail = false;
  await timeline(page).getByRole("button", { name: "Retry" }).click();
  await expect(part(page, "Retry 100")).toHaveCount(1);
  await expect(timeline(page).getByRole("alert")).toHaveCount(0);
  const after = await partIds(page);
  expect(new Set(after).size).toBe(after.length);
  expect(after.length).toBeGreaterThan(before.length);
  expect(after.slice(-before.length)).toEqual(before);
});

test("reading older messages, a new message does not pull you down; at the newest it is followed", async ({
  page,
}) => {
  await longConversation("Reader");
  await page.goto(relay.hostOrigin + "/agent");
  await expect(page.getByRole("status")).toHaveText("● Live");
  await page.getByRole("button", { name: /Reader fixture/ }).click();
  await expect(part(page, `Reader ${PARTS - 1}`)).toBeVisible();
  const reply = (text: string) =>
    tenant(relay.db.connect, "demo", async (db) => {
      const [{ id }] = (
        await db.query<{ id: string }>(
          "SELECT id FROM conversations WHERE title='Reader fixture'",
        )
      ).rows;
      await command(
        db,
        "demo",
        { type: "teammate", principal: "local-grace" },
        "reader-" + text,
        { action: "reply", conversationId: id, text },
      );
    });
  const distanceFromBottom = () =>
    timeline(page).evaluate(
      (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
    );
  // Scroll up a little (not far enough to load older history) and let a new reply arrive.
  await timeline(page).evaluate((el) =>
    el.scrollTo(0, el.scrollHeight - el.clientHeight - 600),
  );
  await expect.poll(distanceFromBottom).toBeGreaterThan(500);
  await reply("A reply while you read");
  await expect(part(page, "A reply while you read")).toHaveCount(1);
  expect(await distanceFromBottom(), "your place is kept").toBeGreaterThan(500);
  // Back at the newest message, the next reply is followed.
  await timeline(page).evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect.poll(distanceFromBottom).toBeLessThan(80);
  await reply("A reply you see arrive");
  await expect(part(page, "A reply you see arrive")).toBeVisible();
  await expect.poll(distanceFromBottom).toBeLessThan(80);
});

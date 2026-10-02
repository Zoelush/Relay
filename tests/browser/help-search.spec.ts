import { test, expect, type Page, type Frame } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";

let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1280, height: 900 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 8946, hostPort: 8947 });
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
const helpSpace = (widget: Frame) =>
  widget.getByRole("navigation").getByRole("button", { name: "Help" }).click();
async function inboxTimeline(page: Page, text: string) {
  await page.goto(relay.hostOrigin + "/agent");
  await expect(page.getByRole("status").filter({ hasText: "●" })).toHaveText(
    "● Live",
  );
  await page
    .getByRole("button", { name: new RegExp(text) })
    .first()
    .click();
  return page.getByRole("log", { name: "Messages" });
}

test("a customer finds an article despite a typo, says it didn't help, and talks to the team with the article attached", async ({
  page,
  browser,
}) => {
  const widget = await messenger(page);
  await helpSpace(widget);
  // Browse: the seeded collection.
  await expect(
    widget.getByRole("button", { name: /Getting started/ }),
  ).toBeVisible();
  // Search with a typo.
  await widget
    .getByRole("searchbox", { name: "Search for help" })
    .fill("geting startd");
  await widget.getByRole("button", { name: "Search" }).click();
  await widget
    .getByRole("button", { name: "Getting started with Relay" })
    .click();
  await expect(
    widget.getByRole("heading", { name: "Getting started with Relay" }),
  ).toBeVisible();
  await expect(
    widget.getByText(
      "Replies usually arrive within an hour during office hours.",
    ),
  ).toBeVisible();
  // Not helpful, with a comment, then "Talk to us".
  const feedback = widget.getByRole("region", { name: "Was this helpful?" });
  await feedback.getByRole("button", { name: "No" }).click();
  await feedback
    .getByRole("textbox", { name: "What were you looking for? (optional)" })
    .fill("How do I invite my team?");
  await feedback.getByRole("button", { name: "Talk to us" }).click();
  // What they said they were looking for starts their message.
  await expect(
    widget.getByRole("textbox", { name: "Write your message" }),
  ).toHaveValue("How do I invite my team?");
  await widget
    .getByRole("textbox", { name: "Write your message" })
    .fill("Can I add teammates?");
  await widget.getByRole("button", { name: "Send message" }).click();
  await expect(
    widget.locator(".message").filter({ hasText: "Can I add teammates?" }),
  ).toBeVisible();
  // The customer never sees the help context.
  await expect(widget.getByText("didn't help")).toHaveCount(0);

  // The teammate sees what the customer read, and that it didn't help.
  const timeline = await inboxTimeline(page, "Can I add teammates");
  await expect(timeline).toContainText(
    "Customer read “Getting started with Relay” and said it didn't help",
  );
  // The search was logged, and the article's editor shows the comment.
  expect(
    (
      await sql(
        "SELECT query,results,opened_record_id IS NOT NULL AS opened FROM help_search_queries",
      )
    ).at(-1),
  ).toEqual({
    query: "geting startd",
    results: 1,
    opened: true,
  });
  await page.getByRole("button", { name: "Knowledge" }).click();
  await page
    .getByRole("region", { name: "Knowledge records" })
    .getByRole("button", { name: /Getting started with Relay/ })
    .click();
  const readers = page.getByRole("region", { name: "Reader feedback" });
  await expect(readers).toContainText("0 found it helpful · 1 did not");
  await expect(readers).toContainText("How do I invite my team?");

  // The public help center, scripts off: search with a typo, and the result opens the article.
  const reader = await (
    await browser.newContext({ javaScriptEnabled: false })
  ).newPage();
  await reader.goto(relay.apiOrigin + "/help/demo/relay-help/en");
  await reader
    .getByRole("searchbox", { name: "Search for answers" })
    .fill("conversaton");
  await reader
    .getByRole("searchbox", { name: "Search for answers" })
    .press("Enter");
  await expect(reader.getByRole("status")).toHaveText(
    "1 result for “conversaton”",
  );
  await reader
    .getByRole("link", { name: "Getting started with Relay" })
    .click();
  await expect(reader).toHaveURL(
    relay.apiOrigin +
      "/help/demo/relay-help/en/articles/getting-started-with-relay",
  );
  // The vote works without scripts, too.
  await reader.getByRole("button", { name: "Yes" }).click();
  await expect(
    reader.getByRole("region", { name: "Was this helpful?" }),
  ).toContainText("Thanks for letting us know.");
  await reader.context().close();
});

test("with “search before contacting” on, the customer can't start until they search, and the teammate sees what they searched; the report lists searches with no results", async ({
  page,
}) => {
  await sql(
    "UPDATE brands SET settings=settings||'{\"requireSearch\":true}' WHERE id='default'",
  );
  const widget = await messenger(page);
  // No way to start yet.
  await expect(
    widget
      .getByText("Please search Help before starting a conversation.")
      .first(),
  ).toBeVisible();
  await expect(
    widget.getByRole("button", { name: "Start a conversation" }),
  ).toHaveCount(0);
  // A search with nothing to find still counts as searching.
  await helpSpace(widget);
  await widget
    .getByRole("searchbox", { name: "Search for help" })
    .fill("cancel my subscription");
  await widget.getByRole("button", { name: "Search" }).click();
  await expect(widget.getByRole("status")).toHaveText(
    "No articles match. Try other words, or start a conversation.",
  );
  await widget.getByRole("button", { name: "Start a conversation" }).click();
  await widget
    .getByRole("textbox", { name: "Write your message" })
    .fill("How do I cancel?");
  await widget.getByRole("button", { name: "Send message" }).click();
  await expect(
    widget.locator(".message").filter({ hasText: "How do I cancel?" }),
  ).toBeVisible();

  const timeline = await inboxTimeline(page, "How do I cancel");
  await expect(timeline).toContainText(
    "Customer searched the help center for “cancel my subscription”",
  );

  // The content team's report: the search that found nothing.
  await page.getByRole("button", { name: "Knowledge" }).click();
  await page
    .getByRole("navigation", { name: "Knowledge areas" })
    .getByRole("button", { name: "Help centers" })
    .click();
  const report = page.getByRole("region", { name: "Search and feedback" });
  await expect(
    report.getByRole("table", { name: "Searches with no results" }),
  ).toContainText("cancel my subscription");
  await sql(
    "UPDATE brands SET settings=settings-'requireSearch' WHERE id='default'",
  );
});

import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { memoryVectorStore, testEmbedder } from "../../server/knowledge-index";

/** The AI index page (phase 07, C2a; docs/KNOWLEDGE_STEP7.md). */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
/** The model can be made to fail, as if the embedding service were down. */
const model = { down: false };
test.use({ viewport: { width: 1440, height: 900 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({
    apiPort: 8912,
    hostPort: 8913,
    index: {
      embedders: [testEmbedder({ fail: () => model.down })],
      vectors: memoryVectorStore(),
    },
  });
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
/** A published English record, straight into the store (the indexer picks it up on its own). */
async function publish(
  id: string,
  title: string,
  text: string,
  audience = "public",
) {
  await sql(
    "INSERT INTO knowledge_records(workspace_id,id,source,owner_id,audience,for_ai,for_inbox) VALUES('demo',$1,$2,'owner',$3,$4,true)",
    [
      id,
      audience === "internal" ? "internal_article" : "article",
      audience,
      audience !== "internal",
    ],
  );
  await sql(
    "INSERT INTO knowledge_locales(workspace_id,record_id,locale,status,draft_title,published_title,published_text,published_revision,published_at) VALUES('demo',$1,'en','published',$2,$2,$3,1,now())",
    [id, title, text],
  );
}
async function openIndex(page: Page) {
  await page.goto(relay.hostOrigin + "/agent");
  await expect(page.getByRole("status").filter({ hasText: "●" })).toHaveText(
    "● Live",
  );
  await page.getByRole("button", { name: "Knowledge", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Knowledge areas" })
    .getByRole("button", { name: "AI index" })
    .click();
}
/** The index is built, in use, and has nothing waiting. */
async function ready(page: Page) {
  await expect(page.getByText("In use since")).toBeVisible({ timeout: 30000 });
  await expect(
    page.getByRole("status").filter({ hasText: /Up to date/ }),
  ).toBeVisible({ timeout: 30000 });
}
async function ask(page: Page, question: string, as: "AI agent" | "Inbox") {
  await page.getByLabel("Question", { exact: true }).fill(question);
  await page.getByLabel("Search as").selectOption({ label: as });
  await page.getByRole("button", { name: "Search", exact: true }).click();
}
const passages = (page: Page) =>
  page.getByRole("list", { name: "Passages found" });

test("the AI index: what it holds, try a question as the AI agent or the inbox, new content indexed on its own, and a re-embed that switches over", async ({
  page,
}) => {
  await publish(
    "idx-refunds",
    "Refund timing",
    "Refunds reach the card you paid with within five working days.",
  );
  await publish(
    "idx-playbook",
    "Angry customer playbook",
    "Escalate angry refund complaints to the billing lead before replying.",
    "internal",
  );
  await openIndex(page);
  await expect(
    page.getByRole("heading", { name: "Current index" }),
  ).toBeVisible();
  await ready(page);
  await expect(page.locator(".pg-index-card").first()).toContainText(
    "relay-test-hash · version 1 · 512 dimensions",
  );

  // The AI agent finds public content; internal content only in the inbox.
  await ask(page, "how long until my refund reaches my card", "AI agent");
  await expect(passages(page).getByRole("listitem").first()).toContainText(
    "Refund timing",
  );
  await ask(page, "angry refund complaints billing lead", "AI agent");
  await expect(passages(page)).not.toContainText("Angry customer playbook");
  await ask(page, "angry refund complaints billing lead", "Inbox");
  await expect(passages(page).getByRole("listitem").first()).toContainText(
    "Angry customer playbook",
  );
  await expect(passages(page).getByRole("listitem").first()).toContainText(
    "Internal article · en",
  );

  // Published content is indexed without anyone asking.
  await publish(
    "idx-pickup",
    "Store pickup",
    "Collect orders from the Leeds store any weekday after noon.",
  );
  await expect
    .poll(
      async () => {
        await ask(page, "collect order Leeds store weekday", "AI agent");
        return passages(page)
          .getByRole("listitem")
          .first()
          .innerText()
          .catch(() => "");
      },
      { timeout: 20000 },
    )
    .toContain("Store pickup");
  // A passage opens its record.
  await passages(page)
    .getByRole("listitem")
    .first()
    .getByRole("button", { name: "Store pickup" })
    .click();
  await expect(
    page.getByRole("region", { name: "Knowledge records" }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Knowledge areas" })
    .getByRole("button", { name: "AI index" })
    .click();

  // Re-embed everything: a new version is built beside the current one, then takes over.
  const [before] = await sql<{ id: string }>(
    "SELECT id FROM knowledge_index_generations WHERE status='active'",
  );
  await page.getByRole("button", { name: "Re-embed everything" }).click();
  await expect
    .poll(
      async () =>
        (
          await sql<{ id: string }>(
            "SELECT id FROM knowledge_index_generations WHERE status='active'",
          )
        )[0]?.id,
      { timeout: 30000 },
    )
    .not.toBe(before.id);
  await expect(page.getByRole("heading", { name: "Re-embedding" })).toHaveCount(
    0,
    {
      timeout: 20000,
    },
  );
  await expect(
    page.getByRole("button", { name: "Re-embed everything" }),
  ).toBeEnabled();
  await ask(page, "how long until my refund reaches my card", "AI agent");
  await expect(passages(page).getByRole("listitem").first()).toContainText(
    "Refund timing",
  );
});

test("when the embedding model is down, the page says so and the change waits; when it's back, the change is indexed", async ({
  page,
}) => {
  await openIndex(page);
  await ready(page);
  model.down = true;
  try {
    await publish(
      "idx-outage",
      "Holiday hours",
      "Support closes at three in the afternoon on public holidays.",
    );
    // The page shows the state when opened (and refreshes itself while indexing is busy).
    await openIndex(page);
    await expect(
      page.getByRole("alert").filter({ hasText: "EMBEDDING_UNAVAILABLE" }),
    ).toBeVisible({
      timeout: 20000,
    });
    await expect(
      page.getByRole("status").filter({ hasText: /1 record is waiting/ }),
    ).toBeVisible();
    // The current index is untouched meanwhile.
    await expect(page.locator(".pg-index-card").first()).toContainText(
      "relay-test-hash · version 1",
    );
  } finally {
    model.down = false;
  }
  await expect(
    page.getByRole("status").filter({ hasText: /Up to date/ }),
  ).toBeVisible({
    timeout: 30000,
  });
  await ask(page, "support closes public holidays afternoon", "AI agent");
  await expect(passages(page).getByRole("listitem").first()).toContainText(
    "Holiday hours",
  );
});

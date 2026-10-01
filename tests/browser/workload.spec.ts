import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { getIdentity } from "../../server/people";
import { command } from "../../server/conversations";

let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 900 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 8936, hostPort: 8937 });
  // Grace is away, so Billing's queue waits for the owner.
  await tenant(relay.db.connect, "demo", (db) =>
    db.query(
      "UPDATE teammates SET presence='away' WHERE workspace_id='demo' AND id='grace'",
    ),
  );
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
/** Customers write in; each conversation is put in the Billing team inbox. */
async function arrive(titles: string[]) {
  for (const title of titles)
    await tenant(relay.db.connect, "demo", async (db) => {
      const identity = await getIdentity(
        db,
        "demo",
        "anonymous",
        "workload-" + title,
      );
      const { conversationId } = (await command(
        db,
        "demo",
        {
          type: "contact",
          identityId: identity.identityId,
          brandId: "default",
        },
        "workload-" + title,
        { action: "start", text: title },
      )) as { conversationId: string };
      await command(
        db,
        "demo",
        { type: "teammate", principal: "local-owner" },
        "workload-team-" + title,
        {
          action: "assign",
          conversationId,
          teamId: "billing",
        },
      );
    });
}
async function open(page: Page) {
  await page.goto(relay.hostOrigin + "/agent");
  await expect(page.getByRole("status").filter({ hasText: "●" })).toHaveText(
    "● Live",
  );
}
const workload = (page: Page) =>
  page.getByRole("button", { name: /^Your workload:/ });
const assignedToOwner = async () =>
  (
    await sql(
      "SELECT count(*)::int AS n FROM conversations WHERE assigned='owner' AND status='open'",
    )
  )[0].n;

test("away, a queue builds, a paced return takes three, and Next conversation pulls one more", async ({
  page,
}) => {
  await open(page);
  await expect(workload(page)).toHaveText("Workload 0 / 5");
  // Status is set in the account menu.
  await page.getByRole("button", { name: /^Account:/ }).click();
  await page
    .getByRole("dialog", { name: "Account" })
    .getByRole("switch", { name: "Away" })
    .click();
  await page.keyboard.press("Escape");
  await expect
    .poll(
      async () =>
        (await sql("SELECT presence FROM teammates WHERE id='owner'"))[0]
          .presence,
    )
    .toBe("away");

  await arrive([
    "Queue 1",
    "Queue 2",
    "Queue 3",
    "Queue 4",
    "Queue 5",
    "Queue 6",
  ]);
  // The Workload panel explains the method and shows what is waiting.
  await workload(page).click();
  const panel = page.getByRole("dialog", { name: "Workload" });
  const billing = panel.getByRole("article", { name: "Team Billing" });
  await expect(billing).toContainText("Balanced.");
  await expect(billing).toContainText(
    "only within the teammate's and inbox's limits",
  );
  await expect(billing).toContainText("6 waiting");
  await billing.getByRole("button", { name: "Edit team settings" }).click();
  await expect(
    panel.getByRole("form", { name: "Settings for Billing" }),
  ).toContainText(
    "It ignores how busy anyone is and does not respect assignment limits.",
  );
  await panel.getByRole("button", { name: "Cancel" }).click();
  await panel.getByRole("button", { name: "Close" }).click();

  // Back: at most three arrive at once, not the whole queue.
  await page.getByRole("button", { name: /^Account:/ }).click();
  await page
    .getByRole("dialog", { name: "Account" })
    .getByRole("switch", { name: "Away" })
    .click();
  await page.keyboard.press("Escape");
  await expect(workload(page)).toHaveText("Workload 3 / 5");
  expect(await assignedToOwner()).toBe(3);

  // Next conversation pulls the next waiting one (oldest first) and opens it.
  await page.getByRole("button", { name: "Next conversation" }).click();
  await expect(
    page
      .getByRole("region", { name: "Conversation timeline" })
      .getByRole("heading", { name: "Queue 4" }),
  ).toBeVisible();
  await expect(workload(page)).toHaveText("Workload 4 / 5");
});

test("Next conversation at the limit is refused with the reason, and nothing is assigned", async ({
  page,
}) => {
  await open(page);
  // Shift+N from the keyboard pulls the fifth (the owner's limit).
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Shift+N");
  await expect(workload(page)).toHaveText("Workload 5 / 5");
  await page.keyboard.press("Shift+N");
  await expect(
    page.getByRole("alert").filter({ hasText: "You're at your limit" }),
  ).toHaveText(
    "You're at your limit (5 of 5). Close or snooze something first.",
  );
  expect(await assignedToOwner()).toBe(5);
  expect(
    (
      await sql(
        "SELECT count(*)::int AS n FROM conversations WHERE team_id='billing' AND assigned='' AND status='open'",
      )
    )[0].n,
  ).toBe(1);
});

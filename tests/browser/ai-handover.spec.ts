import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { standInClassifier, type ClassifierPort } from "../../server/ai-model";

/** The AI agent handing over to the team (phase 08, A2a; docs/AI_STEP2.md). */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
let classifierDown = false;
const classify: ClassifierPort = {
  model: "stand-in-classify",
  async classify(r) {
    if (classifierDown) throw new Error("The classifier is down.");
    return standInClassifier().classify(r);
  },
};
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({
    apiPort: 8998,
    hostPort: 8999,
    ai: { classify },
    inboxViews: true,
  });
  // No office hours, so the outcome doesn't depend on the day the test runs.
  await sql("DELETE FROM calendar_assignments");
  await sql("UPDATE brands SET settings=settings-'calendarId'-'calendarVersion'");
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
async function messenger(page: Page) {
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
  await page.goto(relay.hostOrigin);
  await page.getByRole("button", { name: "Open support", exact: true }).click();
  await expect
    .poll(() =>
      page.frames().some((f) => f.url().includes("/messenger/frame.html")),
    )
    .toBe(true);
  return page.frames().find((f) => f.url().includes("/messenger/frame.html"))!;
}
async function send(
  frame: Awaited<ReturnType<typeof messenger>>,
  text: string,
) {
  await frame.getByRole("button", { name: "Start a conversation" }).click();
  await frame.getByRole("textbox", { name: "Write your message" }).fill(text);
  await frame.getByRole("button", { name: "Send message" }).click();
}

test("the customer asks for a person after a reply the agent couldn't give; the conversation goes to the chosen team with a summary only teammates see", async ({
  page,
  browser,
}) => {
  // Zoe › Escalation: hand over to Billing.
  const agent = await (await browser.newContext()).newPage();
  await agent.goto(relay.hostOrigin + "/agent#zoe/escalation");
  await agent.getByLabel("Hand over to").selectOption({ label: "Billing" });
  await agent.getByRole("button", { name: "Save", exact: true }).click();
  await expect(agent.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();

  // The customer: a refusal with a button, then the handover.
  const frame = await messenger(page);
  await send(frame, "Can I pay for my plan with bitcoin?");
  const offer = frame.getByRole("button", { name: "Talk to a person" });
  await expect(offer).toBeVisible({ timeout: 20000 });
  await offer.click();
  await expect(
    frame.getByText(
      "I'm connecting you with someone from the team. They'll reply here.",
    ),
  ).toBeVisible({ timeout: 20000 });
  // The summary never reaches the customer.
  await expect(frame.getByText(/Handed over by Zoe/)).toHaveCount(0);
  const [row] = await sql<{ ai_state: string; team_id: string }>(
    "SELECT c.ai_state,c.team_id FROM conversations c JOIN conversation_parts p ON p.workspace_id=c.workspace_id AND p.conversation_id=c.id WHERE p.body='Can I pay for my plan with bitcoin?'",
  );
  expect(row).toEqual({ ai_state: "escalated", team_id: "billing" });

  // The teammate: "Escalated by Zoe" in the inbox menu, the card's state, and the summary.
  const inbox = await (await browser.newContext()).newPage();
  await inbox.goto(relay.hostOrigin + "/agent");
  await expect(inbox.getByRole("status").filter({ hasText: "●" })).toHaveText(
    "● Live",
  );
  const view = inbox
    .getByRole("navigation", { name: "Inbox views" })
    .getByRole("button", { name: /Escalated by Zoe/ });
  await expect(view).toBeVisible({ timeout: 15000 });
  await view.click();
  const card = inbox.locator(".pg-card", {
    hasText: "Can I pay for my plan with bitcoin?",
  });
  await expect(card).toBeVisible({ timeout: 15000 });
  await expect(card.locator(".pg-card-ai")).toHaveText("Zoe · escalated");
  await card.click();
  const summary = inbox
    .locator(".pg-message")
    .filter({ hasText: "Handover summary from Zoe · Team only" });
  await expect(summary).toContainText(
    "Handed over by Zoe. The customer asked for a person.",
  );
  await expect(summary).toContainText(
    "First message: “Can I pay for my plan with bitcoin?”",
  );
  await expect(summary).toContainText("AI replies: 1 couldn't answer.");
  const handover = inbox
    .locator(".pg-message")
    .filter({ hasText: "I'm connecting you with someone from the team." });
  await handover.getByRole("button", { name: "Why this reply" }).click();
  await expect(handover.locator(".pg-ai-why")).toContainText(
    "Handed to the team",
  );
});

test("when the classifier fails, a frustrated customer is still answered from content, and the reason says so", async ({
  page,
}) => {
  classifierDown = true;
  try {
    const frame = await messenger(page);
    await send(frame, "This is ridiculous, when do replies usually arrive?");
    await expect(
      frame
        .locator(".message")
        .filter({ hasText: "Replies usually arrive within an hour" }),
    ).toBeVisible({ timeout: 20000 });
    const [answer] = await sql<{ outcome: string; reason: string }>(
      "SELECT a.outcome,a.reason FROM ai_answers a JOIN conversation_parts p ON p.workspace_id=a.workspace_id AND p.id=a.question_part_id WHERE p.body=$1",
      ["This is ridiculous, when do replies usually arrive?"],
    );
    expect(answer.outcome).toBe("answered");
    expect(answer.reason).toContain(
      "The classifier was unavailable, so only the fixed handover triggers applied.",
    );
    const [c] = await sql<{ ai_state: string; team_id: string | null }>(
      "SELECT c.ai_state,c.team_id FROM conversations c JOIN conversation_parts p ON p.workspace_id=c.workspace_id AND p.conversation_id=c.id WHERE p.body=$1",
      ["This is ridiculous, when do replies usually arrive?"],
    );
    expect(c.ai_state).toBe("pending");
  } finally {
    classifierDown = false;
  }
});

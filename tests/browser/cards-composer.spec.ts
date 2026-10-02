import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { getIdentity } from "../../server/people";
import { command } from "../../server/conversations";

/**
 * Conversation cards, the conversation header, the composer and the details card
 * (docs/AGENT_CARDS_AND_COMPOSER.md).
 */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 900 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({
    apiPort: 8906,
    hostPort: 8907,
    inboxViews: true,
  });
});
test.afterAll(async () => {
  await relay?.close();
});
const teammate = { type: "teammate" as const, principal: "local-owner" };
type Step = [string, Record<string, unknown>];
/** A conversation started by a named customer, then the teammate's steps; returns its id and parts. */
async function conversation(name: string, title: string, steps: Step[] = []) {
  return tenant(relay.db.connect, "demo", async (db) => {
    const identity = await getIdentity(
      db,
      "demo",
      "anonymous",
      "cards-" + name,
    );
    const { conversationId } = (await command(
      db,
      "demo",
      { type: "contact", identityId: identity.identityId, brandId: "default" },
      "cards-start-" + title,
      { action: "start", text: title },
    )) as { conversationId: string };
    // The list and header read the conversation's name; the details card reads the contact's.
    await db.query("UPDATE conversations SET name=$2 WHERE id=$1", [
      conversationId,
      name,
    ]);
    await db.query("UPDATE contacts SET name=$2 WHERE id=$1", [
      identity.contactId,
      name,
    ]);
    const parts: string[] = [];
    for (const [i, [action, extra]] of steps.entries()) {
      const r = (await command(db, "demo", teammate, `cards-${title}-${i}`, {
        action,
        conversationId,
        ...extra,
      })) as { partId?: string };
      parts.push(r.partId ?? "");
    }
    return { id: conversationId, parts };
  });
}
const list = (page: Page) => page.getByTestId("virtual-conversations");
const card = (page: Page, title: string) =>
  list(page).locator(".pg-card", { hasText: title });
async function open(page: Page) {
  await page.goto(relay.hostOrigin + "/agent");
  await expect(page.getByRole("status").filter({ hasText: "●" })).toHaveText(
    "● Live",
  );
  await page
    .getByRole("navigation", { name: "Inbox views" })
    .getByRole("button", { name: /^All/ })
    .click();
}

test("cards show who, when, the latest message and the assignee; the header, composer and details follow Intercom", async ({
  page,
}) => {
  await conversation("Zack Jones", "How do I set up KYC verification?", [
    ["reply", { text: "Kindly provide your account email address." }],
    ["note", { text: "Kindly assist this trader with the KYC link." }],
    ["priority", { value: true }],
    ["assign", { teammateId: "owner" }],
  ]);
  await conversation("Isaiah Brooks", "What platforms do you offer?", [
    ["reply", { text: "Currently we only offer Tradovate." }],
  ]);
  await conversation("Maria Silva", "Payout request pending");
  await open(page);

  // A note leads with "Note", your own reply with "You", a customer's message with nothing.
  const zack = card(page, "How do I set up KYC verification?");
  await expect(zack).toBeVisible({ timeout: 15000 });
  await expect(zack.locator(".pg-avatar")).toHaveText("ZJ");
  await expect(zack).toContainText("Zack Jones");
  await expect(zack.locator(".pg-card-preview")).toHaveText(
    "Note: Kindly assist this trader with the KYC link.",
  );
  await expect(zack.locator("time")).toHaveText(/^(now|\d+m)$/);
  await expect(zack.locator(".pg-card-priority")).toBeVisible();
  await expect(zack.locator(".pg-card-assignee")).toHaveAttribute(
    "title",
    "Assigned to Support teammate",
  );
  await expect(
    card(page, "What platforms do you offer?").locator(".pg-card-preview"),
  ).toHaveText("You: Currently we only offer Tradovate.");
  await expect(
    card(page, "Payout request pending").locator(".pg-card-preview"),
  ).toHaveText("Payout request pending");
  await expect(
    card(page, "Payout request pending").locator(".pg-card-assignee"),
  ).toHaveCount(0);
  // Cards are the virtual list's fixed height.
  expect((await zack.boundingBox())!.height).toBe(112);

  // The header: the customer's avatar, name and the conversation's title.
  await zack.click();
  const thread = page.getByRole("region", { name: "Conversation timeline" });
  const header = thread.locator(".pg-thread-who");
  await expect(header.locator(".pg-avatar")).toHaveText("ZJ");
  await expect(header).toContainText("Zack Jones");
  await expect(
    thread.getByRole("heading", { name: "How do I set up KYC verification?" }),
  ).toBeVisible();

  // Bubbles: the customer's on the left, the team's on the right in a different colour.
  const log = page.getByRole("log", { name: "Messages" });
  const theirs = log.locator(".pg-bubble-row.customer .from-customer").first();
  const ours = log.locator(".pg-bubble-row.team .from-team").first();
  await expect(theirs).toContainText("How do I set up KYC verification?");
  await expect(ours).toContainText(
    "Kindly provide your account email address.",
  );
  await expect(log.locator(".pg-bubble-row.team .pg-note")).toContainText(
    "Kindly assist this trader",
  );
  const [left, right] = [await theirs.boundingBox(), await ours.boundingBox()];
  expect(left!.x).toBeLessThan(right!.x);
  expect(left!.x + left!.width).toBeLessThan(right!.x + right!.width);
  const background = (l: typeof ours) =>
    l.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await background(theirs)).not.toBe(await background(ours));

  // The composer: Reply and Internal note with Macros on top; formatting beside Send below.
  const composer = thread.locator("form.pg-composer");
  const reply = composer.getByRole("button", { name: "Reply", exact: true });
  const macros = composer.getByRole("button", { name: /^Macros/ });
  const formatting = composer.getByRole("toolbar", { name: "Formatting" });
  const sendButton = composer.getByRole("button", { name: "Send reply" });
  const editor = composer.getByRole("textbox", { name: "Reply message" });
  await expect(macros).toBeVisible();
  const [top, tools, sendBox, box] = await Promise.all([
    reply.boundingBox(),
    formatting.boundingBox(),
    sendButton.boundingBox(),
    editor.boundingBox(),
  ]);
  expect(Math.abs(top!.y - (await macros.boundingBox())!.y)).toBeLessThan(6);
  expect(tools!.y).toBeGreaterThan(box!.y + box!.height - 1);
  expect(
    Math.abs(tools!.y + tools!.height / 2 - (sendBox!.y + sendBox!.height / 2)),
  ).toBeLessThan(12);
  expect(tools!.x).toBeLessThan(sendBox!.x);
  // Macros opens the macro picker.
  await macros.click();
  await expect(page.getByRole("listbox", { name: "Macros" })).toBeVisible();
  await page.keyboard.press("Escape");

  // The details panel starts with a contact card.
  const details = page.getByRole("complementary", {
    name: "Conversation details",
  });
  await expect(details.locator(".pg-ctx-card")).toContainText("Zack Jones");
  await expect(details.locator(".pg-ctx-role")).toHaveText("Type: Visitor");
});

test("a deleted last message previews the one before it, and a conversation with no messages says so", async ({
  page,
}) => {
  const { id, parts } = await conversation("Ada Okafor", "Refund question", [
    ["reply", { text: "We can refund that today." }],
    ["note", { text: "Wrong customer, deleting this note." }],
  ]);
  await tenant(relay.db.connect, "demo", (db) =>
    command(db, "demo", teammate, "cards-delete-note", {
      action: "delete",
      conversationId: id,
      partId: parts[1],
    }),
  );
  await tenant(relay.db.connect, "demo", (db) =>
    db.query(
      "INSERT INTO conversations(workspace_id,id,brand_id,token_hash,name,email,title,status,assigned,created_at,updated_at) VALUES('demo','cards-empty','default','','Customer','','Imported without messages','open','',now(),now())",
    ),
  );
  await open(page);
  await expect(
    card(page, "Refund question").locator(".pg-card-preview"),
  ).toHaveText("You: We can refund that today.", { timeout: 15000 });
  await expect(card(page, "Refund question")).not.toContainText("deleting");
  await expect(
    card(page, "Imported without messages").locator(".pg-card-preview"),
  ).toHaveText("No messages yet");
});

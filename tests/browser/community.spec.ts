import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { ingestDiscordMessage } from "../../server/community";

/**
 * Slack and Discord (phase 12, E8; docs/OMNICHANNEL_STEP8.md), with the demo's seeded Slack
 * workspace and Discord server: a Slack message becomes a conversation and the reply goes into its
 * thread; a Discord message (as its gateway hands it over) becomes one and the reply answers it; a
 * forged Slack call is refused; a bad token isn't connected; a disconnected server is ignored.
 */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9050, hostPort: 9051, inboxViews: true, aiAgent: false, exampleCommunity: true });
});
test.afterAll(async () => {
  await relay?.close();
});

async function slack(payload: unknown, secret?: string) {
  const call = await relay.community.slackSigned(payload, secret);
  return fetch(relay.apiOrigin + "/v1/hooks/slack/demo", {
    method: "POST",
    headers: { "x-slack-request-timestamp": call.timestamp, "x-slack-signature": call.signature },
    body: call.body,
  });
}
const settled = () =>
  expect
    .poll(async () => (await tenant(relay.db.connect, "demo", (db) => db.query("SELECT count(*)::int AS n FROM community_inbound WHERE status='received'"))).rows[0].n, { timeout: 15000 })
    .toBe(0);
async function open(page: Page, card: string) {
  await page.goto(relay.hostOrigin + "/agent");
  await page.locator(".pg-card", { hasText: card }).click();
}
const timeline = (page: Page) => page.getByRole("region", { name: "Conversation timeline" });

test("a Slack message's reply goes into its thread; a Discord message's reply answers it", async ({ page }) => {
  relay.community.people.set("U0ADA", "Ada");
  const root = relay.community.slackMessage({ channel: "C0SUPPORT", user: "U0ADA", text: "Is the API down for anyone else?" });
  expect((await slack(root)).status).toBe(200);
  await settled();
  await open(page, "Is the API down");
  await expect(timeline(page).locator(".pg-message", { hasText: "Is the API down" })).toContainText("via Slack");
  await page.getByRole("textbox", { name: "Reply message" }).fill("We're looking into it now.");
  await page.getByRole("button", { name: "Send reply", exact: true }).click();
  await expect.poll(() => relay.community.slackSent.length, { timeout: 15000 }).toBe(1);
  expect(relay.community.slackSent[0]).toMatchObject({ channel: "C0SUPPORT", text: "We're looking into it now.", threadTs: root.event.ts });
  // Their reply in the thread joins the conversation.
  await slack(relay.community.slackMessage({ channel: "C0SUPPORT", user: "U0ADA", text: "Thanks, it's back", thread_ts: root.event.ts }));
  await settled();
  await page.reload();
  await page.locator(".pg-card", { hasText: "it's back" }).click();
  await expect(timeline(page).locator(".pg-message", { hasText: "Is the API down" })).toBeVisible();

  const m = relay.community.discordMessage({ channel: "700000000000000001", author: "600000000000000001", username: "Grace", content: "How do I rotate my API key?" });
  expect(await ingestDiscordMessage(relay.db.connect, "demo", "demo-discord", m)).toEqual({ kept: true });
  await settled();
  await open(page, "rotate my API key");
  await expect(timeline(page).locator(".pg-message", { hasText: "rotate my API key" })).toContainText("via Discord");
  await page.getByRole("textbox", { name: "Reply message" }).fill("Settings › API keys › Rotate.");
  await page.getByRole("button", { name: "Send reply", exact: true }).click();
  await expect.poll(() => relay.community.discordSent.length, { timeout: 15000 }).toBe(1);
  expect(relay.community.discordSent[0]).toMatchObject({ channel: "700000000000000001", body: { content: "Settings › API keys › Rotate.", message_reference: { message_id: m.id } } });

  // Settings › Slack & Discord: both connected; Discord's gateway state shown.
  await page.goto(relay.hostOrigin + "/agent#settings/community");
  await expect(page.getByLabel("Status of Slack Relay Community")).toContainText("Connected");
  await expect(page.getByLabel("Status of Discord Relay")).toContainText("gateway: local: messages by /dev/discord");
});

test("a forged Slack call is refused; a bad Slack token isn't connected; a disconnected Discord server is ignored", async ({ page }) => {
  expect((await slack(relay.community.slackMessage({ channel: "C0SUPPORT", user: "U0EVE", text: "Forged message" }), "f".repeat(32))).status).toBe(403);
  await page.goto(relay.hostOrigin + "/agent");
  await expect(page.locator(".pg-card", { hasText: "Forged message" })).toHaveCount(0);

  await page.goto(relay.hostOrigin + "/agent#settings/community");
  const form = page.getByRole("form", { name: "Connect Slack" });
  await form.getByLabel("Bot token").fill("xoxb-a-token-slack-refuses-0000");
  await form.getByLabel("Signing secret").fill("0".repeat(32));
  await form.getByRole("button", { name: "Connect Slack" }).click();
  await expect
    .poll(async () => (await tenant(relay.db.connect, "demo", (db) => db.query("SELECT status,error FROM community_connections WHERE token_hint='0000'"))).rows[0], { timeout: 15000 })
    .toEqual({ status: "failed", error: "Slack refused: invalid_auth" });
  await page.reload();
  await expect(page.getByText("Slack refused: invalid_auth")).toBeVisible();

  await page.getByLabel("Status of Discord Relay").locator("..").getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByRole("status").first()).toHaveText("Disconnected Discord.");
  const after = relay.community.discordMessage({ channel: "700000000000000001", author: "600000000000000003", content: "Anyone there?" });
  expect(await ingestDiscordMessage(relay.db.connect, "demo", "demo-discord", after)).toEqual({ kept: false });
});

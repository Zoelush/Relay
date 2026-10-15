import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { LOCAL_TWILIO } from "../../scripts/local-sms";
import { tenant } from "../../server/db";

/**
 * Voice (phase 12, E9; docs/OMNICHANNEL_STEP9.md), with the demo's seeded UK number taking calls
 * and the owner's phone for transfers: a caller agrees to recording, is transferred warm (the
 * owner presses 1), and the call's end, recording and transcript reach its conversation, which
 * can't be answered in writing; Settings › Voice shows the call and buys a number once confirmed.
 * A forged call is refused; a caller who declines recording and finds nobody leaves a voicemail;
 * a search Twilio refuses says why.
 */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9052, hostPort: 9053, inboxViews: true, aiAgent: false, exampleSms: true, exampleVoice: true });
  // Office hours closed send a call straight to voicemail: none here, so the run doesn't depend on the time of day.
  await tenant(relay.db.connect, "demo", async (db) => {
    await db.query("DELETE FROM calendar_assignments");
    await db.query("UPDATE brands SET settings=settings-'calendarId'-'calendarVersion'");
  });
});
test.afterAll(async () => {
  await relay?.close();
});

const UK = LOCAL_TWILIO.numbers[0];
/** A call's step as Twilio makes it, signed over the exact URL and form; jobs settle after. */
async function step(path: string, params: Record<string, string>, token?: string) {
  const url = `${relay.apiOrigin}/v1/hooks/voice/demo/${path}`;
  const call = await relay.sms.signed(url, params, token);
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": call.signature }, body: call.body });
  const xml = r.status === 200 ? await r.text() : "";
  await expect
    .poll(async () => (await tenant(relay.db.connect, "demo", (db) => db.query("SELECT count(*)::int AS n FROM jobs WHERE kind LIKE 'voice.%' AND state IN ('queued','running')"))).rows[0].n, { timeout: 15000 })
    .toBe(0);
  return { status: r.status, xml };
}
const callId = async (sid: string) => (await tenant(relay.db.connect, "demo", (db) => db.query<{ id: string }>("SELECT id FROM voice_calls WHERE call_sid=$1", [sid]))).rows[0].id;
async function open(page: Page, card: string) {
  await page.goto(relay.hostOrigin + "/agent");
  await page.locator(".pg-card", { hasText: card }).first().click();
}
const timeline = (page: Page) => page.getByRole("region", { name: "Conversation timeline" });

test("a recorded call is transferred warm; its end, recording and transcript reach the conversation; Settings shows it and buys a number", async ({ page }) => {
  const ada = { sid: "CA" + "1".repeat(32), from: "+447700900456", to: UK };
  let r = await step("incoming", relay.sms.call(ada));
  expect(r.xml).toContain("Press 1 to agree");
  await step("consent", relay.sms.call(ada, { Digits: "1" }));
  expect(relay.sms.recordings.map((x) => x.callSid)).toEqual([ada.sid]);
  // Zoe is off here (no AI agent): straight to the team; the owner's phone is rung and whispered to.
  r = await step("route", relay.sms.call(ada));
  expect(r.xml).toContain("/transfer?i=0");
  r = await step("transfer?i=0", relay.sms.call(ada));
  expect(r.xml).toContain(">+447700900999</Number>");
  const id = await callId(ada.sid);
  const leg = relay.sms.call({ sid: "CA" + "2".repeat(32), from: UK, to: "+447700900999" });
  r = await step(`whisper?call=${id}`, leg);
  expect(r.xml).toContain("Relay call from 4 4 7 7 0 0 9 0 0 4 5 6.");
  await step(`accept?call=${id}`, { ...leg, Digits: "1" });
  await step("dialed?i=0", relay.sms.call(ada, { DialCallStatus: "completed" }));
  expect((await step("status", relay.sms.call(ada, { CallStatus: "completed", CallDuration: "95" }))).status).toBe(204);
  await step("recording?kind=call", relay.sms.recorded(ada.sid, new Uint8Array(2048), 64));

  await open(page, "Incoming call");
  await expect(timeline(page).locator(".pg-message", { hasText: "Incoming call" })).toContainText("via Phone");
  await expect(timeline(page).locator(".pg-note", { hasText: "Call from +447700900456 being transferred" })).toBeVisible();
  await timeline(page).getByRole("button", { name: /Show \d+ updates/ }).last().click();
  await expect(timeline(page).getByText(/took the call$/)).toBeVisible();
  await expect(timeline(page).getByText("Call ended after 1:35")).toBeVisible();
  await expect(timeline(page).getByText("Transcript 0:00: (Stand-in transcript of 2048 bytes.)")).toBeVisible();
  await expect(page.getByLabel("Where this reply goes")).toHaveText("Phone call to +447700900456");
  await expect(page.getByRole("status").filter({ hasText: "call +447700900456 back" })).toHaveText("A call can't be answered in writing: call +447700900456 back, or text them.");

  // Settings › Voice: the number takes calls, the call is listed; a number is bought only once confirmed.
  await page.goto(relay.hostOrigin + "/agent#settings/voice");
  await expect(page.getByLabel(`${UK} takes calls`)).toBeChecked();
  await expect(page.getByRole("table", { name: "Recent calls" })).toContainText("+447700900456");
  await expect(page.getByRole("table", { name: "Recent calls" })).toContainText("Answered by the team");
  const find = page.getByRole("form", { name: "Find a number" });
  await find.getByLabel("Country (two letters)").fill("GB");
  await find.getByRole("button", { name: "Find numbers" }).click();
  await expect(page.getByRole("status").first()).toContainText("Searching GB");
  await expect.poll(async () => (await tenant(relay.db.connect, "demo", (db) => db.query("SELECT searched_at IS NOT NULL AS done FROM voice_settings"))).rows[0].done, { timeout: 15000 }).toBe(true);
  await page.getByRole("button", { name: "Refresh" }).click();
  await page.getByRole("button", { name: "Buy +447700900200" }).click();
  await expect(page.getByRole("list", { name: "Numbers you can buy" })).toContainText("Charged to your Twilio account.");
  expect(relay.sms.bought).toHaveLength(0);
  await page.getByRole("button", { name: "Confirm purchase" }).click();
  await expect.poll(() => relay.sms.bought.map((b) => b.phone), { timeout: 15000 }).toEqual(["+447700900200"]);
  await page.reload();
  await expect(page.getByLabel("+447700900200 takes calls")).toBeChecked();
});

test("a forged call is refused; a caller who declines recording and finds nobody leaves a voicemail; a refused search says why", async ({ page }) => {
  const eve = { sid: "CA" + "3".repeat(32), from: "+447700900666", to: UK };
  expect((await step("incoming", relay.sms.call(eve), "f".repeat(32))).status).toBe(403);
  expect((await tenant(relay.db.connect, "demo", (db) => db.query("SELECT 1 FROM voice_calls WHERE call_sid=$1", [eve.sid]))).rows).toHaveLength(0);

  const bo = { sid: "CA" + "4".repeat(32), from: "+447700900457", to: UK };
  await step("incoming", relay.sms.call(bo));
  expect((await step("consent", relay.sms.call(bo, { Digits: "2" }))).xml).toContain("This call won't be recorded.");
  await step("route", relay.sms.call(bo));
  await step("transfer?i=0", relay.sms.call(bo));
  let r = await step("dialed?i=0", relay.sms.call(bo, { DialCallStatus: "no-answer" }));
  r = await step("transfer?i=1", relay.sms.call(bo));
  expect(r.xml).toContain("/voicemail<");
  r = await step("voicemail", relay.sms.call(bo));
  expect(r.xml).toContain("<Record ");
  await step("recording?kind=voicemail", relay.sms.recorded(bo.sid, new Uint8Array(512), 9));
  await step("status", relay.sms.call(bo, { CallStatus: "completed", CallDuration: "30" }));
  expect(relay.sms.recordings.filter((x) => x.callSid === bo.sid)).toHaveLength(0);

  await open(page, "Voicemail: (Stand-in transcript of 512 bytes.)");
  await expect(timeline(page).locator(".pg-message", { hasText: "Voicemail: (Stand-in transcript of 512 bytes.)" })).toContainText("via Phone");
  // Written replies can't reach a caller: refused when written.
  await page.getByRole("textbox", { name: "Reply message" }).fill("Calling you back now");
  await page.getByRole("button", { name: "Send reply", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "A call can't be answered in writing" })).toBeVisible();

  await page.goto(relay.hostOrigin + "/agent#settings/voice");
  await expect(page.getByRole("table", { name: "Recent calls" })).toContainText("Declined recording");
  const find = page.getByRole("form", { name: "Find a number" });
  await find.getByLabel("Country (two letters)").fill("XX");
  await find.getByRole("button", { name: "Find numbers" }).click();
  await expect.poll(async () => (await tenant(relay.db.connect, "demo", (db) => db.query("SELECT last_search->>'error' AS e FROM voice_settings"))).rows[0].e, { timeout: 15000 }).toBe("Twilio refused: No numbers in XX.");
  await page.reload();
  await expect(page.getByText("Twilio refused: No numbers in XX.")).toBeVisible();
});

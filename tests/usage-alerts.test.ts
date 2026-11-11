import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { getIdentity, seedFoundation } from "../server/people";
import { command } from "../server/conversations";
import { hashPassword } from "../server/passwords";
import { changeLimits, readLimits } from "../server/limits";
import { alertText, checkUsageAlerts } from "../server/usage-alerts";
import { sendAlert } from "../server/email-out";
import { listNotifications } from "../server/mentions";
import { localEmailProvider } from "../scripts/local-email";
import type { Job } from "../server/jobs";
import PostalMime from "postal-mime";

/** Usage alerts (phase 16, C9c; docs/SECURITY_STEP18.md). */
test("alert text names the threshold, what it's of, and the amounts", () => {
  assert.equal(alertText({ subject: "emails", threshold: 80, used: 8, of: 10 }), "80% of this period's limit for emails: 8 of 10.");
  assert.equal(alertText({ subject: "spend_cap", threshold: 100, used: 2500, of: 2500 }), "100% of this period's spend cap: $25.00 of $25.00.");
});

test("usage alerts: billing managers on full seats told once per threshold per period, in the app and by email; thresholds set and checked; per workspace; rollback", async () => {
  const db = await testDatabase();
  const q = <T = any>(w: string, sql: string, values: unknown[] = []) => tenant(db.connect, w, async (x) => (await x.query<T>(sql, values)).rows);
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (x) => seedFoundation(x, w, "owner-" + w, { origins: [], master: "m".repeat(40), identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }));
      await q(w, "UPDATE workspace_features SET enabled=true");
    }
    const owner = (await q<{ id: string }>("a", "SELECT id FROM teammates WHERE principal_id='owner-a'"))[0].id;
    await q("a", "INSERT INTO teammate_credentials(workspace_id,teammate_id,email,password_hash) VALUES('a',$1,'owner@example.test',$2)", [owner, hashPassword("a long, varied passphrase")]);
    // An agent (no billing.manage) and an admin on a limited seat: neither is told.
    await q("a", "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','agent-1','agent-1-a','Agent one','agent'),('a','admin-1','admin-1-a','Admin one','admin')");
    await q("a", "UPDATE teammates SET seat='limited' WHERE id='admin-1'");
    await q("a", "UPDATE workspace_plans SET period_anchor=now()-interval '3 days'");

    // Emails sent this period, as deliveries.
    const conv = await tenant(db.connect, "a", async (x) => {
      const who = await getIdentity(x, "a", "user", "ada", { name: "Ada", email: "ada@customer.example" });
      const r = (await command(x, "a", { type: "contact", identityId: who.identityId, brandId: "default" }, crypto.randomUUID(), { action: "start", text: "Hello" } as unknown as Parameters<typeof command>[4])) as {
        conversationId: string;
      };
      const part = (await x.query<{ id: string }>("SELECT id FROM conversation_parts WHERE conversation_id=$1 AND body<>'' LIMIT 1", [r.conversationId])).rows[0].id;
      return { id: r.conversationId, part };
    });
    const sendEmails = async (n: number) => {
      for (let i = 0; i < n; i++)
        await q("a", "INSERT INTO channel_deliveries(workspace_id,id,part_id,conversation_id,channel,identity_id,address,status) VALUES('a',$1,$2,$3,'email',$4,'ada@customer.example','sent')", [
          crypto.randomUUID(),
          conv.part,
          conv.id,
          crypto.randomUUID(),
        ]);
    };
    const check = (now?: Date) => checkUsageAlerts(db.connect, "a", now);

    // No limits: nothing to alert on. The default thresholds are 80% and 100%.
    await sendEmails(7);
    assert.equal(await check(), 0);
    assert.deepEqual((await tenant(db.connect, "a", (x) => readLimits(x, "a"))).alertThresholds, [80, 100]);

    // A limit of 10: 7 is under 80%; 8 crosses it, once.
    await tenant(db.connect, "a", (x) => changeLimits(x, "a", "owner-a", { limits: { emails: 10 } }));
    assert.equal(await check(), 0);
    await sendEmails(1);
    assert.equal(await check(), 1);
    assert.equal(await check(), 0, "once per threshold per period");
    const notified = await q<{ teammate_id: string; excerpt: string }>("a", "SELECT teammate_id,excerpt FROM notifications WHERE kind='usage_alert'");
    assert.deepEqual(notified, [{ teammate_id: owner, excerpt: "80% of this period's limit for emails: 8 of 10." }], "only billing managers on full seats");
    const listed = (await tenant(db.connect, "a", (x) => listNotifications(x, "a", "owner-a"))).items;
    assert.equal(listed[0].kind, "usage_alert");

    // The email goes through the alert path.
    const emails = await q<{ id: string; address: string; kind: string }>("a", "SELECT id,address,kind FROM email_alerts WHERE kind='usage'");
    assert.deepEqual(emails.map((e) => e.address), ["owner@example.test"]);
    const provider = localEmailProvider();
    const job = (await q<Job>("a", "SELECT * FROM jobs WHERE kind='email.alert' AND payload->>'alertId'=$1", [emails[0].id]))[0];
    await sendAlert(db.connect, { sender: provider.sender, inboundDomain: "in.test", sendingDomain: "relay.test", region: "eu-west-2" }, job);
    const sent = await PostalMime.parse(provider.outbox.at(-1)!.raw);
    assert.equal(sent.subject, "Relay usage: 80% of a limit in Relay");
    assert.match(sent.text ?? "", /80% of this period's limit for emails: 8 of 10\./);
    assert.match(sent.text ?? "", /Settings › Billing › Usage/);
    assert.equal((await q("a", "SELECT status FROM email_alerts WHERE id=$1", [emails[0].id]))[0].status, "sent");

    // 100%: the second threshold, once.
    await sendEmails(2);
    assert.equal(await check(), 1);
    assert.deepEqual((await q<{ threshold: number }>("a", "SELECT threshold FROM usage_alerts ORDER BY threshold")).map((r) => r.threshold), [80, 100]);
    // A new period starts afresh (and its usage is below the thresholds).
    assert.equal(await check(new Date(Date.now() + 40 * 86_400_000)), 0);

    // Thresholds: up to 5 whole percentages from 1 to 100; none turns alerts off.
    await assert.rejects(tenant(db.connect, "a", (x) => changeLimits(x, "a", "owner-a", { alertThresholds: [0] })), /up to 5 percentages/);
    await assert.rejects(tenant(db.connect, "a", (x) => changeLimits(x, "a", "owner-a", { alertThresholds: [10, 20, 30, 40, 50, 60] })), /up to 5 percentages/);
    await assert.rejects(tenant(db.connect, "a", (x) => changeLimits(x, "a", "agent-1-a", { alertThresholds: [50] })), /permission/);
    const set = await tenant(db.connect, "a", (x) => changeLimits(x, "a", "owner-a", { alertThresholds: [100, 50, 50] }));
    assert.deepEqual(set.alertThresholds, [50, 100]);
    assert.equal(await check(), 1, "50% is new this period");
    await tenant(db.connect, "a", (x) => changeLimits(x, "a", "owner-a", { alertThresholds: [] }));
    await tenant(db.connect, "a", (x) => changeLimits(x, "a", "owner-a", { limits: { whatsapp: 1 } }));
    assert.equal(await check(), 0, "no thresholds, no alerts");

    // Another workspace is never told about this one.
    assert.equal((await q("b", "SELECT count(*)::int AS n FROM notifications WHERE kind='usage_alert'"))[0].n, 0);
    assert.equal(await checkUsageAlerts(db.connect, "b"), 0);

    // The rollback: thresholds cleared everywhere; sent alerts stay.
    await tenant(db.connect, "a", (x) => changeLimits(x, "a", "owner-a", { alertThresholds: [10] }));
    await db.pg.exec(await readFile("db/rollback/0096_usage_alerts.sql", "utf8"));
    assert.deepEqual((await tenant(db.connect, "a", (x) => readLimits(x, "a"))).alertThresholds, []);
    assert.equal(await check(), 0);
    assert.ok((await q("a", "SELECT count(*)::int AS n FROM usage_alerts"))[0].n >= 3);
  } finally {
    await db.close();
  }
});

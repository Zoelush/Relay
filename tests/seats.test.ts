import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { getIdentity, seedFoundation } from "../server/people";
import { command } from "../server/conversations";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { can, scopeOf } from "../server/policy";
import { searchConversations } from "../server/search";
import { changeSeat, readSeats } from "../server/seats";
import { periodOf, seatBill, type SeatChange } from "../lib/seats";

/** Seats (phase 16, C8b; docs/SECURITY_STEP15.md). */
const d = (iso: string) => new Date(iso);

test("seat billing: monthly periods from the anchor; additions prorated by the second, removals at period end, never charged twice", () => {
  // Periods: the anchor's day, clamped to short months.
  assert.deepEqual(periodOf(d("2026-01-31T10:00:00Z"), d("2026-02-15T00:00:00Z")), { start: d("2026-01-31T10:00:00Z"), end: d("2026-02-28T10:00:00Z") });
  assert.deepEqual(periodOf(d("2026-01-31T10:00:00Z"), d("2026-03-01T00:00:00Z")), { start: d("2026-02-28T10:00:00Z"), end: d("2026-03-31T10:00:00Z") });
  assert.deepEqual(periodOf(d("2026-11-06T00:00:00Z"), d("2026-11-06T00:00:00Z")), { start: d("2026-11-06T00:00:00Z"), end: d("2026-12-06T00:00:00Z") });

  const period = { start: d("2026-11-01T00:00:00Z"), end: d("2026-12-01T00:00:00Z") };
  const c = (id: string, from: SeatChange["from"], to: SeatChange["to"], at: string): SeatChange => ({ teammateId: id, teammateName: id, from, to, at: d(at) });
  const changes = [
    c("ada", null, "full", "2026-10-01T00:00:00Z"), // full before the period: a whole period
    c("bob", null, "full", "2026-10-15T00:00:00Z"),
    c("bob", "full", "limited", "2026-11-10T00:00:00Z"), // removed: stays paid, no credit
    c("bob", "limited", "full", "2026-11-20T00:00:00Z"), // back: already paid this period
    c("cy", null, "full", "2026-11-16T00:00:00Z"), // added halfway: half the period
    c("dee", null, "limited", "2026-11-02T00:00:00Z"), // limited: free
    c("eve", null, "full", "2026-11-21T00:00:00Z"),
    c("eve", "full", "limited", "2026-11-25T00:00:00Z"), // added then removed: the addition stands
  ];
  const free = seatBill(changes, period, null);
  assert.equal(free.fullAtStart, 2);
  assert.deepEqual(
    free.prorations.map((p) => [p.teammateId, p.fraction, p.amountCents]),
    [
      ["cy", 0.5, null],
      ["eve", 0.333333, null],
    ],
  );
  assert.equal(free.baseCents, null);
  assert.equal(free.fullNextPeriod, 3, "ada, bob and cy; eve's removal takes effect next period");
  const priced = seatBill(changes, period, 3000);
  assert.deepEqual([priced.baseCents, priced.prorations.map((p) => p.amountCents), priced.proratedCents], [6000, [1500, 1000], 2500]);
});

test("seats: the ledger written by the database; limited seats keep only reading and notes, by link; the Seats page; per workspace; rollback", async () => {
  const db = await testDatabase();
  const api: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    realtimeUrl: "wss://relay.test/realtime",
    storageTransport: "local-pglite",
  };
  const q = <T = any>(w: string, sql: string, values: unknown[] = []) => tenant(db.connect, w, async (x) => (await x.query<T>(sql, values)).rows);
  const agent = async (path: string, data?: unknown, principal = "owner-a", w = "a") => {
    const r = await bridgeAgentRequest(
      new Request("https://app.test/api/agent/" + path, {
        method: data === undefined ? "GET" : "POST",
        headers: { origin: "https://app.test", "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      }),
      principal,
      { RELAY_AGENT_INBOX_V1: "true", RELAY_STORAGE_AUTHORITY: "postgres", RELAY_API_ORIGIN: "https://relay.test", RELAY_WORKSPACE_ID: w, RELAY_BRIDGE_SECRET: api.bridgeSecret },
      (x) => handleApi(x, api),
    );
    return { status: r.status, body: (await r.json()) as any };
  };
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (x) => seedFoundation(x, w, "owner-" + w, { origins: [], master: api.identityMaster, identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }));
      await q(w, "UPDATE workspace_features SET enabled=true");
      await q(w, "DELETE FROM calendar_assignments");
    }
    // Joining writes the ledger: a full seat by default.
    await q("a", "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','agent-1','agent-1-a','Agent one','agent')");
    const ledger = () => q<{ teammate_id: string; from_seat: string | null; to_seat: string; actor_name: string | null }>("a", "SELECT teammate_id,from_seat,to_seat,actor_name FROM seat_changes ORDER BY seq");
    assert.deepEqual((await ledger()).map((r) => [r.teammate_id, r.from_seat, r.to_seat]).slice(-1), [["agent-1", null, "full"]]);
    assert.ok((await ledger()).some((r) => r.to_seat === "full" && r.from_seat === null && r.teammate_id !== "agent-1"), "the owner too");

    // A customer's conversation, assigned to the agent.
    const conv = await tenant(db.connect, "a", async (x) => {
      const who = await getIdentity(x, "a", "user", "ada", { name: "Ada", email: "ada@customer.example" });
      return (await command(x, "a", { type: "contact", identityId: who.identityId, brandId: "default" }, crypto.randomUUID(), { action: "start", text: "Hello seats" } as unknown as Parameters<typeof command>[4])) as {
        conversationId: string;
      };
    });
    assert.equal((await agent("inbox", undefined, "agent-1-a")).body.conversations.length, 1, "a full seat lists it");

    // Changing a seat: billing.manage only; the owner always full; recorded with the actor and audited.
    assert.equal((await agent("seats", { teammateId: "agent-1", seat: "limited" }, "agent-1-a")).status, 403);
    const ownerId = (await q<{ id: string }>("a", "SELECT id FROM teammates WHERE principal_id='owner-a'"))[0].id;
    const refused = await agent("seats", { teammateId: ownerId, seat: "limited" });
    assert.deepEqual([refused.status, refused.body.error.message], [409, "The owner always has a full seat."]);
    const changed = await agent("seats", { teammateId: "agent-1", seat: "limited" });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.deepEqual([changed.body.full, changed.body.limited], [1, 1]);
    const last = (await ledger()).at(-1)!;
    assert.deepEqual([last.teammate_id, last.from_seat, last.to_seat, last.actor_name], ["agent-1", "full", "limited", (await q<{ name: string }>("a", "SELECT name FROM teammates WHERE id=$1", [ownerId]))[0].name]);
    assert.ok((await q("a", "SELECT 1 FROM audit_events WHERE action='teammate.changed' AND target_id='agent-1'")).length >= 1);
    await assert.rejects(q("a", "UPDATE seat_changes SET to_seat='full'"), /append-only/);

    // A limited seat: no lists, counts, views or search; it opens by link, reads and notes; no reply or assignment.
    const snapshot = (await agent("inbox", undefined, "agent-1-a")).body;
    assert.deepEqual([snapshot.conversations.length, snapshot.counters.length, snapshot.account.limitedSeat], [0, 0, true]);
    assert.deepEqual([snapshot.capabilities.reply, snapshot.capabilities.note], [false, true]);
    assert.deepEqual((await agent("views", undefined, "agent-1-a")).body.views, []);
    const search = (principal: string) => tenant(db.connect, "a", async (x) => (await searchConversations(x, "a", new URLSearchParams("q=Hello"), await scopeOf(x, "a", principal))).conversations);
    assert.deepEqual(await search("agent-1-a"), [], "search finds nothing for a limited seat");
    const opened = await agent("inbox?conversation=" + conv.conversationId, undefined, "agent-1-a");
    assert.equal(opened.status, 200, "opened by link");
    const cmd = (p: Record<string, unknown>) => agent("command", { conversationId: conv.conversationId, ...p }, "agent-1-a");
    assert.equal((await cmd({ action: "note", text: "Seen it" })).status, 200);
    assert.equal((await cmd({ action: "reply", text: "Hi" })).status, 403);
    assert.equal((await cmd({ action: "assign", teammateId: "agent-1" })).status, 403);
    assert.equal((await agent("settings?section=overview", undefined, "agent-1-a")).body.pages.includes("macros"), false);
    await tenant(db.connect, "a", async (x) => {
      assert.equal(await can(x, "a", "agent-1-a", "conversations.read"), true);
      assert.equal(await can(x, "a", "agent-1-a", "macros.use"), false, "cut whatever the role allows");
    });
    // Back to full: lists again.
    await agent("seats", { teammateId: "agent-1", seat: "full" });
    assert.equal((await agent("inbox", undefined, "agent-1-a")).body.conversations.length, 1);
    assert.equal((await search("agent-1-a")).length, 1, "search finds it for a full seat");

    // The Seats page: this period's seats from the ledger (prices are placeholders, so no amounts).
    const anchor = (await q<{ period_anchor: Date }>("a", "SELECT period_anchor FROM workspace_plans"))[0].period_anchor;
    const later = new Date(new Date(anchor).getTime() + 3 * 86_400_000);
    await q("a", "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','agent-2','agent-2-a','Agent two','agent')");
    const seats = await tenant(db.connect, "a", (x) => readSeats(x, "a", "owner-a", later));
    assert.equal(seats.priceSet, false);
    assert.equal(seats.full, 3);
    assert.ok(seats.bill.prorations.some((p) => p.teammateName === "Agent two" && p.amountCents === null && p.fraction > 0.8), JSON.stringify(seats.bill));
    assert.equal(seats.teammates.find((t) => t.owner)?.seat, "full");
    assert.equal((await agent("seats", undefined, "agent-1-a")).status, 403);
    assert.deepEqual((await agent("seats", undefined, "owner-b", "b")).body.teammates.map((t: { name: string }) => t.name).length, 1, "another workspace's seats are its own");
    await assert.rejects(tenant(db.connect, "b", (x) => changeSeat(x, "b", "owner-a", { teammateId: "agent-1", seat: "limited" })), /permission/);

    // The rollback: limited seats back to full, and the ledger stops being written.
    await agent("seats", { teammateId: "agent-2", seat: "limited" });
    const before = (await ledger()).length;
    await db.pg.exec(await readFile("db/rollback/0093_seats.sql", "utf8"));
    assert.deepEqual(await q("a", "SELECT seat FROM teammates WHERE id='agent-2'"), [{ seat: "full" }]);
    await q("a", "UPDATE teammates SET seat='limited' WHERE id='agent-2'");
    assert.equal((await ledger()).length, before);
  } finally {
    await db.close();
  }
});

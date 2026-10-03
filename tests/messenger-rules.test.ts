import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { getIdentity, seedFoundation } from "../server/people";
import { command } from "../server/conversations";
import { saveTicketType } from "../server/tickets";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { DEFAULT_GENERAL, DEFAULT_INBOUND } from "../server/messenger-config";

/** Messenger settings M3 (docs/MESSENGER_SETTINGS_STEP3.md): rules, languages, privacy, install. */
test("messenger rules: enforced by the server for each audience, interface languages and reply times applied at boot, and failed verifications logged without personal data", async () => {
  const db = await testDatabase();
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    realtimeUrl: "wss://relay.test/realtime",
    storageTransport: "local-pglite",
  };
  const agent = async (
    path: string,
    data?: unknown,
    principal = "owner-a",
    workspace = "a",
    key: string = crypto.randomUUID(),
  ) => {
    const response = await bridgeAgentRequest(
      new Request("https://app.test/api/agent/" + path, {
        method: data === undefined ? "GET" : "POST",
        headers: {
          origin: "https://app.test",
          "content-type": "application/json",
          "idempotency-key": key,
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      }),
      principal,
      {
        RELAY_AGENT_INBOX_V1: "true",
        RELAY_STORAGE_AUTHORITY: "postgres",
        RELAY_API_ORIGIN: "https://relay.test",
        RELAY_WORKSPACE_ID: workspace,
        RELAY_BRIDGE_SECRET: env.bridgeSecret,
      },
      (r) => handleApi(r, env),
    );
    return { status: response.status, body: (await response.json()) as any };
  };
  const sql = <T = any>(w: string, text: string, values: unknown[] = []) =>
    tenant(db.connect, w, async (q) => (await q.query<T>(text, values)).rows);
  const boot = (body: Record<string, unknown>, w = "a") =>
    handleApi(
      new Request("https://relay.test/v1/messenger/boot", {
        method: "POST",
        headers: {
          origin: "https://shop.test",
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          workspaceId: w,
          brandId: "default",
          deviceToken: "rules-device-".repeat(4) + crypto.randomUUID(),
          pageUrl: "https://shop.test/pricing",
          ...body,
        }),
      }),
      env,
    ).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
  const customer = async (key: string, verified = false) =>
    tenant(db.connect, "a", async (q) => {
      const identity = await getIdentity(
        q,
        "a",
        verified ? "user" : "anonymous",
        key,
      );
      return {
        type: "contact" as const,
        identityId: identity.identityId,
        brandId: "default",
        verified,
      };
    });
  const run = (actor: any, p: any) =>
    tenant(db.connect, "a", (q) =>
      command(q, "a", actor, "k-" + crypto.randomUUID(), p),
    ) as Promise<any>;
  const owner = { type: "teammate" as const, principal: "owner-a" };
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (q) =>
        seedFoundation(q, w, "owner-" + w, {
          origins: ["https://shop.test"],
          master: env.identityMaster,
          identitySecret: new TextEncoder().encode("i".repeat(32)),
          enable: true,
        }),
      );
      await sql(
        w,
        "UPDATE workspace_features SET enabled=true WHERE workspace_id=$1 AND name IN ('settings_v1','messenger_v3','tickets_v1')",
        [w],
      );
    }

    // A draft from before M3 reads with the defaults, and isn't "changed" by them.
    const first = (await agent("messenger?brand=default")).body;
    const older = structuredClone(first.draft);
    delete older.general;
    delete older.audiences.visitors.inbound;
    delete older.audiences.users.inbound;
    await sql("a", "UPDATE messenger_drafts SET config=$1", [
      JSON.stringify(older),
    ]);
    const read = (await agent("messenger?brand=default")).body;
    assert.deepEqual(read.draft.general, DEFAULT_GENERAL);
    assert.deepEqual(read.draft.audiences.visitors.inbound, DEFAULT_INBOUND);
    assert.equal(read.changed, false);

    // What M3's settings can't be.
    const refuse = async (change: (d: any) => void, text: RegExp) => {
      const d = structuredClone(read.draft);
      change(d);
      const r = await agent("messenger", {
        brandId: "default",
        action: "save",
        draftVersion: read.draftVersion,
        config: d,
      });
      assert.equal(r.status, 400, String(text));
      assert.match(r.body.error.message, text);
    };
    await refuse(
      (d) => (d.general.languages = ["ja"]),
      /languages the messenger has words for/,
    );
    await refuse(
      (d) =>
        (d.general.privacy = {
          enabled: true,
          url: "",
          text: { en: "We care." },
        }),
      /privacy policy's address/,
    );
    await refuse(
      (d) =>
        (d.general.privacy = {
          enabled: true,
          url: "http://shop.test/privacy",
          text: { en: "x" },
        }),
      /needs an https/,
    );
    await refuse(
      (d) =>
        (d.general.privacy = {
          enabled: true,
          url: "https://shop.test/privacy",
          text: {},
        }),
      /notice in the messenger's own language/,
    );
    await refuse(
      (d) => (d.general.replyTimes = "sometimes"),
      /when reply times show/,
    );
    await refuse(
      (d) => (d.audiences.users.inbound.oneConversation = "yes"),
      /each conversation rule/,
    );

    // Published: visitors get one conversation at a time and no replies once closed; users no
    // replies to closed tickets. French is offered; reply times wait for a team; a privacy notice.
    const config = structuredClone(read.draft);
    config.audiences.visitors.inbound = {
      oneConversation: true,
      talkAfterUnhelpful: false,
      blockClosedReplies: true,
      blockClosedTicketReplies: false,
    };
    config.audiences.users.inbound = {
      oneConversation: false,
      talkAfterUnhelpful: true,
      blockClosedReplies: false,
      blockClosedTicketReplies: true,
    };
    config.general = {
      replyTimes: "after_team",
      soundDefault: true,
      languages: ["fr", "en"],
      privacy: {
        enabled: true,
        url: "https://shop.test/privacy",
        text: { en: "We use your messages to help you." },
      },
    };
    const saved = await agent("messenger", {
      brandId: "default",
      action: "save",
      draftVersion: read.draftVersion,
      config,
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(
      saved.body.draft.general.languages,
      ["fr"],
      "the messenger's own language isn't listed",
    );
    await agent("messenger", {
      brandId: "default",
      action: "publish",
      draftVersion: saved.body.draftVersion,
    });

    // One open conversation at a time, for visitors.
    const ada = await customer("ada");
    const a1 = await run(ada, { action: "start", text: "First question" });
    await assert.rejects(
      run(ada, { action: "start", text: "Second question" }),
      (e: any) => {
        assert.equal(e.code, "CONVERSATION_OPEN");
        assert.equal(e.details.conversationId, a1.conversationId);
        return true;
      },
    );
    // Closed: a visitor can't reply, but can start again.
    await run(owner, { action: "close", conversationId: a1.conversationId });
    await assert.rejects(
      run(ada, {
        action: "reply",
        conversationId: a1.conversationId,
        text: "One more thing",
      }),
      { code: "CONVERSATION_CLOSED" },
    );
    await run(ada, { action: "start", text: "A new question" });
    // A signed-in user may reply to a closed conversation (it reopens), but not to a closed ticket.
    const sam = await customer("sam", true);
    const s1 = await run(sam, { action: "start", text: "Billing question" });
    await run(owner, { action: "close", conversationId: s1.conversationId });
    await run(sam, {
      action: "reply",
      conversationId: s1.conversationId,
      text: "Still there?",
    });
    assert.equal(
      (
        await sql("a", "SELECT status FROM conversations WHERE id=$1", [
          s1.conversationId,
        ])
      )[0].status,
      "open",
    );
    const type = await tenant(db.connect, "a", (q) =>
      saveTicketType(q, "a", "owner-a", {
        name: "Refund",
        category: "customer",
        states: [
          { key: "new", name: "New", kind: "submitted" },
          { key: "done", name: "Done", kind: "resolved" },
        ],
        transitions: [["new", "done"]],
      }),
    );
    const s2 = await run(sam, { action: "start", text: "Refund please" });
    await sql(
      "a",
      "INSERT INTO tickets(workspace_id,conversation_id,number,type_id,state_id,created_by) VALUES('a',$1,1,$2,$3,'owner')",
      [s2.conversationId, type.id, type.id + ".done"],
    );
    await run(owner, { action: "close", conversationId: s2.conversationId });
    await assert.rejects(
      run(sam, {
        action: "reply",
        conversationId: s2.conversationId,
        text: "Reopen?",
      }),
      { code: "TICKET_CLOSED" },
    );
    // With drafts off, the rules don't apply.
    await sql(
      "a",
      "UPDATE workspace_features SET enabled=false WHERE workspace_id='a' AND name='messenger_v3'",
    );
    await run(ada, {
      action: "reply",
      conversationId: a1.conversationId,
      text: "Back again",
    });
    await sql(
      "a",
      "UPDATE workspace_features SET enabled=true WHERE workspace_id='a' AND name='messenger_v3'",
    );

    // Boot: the offered languages, and reply times only once a team has the conversation.
    const fr = await boot({ locale: "fr-CA" });
    assert.equal(fr.status, 200);
    assert.equal(fr.body.locale, "fr");
    assert.equal((await boot({ locale: "de-DE" })).body.locale, "en");
    assert.equal(fr.body.availability, null);
    assert.equal(fr.body.replyTime, null);
    assert.equal(fr.body.brand.messenger3.general.soundDefault, true);

    // A failed verification is counted with its reason only, and shown in Settings.
    const bad = await boot({
      user: { userId: "u-42", email: "secret@shop.test", jwt: "not-a-token" },
    });
    assert.equal(bad.status, 401);
    await boot({
      user: { userId: "u-43", email: "other@shop.test", jwt: "not-a-token" },
    });
    const failures = await sql(
      "a",
      "SELECT reason,count FROM identity_failures",
    );
    assert.equal(failures.length, 1);
    assert.equal(failures[0].count, 2);
    assert(
      !JSON.stringify(failures).includes("secret@shop.test") &&
        !JSON.stringify(failures).includes("u-42"),
    );
    const install = (await agent("messenger?brand=default")).body.install;
    assert.equal(install.failures[0].count, 2);
    assert.deepEqual(
      install.origins.map((o: any) => [o.origin, o.verified]),
      [["https://shop.test", 0]],
    );
    assert(install.origins[0].sessions >= 2);

    // Kept to the workspace.
    const other = (
      await agent("messenger?brand=default", undefined, "owner-b", "b")
    ).body.install;
    assert.deepEqual(other, { origins: [], failures: [] });
    assert.equal(
      (await sql("b", "SELECT count(*)::int AS n FROM identity_failures"))[0].n,
      0,
    );
  } finally {
    await db.close();
  }
});

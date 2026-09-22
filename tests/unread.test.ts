import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import {
  seedFoundation,
  getIdentity,
  mergeVisitorIdentity,
  reverseContactMerge,
} from "../server/people";
import { command, timeline } from "../server/conversations";
import { customerRead, customerUnreadSnapshots } from "../server/unread";

test("unread counts follow retained identities, reversal and merged timelines without granting anonymous account access", async () => {
  const db = await testDatabase();
  try {
    await tenant(db.connect, "a", async (sql) => {
      await seedFoundation(sql, "a", "owner", {
        origins: [],
        master: "m".repeat(40),
        identitySecret: new TextEncoder().encode("i".repeat(40)),
      });
      const visitor = await getIdentity(sql, "a", "anonymous", "device"),
        user = await getIdentity(sql, "a", "user", "account");
      const anon = {
          type: "contact" as const,
          identityId: visitor.identityId,
          brandId: "default",
        },
        known = {
          type: "contact" as const,
          identityId: user.identityId,
          brandId: "default",
          verified: true,
        },
        agent = { type: "teammate" as const, principal: "owner" };
      const write = (
        actor: typeof anon | typeof known | typeof agent,
        p: Parameters<typeof command>[4],
      ) => command(sql, "a", actor, crypto.randomUUID(), p);
      const a = String(
          (await write(anon, { action: "start", text: "Visitor thread" }))
            .conversationId,
        ),
        b = String(
          (await write(known, { action: "start", text: "Account thread" }))
            .conversationId,
        );
      const replyA = await write(agent, {
          action: "reply",
          conversationId: a,
          text: "Visitor response",
        }),
        replyB = await write(agent, {
          action: "reply",
          conversationId: b,
          text: "Account response",
        });
      assert("partId" in replyA && "partId" in replyB);
      const count = async (identityId: string, verified: boolean) =>
        (
          await customerUnreadSnapshots(sql, "a", [
            { sessionId: identityId, identityId, brandId: "default", verified },
          ])
        )[0].unread_count;
      assert.equal(await count(visitor.identityId, false), 1);
      assert.equal(await count(user.identityId, true), 1);
      const merge = await mergeVisitorIdentity(
        sql,
        "a",
        visitor.identityId,
        user.contactId,
      );
      assert(merge);
      assert.equal(await count(user.identityId, true), 2);
      assert.equal(await count(visitor.identityId, false), 1);
      await reverseContactMerge(sql, "a", merge);
      assert.equal(await count(user.identityId, true), 1);
      assert.equal(await count(visitor.identityId, false), 1);
      await mergeVisitorIdentity(sql, "a", visitor.identityId, user.contactId);
      // The verified session can acknowledge its imported timeline on all linked devices.
      await customerRead(
        sql,
        "a",
        user.identityId,
        "default",
        a,
        String(replyA.partId),
        true,
      );
      assert.equal(await count(user.identityId, true), 1);
      assert.equal(await count(visitor.identityId, false), 0);
      const latestA = await write(agent, {
        action: "reply",
        conversationId: a,
        text: "Another response",
      });
      assert("partId" in latestA);
      assert.equal(await count(user.identityId, true), 2);
      await write(agent, { action: "merge", conversationId: a, targetId: b });
      assert.equal(await count(user.identityId, true), 1);
      assert.equal(await count(visitor.identityId, false), 1);
      await customerRead(
        sql,
        "a",
        user.identityId,
        "default",
        a,
        String(latestA.partId),
        true,
      );
      assert.equal(await count(user.identityId, true), 1);
      await customerRead(
        sql,
        "a",
        user.identityId,
        "default",
        b,
        String(replyB.partId),
        true,
      );
      assert.equal(await count(user.identityId, true), 0);
      await customerRead(
        sql,
        "a",
        user.identityId,
        "default",
        b,
        String(replyB.partId),
        true,
      );
      assert.equal(await count(user.identityId, true), 0);
      assert.equal(await count(visitor.identityId, false), 0);
      const later = String(
        (
          await write(known, {
            action: "start",
            text: "Private account conversation",
          })
        ).conversationId,
      );
      // Domain rejection occurs before a SQL error; the transaction remains usable.
      await assert.rejects(timeline(sql, "a", later, anon), {
        code: "CONVERSATION_NOT_FOUND",
      });
      assert.equal(
        (
          await customerUnreadSnapshots(sql, "b", [
            {
              sessionId: "x",
              identityId: user.identityId,
              brandId: "default",
              verified: true,
            },
          ])
        ).length,
        0,
      );
      assert.equal(
        (
          await sql.query(
            "SELECT * FROM customer_unread_threads WHERE workspace_id=$1 AND conversation_id=$2",
            ["a", a],
          )
        ).rows.length,
        0,
      );
    });
  } finally {
    await db.close();
  }
});

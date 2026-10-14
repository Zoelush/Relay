import { assert, once, type Sql } from "./db";
import { authorize } from "./policy";
import { queueDeliveryTo } from "./channels";
import { copiesOf } from "./email-out";

/**
 * Side conversations (phase 12, step E4; docs/OMNICHANNEL_STEP4.md): an email thread with someone
 * other than the customer (a supplier, another department), attached to a conversation. Its
 * messages are internal parts of that conversation (a `system_event` of `side_conversation`), so
 * they inherit its assignment, team and history and are never the customer's to see. A teammate's
 * message is a delivery (purpose `side`) through the same gate; answers come back to the side
 * conversation's own reply address (`<workspace>+s-<token>@<inbound domain>`), or by In-Reply-To.
 */
const MAX_TEXT = 20_000;
const token = () => [...crypto.getRandomValues(new Uint8Array(20))].map((b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");

async function emailOn(db: Sql, w: string) {
  return (
    (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM workspace_features WHERE workspace_id=$1 AND enabled AND name IN ('channels_v1','channel_email_v1')", [w]))
      .rows[0].n === 2
  );
}

/** A teammate's message in a side conversation: an internal part, and its delivery to the participants. */
async function post(db: Sql, w: string, teammate: { id: string }, side: { id: string; conversation_id: string; subject: string; participants: string[] }, text: string, first: boolean) {
  const { append, conversation } = await import("./conversations");
  const c = await conversation(db, w, side.conversation_id);
  const name = (await db.query<{ name: string }>("SELECT name FROM teammates WHERE workspace_id=$1 AND id=$2", [w, teammate.id])).rows[0]?.name;
  const part = await append(
    db,
    w,
    c,
    { type: "teammate", id: teammate.id, name },
    "system_event",
    text,
    { event: "side_conversation", sideId: side.id, direction: "out", subject: side.subject, to: side.participants, text, first },
    "internal",
    null,
    "email",
  );
  await db.query("INSERT INTO side_messages(workspace_id,side_id,part_id,direction) VALUES($1,$2,$3,'out')", [w, side.id, part.id]);
  await db.query("UPDATE side_conversations SET updated_at=now() WHERE workspace_id=$1 AND id=$2", [w, side.id]);
  await queueDeliveryTo(db, w, side.conversation_id, part.id, "email", `side:${side.id}`, side.participants[0], "side");
  return part.id;
}

/** `POST side-conversation`: start one ({conversationId, to, subject, text}) or reply in one ({sideId, text}). */
export async function changeSideConversation(db: Sql, w: string, principal: string, key: string, p: Record<string, unknown>) {
  const t = await authorize(db, w, principal, "conversations.reply");
  assert(await emailOn(db, w), "EMAIL_DISABLED", "Email is not enabled for this workspace.", 404);
  return once(db, w, "side-conversation:" + principal, key, p, async () => {
    const text = typeof p.text === "string" ? p.text.trim() : "";
    assert(text && text.length <= MAX_TEXT, "INVALID_SIDE_CONVERSATION", "Write the message, in up to 20,000 characters.", 400);
    if (p.action === "start") {
      const conversationId = String(p.conversationId ?? "");
      assert(
        (await db.query("SELECT 1 FROM conversations WHERE workspace_id=$1 AND id=$2", [w, conversationId])).rows.length,
        "CONVERSATION_NOT_FOUND",
        "Conversation unavailable.",
        404,
      );
      const to = copiesOf(p.to);
      assert(to && to.length, "INVALID_SIDE_CONVERSATION", "Send it to one to ten email addresses.", 400);
      const subject = typeof p.subject === "string" ? p.subject.replace(/[\r\n]+/g, " ").trim() : "";
      assert(subject && subject.length <= 200, "INVALID_SIDE_CONVERSATION", "Give it a subject, in up to 200 characters.", 400);
      const side = { id: crypto.randomUUID(), conversation_id: conversationId, subject, participants: to! };
      await db.query("INSERT INTO side_conversations(workspace_id,id,conversation_id,subject,participants,token,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)", [
        w,
        side.id,
        conversationId,
        subject,
        to,
        token(),
        t.id,
      ]);
      const partId = await post(db, w, t, side, text, true);
      return { sideId: side.id, partId, conversationId };
    }
    if (p.action === "reply") {
      const side = (
        await db.query<{ id: string; conversation_id: string; subject: string; participants: string[] }>(
          "SELECT id,conversation_id,subject,participants FROM side_conversations WHERE workspace_id=$1 AND id=$2",
          [w, String(p.sideId ?? "")],
        )
      ).rows[0];
      assert(side, "SIDE_CONVERSATION_NOT_FOUND", "That side conversation isn't available.", 404);
      const partId = await post(db, w, t, side, text, false);
      return { sideId: side.id, partId, conversationId: side.conversation_id };
    }
    assert(false, "INVALID_SIDE_CONVERSATION", "Start a side conversation or reply in one.", 400);
  });
}

/** `GET side-conversations?conversation=`: a conversation's side conversations, newest first. */
export async function readSideConversations(db: Sql, w: string, principal: string, conversationId: string) {
  await authorize(db, w, principal, "conversations.read");
  assert(
    (await db.query("SELECT 1 FROM conversations WHERE workspace_id=$1 AND id=$2", [w, conversationId])).rows.length,
    "CONVERSATION_NOT_FOUND",
    "Conversation unavailable.",
    404,
  );
  const rows = (
    await db.query<{ id: string; subject: string; participants: string[]; created_at: string; updated_at: string; messages: number }>(
      `SELECT s.id,s.subject,s.participants,s.created_at,s.updated_at,(SELECT count(*)::int FROM side_messages m WHERE m.workspace_id=s.workspace_id AND m.side_id=s.id) AS messages
       FROM side_conversations s WHERE s.workspace_id=$1 AND s.conversation_id=$2 ORDER BY s.updated_at DESC`,
      [w, conversationId],
    )
  ).rows;
  return {
    sideConversations: rows.map((r) => ({
      id: r.id,
      subject: r.subject,
      participants: r.participants,
      messages: r.messages,
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
    })),
  };
}

/** Which side conversation mail is for: its reply address, else one of its messages the mail answers. */
export async function sideFor(db: Sql, w: string, envelopeTo: string, refersTo: string[]) {
  const t = /^[^+@]+\+s-([a-z0-9]{16,40})@/i.exec(envelopeTo)?.[1]?.toLowerCase();
  if (t) return (await db.query<{ id: string }>("SELECT id FROM side_conversations WHERE workspace_id=$1 AND token=$2", [w, t])).rows[0]?.id ?? null;
  if (!refersTo.length) return null;
  return (
    (
      await db.query<{ side_id: string }>("SELECT side_id FROM side_messages WHERE workspace_id=$1 AND message_id=ANY($2::text[]) ORDER BY created_at DESC LIMIT 1", [
        w,
        refersTo,
      ])
    ).rows[0]?.side_id ?? null
  );
}

/** An answer in a side conversation: an internal part of its conversation, never the customer's. */
export async function receiveSideMail(
  db: Sql,
  w: string,
  sideId: string,
  m: { from: { address: string; name: string }; subject: string; text: string; messageId: string | null; kind: string },
) {
  const side = (
    await db.query<{ id: string; conversation_id: string; subject: string }>("SELECT id,conversation_id,subject FROM side_conversations WHERE workspace_id=$1 AND id=$2", [w, sideId])
  ).rows[0];
  const { append, conversation } = await import("./conversations");
  const c = await conversation(db, w, side.conversation_id);
  const part = await append(
    db,
    w,
    c,
    { type: "system", id: "email" },
    "system_event",
    m.text,
    {
      event: "side_conversation",
      sideId,
      direction: "in",
      subject: m.subject || side.subject,
      from: m.from,
      text: m.text,
      ...(m.kind !== "message" ? { automatic: m.kind } : {}),
    },
    "internal",
    null,
    "email",
  );
  await db.query("INSERT INTO side_messages(workspace_id,side_id,part_id,message_id,direction) VALUES($1,$2,$3,$4,'in')", [w, sideId, part.id, m.messageId]);
  await db.query("UPDATE side_conversations SET updated_at=now() WHERE workspace_id=$1 AND id=$2", [w, sideId]);
  return { conversationId: side.conversation_id, partId: part.id };
}

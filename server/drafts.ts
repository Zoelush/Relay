import { assert, DomainError, tenant, type Sql, type Connect } from "./db";
import { authorize } from "./policy";
import { access, conversation } from "./conversations";
import { validTimeZone } from "./snooze";
import {
  normalizeDoc,
  plainText,
  RichDocError,
  type RichDoc,
} from "../lib/rich-doc";

export type Draft = { doc: RichDoc; version: string; updated_at: string };
type Mode = "reply" | "note";
const capability = {
  reply: "conversations.reply",
  note: "conversations.note",
} as const;
/** Days a draft is kept after its last save. */
export const DRAFT_RETENTION_DAYS = 30;

/** The signed-in teammate's own drafts for a conversation. Other teammates' are never read. */
export async function readDrafts(
  db: Sql,
  w: string,
  principal: string,
  conversationId: string,
) {
  const t = await authorize(db, w, principal, "conversations.read");
  const c = await conversation(db, w, conversationId);
  await access(db, w, c, { type: "teammate", principal });
  const rows = (
    await db.query<Draft & { mode: Mode }>(
      "SELECT mode,doc,version::text AS version,updated_at FROM conversation_drafts WHERE workspace_id=$1 AND conversation_id=$2 AND teammate_id=$3",
      [w, c.id, t.id],
    )
  ).rows;
  return Object.fromEntries(
    rows.map((r) => [
      r.mode,
      { doc: r.doc, version: String(r.version), updated_at: r.updated_at },
    ]),
  ) as Partial<Record<Mode, Draft>>;
}

/**
 * Saves (or, with `doc: null`, discards) the teammate's draft. `baseVersion` is the version the
 * editor started from; if another tab saved since, nothing is written and the current draft is
 * returned so the teammate can choose.
 */
export async function saveDraft(
  db: Sql,
  w: string,
  principal: string,
  p: Record<string, unknown>,
): Promise<
  | { conflict: false; version: string | null }
  | { conflict: true; draft: Draft | null }
> {
  assert(
    p.mode === "reply" || p.mode === "note",
    "INVALID_DRAFT",
    "Choose reply or note.",
  );
  const mode = p.mode as Mode;
  const t = await authorize(db, w, principal, capability[mode]);
  const c = await conversation(db, w, String(p.conversationId ?? ""));
  await access(db, w, c, { type: "teammate", principal });
  assert(
    p.baseVersion === null ||
      (typeof p.baseVersion === "string" && /^\d+$/.test(p.baseVersion)),
    "INVALID_DRAFT",
    "Include the draft version you edited.",
  );
  const current = (
    await db.query<Draft>(
      "SELECT doc,version::text AS version,updated_at FROM conversation_drafts WHERE workspace_id=$1 AND conversation_id=$2 AND teammate_id=$3 AND mode=$4 FOR UPDATE",
      [w, c.id, t.id, mode],
    )
  ).rows[0];
  if ((current?.version ?? null) !== p.baseVersion)
    return {
      conflict: true,
      draft: current ? { ...current, version: String(current.version) } : null,
    };
  if (p.doc === null) {
    await db.query(
      "DELETE FROM conversation_drafts WHERE workspace_id=$1 AND conversation_id=$2 AND teammate_id=$3 AND mode=$4",
      [w, c.id, t.id, mode],
    );
    return { conflict: false, version: null };
  }
  let doc: RichDoc;
  try {
    doc = normalizeDoc(p.doc);
  } catch (e) {
    if (e instanceof RichDocError)
      throw new DomainError(e.code, e.message, 400);
    throw e;
  }
  const saved = (
    await db.query<{ version: string }>(
      `INSERT INTO conversation_drafts(workspace_id,conversation_id,teammate_id,mode,doc,body,origin_timezone) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(workspace_id,conversation_id,teammate_id,mode) DO UPDATE SET doc=EXCLUDED.doc,body=EXCLUDED.body,version=conversation_drafts.version+1,updated_at=now(),origin_timezone=EXCLUDED.origin_timezone
      RETURNING version::text AS version`,
      [
        w,
        c.id,
        t.id,
        mode,
        JSON.stringify(doc),
        plainText(doc),
        p.timezone === undefined ? null : validTimeZone(p.timezone),
      ],
    )
  ).rows[0];
  return { conflict: false, version: String(saved.version) };
}

/** Deletes up to 500 drafts untouched for the retention period. Returns how many went. */
export async function purgeDrafts(connect: Connect, w: string) {
  return tenant(
    connect,
    w,
    async (db) =>
      (
        await db.query(
          `DELETE FROM conversation_drafts WHERE workspace_id=$1 AND (conversation_id,teammate_id,mode) IN (
        SELECT conversation_id,teammate_id,mode FROM conversation_drafts WHERE workspace_id=$1 AND updated_at<now()-make_interval(days=>$2) ORDER BY updated_at LIMIT 500)
        RETURNING 1`,
          [w, DRAFT_RETENTION_DAYS],
        )
      ).rows.length,
  );
}

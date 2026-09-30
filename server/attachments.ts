import { assert, once, tenant, type Connect, type Sql } from "./db";
import {
  access,
  conversation,
  publishAttachment,
  type Actor,
} from "./conversations";
import { enqueueJob, type Job } from "./jobs";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const allowed = new Set([
  "image/png",
  "image/jpeg",
  "application/pdf",
  "text/plain",
]);
export interface AttachmentStorage {
  signUpload(
    key: string,
    type: string,
    size: number,
  ): Promise<{
    url: string;
    headers: Record<string, string>;
    expiresAt: string;
  }>;
  getQuarantine(
    key: string,
  ): Promise<{ bytes: Uint8Array; type: string } | null>;
  scan(bytes: Uint8Array): Promise<"clean" | "infected">;
  putClean(
    key: string,
    bytes: Uint8Array,
    type: string,
    name: string,
  ): Promise<void>;
  preview?(bytes: Uint8Array, type: string): Promise<Uint8Array>;
  deleteQuarantine(key: string): Promise<void>;
  signDownload(
    key: string,
    preview: boolean,
  ): Promise<{ url: string; expiresAt: string }>;
  /** Internal downloads are streamed through an authenticated agent route. */
  readClean?(key: string): Promise<Response>;
  /** Removes a clean object or preview; used by inline-image retention. */
  deleteClean?(key: string): Promise<void>;
}
/** Images that can be placed inside a message: PNG and JPEG, identified from their bytes. */
export const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg"]);
export function detectedType(bytes: Uint8Array) {
  if (
    bytes.length >= 8 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)
  )
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  const prefix = new TextDecoder().decode(bytes.slice(0, 5));
  if (prefix === "%PDF-") return "application/pdf";
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!/[\u0000-\u0008\u000b\u000e-\u001f]/.test(text)) return "text/plain";
  } catch {}
  return "application/octet-stream";
}
export async function prepareAttachment(
  db: Sql,
  w: string,
  actor: Actor,
  key: string,
  p: {
    conversationId: string;
    name: string;
    size: number;
    type: string;
    audience?: "customer_visible" | "internal";
    /** `inline`: an image placed inside a message, never published as its own part. */
    purpose?: "part" | "inline";
  },
) {
  return once(
    db,
    w,
    "attachment.prepare:" +
      (actor.type === "contact" ? actor.identityId : actor.principal),
    key,
    p,
    async () => {
      const c = await conversation(db, w, p.conversationId, true);
      const audience =
        p.audience ??
        (actor.type === "contact" ? "customer_visible" : "internal");
      assert(
        ["customer_visible", "internal"].includes(audience),
        "ATTACHMENT_AUDIENCE",
        "Choose an attachment audience.",
      );
      assert(
        actor.type === "teammate" || audience === "customer_visible",
        "FORBIDDEN",
        "Customers cannot upload internal files.",
        403,
      );
      const owner = await access(
        db,
        w,
        c,
        actor,
        audience === "internal" ? "conversations.note" : "conversations.reply",
      );
      assert(
        typeof p.name === "string" &&
          p.name.length > 0 &&
          p.name.length <= 200 &&
          !/[\x00-\x1f]/.test(p.name),
        "ATTACHMENT_NAME",
        "Choose a valid file name.",
      );
      assert(
        Number.isInteger(p.size) &&
          p.size > 0 &&
          p.size <= MAX_ATTACHMENT_BYTES,
        "ATTACHMENT_SIZE",
        "Files must be between 1 byte and 10 MB.",
      );
      assert(
        allowed.has(p.type),
        "ATTACHMENT_TYPE",
        "Supported files: PNG, JPEG, PDF and plain text.",
      );
      const purpose = p.purpose ?? "part";
      assert(
        purpose === "part" ||
          (purpose === "inline" &&
            actor.type === "teammate" &&
            INLINE_IMAGE_TYPES.has(p.type)),
        "ATTACHMENT_TYPE",
        "Images in messages must be PNG or JPEG.",
      );
      const id = crypto.randomUUID(),
        objectKey = `${encodeURIComponent(w)}/${id}/quarantine`;
      await db.query(
        "INSERT INTO attachments(workspace_id,id,conversation_id,owner_identity_id,object_key,name,size,mime,audience,owner_teammate_id,purpose) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [
          w,
          id,
          c.id,
          actor.type === "contact" ? actor.identityId : null,
          objectKey,
          p.name,
          p.size,
          p.type,
          audience,
          actor.type === "teammate" ? owner.id : null,
          purpose,
        ],
      );
      return { id, objectKey, type: p.type, size: p.size };
    },
  );
}
export async function completeAttachment(
  db: Sql,
  w: string,
  actor: Actor,
  key: string,
  p: { attachmentId: string },
) {
  return once(
    db,
    w,
    "attachment.complete:" +
      (actor.type === "contact" ? actor.identityId : actor.principal),
    key,
    p,
    async () => {
      const a = (
        await db.query<{
          id: string;
          conversation_id: string;
          owner_identity_id: string;
          owner_teammate_id: string | null;
          audience: string;
          job_id: string | null;
        }>(
          "SELECT * FROM attachments WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
          [w, p.attachmentId],
        )
      ).rows[0];
      assert(a, "ATTACHMENT_NOT_FOUND", "Attachment unavailable.", 404);
      const c = await conversation(db, w, a.conversation_id);
      assert(
        actor.type === "teammate" || a.audience === "customer_visible",
        "ATTACHMENT_NOT_FOUND",
        "Attachment unavailable.",
        404,
      );
      const who = await access(
        db,
        w,
        c,
        actor,
        a.audience === "internal"
          ? "conversations.note"
          : "conversations.reply",
      );
      assert(
        actor.type === "teammate"
          ? a.owner_teammate_id === who.id
          : a.owner_identity_id === actor.identityId,
        "ATTACHMENT_NOT_FOUND",
        "Attachment unavailable.",
        404,
      );
      if (a.job_id) return { jobId: a.job_id, attachmentId: a.id };
      const jobId = await enqueueJob(
        db,
        w,
        "attachment.scan",
        { attachmentId: a.id },
        {
          identityId: actor.type === "contact" ? actor.identityId : undefined,
          teammateId: actor.type === "teammate" ? who.id : undefined,
        },
      );
      await db.query(
        "UPDATE attachments SET status='scanning',job_id=$3,version=version+1 WHERE workspace_id=$1 AND id=$2",
        [w, a.id, jobId],
      );
      return { jobId, attachmentId: a.id };
    },
  );
}
export async function attachmentScan(
  connect: Connect,
  storage: AttachmentStorage,
  job: Job,
) {
  const w = job.workspace_id,
    id = String(job.payload.attachmentId);
  const a = await tenant(
    connect,
    w,
    async (db) =>
      (
        await db.query<{
          conversation_id: string;
          object_key: string;
          name: string;
          size: string;
          mime: string;
          status: string;
          audience: "customer_visible" | "internal";
          purpose: "part" | "inline";
        }>(
          "SELECT conversation_id,object_key,name,size,mime,status,audience,purpose FROM attachments WHERE workspace_id=$1 AND id=$2",
          [w, id],
        )
      ).rows[0],
  );
  assert(a, "ATTACHMENT_NOT_FOUND", "Attachment unavailable.", 404);
  if (a.status === "clean" || a.status === "rejected")
    return { done: true, result: { attachmentId: id, status: a.status } };
  const upload = await storage.getQuarantine(a.object_key);
  assert(upload, "UPLOAD_MISSING", "Upload did not reach storage.", 409);
  let reason: string | null = null;
  const actualType = detectedType(upload.bytes);
  if (
    upload.bytes.length !== Number(a.size) ||
    upload.bytes.length > MAX_ATTACHMENT_BYTES
  )
    reason = "SIZE_MISMATCH";
  else if (actualType !== a.mime || upload.type !== a.mime)
    reason = "TYPE_MISMATCH";
  else if ((await storage.scan(upload.bytes)) !== "clean")
    reason = "VIRUS_DETECTED";
  if (reason) {
    await tenant(connect, w, (db) =>
      db.query(
        "UPDATE attachments SET status='rejected',version=version+1 WHERE workspace_id=$1 AND id=$2",
        [w, id],
      ),
    );
    await storage.deleteQuarantine(a.object_key);
    return {
      done: true,
      result: { attachmentId: id, status: "rejected", reason },
    };
  }
  const checksum = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", upload.bytes as BufferSource),
      ),
      (b) => b.toString(16).padStart(2, "0"),
    ).join(""),
    cleanKey = `${encodeURIComponent(w)}/${id}/${checksum}/clean`,
    previewKey =
      actualType.startsWith("image/") && storage.preview
        ? `${encodeURIComponent(w)}/${id}/${checksum}/preview.png`
        : null;
  // Copy these exact scanned bytes into a different private key. A still-live PUT URL can only replace quarantine.
  await storage.putClean(cleanKey, upload.bytes, actualType, a.name);
  if (previewKey)
    await storage.putClean(
      previewKey,
      await storage.preview!(upload.bytes, actualType),
      "image/png",
      "preview.png",
    );
  await tenant(connect, w, async (db) => {
    const current = (
      await db.query<{ lease_token: string }>(
        "SELECT lease_token FROM jobs WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [w, job.id],
      )
    ).rows[0];
    assert(
      current?.lease_token === job.lease_token,
      "STALE_JOB",
      "A newer worker owns this scan.",
      409,
    );
    await db.query(
      "UPDATE attachments SET status='clean',checksum=$3,clean_key=$4,preview_key=$5,version=version+1 WHERE workspace_id=$1 AND id=$2",
      [w, id, checksum, cleanKey, previewKey],
    );
    // Inline images appear inside the message that references them, not as a part of their own.
    if (a.purpose !== "inline")
      await publishAttachment(
        db,
        w,
        job.id,
        id,
        a.conversation_id,
        {
          type: job.owner_identity_id ? "contact" : "teammate",
          id: job.owner_identity_id ?? job.owner_teammate_id!,
        },
        {
          name: a.name,
          mime: a.mime,
          size: Number(a.size),
          hasPreview: !!previewKey,
        },
        a.audience,
      );
  });
  await storage.deleteQuarantine(a.object_key);
  return {
    done: true,
    result: { attachmentId: id, status: "clean", hasPreview: !!previewKey },
  };
}
export async function downloadAttachment(
  db: Sql,
  w: string,
  actor: Actor,
  id: string,
  preview: boolean,
) {
  const a = (
    await db.query<{
      conversation_id: string;
      status: string;
      clean_key: string;
      preview_key: string;
      audience: string;
      purpose: string;
    }>(
      "SELECT conversation_id,status,clean_key,preview_key,audience,purpose FROM attachments WHERE workspace_id=$1 AND id=$2",
      [w, id],
    )
  ).rows[0];
  assert(a, "ATTACHMENT_NOT_FOUND", "Attachment unavailable.", 404);
  assert(
    actor.type === "teammate" || a.audience === "customer_visible",
    "ATTACHMENT_NOT_FOUND",
    "Attachment unavailable.",
    404,
  );
  const c = await conversation(db, w, a.conversation_id);
  await access(db, w, c, actor);
  // A customer sees an inline image only once a sent, public message references it: never an
  // image pasted into a reply that was then removed or not sent.
  if (actor.type === "contact" && a.purpose === "inline")
    assert(
      (
        await db.query(
          "SELECT 1 FROM conversation_part_images i JOIN conversation_parts p ON p.workspace_id=i.workspace_id AND p.id=i.part_id WHERE i.workspace_id=$1 AND i.attachment_id=$2 AND p.audience='public' AND p.kind<>'internal_note' LIMIT 1",
          [w, id],
        )
      ).rows.length,
      "ATTACHMENT_NOT_FOUND",
      "Attachment unavailable.",
      404,
    );
  assert(
    a.status === "clean",
    "ATTACHMENT_NOT_READY",
    "File has not passed its checks.",
    409,
  );
  assert(
    !preview || a.preview_key,
    "PREVIEW_UNAVAILABLE",
    "Preview unavailable.",
    404,
  );
  return preview ? a.preview_key : a.clean_key;
}

/**
 * Checks every image a message places inline before it is sent: each must be the sender's own
 * clean inline upload in this conversation (or one merged into it), and a reply may only use
 * images uploaded as customer-visible. Returns nothing; throws a specific error.
 */
export async function verifyInlineImages(
  db: Sql,
  w: string,
  c: { id: string },
  senderTeammateId: string,
  ids: string[],
  audience: "public" | "internal",
) {
  for (const id of ids) {
    const a = (
      await db.query<{
        conversation_id: string;
        owner_teammate_id: string | null;
        status: string;
        audience: string;
        purpose: string;
      }>(
        "SELECT conversation_id,owner_teammate_id,status,audience,purpose FROM attachments WHERE workspace_id=$1 AND id=$2",
        [w, id],
      )
    ).rows[0];
    assert(
      a &&
        a.purpose === "inline" &&
        a.owner_teammate_id === senderTeammateId &&
        (await conversation(db, w, a.conversation_id)).id === c.id,
      "IMAGE_NOT_FOUND",
      "An image in this message is unavailable. Remove it and add it again.",
      404,
    );
    assert(
      a.status === "clean",
      a.status === "rejected" ? "IMAGE_BLOCKED" : "IMAGE_NOT_READY",
      a.status === "rejected"
        ? "An image was blocked by the scanner. Remove it to send."
        : "An image is still being checked. Send once it is ready.",
      409,
    );
    assert(
      audience === "internal" || a.audience === "customer_visible",
      "IMAGE_AUDIENCE",
      "An image added to a note cannot be sent in a reply. Add it to the reply again.",
    );
  }
}
/** Days an inline upload is kept when no sent message or draft references it. */
export const INLINE_RETENTION_DAYS = 30;
/**
 * Deletes up to 100 inline uploads older than the retention period that no sent part and no
 * draft references, from storage and the database. Returns how many went.
 */
export async function purgeInlineImages(
  connect: Connect,
  storage: AttachmentStorage | undefined,
  w: string,
) {
  const orphans = await tenant(
    connect,
    w,
    async (db) =>
      (
        await db.query<{
          id: string;
          object_key: string;
          clean_key: string | null;
          preview_key: string | null;
        }>(
          `SELECT a.id,a.object_key,a.clean_key,a.preview_key FROM attachments a
          WHERE a.workspace_id=$1 AND a.purpose='inline' AND a.created_at<now()-make_interval(days=>$2)
          AND NOT EXISTS(SELECT 1 FROM conversation_part_images i WHERE i.workspace_id=$1 AND i.attachment_id=a.id)
          AND NOT EXISTS(SELECT 1 FROM conversation_drafts d WHERE d.workspace_id=$1 AND d.doc::text LIKE '%' || a.id || '%')
          ORDER BY a.created_at LIMIT 100`,
          [w, INLINE_RETENTION_DAYS],
        )
      ).rows,
  );
  for (const a of orphans) {
    // Storage first: a failure leaves the row, so the next sweep retries.
    await storage?.deleteQuarantine(a.object_key);
    for (const key of [a.clean_key, a.preview_key])
      if (key) await storage?.deleteClean?.(key);
    await tenant(connect, w, (db) =>
      db.query("DELETE FROM attachments WHERE workspace_id=$1 AND id=$2", [
        w,
        a.id,
      ]),
    );
  }
  return orphans.length;
}

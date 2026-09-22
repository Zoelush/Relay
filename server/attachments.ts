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
}
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
      const id = crypto.randomUUID(),
        objectKey = `${encodeURIComponent(w)}/${id}/quarantine`;
      await db.query(
        "INSERT INTO attachments(workspace_id,id,conversation_id,owner_identity_id,object_key,name,size,mime,audience,owner_teammate_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
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
        }>(
          "SELECT conversation_id,object_key,name,size,mime,status,audience FROM attachments WHERE workspace_id=$1 AND id=$2",
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
    }>(
      "SELECT conversation_id,status,clean_key,preview_key,audience FROM attachments WHERE workspace_id=$1 AND id=$2",
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

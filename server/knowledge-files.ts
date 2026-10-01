import { assert, DomainError, tenant, type Connect, type Sql } from "./db";
import { authorize, can } from "./policy";
import { enqueueJob, type Job } from "./jobs";
import type { AttachmentStorage } from "./attachments";
import { manager, record, requireKnowledge, validLocale } from "./knowledge";
import { indexRecord } from "./help-search";
import {
  DOCUMENT_TYPES,
  extract,
  ExtractError,
  IMAGE_TYPES,
  matchesType,
  MAX_DOCUMENT_BYTES,
  MAX_IMAGE_BYTES,
  type DocumentType,
} from "./knowledge-extract";

/**
 * Knowledge files (phase 07, step C1a): documents that become `file` knowledge records, images
 * inside articles, and a help center's logo, favicon and social image.
 *
 * Uploads follow the attachment path: the browser puts the bytes into quarantine with a signed
 * URL, a background job checks the size and real type, scans them, and copies them to a clean key.
 * For a document the job then extracts the text and publishes it as the record's content, which
 * is indexed for search; replacing the file publishes a new version. A new file starts internal
 * and available to the inbox only; a teammate can make it customer-facing and available to the AI
 * agent in its settings. Files never appear in the help center (only articles do).
 * TODO(phase 07 C2): chunk and embed the extracted text.
 */
export type FilePurpose =
  "source" | "article_image" | "theme_logo" | "theme_favicon" | "social_image";
const PURPOSES: FilePurpose[] = [
  "source",
  "article_image",
  "theme_logo",
  "theme_favicon",
  "social_image",
];
export const THEME_PURPOSES = [
  "theme_logo",
  "theme_favicon",
  "social_image",
] as const;

type FileRow = {
  id: string;
  purpose: FilePurpose;
  record_id: string | null;
  center_id: string | null;
  locale: string | null;
  version: number;
  name: string;
  size: string;
  mime: string;
  object_key: string;
  clean_key: string | null;
  status:
    | "uploading"
    | "scanning"
    | "ready"
    | "rejected"
    | "failed"
    | "replaced"
    | "removed";
  failure_code: string | null;
  pages: number | null;
  chars: number | null;
  truncated: boolean;
  job_id: string | null;
  uploaded_by: string;
  ready_at: string | null;
  created_at: string;
};
const FILE =
  "SELECT id,purpose,record_id,center_id,locale,version,name,size::text AS size,mime,object_key,clean_key,status,failure_code,pages,chars,truncated,job_id,uploaded_by,ready_at,created_at FROM knowledge_files";

const invalid = (code: string, message: string): never => {
  throw new DomainError(code, message, 400);
};
/** "Refund policy.pdf" → "Refund policy". */
const titleFrom = (name: string) =>
  name
    .replace(/\.[A-Za-z0-9]{1,8}$/, "")
    .trim()
    .slice(0, 300) || name.slice(0, 300);

/**
 * Starts an upload. A document without `recordId` creates a new `file` record (internal, for the
 * inbox, switched off for the AI agent until a teammate turns it on); with `recordId` it uploads a
 * new version of that file. An image belongs to an article (`recordId`) or a help center
 * (`centerId`). Returns where the browser puts the bytes.
 */
export async function prepareKnowledgeFile(
  db: Sql,
  w: string,
  principal: string,
  storage: AttachmentStorage,
  p: Record<string, unknown>,
) {
  const t = await manager(db, w, principal);
  const purpose = p.purpose as FilePurpose;
  if (!PURPOSES.includes(purpose))
    invalid("INVALID_FILE", "Choose what this file is for.");
  const name = typeof p.name === "string" ? p.name.trim() : "";
  if (!name || name.length > 200 || /[\x00-\x1f]/.test(name))
    invalid("INVALID_FILE", "Choose a file with a valid name.");
  const size = Number(p.size);
  const type = String(p.type ?? "");
  const document = purpose === "source";
  const max = document ? MAX_DOCUMENT_BYTES : MAX_IMAGE_BYTES;
  if (!Number.isInteger(size) || size < 1 || size > max)
    invalid(
      "FILE_SIZE",
      document ? "Files can be up to 20 MB." : "Images can be up to 5 MB.",
    );
  if (document ? !(type in DOCUMENT_TYPES) : !(type in IMAGE_TYPES))
    invalid(
      "FILE_TYPE",
      document
        ? "Upload a PDF, Word (.docx), HTML, Markdown or text file."
        : "Upload a PNG, JPEG, GIF or WebP image.",
    );
  const id = crypto.randomUUID();
  let recordId: string | null = null,
    centerId: string | null = null,
    locale: string | null = null,
    version = 1;
  if (document) {
    if (p.recordId) {
      const r = await record(db, w, p.recordId, true);
      assert(
        r.source === "file",
        "KNOWLEDGE_SOURCE",
        "Only file records take a new file.",
        409,
      );
      recordId = r.id;
      const current = (
        await db.query<{ locale: string; next: number }>(
          `SELECT (SELECT locale FROM knowledge_locales WHERE workspace_id=$1 AND record_id=$2 ORDER BY locale LIMIT 1) AS locale,
          COALESCE((SELECT max(version)+1 FROM knowledge_files WHERE workspace_id=$1 AND record_id=$2),1)::int AS next`,
          [w, r.id],
        )
      ).rows[0];
      locale = current.locale;
      version = current.next;
    } else {
      locale = validLocale(p.locale ?? "en");
      recordId = crypto.randomUUID();
      await db.query(
        `INSERT INTO knowledge_records(workspace_id,id,source,owner_id,audience,for_ai,for_help_center,for_inbox)
        VALUES($1,$2,'file',$3,'internal',false,false,true)`,
        [w, recordId, t.id],
      );
      await db.query(
        "INSERT INTO knowledge_locales(workspace_id,record_id,locale,draft_title,draft_updated_by) VALUES($1,$2,$3,$4,$5)",
        [w, recordId, locale, titleFrom(name), t.id],
      );
    }
  } else if (purpose === "article_image") {
    const r = await record(db, w, p.recordId);
    assert(
      r.source === "article" || r.source === "internal_article",
      "KNOWLEDGE_SOURCE",
      "Images go in articles.",
      409,
    );
    recordId = r.id;
  } else {
    const c = (
      await db.query<{ id: string }>(
        "SELECT id FROM help_centers WHERE workspace_id=$1 AND id=$2",
        [w, String(p.centerId ?? "")],
      )
    ).rows[0];
    assert(c, "HELP_CENTER_NOT_FOUND", "Help center unavailable.", 404);
    centerId = c.id;
  }
  const objectKey = `${encodeURIComponent(w)}/knowledge/${id}/quarantine`;
  await db.query(
    `INSERT INTO knowledge_files(workspace_id,id,purpose,record_id,center_id,locale,version,name,size,mime,object_key,uploaded_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      w,
      id,
      purpose,
      recordId,
      centerId,
      locale,
      version,
      name,
      size,
      type,
      objectKey,
      t.id,
    ],
  );
  const upload = await storage.signUpload(objectKey, type, size);
  return {
    fileId: id,
    recordId,
    url: upload.url,
    headers: upload.headers,
    expiresAt: upload.expiresAt,
  };
}

/** The bytes are in place: queue the scan (and extraction). Repeating it is harmless. */
export async function completeKnowledgeFile(
  db: Sql,
  w: string,
  principal: string,
  p: Record<string, unknown>,
) {
  const t = await manager(db, w, principal);
  const f = (
    await db.query<FileRow>(
      `${FILE} WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
      [w, String(p.fileId ?? "")],
    )
  ).rows[0];
  assert(f, "FILE_NOT_FOUND", "File unavailable.", 404);
  if (f.job_id) return { fileId: f.id, jobId: f.job_id };
  assert(
    f.status === "uploading",
    "FILE_STATE",
    "This file is already processed.",
    409,
  );
  const jobId = await enqueueJob(
    db,
    w,
    "knowledge.file.process",
    { fileId: f.id },
    { teammateId: t.id },
  );
  await db.query(
    "UPDATE knowledge_files SET status='scanning',job_id=$3 WHERE workspace_id=$1 AND id=$2",
    [w, f.id, jobId],
  );
  return { fileId: f.id, jobId };
}

/**
 * The background job: size, real type and virus checks; a clean copy; then, for a document, text
 * extraction and publishing. A file that fails a check is rejected and its upload deleted. A
 * document whose text cannot be extracted is kept (it can be downloaded) and marked failed, with a
 * reason a teammate can act on.
 */
export async function processKnowledgeFile(
  connect: Connect,
  storage: AttachmentStorage,
  job: Job,
) {
  const w = job.workspace_id,
    id = String(job.payload.fileId);
  const f = await tenant(
    connect,
    w,
    async (db) =>
      (
        await db.query<FileRow>(`${FILE} WHERE workspace_id=$1 AND id=$2`, [
          w,
          id,
        ])
      ).rows[0],
  );
  assert(f, "FILE_NOT_FOUND", "File unavailable.", 404);
  if (f.status !== "uploading" && f.status !== "scanning")
    return { done: true, result: { fileId: id, status: f.status } };
  const upload = await storage.getQuarantine(f.object_key);
  assert(upload, "UPLOAD_MISSING", "Upload did not reach storage.", 409);
  const max = f.purpose === "source" ? MAX_DOCUMENT_BYTES : MAX_IMAGE_BYTES;
  let reason: string | null = null;
  if (upload.bytes.length !== Number(f.size) || upload.bytes.length > max)
    reason = "SIZE_MISMATCH";
  else if (!matchesType(upload.bytes, f.mime)) reason = "TYPE_MISMATCH";
  else if ((await storage.scan(upload.bytes)) !== "clean")
    reason = "VIRUS_DETECTED";
  if (reason) {
    await tenant(connect, w, (db) =>
      db.query(
        "UPDATE knowledge_files SET status='rejected',failure_code=$3 WHERE workspace_id=$1 AND id=$2",
        [w, id, reason],
      ),
    );
    await storage.deleteQuarantine(f.object_key);
    return { done: true, result: { fileId: id, status: "rejected", reason } };
  }
  const checksum = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", upload.bytes as BufferSource),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  const cleanKey = `${encodeURIComponent(w)}/knowledge/${id}/${checksum}/clean`;
  await storage.putClean(cleanKey, upload.bytes, f.mime, f.name);
  await storage.deleteQuarantine(f.object_key);

  if (f.purpose !== "source") {
    await tenant(connect, w, (db) =>
      db.query(
        "UPDATE knowledge_files SET status='ready',clean_key=$3,checksum=$4,ready_at=now() WHERE workspace_id=$1 AND id=$2",
        [w, id, cleanKey, checksum],
      ),
    );
    return { done: true, result: { fileId: id, status: "ready" } };
  }

  let extracted;
  try {
    extracted = await extract(upload.bytes, f.mime as DocumentType);
  } catch (e) {
    const code = e instanceof ExtractError ? e.code : "UNREADABLE";
    await tenant(connect, w, (db) =>
      db.query(
        "UPDATE knowledge_files SET status='failed',failure_code=$3,clean_key=$4,checksum=$5 WHERE workspace_id=$1 AND id=$2",
        [w, id, code, cleanKey, checksum],
      ),
    );
    return {
      done: true,
      result: { fileId: id, status: "failed", reason: code },
    };
  }
  const replaced = await tenant(connect, w, async (db) => {
    const current = (
      await db.query<{ lease_token: string }>(
        "SELECT lease_token FROM jobs WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [w, job.id],
      )
    ).rows[0];
    assert(
      current?.lease_token === job.lease_token,
      "STALE_JOB",
      "A newer worker owns this file.",
      409,
    );
    // A newer version that finished first wins: this one is kept only as history.
    const newer = (
      await db.query(
        "SELECT 1 FROM knowledge_files WHERE workspace_id=$1 AND record_id=$2 AND status='ready' AND version>$3",
        [w, f.record_id, f.version],
      )
    ).rows.length;
    // Replaced versions keep their row (history) but not their bytes, deleted after commit.
    const previous = newer
      ? []
      : (
          await db.query<{ clean_key: string }>(
            `UPDATE knowledge_files n SET status='replaced',clean_key=NULL FROM knowledge_files o
            WHERE n.workspace_id=$1 AND n.record_id=$2 AND n.status='ready' AND n.id<>$3 AND o.workspace_id=n.workspace_id AND o.id=n.id
            RETURNING o.clean_key`,
            [w, f.record_id, id],
          )
        ).rows;
    await db.query(
      `UPDATE knowledge_files SET status=$8,clean_key=$3,checksum=$4,pages=$5,chars=$6,truncated=$7,ready_at=now()
      WHERE workspace_id=$1 AND id=$2`,
      [
        w,
        id,
        newer ? null : cleanKey,
        checksum,
        extracted.pages,
        extracted.text.length,
        extracted.truncated,
        newer ? "replaced" : "ready",
      ],
    );
    if (newer) return [{ clean_key: cleanKey }];
    await db.query(
      `UPDATE knowledge_locales SET status='published',published_title=draft_title,published_body=NULL,published_text=$4,
      published_revision=$5,published_at=now(),published_by=$6 WHERE workspace_id=$1 AND record_id=$2 AND locale=$3`,
      [w, f.record_id, f.locale, extracted.text, f.version, f.uploaded_by],
    );
    await db.query(
      "UPDATE knowledge_records SET updated_at=now() WHERE workspace_id=$1 AND id=$2",
      [w, f.record_id],
    );
    await indexRecord(db, w, f.record_id!);
    return previous;
  });
  for (const r of replaced)
    if (r.clean_key) await storage.deleteClean?.(r.clean_key);
  return {
    done: true,
    result: {
      fileId: id,
      status: "ready",
      chars: extracted.text.length,
      pages: extracted.pages,
    },
  };
}

/**
 * Removes a file record: its language is archived (so it leaves search and every surface) and
 * every stored version is marked removed. The record and its history remain. Returns the stored
 * objects to delete once this transaction has committed (`deleteKnowledgeObjects`).
 */
export async function removeKnowledgeFile(
  db: Sql,
  w: string,
  principal: string,
  p: Record<string, unknown>,
) {
  await manager(db, w, principal);
  const r = await record(db, w, p.recordId, true);
  assert(
    r.source === "file",
    "KNOWLEDGE_SOURCE",
    "Only file records are removed this way.",
    409,
  );
  await db.query(
    "UPDATE knowledge_locales SET status='archived' WHERE workspace_id=$1 AND record_id=$2",
    [w, r.id],
  );
  const removed = (
    await db.query<{ clean_key: string | null }>(
      `UPDATE knowledge_files n SET status='removed',clean_key=NULL FROM knowledge_files o
      WHERE n.workspace_id=$1 AND n.record_id=$2 AND n.status<>'removed' AND o.workspace_id=n.workspace_id AND o.id=n.id
      RETURNING o.clean_key`,
      [w, r.id],
    )
  ).rows;
  await indexRecord(db, w, r.id);
  await db.query(
    "UPDATE knowledge_records SET updated_at=now() WHERE workspace_id=$1 AND id=$2",
    [w, r.id],
  );
  return {
    recordId: r.id,
    keys: removed.map((x) => x.clean_key).filter((k): k is string => !!k),
  };
}
/** Deletes stored objects after the change that released them committed. Repeating is harmless. */
export async function deleteKnowledgeObjects(
  storage: AttachmentStorage,
  keys: string[],
) {
  for (const key of keys) await storage.deleteClean?.(key);
}

/** A file record's current file, for the editor: status, reason, sizes and an excerpt. */
export async function fileSummary(db: Sql, w: string, recordId: string) {
  const f = (
    await db.query<FileRow>(
      `${FILE} WHERE workspace_id=$1 AND record_id=$2 AND purpose='source' ORDER BY version DESC LIMIT 1`,
      [w, recordId],
    )
  ).rows[0];
  if (!f) return null;
  const live = (
    await db.query<{ version: number }>(
      `SELECT version FROM knowledge_files WHERE workspace_id=$1 AND record_id=$2 AND status='ready' ORDER BY version DESC LIMIT 1`,
      [w, recordId],
    )
  ).rows[0];
  const excerpt = (
    await db.query<{ text: string | null }>(
      "SELECT left(published_text,1200) AS text FROM knowledge_locales WHERE workspace_id=$1 AND record_id=$2 AND status='published' ORDER BY locale LIMIT 1",
      [w, recordId],
    )
  ).rows[0];
  return {
    id: f.id,
    name: f.name,
    size: Number(f.size),
    type: f.mime,
    version: f.version,
    status: f.status,
    failure: f.failure_code,
    pages: f.pages,
    chars: f.chars,
    truncated: f.truncated,
    liveVersion: live?.version ?? null,
    readyAt: f.ready_at ? new Date(f.ready_at).toISOString() : null,
    excerpt: excerpt?.text ?? null,
  };
}

/**
 * A file's bytes for a teammate: the original document (knowledge.manage, or a record available
 * to the inbox), an article image (anyone who may read the article), or a theme image.
 */
export async function teammateFile(
  db: Sql,
  w: string,
  principal: string,
  id: string,
) {
  await authorize(db, w, principal, "conversations.read");
  await requireKnowledge(db, w);
  const f = (
    await db.query<FileRow>(`${FILE} WHERE workspace_id=$1 AND id=$2`, [w, id])
  ).rows[0];
  assert(
    f?.clean_key &&
      (f.status === "ready" ||
        f.status === "failed" ||
        f.status === "replaced"),
    "FILE_NOT_FOUND",
    "File unavailable.",
    404,
  );
  if (f.record_id && !(await can(db, w, principal, "knowledge.manage"))) {
    const r = (
      await db.query(
        "SELECT 1 FROM knowledge_records WHERE workspace_id=$1 AND id=$2 AND for_inbox",
        [w, f.record_id],
      )
    ).rows.length;
    assert(r, "FILE_NOT_FOUND", "File unavailable.", 404);
  }
  return {
    key: f.clean_key!,
    type: f.mime,
    name: f.name,
    image: f.purpose !== "source",
  };
}

/**
 * Whether a file may be shown on a public help center page: a theme image of this help center, or
 * an image inside a published version of an article the visitor may read there.
 */
export async function publicFile(
  db: Sql,
  w: string,
  centerId: string,
  id: string,
  visibleArticle: (recordId: string) => boolean,
) {
  const f = (
    await db.query<FileRow>(
      `${FILE} WHERE workspace_id=$1 AND id=$2 AND status='ready'`,
      [w, id],
    )
  ).rows[0];
  if (!f?.clean_key) return null;
  if ((THEME_PURPOSES as readonly string[]).includes(f.purpose))
    return f.center_id === centerId ? { key: f.clean_key, type: f.mime } : null;
  if (
    f.purpose !== "article_image" ||
    !f.record_id ||
    !visibleArticle(f.record_id)
  )
    return null;
  const used = (
    await db.query(
      "SELECT 1 FROM knowledge_locales WHERE workspace_id=$1 AND record_id=$2 AND status='published' AND published_body::text LIKE '%' || $3 || '%' LIMIT 1",
      [w, f.record_id, id],
    )
  ).rows.length;
  return used ? { key: f.clean_key, type: f.mime } : null;
}

/** A ready article image, for a signed messenger address (the signature names the file). */
export async function articleImage(db: Sql, w: string, id: string) {
  const f = (
    await db.query<{ clean_key: string; mime: string }>(
      "SELECT clean_key,mime FROM knowledge_files WHERE workspace_id=$1 AND id=$2 AND purpose='article_image' AND status='ready'",
      [w, id],
    )
  ).rows[0];
  return f ? { key: f.clean_key, type: f.mime } : null;
}

/** Article images that are ready, of the ids given, for a record (publishing checks this). */
export async function readyImages(
  db: Sql,
  w: string,
  recordId: string,
  ids: string[],
) {
  if (!ids.length) return new Set<string>();
  return new Set(
    (
      await db.query<{ id: string }>(
        "SELECT id FROM knowledge_files WHERE workspace_id=$1 AND record_id=$2 AND purpose='article_image' AND status='ready' AND id=ANY($3::text[])",
        [w, recordId, ids],
      )
    ).rows.map((r) => r.id),
  );
}

/** A ready theme image of this help center with the expected purpose, or a refusal. */
export async function themeImage(
  db: Sql,
  w: string,
  centerId: string,
  purpose: (typeof THEME_PURPOSES)[number],
  id: unknown,
) {
  if (id === null || id === undefined || id === "") return null;
  const ok = (
    await db.query(
      "SELECT 1 FROM knowledge_files WHERE workspace_id=$1 AND id=$2 AND center_id=$3 AND purpose=$4 AND status='ready'",
      [w, String(id), centerId, purpose],
    )
  ).rows.length;
  if (!ok)
    throw new DomainError(
      "INVALID_HELP_CENTER",
      "That image is not ready yet. Upload it again.",
      400,
    );
  return String(id);
}

/** Streams a stored file with headers that stop a browser from running it. */
export async function fileResponse(
  storage: AttachmentStorage,
  file: { key: string; type: string; name?: string },
  options: { download: boolean; cache: string },
) {
  if (!storage.readClean) return new Response("Not available", { status: 404 });
  const stored = await storage.readClean(file.key);
  if (!stored.ok) return new Response("Not found", { status: 404 });
  const headers = new Headers({
    "content-type": file.type,
    "cache-control": options.cache,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
  });
  if (options.download)
    headers.set(
      "content-disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(file.name ?? "file")}`,
    );
  return new Response(stored.body, { status: 200, headers });
}

/** A short-lived signed address for an image in the messenger (an <img> cannot send a token). */
export async function signFileUrl(
  secret: string,
  w: string,
  id: string,
  now = Date.now(),
) {
  const expires = Math.floor(now / 1000) + 3600;
  const sig = await hmac(secret, `${w}:${id}:${expires}`);
  return `/v1/messenger/help/file?${new URLSearchParams({ w, id, e: String(expires), s: sig })}`;
}
export async function verifyFileUrl(
  secret: string,
  q: URLSearchParams,
  now = Date.now(),
) {
  const w = q.get("w") ?? "",
    id = q.get("id") ?? "",
    e = Number(q.get("e")),
    s = q.get("s") ?? "";
  if (!w || !id || !(e * 1000 > now)) return null;
  const expected = await hmac(secret, `${w}:${id}:${e}`);
  if (expected.length !== s.length) return null;
  let diff = 0;
  for (let i = 0; i < s.length; i++)
    diff |= expected.charCodeAt(i) ^ s.charCodeAt(i);
  return diff === 0 ? { workspace: w, id } : null;
}
async function hmac(secret: string, message: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("relay-knowledge-file:" + secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)),
  );
  return btoa(String.fromCharCode(...sig))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

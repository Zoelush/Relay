import { assert, DomainError, tenant, type Connect, type Sql } from "./db";
import { enqueueJob, type Job } from "./jobs";
import type { AttachmentStorage } from "./attachments";
import { matchesType } from "./knowledge-extract";
import { manage, type MessengerConfig } from "./messenger-config";
import { authorize } from "./policy";
import { aiEnabled } from "./ai-agent";

/**
 * Images a brand uploads for its messenger (messenger settings M5; docs/MESSENGER_SETTINGS_STEP5.md):
 * the Home screen logo, the launcher logo and Home's background.
 *
 * Uploads follow the attachment path: the browser puts the bytes into quarantine with a signed
 * URL, a background job checks the size and real type, scans them, and copies them to a clean key.
 * The messenger config refers to a ready image as `asset:<id>`, in the field that used to take an
 * https address (which still works). Customers are served an image only while their brand's
 * published messenger uses it; teammates see draft images through the agent app. Uploads that
 * nothing uses (no draft, no live messenger, no version) are removed a day later, when the brand
 * next uploads, so restoring an earlier version always finds its images.
 */
export const ASSET_PURPOSES = [
  "home_logo",
  "launcher_logo",
  "home_background",
  // Z1: Zoe's avatar per brand, for the light and dark messenger themes.
  "agent_avatar",
  "agent_avatar_dark",
] as const;
const AGENT_PURPOSES = ["agent_avatar", "agent_avatar_dark"];
/**
 * Who may upload: the messenger's images need its drafts (messenger_v3); Zoe's avatars need the
 * AI agent (ai_agent_v1). Both need workspace.manage and the brand.
 */
async function permitted(
  db: Sql,
  w: string,
  principal: string,
  brandId: unknown,
  purpose: string,
) {
  if (!AGENT_PURPOSES.includes(purpose))
    return manage(db, w, principal, brandId);
  const t = await authorize(db, w, principal, "workspace.manage");
  assert(
    await aiEnabled(db, w),
    "AI_AGENT_DISABLED",
    "The AI agent is not enabled for this workspace.",
    404,
  );
  const brand = (
    await db.query<{ id: string }>(
      "SELECT id FROM brands WHERE workspace_id=$1 AND id=$2",
      [w, String(brandId ?? "")],
    )
  ).rows[0];
  assert(brand, "BRAND_NOT_FOUND", "Brand unavailable.", 404);
  return { t, brand };
}
export type AssetPurpose = (typeof ASSET_PURPOSES)[number];
export const ASSET_TYPES = ["image/png", "image/jpeg", "image/gif"];
export const MAX_ASSET_BYTES = 1024 * 1024;
const REF = /^asset:([0-9a-f-]{36})$/;
/** The asset id in a config value such as "asset:<id>", or null for an address or nothing. */
export const assetId = (value: unknown) =>
  typeof value === "string" ? (REF.exec(value)?.[1] ?? null) : null;
export const isAssetRef = (value: unknown) => assetId(value) !== null;

type Row = {
  id: string;
  brand_id: string;
  purpose: AssetPurpose;
  name: string;
  size: number;
  mime: string;
  object_key: string;
  clean_key: string | null;
  status: "uploading" | "scanning" | "ready" | "rejected";
  failure_code: string | null;
  job_id: string | null;
};
const ROW =
  "SELECT id,brand_id,purpose,name,size,mime,object_key,clean_key,status,failure_code,job_id FROM brand_assets";
const invalid = (message: string): never => {
  throw new DomainError("INVALID_ASSET", message, 400);
};
const WHAT: Record<AssetPurpose, string> = {
  home_logo: "Home screen logo",
  launcher_logo: "launcher logo",
  home_background: "Home background image",
  agent_avatar: "avatar",
  agent_avatar_dark: "dark-theme avatar",
};

/** Where each kind of image sits in a messenger config (live settings or a draft). */
function slots(c: {
  logo?: unknown;
  look?: { launcherLogo?: unknown; header?: { image?: unknown } };
  messenger3?: {
    look?: { launcherLogo?: unknown; header?: { image?: unknown } };
  };
}): [AssetPurpose, unknown][] {
  const look = c.look ?? c.messenger3?.look;
  return [
    ["home_logo", c.logo],
    ["launcher_logo", look?.launcherLogo],
    ["home_background", look?.header?.image],
  ];
}
/** The asset ids a config (or a brand's live settings) uses. */
export const assetsIn = (c: Parameters<typeof slots>[0] | null | undefined) =>
  c
    ? slots(c)
        .map(([, v]) => assetId(v))
        .filter((x): x is string => !!x)
    : [];

/**
 * Before a draft is saved or published: every image it uses is this brand's, ready, and in the
 * place it was uploaded for.
 */
export async function checkAssets(
  db: Sql,
  w: string,
  brandId: string,
  config: MessengerConfig,
) {
  for (const [purpose, value] of slots(config)) {
    const id = assetId(value);
    if (!id) continue;
    const ok = (
      await db.query(
        "SELECT 1 FROM brand_assets WHERE workspace_id=$1 AND id=$2 AND brand_id=$3 AND purpose=$4 AND status='ready'",
        [w, id, brandId, purpose],
      )
    ).rows.length;
    if (!ok)
      invalid(`The ${WHAT[purpose]} isn't available. Upload it again.`);
  }
}

/** Starts an upload: checks it, tidies away unused uploads, and signs the quarantine address. */
export async function prepareBrandAsset(
  db: Sql,
  w: string,
  principal: string,
  storage: AttachmentStorage,
  p: Record<string, unknown>,
) {
  const purpose = p.purpose as AssetPurpose;
  if (!ASSET_PURPOSES.includes(purpose))
    invalid("Choose which image this is.");
  const { t, brand } = await permitted(db, w, principal, p.brandId, purpose);
  const name = typeof p.name === "string" ? p.name.trim() : "";
  if (!name || name.length > 200 || /[\x00-\x1f]/.test(name))
    invalid("Choose a file with a valid name.");
  const type = String(p.type ?? "");
  if (type === "image/svg+xml" || /\.svg$/i.test(name))
    invalid(
      "SVG images can carry scripts, so they aren't accepted. Save it as a PNG.",
    );
  if (!ASSET_TYPES.includes(type)) invalid("Upload a PNG, JPG or GIF image.");
  const size = Number(p.size);
  if (!Number.isInteger(size) || size < 1 || size > MAX_ASSET_BYTES)
    invalid("Images can be up to 1 MB.");
  const removed = await tidy(db, w, brand.id);
  const id = crypto.randomUUID();
  const objectKey = `${encodeURIComponent(w)}/brand-assets/${id}/quarantine`;
  await db.query(
    `INSERT INTO brand_assets(workspace_id,id,brand_id,purpose,name,size,mime,object_key,uploaded_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [w, id, brand.id, purpose, name, size, type, objectKey, t.id],
  );
  const upload = await storage.signUpload(objectKey, type, size);
  return {
    assetId: id,
    url: upload.url,
    headers: upload.headers,
    expiresAt: upload.expiresAt,
    // Stored objects to remove once this transaction has committed (server-side only).
    removedKeys: removed,
  };
}

/**
 * Uploads more than a day old that nothing uses: not the draft, not the live messenger, not any
 * published version. Returns their stored objects to delete after commit.
 */
async function tidy(db: Sql, w: string, brandId: string) {
  const used = new Set<string>();
  const configs = (
    await db.query<{ config: Record<string, unknown> }>(
      `SELECT config FROM messenger_drafts WHERE workspace_id=$1 AND brand_id=$2
       UNION ALL SELECT config FROM messenger_versions WHERE workspace_id=$1 AND brand_id=$2
       UNION ALL SELECT settings FROM brands WHERE workspace_id=$1 AND id=$2`,
      [w, brandId],
    )
  ).rows;
  for (const { config } of configs) for (const id of assetsIn(config)) used.add(id);
  // Zoe's avatars (Z1) are in use while an identity names them.
  for (const r of (
    await db.query<{ avatar: string; avatar_dark: string }>(
      "SELECT avatar,avatar_dark FROM ai_agent_identities WHERE workspace_id=$1 AND brand_id=$2",
      [w, brandId],
    )
  ).rows)
    for (const v of [r.avatar, r.avatar_dark]) {
      const id = assetId(v);
      if (id) used.add(id);
    }
  const old = (
    await db.query<{ id: string; object_key: string; clean_key: string | null }>(
      `DELETE FROM brand_assets WHERE workspace_id=$1 AND brand_id=$2 AND created_at<now()-interval '1 day'
       AND NOT (id=ANY($3::text[])) RETURNING id,object_key,clean_key`,
      [w, brandId, [...used]],
    )
  ).rows;
  return old.flatMap((a) => [a.clean_key, a.object_key].filter((k): k is string => !!k));
}
/** Removes stored objects of tidied uploads (after the transaction that deleted their rows). */
export async function deleteAssetObjects(
  storage: AttachmentStorage,
  keys: unknown,
) {
  if (!Array.isArray(keys)) return;
  for (const key of keys) {
    if (String(key).endsWith("/quarantine"))
      await storage.deleteQuarantine(String(key));
    else await storage.deleteClean?.(String(key));
  }
}

/** The bytes are in place: queue the check. Repeating it is harmless. */
export async function completeBrandAsset(
  db: Sql,
  w: string,
  principal: string,
  p: Record<string, unknown>,
) {
  const a = (
    await db.query<Row>(`${ROW} WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, [
      w,
      String(p.assetId ?? ""),
    ])
  ).rows[0];
  assert(a, "ASSET_NOT_FOUND", "Image unavailable.", 404);
  const { t } = await permitted(db, w, principal, a.brand_id, a.purpose);
  if (a.job_id) return { assetId: a.id, jobId: a.job_id };
  assert(a.status === "uploading", "ASSET_STATE", "This image is already checked.", 409);
  const jobId = await enqueueJob(
    db,
    w,
    "messenger.asset.process",
    { assetId: a.id },
    { teammateId: t.id },
  );
  await db.query(
    "UPDATE brand_assets SET status='scanning',job_id=$3 WHERE workspace_id=$1 AND id=$2",
    [w, a.id, jobId],
  );
  return { assetId: a.id, jobId };
}

/** The background job: size, real type and virus checks, then a clean copy. */
export async function processBrandAsset(
  connect: Connect,
  storage: AttachmentStorage,
  job: Job,
) {
  const w = job.workspace_id,
    id = String(job.payload.assetId);
  const a = await tenant(
    connect,
    w,
    async (db) =>
      (await db.query<Row>(`${ROW} WHERE workspace_id=$1 AND id=$2`, [w, id]))
        .rows[0],
  );
  assert(a, "ASSET_NOT_FOUND", "Image unavailable.", 404);
  if (a.status !== "uploading" && a.status !== "scanning")
    return { done: true, result: { assetId: id, status: a.status } };
  const upload = await storage.getQuarantine(a.object_key);
  assert(upload, "UPLOAD_MISSING", "Upload did not reach storage.", 409);
  let reason: string | null = null;
  if (upload.bytes.length !== Number(a.size) || upload.bytes.length > MAX_ASSET_BYTES)
    reason = "SIZE_MISMATCH";
  else if (!matchesType(upload.bytes, a.mime)) reason = "TYPE_MISMATCH";
  else if ((await storage.scan(upload.bytes)) !== "clean")
    reason = "VIRUS_DETECTED";
  if (reason) {
    await tenant(connect, w, (db) =>
      db.query(
        "UPDATE brand_assets SET status='rejected',failure_code=$3 WHERE workspace_id=$1 AND id=$2",
        [w, id, reason],
      ),
    );
    await storage.deleteQuarantine(a.object_key);
    return { done: true, result: { assetId: id, status: "rejected", reason } };
  }
  const checksum = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", upload.bytes as BufferSource),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  const cleanKey = `${encodeURIComponent(w)}/brand-assets/${id}/${checksum}/clean`;
  await storage.putClean(cleanKey, upload.bytes, a.mime, a.name);
  await storage.deleteQuarantine(a.object_key);
  await tenant(connect, w, (db) =>
    db.query(
      "UPDATE brand_assets SET status='ready',clean_key=$3,checksum=$4,ready_at=now() WHERE workspace_id=$1 AND id=$2",
      [w, id, cleanKey, checksum],
    ),
  );
  return { done: true, result: { assetId: id, status: "ready" } };
}

/** A ready image, for a teammate who manages the messenger (the Settings preview). */
export async function teammateAsset(
  db: Sql,
  w: string,
  principal: string,
  id: string,
) {
  const a = (
    await db.query<Row>(
      `${ROW} WHERE workspace_id=$1 AND id=$2 AND status='ready'`,
      [w, id],
    )
  ).rows[0];
  assert(a?.clean_key, "ASSET_NOT_FOUND", "Image unavailable.", 404);
  await permitted(db, w, principal, a.brand_id, a.purpose);
  return { key: a.clean_key!, type: a.mime };
}

/** A ready image the brand's published messenger uses, for customers; otherwise null. */
export async function liveAsset(db: Sql, w: string, id: string) {
  const a = (
    await db.query<Row & { settings: Record<string, unknown> }>(
      `SELECT a.clean_key,a.mime,b.settings FROM brand_assets a JOIN brands b ON b.workspace_id=a.workspace_id AND b.id=a.brand_id
       WHERE a.workspace_id=$1 AND a.id=$2 AND a.status='ready'`,
      [w, id],
    )
  ).rows[0];
  if (!a?.clean_key) return null;
  const inIdentity = (
    await db.query(
      "SELECT 1 FROM ai_agent_identities i JOIN brand_assets a ON a.workspace_id=i.workspace_id AND a.id=$2 AND a.brand_id=i.brand_id WHERE i.workspace_id=$1 AND (i.avatar=$3 OR i.avatar_dark=$3)",
      [w, id, "asset:" + id],
    )
  ).rows.length;
  if (!inIdentity && !assetsIn(a.settings).includes(id)) return null;
  return { key: a.clean_key, type: a.mime };
}

/** The customer-facing address of an image in a published messenger. */
export const assetUrl = (apiOrigin: string, w: string, id: string) =>
  `${apiOrigin}/v1/messenger/brand-asset?${new URLSearchParams({ w, id })}`;
/** Live settings with "asset:<id>" replaced by the image's address, for the messenger's boot. */
export function resolveAssets<T extends Record<string, unknown>>(
  settings: T,
  apiOrigin: string,
  w: string,
): T {
  const url = (v: unknown) => {
    const id = assetId(v);
    return id ? assetUrl(apiOrigin, w, id) : v;
  };
  const m3 = settings.messenger3 as
    | { look?: { launcherLogo?: unknown; header?: { image?: unknown } } }
    | undefined;
  return {
    ...settings,
    ...("logo" in settings ? { logo: url(settings.logo) } : {}),
    ...(m3?.look
      ? {
          messenger3: {
            ...m3,
            look: {
              ...m3.look,
              launcherLogo: url(m3.look.launcherLogo),
              ...(m3.look.header
                ? { header: { ...m3.look.header, image: url(m3.look.header.image) } }
                : {}),
            },
          },
        }
      : {}),
  };
}

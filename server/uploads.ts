import type { Sql } from "./db";
import type { AttachmentStorage } from "./attachments";

/**
 * Moving an upload from one workspace to another (docs/TEST_WORKSPACE_STEP4.md, T2b): the images a
 * messenger, a help centre's look, Zoe's identity or an article refers to.
 *
 * Two places need this, in opposite directions — the copy that makes a test workspace, and a
 * promotion back into production — so what an upload is made of is written down once here.
 *
 * Nothing is shared between the two workspaces. An image that arrives is the receiving
 * workspace's own row and its own stored object, under a key of its own, so removing a workspace
 * can never take the other's image away. The key is the one that workspace's own upload path
 * would have given it: the workspace, the id and the bytes' checksum.
 */
export type UploadTable = "brand_assets" | "knowledge_files";

export type Upload = {
  table: UploadTable;
  id: string;
  purpose: string;
  name: string;
  mime: string;
  size: number;
  checksum: string;
  cleanKey: string;
  /** `brand_assets`: the brand whose image it is. */
  brandId: string | null;
  /** `knowledge_files`: the help centre or the article it belongs to. */
  centerId: string | null;
  recordId: string | null;
  locale: string | null;
  version: number;
  /** Whoever uploaded it, which a copy keeps: the pair's teammates have the same ids. */
  uploadedBy: string | null;
};

const SELECT: Record<UploadTable, string> = {
  brand_assets: `SELECT id,purpose,brand_id,NULL AS center_id,NULL AS record_id,NULL AS locale,1 AS version,
    name,size::text AS size,mime,checksum,clean_key,uploaded_by FROM brand_assets`,
  knowledge_files: `SELECT id,purpose,NULL AS brand_id,center_id,record_id,locale,version,
    name,size::text AS size,mime,checksum,clean_key,uploaded_by FROM knowledge_files`,
};
type Row = {
  id: string;
  purpose: string;
  brand_id: string | null;
  center_id: string | null;
  record_id: string | null;
  locale: string | null;
  version: number;
  name: string;
  size: string;
  mime: string;
  checksum: string | null;
  clean_key: string | null;
  uploaded_by: string | null;
};

/**
 * The uploads of these ids that are ready and have their bytes. Anything still being checked, or
 * rejected, or whose bytes were tidied away, is not here: it cannot be brought.
 */
export async function readUploads(db: Sql, w: string, table: UploadTable, ids: string[]): Promise<Upload[]> {
  if (!ids.length) return [];
  const rows = (
    await db.query<Row>(`${SELECT[table]} WHERE workspace_id=$1 AND id=ANY($2::text[]) AND status='ready'`, [w, [...new Set(ids)]])
  ).rows;
  return rows
    .filter((r) => r.clean_key && r.checksum)
    .map((r) => ({
      table,
      id: r.id,
      purpose: r.purpose,
      name: r.name,
      mime: r.mime,
      size: Number(r.size),
      checksum: r.checksum as string,
      cleanKey: r.clean_key as string,
      brandId: r.brand_id,
      centerId: r.center_id,
      recordId: r.record_id,
      locale: r.locale,
      version: r.version,
      uploadedBy: r.uploaded_by,
    }));
}

/** Where a workspace keeps an upload's bytes: the key its own upload path builds. */
export const cleanKeyIn = (table: UploadTable, w: string, id: string, checksum: string) =>
  `${encodeURIComponent(w)}/${table === "brand_assets" ? "brand-assets" : "knowledge"}/${id}/${checksum}/clean`;

/**
 * Copies an upload's bytes to the key the receiving workspace will use. False when this
 * deployment cannot read stored objects, or the bytes are no longer there — the caller then
 * leaves the row out rather than writing one that points at nothing.
 */
export async function copyBytes(storage: AttachmentStorage | undefined, u: Upload, toKey: string) {
  if (!storage?.readClean) return false;
  const stored = await storage.readClean(u.cleanKey).catch(() => null);
  if (!stored || !stored.ok) return false;
  const bytes = new Uint8Array(await stored.arrayBuffer());
  if (!bytes.length) return false;
  await storage.putClean(toKey, bytes, u.mime, u.name);
  return true;
}

/**
 * Writes the upload into the receiving workspace, ready, pointing at bytes already stored there.
 * `id` is the upload's own id when it is being copied as it is (the pair keeps ids, so a copied
 * configuration still finds its images) and a new one when it is arriving as this workspace's own
 * upload.
 */
export async function writeUpload(db: Sql, to: string, u: Upload, p: { id: string; cleanKey: string; by: string }) {
  const objectKey = `${encodeURIComponent(to)}/${u.table === "brand_assets" ? "brand-assets" : "knowledge"}/${p.id}/quarantine`;
  if (u.table === "brand_assets")
    await db.query(
      `INSERT INTO brand_assets(workspace_id,id,brand_id,purpose,name,size,mime,object_key,clean_key,checksum,status,uploaded_by,ready_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ready',$11,now()) ON CONFLICT DO NOTHING`,
      [to, p.id, u.brandId, u.purpose, u.name, u.size, u.mime, objectKey, p.cleanKey, u.checksum, p.by],
    );
  else
    await db.query(
      `INSERT INTO knowledge_files(workspace_id,id,purpose,record_id,center_id,locale,version,name,size,mime,object_key,clean_key,checksum,status,uploaded_by,ready_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'ready',$14,now()) ON CONFLICT DO NOTHING`,
      [to, p.id, u.purpose, u.recordId, u.centerId, u.locale, u.version, u.name, u.size, u.mime, objectKey, p.cleanKey, u.checksum, p.by],
    );
}

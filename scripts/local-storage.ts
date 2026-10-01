/**
 * Loopback-only attachment storage for the local relay and browser tests. Never imported by the
 * deployed Worker, which uses R2 (`workers/storage.ts`).
 *
 * Objects live in memory. Upload and download URLs are relative, one-time-token paths served by
 * both local servers, so the agent page and the messenger frame each reach them on their own
 * origin within their content security policies. The scanner reports "infected" for the
 * standard EICAR antivirus test string and "clean" otherwise.
 */
import type { AttachmentStorage } from "../server/attachments";

const EICAR =
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
export const LOCAL_STORAGE_PATH = "/__local-storage/";
// Knowledge files go up to 20 MB (phase 07, C1a); message attachments keep their own 10 MB check.
export const LOCAL_UPLOAD_LIMIT = 20 * 1024 * 1024;

export function localAttachmentStorage() {
  const quarantine = new Map<string, { bytes: Uint8Array; type: string }>();
  const clean = new Map<
    string,
    { bytes: Uint8Array; type: string; name: string }
  >();
  const uploads = new Map<
    string,
    { key: string; type: string; size: number; expires: number }
  >();
  const downloads = new Map<string, { key: string; expires: number }>();
  const token = () => crypto.randomUUID().replace(/-/g, "");
  const storage: AttachmentStorage = {
    async signUpload(key, type, size) {
      const t = token(),
        expires = Date.now() + 10 * 60_000;
      uploads.set(t, { key, type, size, expires });
      return {
        url: `${LOCAL_STORAGE_PATH}upload/${t}`,
        headers: { "content-type": type },
        expiresAt: new Date(expires).toISOString(),
      };
    },
    getQuarantine: async (key) => quarantine.get(key) ?? null,
    scan: async (bytes) =>
      new TextDecoder().decode(bytes).includes(EICAR) ? "infected" : "clean",
    async putClean(key, bytes, type, name) {
      clean.set(key, { bytes, type, name });
    },
    // Local previews reuse the image bytes; browsers decode by content, not the label.
    preview: async (bytes) => bytes,
    deleteQuarantine: async (key) => void quarantine.delete(key),
    deleteClean: async (key) => void clean.delete(key),
    async signDownload(key) {
      const t = token(),
        expires = Date.now() + 5 * 60_000;
      downloads.set(t, { key, expires });
      return {
        url: `${LOCAL_STORAGE_PATH}download/${t}`,
        expiresAt: new Date(expires).toISOString(),
      };
    },
    async readClean(key) {
      const object = clean.get(key);
      return object
        ? new Response(object.bytes as BodyInit, {
            headers: { "content-type": object.type },
          })
        : new Response("Not found", { status: 404 });
    },
  };
  /** Serves upload (PUT) and download (GET) token paths; null for any other path. */
  async function handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith(LOCAL_STORAGE_PATH)) return null;
    const [kind, t] = url.pathname.slice(LOCAL_STORAGE_PATH.length).split("/");
    const headers = {
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    };
    if (kind === "upload" && req.method === "PUT") {
      const grant = uploads.get(t);
      uploads.delete(t);
      if (!grant || grant.expires < Date.now())
        return new Response("Upload link expired", { status: 403, headers });
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (
        bytes.length !== grant.size ||
        req.headers.get("content-type") !== grant.type
      )
        return new Response("Upload does not match its grant", {
          status: 400,
          headers,
        });
      quarantine.set(grant.key, { bytes, type: grant.type });
      return new Response(null, { status: 200, headers });
    }
    if (kind === "download" && req.method === "GET") {
      const grant = downloads.get(t);
      const object =
        grant && grant.expires >= Date.now() ? clean.get(grant.key) : undefined;
      if (!object) return new Response("Not found", { status: 404, headers });
      return new Response(object.bytes as BodyInit, {
        headers: { ...headers, "content-type": object.type },
      });
    }
    return new Response("Not found", { status: 404, headers });
  }
  return { storage, handle };
}

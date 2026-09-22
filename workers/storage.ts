import { AwsClient } from "aws4fetch";
import { assert } from "../server/db";
import {
  MAX_ATTACHMENT_BYTES,
  type AttachmentStorage,
} from "../server/attachments";

export interface StorageEnv {
  ATTACHMENT_QUARANTINE: R2Bucket;
  ATTACHMENT_CLEAN: R2Bucket;
  SCANNER: Fetcher;
  SCAN_SERVICE_TOKEN: string;
  IMAGE_PREVIEW?: Fetcher;
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_QUARANTINE_BUCKET: string;
  R2_CLEAN_BUCKET: string;
}
export function r2Attachments(env: StorageEnv): AttachmentStorage {
  const signer = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    region: "auto",
    service: "s3",
  });
  const signed = async (
    bucket: string,
    key: string,
    method: string,
    headers: Record<string, string> = {},
    preview = false,
  ) => {
    const url = new URL(
      `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`,
    );
    url.searchParams.set("X-Amz-Expires", "300");
    if (method === "GET")
      url.searchParams.set(
        "response-content-disposition",
        preview ? "inline" : "attachment",
      );
    const req = await signer.sign(new Request(url, { method, headers }), {
      aws: { signQuery: true, allHeaders: true },
    });
    return {
      url: req.url,
      headers,
      expiresAt: new Date(Date.now() + 300000).toISOString(),
    };
  };
  return {
    signUpload: (key, type) =>
      signed(env.R2_QUARANTINE_BUCKET, key, "PUT", { "Content-Type": type }),
    async getQuarantine(key) {
      const object = await env.ATTACHMENT_QUARANTINE.get(key);
      if (!object) return null;
      assert(
        object.size <= MAX_ATTACHMENT_BYTES,
        "ATTACHMENT_SIZE",
        "Uploaded file is too large.",
      );
      return {
        bytes: new Uint8Array(await object.arrayBuffer()),
        type: object.httpMetadata?.contentType ?? "",
      };
    },
    async scan(bytes) {
      const response = await env.SCANNER.fetch(
        new Request("https://scanner.internal/scan", {
          method: "POST",
          body: bytes as BodyInit,
          headers: {
            "content-type": "application/octet-stream",
            authorization: "Bearer " + env.SCAN_SERVICE_TOKEN,
          },
          signal: AbortSignal.timeout(90000),
        }),
      );
      assert(
        response.ok,
        "SCANNER_UNAVAILABLE",
        "Attachment scanning is temporarily unavailable.",
        503,
      );
      const result = (await response.json()) as { verdict: string };
      assert(
        ["clean", "infected"].includes(result.verdict),
        "SCANNER_INVALID",
        "Scanner returned an invalid result.",
        503,
      );
      return result.verdict as "clean" | "infected";
    },
    async putClean(key, bytes, type, name) {
      await env.ATTACHMENT_CLEAN.put(key, bytes, {
        httpMetadata: {
          contentType: type,
          contentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
          cacheControl: "private, no-store",
        },
      });
    },
    ...(env.IMAGE_PREVIEW
      ? {
          async preview(bytes: Uint8Array, type: string) {
            const r = await env.IMAGE_PREVIEW!.fetch(
              new Request("https://preview.internal/thumbnail", {
                method: "POST",
                headers: { "content-type": type },
                body: bytes as BodyInit,
                signal: AbortSignal.timeout(30000),
              }),
            );
            assert(
              r.ok && r.headers.get("content-type") === "image/png",
              "PREVIEW_FAILED",
              "Image preview could not be generated.",
              503,
            );
            const output = new Uint8Array(await r.arrayBuffer());
            assert(
              output.length <= 2 * 1024 * 1024,
              "PREVIEW_FAILED",
              "Preview is too large.",
              503,
            );
            return output;
          },
        }
      : {}),
    deleteQuarantine: (key) => env.ATTACHMENT_QUARANTINE.delete(key),
    async readClean(key) {
      const object = await env.ATTACHMENT_CLEAN.get(key);
      if (!object) return new Response("Not found", { status: 404 });
      return new Response(object.body, {
        headers: {
          "content-type":
            object.httpMetadata?.contentType ?? "application/octet-stream",
        },
      });
    },
    signDownload: (key, preview) =>
      signed(env.R2_CLEAN_BUCKET, key, "GET", {}, preview),
  };
}

import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation, getIdentity } from "../server/people";
import { command, timeline } from "../server/conversations";
import {
  prepareAttachment,
  completeAttachment,
  attachmentScan,
  downloadAttachment,
  type AttachmentStorage,
} from "../server/attachments";
import { runJob } from "../server/jobs";

test("quarantine, asynchronous scan, exact-byte promotion, idempotent part, and tenant-scoped download", async () => {
  const db = await testDatabase(),
    objects = new Map<string, { bytes: Uint8Array; type: string }>(),
    clean = new Map<string, Uint8Array>();
  let verdict: "clean" | "infected" = "clean";
  let scans = 0;
  const storage: AttachmentStorage = {
    signUpload: async () => ({
      url: "https://example.invalid/upload",
      headers: {},
      expiresAt: "",
    }),
    getQuarantine: async (key) => objects.get(key) ?? null,
    scan: async () => {
      scans++;
      return verdict;
    },
    putClean: async (key, bytes) => {
      clean.set(key, bytes);
    },
    deleteQuarantine: async (key) => {
      objects.delete(key);
    },
    signDownload: async () => ({
      url: "https://example.invalid/private",
      expiresAt: "",
    }),
  };
  try {
    await tenant(db.connect, "a", (sql) =>
      seedFoundation(sql, "a", "owner", {
        origins: [],
        master: "a".repeat(32),
        identitySecret: new TextEncoder().encode("b".repeat(32)),
      }),
    );
    const identity = await tenant(db.connect, "a", (sql) =>
      getIdentity(sql, "a", "anonymous", "device"),
    );
    const actor = {
      type: "contact" as const,
      identityId: identity.identityId,
      brandId: "default",
    };
    const c = await tenant(db.connect, "a", (sql) =>
      command(sql, "a", actor, "start-file", {
        action: "start",
        text: "File upload",
      }),
    );
    const conversationId = String(c.conversationId);
    const upload = async (
      name: string,
      bytes: Uint8Array,
      mime = "text/plain",
    ) => {
      const a = await tenant(db.connect, "a", (sql) =>
        prepareAttachment(sql, "a", actor, crypto.randomUUID(), {
          conversationId,
          name,
          size: bytes.length,
          type: mime,
        }),
      );
      objects.set(a.objectKey, { bytes, type: mime });
      const job = await tenant(db.connect, "a", (sql) =>
        completeAttachment(sql, "a", actor, crypto.randomUUID(), {
          attachmentId: a.id,
        }),
      );
      return { ...a, ...job };
    };
    const a = await upload("hello.txt", new TextEncoder().encode("safe text"));
    await assert.rejects(
      tenant(db.connect, "a", (sql) =>
        downloadAttachment(sql, "a", actor, a.id, false),
      ),
      { code: "ATTACHMENT_NOT_READY" },
    );
    const handlers = {
      "attachment.scan": (job: Parameters<typeof attachmentScan>[2]) =>
        attachmentScan(db.connect, storage, job),
    };
    assert.equal(
      (await runJob(db.connect, "a", a.jobId, handlers)).state,
      "succeeded",
    );
    await runJob(db.connect, "a", a.jobId, handlers);
    assert.equal(scans, 1);
    const key = await tenant(db.connect, "a", (sql) =>
      downloadAttachment(sql, "a", actor, a.id, false),
    );
    assert.notEqual(key, a.objectKey);
    assert.equal(new TextDecoder().decode(clean.get(key)), "safe text");
    objects.set(a.objectKey, {
      bytes: new TextEncoder().encode("late replacement"),
      type: "text/plain",
    });
    assert.equal(new TextDecoder().decode(clean.get(key)), "safe text");
    await assert.rejects(
      tenant(db.connect, "b", (sql) =>
        downloadAttachment(sql, "b", actor, a.id, false),
      ),
      { code: "ATTACHMENT_NOT_FOUND" },
    );
    const history = await tenant(db.connect, "a", (sql) =>
      timeline(sql, "a", conversationId, actor),
    );
    assert.equal(
      history.parts.filter((p) => p.kind === "attachment").length,
      1,
    );
    verdict = "infected";
    const infected = await upload(
      "bad.txt",
      new TextEncoder().encode("test scanner input"),
    );
    await runJob(db.connect, "a", infected.jobId, handlers);
    await assert.rejects(
      tenant(db.connect, "a", (sql) =>
        downloadAttachment(sql, "a", actor, infected.id, false),
      ),
      { code: "ATTACHMENT_NOT_READY" },
    );
    const mismatch = await upload(
      "fake.png",
      new TextEncoder().encode("<html>not an image</html>"),
      "image/png",
    );
    await runJob(db.connect, "a", mismatch.jobId, handlers);
    assert.equal(scans, 2);
    assert.equal(clean.size, 1);
  } finally {
    await db.close();
  }
});

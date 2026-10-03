/** Loopback-only development fixture. Never imported by the deployed Worker. */
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import {
  memoryVectorStore,
  testEmbedder,
  type IndexEnvironment,
} from "../server/knowledge-index";

/**
 * The local relay's AI index (phase 07, C2a): the deterministic test embedder and a vector store
 * in memory, saved to `vectors.json` in the relay's data folder (when it has one) so the index
 * survives a restart along with the database that points into it. Writes are batched a second.
 */
export function localIndex(directory?: string): IndexEnvironment {
  if (!directory)
    return { embedders: [testEmbedder()], vectors: memoryVectorStore() };
  const path = resolve(directory, "vectors.json");
  let initial: Record<string, Record<string, number[]>> = {};
  try {
    initial = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // No saved index yet: the indexer builds one from the database.
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latest: Record<string, Record<string, number[]>> = initial;
  const vectors = memoryVectorStore({
    initial,
    save(data) {
      latest = data;
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        writeFileSync(path + ".tmp", JSON.stringify(latest));
        renameSync(path + ".tmp", path);
      }, 1000);
      timer.unref?.();
    },
  });
  return { embedders: [testEmbedder()], vectors };
}

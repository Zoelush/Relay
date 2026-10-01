import { PGlite } from "@electric-sql/pglite";
// Trigram matching for help center search (phase 07, B2); hosted PostgreSQL has it built in.
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { readFile, readdir, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { Connect, Sql } from "../server/db";
import { AsyncLocalStorage } from "node:async_hooks";

type Timing = {
  queueMs: number;
  transactionMs: number;
  sqlMs: number;
  queries: number;
};

export async function localDatabase(directory?: string) {
  if (directory) await mkdir(directory, { recursive: true });
  const pg = new PGlite({ dataDir: directory, extensions: { pg_trgm } });
  await pg.exec(
    "CREATE TABLE IF NOT EXISTS relay_schema_migrations(workspace_id text NOT NULL,name text NOT NULL,checksum text NOT NULL,PRIMARY KEY(workspace_id,name));ALTER TABLE relay_schema_migrations ENABLE ROW LEVEL SECURITY;ALTER TABLE relay_schema_migrations FORCE ROW LEVEL SECURITY;DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE tablename='relay_schema_migrations' AND policyname='tenant') THEN CREATE POLICY tenant ON relay_schema_migrations USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true)); END IF; END $$;",
  );
  const applied = new Map(
    (
      await pg.query<{ name: string; checksum: string }>(
        "SELECT name,checksum FROM relay_schema_migrations WHERE workspace_id='__schema__'",
      )
    ).rows.map((r) => [r.name, r.checksum]),
  );
  for (const file of (await readdir("db/postgres"))
    .filter((x) => x.endsWith(".sql"))
    .sort()) {
    const sql = await readFile("db/postgres/" + file, "utf8"),
      checksum = createHash("sha256").update(sql).digest("hex");
    if (applied.has(file)) {
      if (applied.get(file) !== checksum)
        throw new Error("Applied local migration changed: " + file);
      continue;
    }
    await pg.exec("BEGIN");
    try {
      await pg.exec(sql);
      await pg.query(
        "INSERT INTO relay_schema_migrations(workspace_id,name,checksum) VALUES('__schema__',$1,$2)",
        [file, checksum],
      );
      await pg.exec("COMMIT");
    } catch (error) {
      await pg.exec("ROLLBACK");
      throw error;
    }
  }
  await pg.exec(
    "DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='relay_test_runtime') THEN CREATE ROLE relay_test_runtime NOLOGIN NOBYPASSRLS; END IF; END $$; GRANT USAGE ON SCHEMA public TO relay_test_runtime; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO relay_test_runtime;",
  );
  const timing = new AsyncLocalStorage<Timing>();
  const statements = new Map<
    string,
    { calls: number; totalMs: number; maxMs: number }
  >();
  const query: Sql["query"] = async <T>(sql: string, values?: unknown[]) => {
    const started = performance.now();
    try {
      return { rows: (await pg.query<T>(sql, values)).rows };
    } finally {
      const elapsed = performance.now() - started,
        measurement = timing.getStore();
      if (measurement) {
        measurement.sqlMs += elapsed;
        measurement.queries++;
      }
      // SQL text only, never parameter values, tokens, or application data.
      const label = sql.replace(/\s+/g, " ").slice(0, 110),
        stats = statements.get(label) ?? { calls: 0, totalMs: 0, maxMs: 0 };
      stats.calls++;
      stats.totalMs += elapsed;
      stats.maxMs = Math.max(stats.maxMs, elapsed);
      statements.set(label, stats);
    }
  };
  let tail = Promise.resolve();
  const connect: Connect = async () => {
    const waiting = performance.now();
    const before = tail;
    let unlock!: () => void;
    tail = new Promise<void>((r) => {
      unlock = r;
    });
    await before;
    const acquired = performance.now(),
      measurement = timing.getStore();
    if (measurement) measurement.queueMs += acquired - waiting;
    try {
      await pg.exec("SET ROLE relay_test_runtime");
    } catch (error) {
      unlock();
      throw error;
    }
    return {
      query,
      close: async () => {
        try {
          await pg.exec("RESET ROLE");
        } finally {
          if (measurement)
            measurement.transactionMs += performance.now() - acquired;
          unlock();
        }
      },
    };
  };
  return {
    pg,
    connect,
    query,
    close: () => pg.close(),
    async measure<T>(work: () => Promise<T>) {
      const sample: Timing = {
        queueMs: 0,
        transactionMs: 0,
        sqlMs: 0,
        queries: 0,
      };
      const value = await timing.run(sample, work);
      return { value, timing: sample };
    },
    resetMeasurements() {
      statements.clear();
    },
    statementTimings() {
      return [...statements]
        .map(([statement, stats]) => ({ statement, ...stats }))
        .sort((a, b) => b.totalMs - a.totalMs)
        .slice(0, 12);
    },
  };
}

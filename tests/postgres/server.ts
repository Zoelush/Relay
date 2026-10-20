import { mkdtempSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import type { Connect } from "../../server/db";
import { hyperdriveConnection } from "../../server/postgres";

/**
 * A real PostgreSQL 17 server for the concurrency tests: every migration applied as the owner,
 * and a runtime role that can't bypass row-level security, reached through `pg` (the Hyperdrive
 * path). Each tenant transaction is its own connection, truly in parallel.
 */
export async function server() {
  const pg = new EmbeddedPostgres({
    databaseDir: mkdtempSync(join(tmpdir(), "relay-pg-")),
    user: "postgres",
    password: "postgres",
    port: 55000 + Math.floor(Math.random() * 1000),
    persistent: false,
    onLog: () => {},
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("relay");
  const owner = pg.getPgClient("relay");
  await owner.connect();
  for (const file of (await readdir("db/postgres"))
    .filter((x) => x.endsWith(".sql"))
    .sort())
    await owner.query(await readFile("db/postgres/" + file, "utf8"));
  await owner.query(
    "CREATE ROLE relay_runtime LOGIN PASSWORD 'runtime' NOBYPASSRLS; GRANT USAGE ON SCHEMA public TO relay_runtime; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO relay_runtime;",
  );
  await owner.end();
  // 127.0.0.1, not localhost: on macOS, resolving localhost to IPv6 first occasionally stalled a
  // connection attempt until the 5-second connect timeout (about half the runs).
  const connect: Connect = hyperdriveConnection({
    connectionString: `postgres://relay_runtime:runtime@127.0.0.1:${(pg as unknown as { options: { port: number } }).options.port}/relay`,
  });
  return { pg, connect };
}

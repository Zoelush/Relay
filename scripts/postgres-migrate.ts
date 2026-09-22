import { Client } from "pg";
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  importSnapshot,
  exportSnapshot,
  type LegacySnapshot,
} from "../server/migration";
try {
  process.loadEnvFile(".dev.vars");
} catch {}
const [action = "status", ...args] = process.argv.slice(2),
  option = (key: string) => args[args.indexOf(key) + 1];
const url = process.env.DATABASE_URL;
if (!url)
  throw new Error(
    "Configure DATABASE_URL in ignored .dev.vars. No database connection was attempted.",
  );
const client = new Client({
  connectionString: url,
  connectionTimeoutMillis: 10000,
});
try {
  await client.connect();
  await client.query(
    "SELECT pg_advisory_lock(hashtextextended('relay:schema',0))",
  );
  if (["status", "up"].includes(action)) {
    await client.query(
      "CREATE TABLE IF NOT EXISTS relay_schema_migrations(workspace_id text NOT NULL DEFAULT '__schema__',name text NOT NULL,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,name)); ALTER TABLE relay_schema_migrations ENABLE ROW LEVEL SECURITY; ALTER TABLE relay_schema_migrations FORCE ROW LEVEL SECURITY;",
    );
    await client.query(
      "DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE tablename='relay_schema_migrations' AND policyname='tenant') THEN CREATE POLICY tenant ON relay_schema_migrations USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true)); END IF; END $$;",
    );
    await client.query(
      "SELECT set_config('relay.workspace_id','__schema__',false)",
    );
    const applied = new Map(
      (
        await client.query<{ name: string; checksum: string }>(
          "SELECT name,checksum FROM relay_schema_migrations WHERE workspace_id='__schema__'",
        )
      ).rows.map((r) => [r.name, r.checksum]),
    );
    const through = args.includes("--through")
        ? option("--through")
        : "0001_chat.sql",
      files = (await readdir("db/postgres"))
        .filter((x) => x.endsWith(".sql"))
        .sort();
    if (!files.includes(through))
      throw new Error("Unknown --through migration.");
    for (const file of files) {
      const sql = await readFile("db/postgres/" + file, "utf8"),
        checksum = createHash("sha256").update(sql).digest("hex");
      if (applied.has(file) && applied.get(file) !== checksum)
        throw new Error("An applied migration changed: " + file);
      if (action === "status") {
        console.log(file + ": " + (applied.has(file) ? "applied" : "pending"));
        continue;
      }
      if (file > through || applied.has(file)) continue;
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO relay_schema_migrations(workspace_id,name,checksum) VALUES('__schema__',$1,$2)",
          [file, checksum],
        );
        await client.query("COMMIT");
        console.log("Applied " + file);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } else if (["import", "export"].includes(action)) {
    const workspace = args.includes("--workspace")
      ? option("--workspace")
      : null;
    if (!workspace) throw new Error("--workspace is required.");
    await client.query("BEGIN");
    await client.query("SELECT set_config('relay.workspace_id',$1,true)", [
      workspace,
    ]);
    if (action === "import") {
      const source = args.includes("--source") ? option("--source") : null;
      if (!source) throw new Error("--source is required.");
      if (!args.includes("--source-frozen"))
        throw new Error(
          "Freeze D1 writes and verify the fence before using --source-frozen.",
        );
      const snapshot = JSON.parse(
        await readFile(source, "utf8"),
      ) as LegacySnapshot;
      const result = await importSnapshot(client, workspace, snapshot);
      await client.query(
        "INSERT INTO storage_migration_state(workspace_id,authority,source_digest,verified_at) VALUES($1,'frozen',$2,now()) ON CONFLICT(workspace_id) DO UPDATE SET authority='frozen',source_digest=$2,verified_at=now(),version=storage_migration_state.version+1",
        [workspace, result.digest],
      );
      await client.query("COMMIT");
      console.log(
        JSON.stringify({ workspace, ...result, authority: "frozen" }),
      );
    } else {
      const target = args.includes("--output")
        ? resolve(option("--output"))
        : null;
      if (!target || !target.startsWith(resolve("work") + "/"))
        throw new Error("--output must be inside ignored work/.");
      const snapshot = await exportSnapshot(client, workspace);
      await client.query("COMMIT");
      await mkdir(resolve("work"), { recursive: true });
      await writeFile(target, JSON.stringify(snapshot), {
        mode: 0o600,
        flag: "wx",
      });
      console.log(
        "Private rollback snapshot written. It contains contact data and token hashes; do not commit it.",
      );
    }
  } else
    throw new Error(
      "Use status, up, import or export. No automated authority cutover is enabled.",
    );
} catch (error) {
  try {
    await client.query("ROLLBACK");
  } catch {}
  console.error(
    error instanceof Error &&
      /^(Unknown|An applied|--|Freeze|Use )/.test(error.message)
      ? error.message
      : "Migration failed. Database details were suppressed; authority remains unchanged.",
  );
  process.exitCode = 1;
} finally {
  await client.end();
}

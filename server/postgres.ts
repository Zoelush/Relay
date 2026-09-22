import { Client } from "pg";
import type { Connect, Sql } from "./db";

/** FORCE RLS cannot protect a connection that can bypass it or owns the schema. */
export async function assertRuntimeRole(db: Sql) {
  const row = (
    await db.query<{
      unsafe: boolean;
    }>(`SELECT r.rolsuper OR r.rolbypassrls OR EXISTS(
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND c.relowner=r.oid
  ) AS unsafe FROM pg_roles r WHERE r.rolname=current_user`)
  ).rows[0];
  if (!row || row.unsafe)
    throw new Error(
      "Hyperdrive must use the separate non-owner, NOBYPASSRLS runtime role",
    );
}

export function hyperdriveConnection(
  binding: { connectionString: string } | undefined,
): Connect {
  return async () => {
    if (!binding?.connectionString)
      throw new Error("Hyperdrive binding is required");
    const client = new Client({
      connectionString: binding.connectionString,
      statement_timeout: 15000,
      connectionTimeoutMillis: 5000,
    });
    await client.connect();
    const db = {
      query: ((text: string, values?: unknown[]) =>
        client.query(text, values)) as Sql["query"],
      close: () => client.end(),
    };
    try {
      await assertRuntimeRole(db);
      return db;
    } catch (error) {
      await client.end();
      throw error;
    }
  };
}

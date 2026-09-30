export interface Sql {
  query<T = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
}
export type Connect = () => Promise<Sql & { close(): Promise<void> }>;

/** Tenant context is transaction-local: safe with Hyperdrive transaction pooling. */
export async function tenant<T>(
  connect: Connect,
  workspaceId: string,
  work: (sql: Sql) => Promise<T>,
): Promise<T> {
  if (!workspaceId || workspaceId.length > 100)
    throw new Error("Invalid workspace context");
  const db = await connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT set_config('relay.workspace_id',$1,true)", [
      workspaceId,
    ]);
    const result = await work(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await db.close();
  }
}

export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    /** Structured detail returned with the error, such as the fields a closure is missing. */
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
export function assert(
  condition: unknown,
  code: string,
  message: string,
  status = 400,
): asserts condition {
  if (!condition) throw new DomainError(code, message, status);
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}
export async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(value));
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function once<T>(
  db: Sql,
  workspace: string,
  scope: string,
  key: string,
  request: unknown,
  work: () => Promise<T>,
): Promise<T> {
  assert(
    typeof key === "string" && key.length >= 8 && key.length <= 200,
    "IDEMPOTENCY_KEY_REQUIRED",
    "Supply a stable Idempotency-Key header.",
  );
  const fingerprint = await digest(request);
  const inserted = await db.query(
    "INSERT INTO idempotency_receipts(workspace_id,scope,key,digest) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING key",
    [workspace, scope, key, fingerprint],
  );
  if (!inserted.rows.length) {
    const receipt = (
      await db.query<{ digest: string; response: T }>(
        "SELECT digest,response FROM idempotency_receipts WHERE workspace_id=$1 AND scope=$2 AND key=$3 FOR UPDATE",
        [workspace, scope, key],
      )
    ).rows[0];
    assert(
      receipt && receipt.digest === fingerprint,
      "IDEMPOTENCY_CONFLICT",
      "This key was already used with different data.",
      409,
    );
    return receipt.response;
  }
  const result = await work();
  await db.query(
    "UPDATE idempotency_receipts SET response=$4 WHERE workspace_id=$1 AND scope=$2 AND key=$3",
    [workspace, scope, key, JSON.stringify(result)],
  );
  return result;
}

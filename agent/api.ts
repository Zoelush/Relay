export class InboxError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  body?: unknown,
  key = crypto.randomUUID(),
): Promise<T> {
  const r = await fetch("/api/agent/" + path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers:
      body === undefined
        ? {}
        : { "content-type": "application/json", "idempotency-key": key },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await r.json()) as T & {
    error?: { message?: string; code?: string };
  };
  if (!r.ok)
    throw new InboxError(
      data.error?.message ?? "The inbox is unavailable.",
      r.status,
      data.error?.code ?? "UNAVAILABLE",
    );
  return data;
}

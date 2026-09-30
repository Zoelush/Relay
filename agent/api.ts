export class InboxError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
    /** The full response body, for errors that carry data (a draft conflict's other version). */
    public data?: unknown,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  body?: unknown,
  key = crypto.randomUUID(),
  /** keepalive: the browser completes the request even if the page unloads. */
  options: { keepalive?: boolean } = {},
): Promise<T> {
  const r = await fetch("/api/agent/" + path, {
    keepalive: options.keepalive,
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
      data,
    );
  return data;
}

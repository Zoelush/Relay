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
  // Phase 16 C3a: a Relay session that ended (signed out elsewhere, revoked, or over its limits).
  if (r.status === 401 && data.error?.code === "SIGNED_OUT" && typeof window !== "undefined" && window.location.pathname !== "/signin")
    window.location.assign("/signin?next=" + encodeURIComponent(window.location.pathname + window.location.hash));
  if (!r.ok)
    throw new InboxError(
      data.error?.message ?? "The inbox is unavailable.",
      r.status,
      data.error?.code ?? "UNAVAILABLE",
      data,
    );
  return data;
}

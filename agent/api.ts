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
/**
 * The paired test workspace (docs/TEST_WORKSPACE_PLAN.md): which of the pair this browser works
 * in. Kept per browser, sent with every request, and checked by the server, which refuses a
 * workspace that isn't this one's test pair or where this teammate has no role.
 */
const WORKSPACE_KEY = "relay.workspace";
export function chosenWorkspace() {
  try {
    return localStorage.getItem(WORKSPACE_KEY) ?? "";
  } catch {
    return "";
  }
}
export function chooseWorkspace(id: string) {
  try {
    if (id) localStorage.setItem(WORKSPACE_KEY, id);
    else localStorage.removeItem(WORKSPACE_KEY);
  } catch {
    /* a browser that forbids storage simply stays in production */
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
    headers: {
      ...(chosenWorkspace() ? { "x-relay-workspace": chosenWorkspace() } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json", "idempotency-key": key }),
    },
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

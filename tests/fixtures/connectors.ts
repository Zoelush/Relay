/**
 * Recorded exchanges for the data connectors tests use (phase 09 D1; docs/ACTIONS_STEP1.md), so
 * every test runs offline. `recordedFetch` answers only these requests: anything else fails the
 * request and is listed in `unmatched`, which tests check is empty.
 */
export type Exchange = {
  method: string;
  url: string;
  /** Several responses are given in turn (a 500, then a 200), the last one repeating. */
  responses: ({ status: number; body: unknown; headers?: Record<string, string> } | "timeout")[];
};
export type Sent = { method: string; url: string; headers: Record<string, string>; body: string | null };

export const SHOP_KEY = "sk_test_shop_7f3a9c21d4e5";
export const CRM_CLIENT_SECRET = "crm_secret_91b2c3d4e5f6";

export const ORDER_LOOKUP = {
  name: "Order lookup",
  definition: {
    description: "Finds an order by its number, for the customer who placed it.",
    method: "GET",
    baseUrl: "https://api.shop.example/v1",
    path: "/orders/{{order_id}}",
    query: [{ name: "email", value: "{{email}}" }],
    headers: [{ name: "X-Shop", value: "fernhill" }],
    body: "",
    inputs: [
      { name: "order_id", label: "Order number", type: "string", source: "customer", required: true, sensitive: false, pattern: "[A-Z]\\d{4}", maxLength: 10 },
      { name: "email", label: "Email", type: "string", source: "contact.email", required: true, sensitive: true, pattern: "", maxLength: 200 },
    ],
    outputs: [
      { name: "status", label: "Status", path: "order.status", type: "string", sensitive: false },
      { name: "eta", label: "Delivery date", path: "order.eta", type: "string", sensitive: false },
      { name: "first_item", label: "First item", path: "order.items[0].name", type: "string", sensitive: false },
      { name: "total", label: "Total", path: "order.total", type: "number", sensitive: false },
      { name: "paid", label: "Paid", path: "order.paid", type: "boolean", sensitive: false },
      { name: "tracking", label: "Tracking", path: "order.tracking", type: "string", sensitive: false },
    ],
    auth: { type: "api_key", header: "X-Api-Key" },
    timeoutMs: 1000,
    retries: 1,
    rateLimit: 60,
  },
};

/** The order lookup by number only (for messenger visitors, who have no email on file). */
export const ORDER_STATUS = {
  name: "Order status",
  definition: {
    ...ORDER_LOOKUP.definition,
    description: "An order's status by its number.",
    query: [],
    inputs: [ORDER_LOOKUP.definition.inputs[0]],
    retries: 0,
  },
};

/** A write (D3): cancels an order, with an idempotency key and a teammate's approval. */
export const CANCEL_ORDER = {
  name: "Cancel order",
  definition: {
    description: "Cancels an order that hasn't shipped.",
    access: "write",
    method: "POST",
    baseUrl: "https://api.shop.example/v1",
    path: "/orders/{{order_id}}/cancel",
    query: [],
    headers: [],
    body: '{"reason": "{{reason}}"}',
    inputs: [
      ORDER_LOOKUP.definition.inputs[0],
      { name: "reason", label: "Reason", type: "string", source: "customer", required: false, sensitive: true, pattern: "", maxLength: 200 },
    ],
    outputs: [{ name: "status", label: "Status", path: "order.status", type: "string", sensitive: false }],
    auth: { type: "api_key", header: "X-Api-Key" },
    timeoutMs: 1000,
    retries: 1,
    rateLimit: 60,
    approval: "always",
    idempotencyHeader: "Idempotency-Key",
  },
};

/** D4: a calendar connected on the workspace's behalf (OAuth 2 authorization code with refresh). */
export const CALENDAR_SECRET = "cal_client_secret_8a7b6c5d";
export const BOOKINGS = {
  name: "Bookings",
  definition: {
    description: "The customer's next booking, from the calendar.",
    access: "read",
    method: "GET",
    baseUrl: "https://api.calendar.example/v1",
    path: "/bookings",
    query: [{ name: "email", value: "{{email}}" }],
    headers: [],
    body: "",
    inputs: [{ name: "email", label: "Email", type: "string", source: "contact.email", required: true, sensitive: true, pattern: "", maxLength: 200 }],
    outputs: [{ name: "next_booking", label: "Next booking", path: "next.when", type: "string", sensitive: false }],
    auth: {
      type: "oauth_authorization_code",
      authorizeUrl: "https://auth.calendar.example/authorize",
      tokenUrl: "https://auth.calendar.example/oauth/token",
      clientId: "relay-fernhill",
      scope: "bookings.read offline_access",
    },
    timeoutMs: 2000,
    retries: 0,
    rateLimit: 60,
  },
};

export const ACCOUNT_STATUS = {
  name: "Account status",
  definition: {
    description: "The customer's plan and seats, from the CRM.",
    method: "POST",
    baseUrl: "https://api.crm.example",
    path: "/accounts/search",
    query: [],
    headers: [],
    body: '{"user": "{{user_id}}", "include": ["plan", "seats"], "note": "asked about {{user_id}}"}',
    inputs: [
      { name: "user_id", label: "User ID", type: "string", source: "contact.external_id", required: true, sensitive: false, pattern: "", maxLength: 100 },
    ],
    outputs: [
      { name: "plan", label: "Plan", path: "account.plan", type: "string", sensitive: false },
      { name: "seats", label: "Seats", path: "account.seats", type: "number", sensitive: false },
      { name: "features", label: "Features", path: "account.features", type: "list", sensitive: false },
    ],
    auth: { type: "oauth_client_credentials", tokenUrl: "https://auth.crm.example/oauth/token", clientId: "relay-fernhill", scope: "accounts.read" },
    timeoutMs: 2000,
    retries: 0,
    rateLimit: 60,
  },
};

const order = (status: string, extra: Record<string, unknown> = {}) => ({
  order: {
    id: "A1001",
    status,
    eta: "2026-10-15",
    items: [{ name: "Road bike", sku: "RB-1" }],
    total: 899.5,
    paid: true,
    ...extra,
  },
  // Never mapped: it must never reach Zoe or the audit.
  internal: { card_last4: "4242", risk_score: 0.12 },
});
const shop = (id: string) => `https://api.shop.example/v1/orders/${id}?email=ada%40example.com`;

export const EXCHANGES: Exchange[] = [
  { method: "GET", url: shop("A1001"), responses: [{ status: 200, body: order("shipped") }] },
  { method: "GET", url: shop("A5000"), responses: [{ status: 500, body: { error: "busy" } }, { status: 200, body: order("processing") }] },
  { method: "GET", url: shop("A4040"), responses: [{ status: 404, body: { error: "No such order" } }] },
  { method: "GET", url: shop("A9999"), responses: ["timeout"] },
  { method: "GET", url: shop("A2222"), responses: [{ status: 200, body: "<html>maintenance</html>", headers: { "content-type": "text/html" } }] },
  { method: "GET", url: shop("A3333"), responses: [{ status: 200, body: order("shipped", { total: "a lot" }) }] },
  { method: "GET", url: "https://api.shop.example/v1/orders/A1001", responses: [{ status: 200, body: order("shipped") }] },
  // Writes (D3).
  { method: "POST", url: "https://api.shop.example/v1/orders/A1001/cancel", responses: [{ status: 200, body: { order: { id: "A1001", status: "cancelled" } } }] },
  { method: "POST", url: "https://api.shop.example/v1/orders/A2002/cancel", responses: [{ status: 200, body: { order: { id: "A2002", status: "cancelled" } } }] },
  { method: "POST", url: "https://api.shop.example/v1/orders/A9999/cancel", responses: ["timeout"] },
  { method: "POST", url: "https://api.shop.example/v1/orders/A5000/cancel", responses: [{ status: 500, body: { error: "busy" } }, { status: 200, body: { order: { status: "cancelled" } } }] },
  { method: "GET", url: "https://api.shop.example/v1/orders/A9999", responses: ["timeout"] },
  { method: "POST", url: "https://auth.crm.example/oauth/token", responses: [{ status: 200, body: { access_token: "crm-token-1", token_type: "Bearer", expires_in: 3600 } }] },
  {
    method: "POST",
    url: "https://api.crm.example/accounts/search",
    responses: [{ status: 200, body: { account: { plan: "Pro", seats: 12, features: ["sso", "audit"], billing_email: "billing@acme.example" } } }],
  },
];

/** A fetch that answers only the recorded exchanges, and remembers what was sent. */
export function recordedFetch(exchanges: Exchange[] = EXCHANGES) {
  const sent: Sent[] = [];
  const unmatched: string[] = [];
  const turns = new Map<string, number>();
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    sent.push({ method, url, headers, body: typeof init?.body === "string" ? init.body : null });
    // An API key that isn't the recorded one is refused, as the service would.
    if (url.startsWith("https://api.shop.example/") && headers["x-api-key"] !== SHOP_KEY)
      return new Response(JSON.stringify({ error: "Invalid API key" }), { status: 401 });
    if (url.startsWith("https://api.crm.example/") && headers.authorization !== "Bearer crm-token-1")
      return new Response(JSON.stringify({ error: "Invalid token" }), { status: 401 });
    if (url === "https://auth.crm.example/oauth/token" && !String(init?.body).includes(`client_secret=${CRM_CLIENT_SECRET}`))
      return new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 });
    // D4: the calendar's OAuth provider, as a real one behaves: codes once, PKCE, rotating refresh.
    if (url === "https://auth.calendar.example/oauth/token") {
      const f = new URLSearchParams(String(init?.body ?? ""));
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (f.get("client_id") !== "relay-fernhill" || f.get("client_secret") !== CALENDAR_SECRET) return json(401, { error: "invalid_client" });
      if (f.get("grant_type") === "authorization_code") {
        // The redirect must be the agent app's (https://app.test in unit tests, the local relay's in browser tests).
        if (!f.get("code_verifier") || !/^https?:\/\/[^/]+\/agent$/.test(f.get("redirect_uri") ?? "")) return json(400, { error: "invalid_request" });
        if (f.get("code") === "good-code") return json(200, { access_token: "cal-token-1", refresh_token: "cal-refresh-1", expires_in: 3600 });
        if (f.get("code") === "no-refresh") return json(200, { access_token: "cal-token-x", expires_in: 3600 });
        return json(400, { error: "invalid_grant" });
      }
      if (f.get("grant_type") === "refresh_token") {
        if (f.get("refresh_token") === "cal-refresh-1") return json(200, { access_token: "cal-token-2", refresh_token: "cal-refresh-2", expires_in: 3600 });
        if (f.get("refresh_token") === "cal-refresh-2") return json(200, { access_token: "cal-token-3", expires_in: 3600 });
        return json(400, { error: "invalid_grant" });
      }
      return json(400, { error: "unsupported_grant_type" });
    }
    if (url.startsWith("https://api.calendar.example/")) {
      if (!["Bearer cal-token-1", "Bearer cal-token-2", "Bearer cal-token-3"].includes(headers.authorization ?? ""))
        return new Response(JSON.stringify({ error: "invalid_token" }), { status: 401 });
      return new Response(JSON.stringify({ next: { when: "Tuesday 14 October, 10:00", room: "Workshop 2" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const exchange = exchanges.find((x) => x.method === method && x.url === url);
    if (!exchange) {
      unmatched.push(`${method} ${url}`);
      throw new TypeError("No recorded response");
    }
    const key = `${method} ${url}`;
    const turn = turns.get(key) ?? 0;
    turns.set(key, turn + 1);
    const r = exchange.responses[Math.min(turn, exchange.responses.length - 1)];
    if (r === "timeout")
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json", ...r.headers },
    });
  }) as typeof globalThis.fetch;
  return { fetch, sent, unmatched };
}

import { SignJWT } from "jose";
import { digest, DomainError, assert } from "./db";

export interface AgentBridgeConfig {
  RELAY_AGENT_INBOX_V1?: string;
  RELAY_STORAGE_AUTHORITY?: string;
  RELAY_API_ORIGIN?: string;
  RELAY_WORKSPACE_ID?: string;
  RELAY_BRIDGE_SECRET?: string;
}
/** Bulk selections carry up to 5,000 conversation ids, so that route alone allows 256 KB. */
export const BULK_BODY_LIMIT = 256_000;
/** Knowledge articles run to 200,000 characters; their JSON documents fit in 1 MB. */
export const KNOWLEDGE_BODY_LIMIT = 1_000_000;
/** Request size per bridged route: larger only where the content needs it. */
export const bodyLimit = (path: string) =>
  path === "bulk"
    ? BULK_BODY_LIMIT
    : path === "knowledge"
      ? KNOWLEDGE_BODY_LIMIT
      : 20000;
export const postgresInboxEnabled = (config: AgentBridgeConfig) =>
  config.RELAY_AGENT_INBOX_V1 === "true";
export const legacyWritesEnabled = (config: AgentBridgeConfig) =>
  !postgresInboxEnabled(config) &&
  (config.RELAY_STORAGE_AUTHORITY ?? "d1") === "d1";

/** Every agent route the bridge passes on (phase 16 C2: the permissions matrix runs over these). */
export const AGENT_ROUTES: { GET: ReadonlySet<string>; POST: ReadonlySet<string> } = {
  get GET() {
    return routes.GET;
  },
  get POST() {
    return routes.POST;
  },
};
const routes = {
  GET: new Set([
    "inbox",
    "job",
    "attachment/content",
    "views",
    "view-page",
    "history",
    "drafts",
    "notifications",
    "macros",
    "context",
    "ai-answers",
    "ai-settings",
    "ai-approval",
    "ai-audit",
    "workflows",
    "workflow-runs",
    "workflow-estimate",
    "workflow-conversations",
    "suppressions",
    "deliveries",
    "reply-target",
    "side-conversations",
    "whatsapp-settings",
    "sms-settings",
    "meta-settings",
    "community-settings",
    "voice-settings",
    "people",
    "events-settings",
    "subscription-settings",
    "outbound",
    "outbound-message",
    "reporting-status",
    "live-dashboard",
    "developer-settings",
    "developer-webhooks",
    "developer-apps",
    "oauth-consent",
    "canvas-apps",
    "audit",
    "account",
    "security-sessions",
    "security-access",
    "sso-settings",
    "data-requests",
    "retention",
    "data-protection",
    "links",
    "link-verdict",
    "invitations",
    "developer-webhook-deliveries",
    "developer-webhook-delivery",
    "email-message",
    "email-settings",
    "zoe",
    "bulk",
    "ticket-types",
    "ticket-preview",
    "tickets",
    "ticket-broadcast",
    "calendars",
    "calendar-resolve",
    "sla-policies",
    "portal-settings",
    "teams",
    "workload",
    "knowledge",
    "knowledge-record",
    "knowledge-file",
    "knowledge-sources",
    "knowledge-source",
    "knowledge-index",
    "knowledge-retrieve",
    "knowledge-health",
    "settings",
    "tags",
    "attributes",
    "teammates",
    "roles",
    "brands",
    "messenger",
    "messenger-asset",
    "help-centers",
    "help-center",
    "help-insights",
  ]),
  POST: new Set([
    "command",
    "views",
    "drafts",
    "notifications",
    "macros",
    "bulk",
    "ticket-types",
    "tickets",
    "calendars",
    "sla-policies",
    "portal-settings",
    "teams",
    "teammate-limits",
    "presence",
    "next",
    "knowledge",
    "knowledge-files",
    "knowledge-sources",
    "knowledge-index",
    "knowledge-health",
    "settings",
    "tags",
    "attributes",
    "teammates",
    "roles",
    "brands",
    "messenger",
    "messenger-assets",
    "ai-settings",
    "zoe-identity",
    "zoe-playground",
    "zoe-guidance",
    "zoe-specialist",
    "zoe-review",
    "zoe-monitors",
    "zoe-connector",
    "zoe-procedure",
    "ai-approval",
    "workflow",
    "workflow-run",
    "workflow-simulate",
    "suppression",
    "delivery",
    "side-conversation",
    "whatsapp-settings",
    "sms-settings",
    "meta-settings",
    "community-settings",
    "voice-settings",
    "people",
    "events-settings",
    "subscription-settings",
    "outbound-message",
    "outbound-settings",
    "report-metric",
    "report-flow",
    "developer-token",
    "developer-webhook",
    "developer-app",
    "oauth-consent",
    "canvas",
    "audit",
    "account",
    "security-sessions",
    "security-access",
    "sso-settings",
    "data-requests",
    "retention",
    "data-protection",
    "links",
    "link-verdict",
    "invitations",
    "email-settings",
    "help-centers",
    "realtime-ticket",
    "attachment/prepare",
    "attachment/complete",
  ]),
};

/** Principal comes exclusively from the hosting platform's authenticated session. */
/** Phase 16 C3a: Relay's own session cookie (HttpOnly; the API resolves it on every request). */
export const SESSION_COOKIE = "relay_session";
/** Phase 16 C3b: the two-factor challenge between a right password and the code (on `/auth` only). */
export const CHALLENGE_COOKIE = "relay_2fa";
/** The session token in a request's cookies, if any. */
export function sessionCookie(request: Request, name = SESSION_COOKIE) {
  return (
    request.headers
      .get("cookie")
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(name + "="))
      ?.slice(name.length + 1) || undefined
  );
}
/** Where the request came from, for sessions and the audit log (the host's proxy sets this). */
const clientOf = (request: Request) => ({
  ip: request.headers.get("cf-connecting-ip") ?? request.headers.get("x-real-ip") ?? null,
  ua: request.headers.get("user-agent")?.slice(0, 300) ?? null,
});

export async function bridgeAgentRequest(
  request: Request,
  principal: string | undefined,
  config: AgentBridgeConfig,
  send: (request: Request) => Promise<Response> = fetch,
  /** Phase 16 C3a: a Relay session (from `sessionCookie`), used in place of the platform's principal. */
  session?: string,
) {
  try {
    assert(principal || session, "AUTH_REQUIRED", "Sign in to open your inbox.", 401);
    assert(
      postgresInboxEnabled(config),
      "FEATURE_DISABLED",
      "The new inbox is disabled.",
      404,
    );
    assert(
      config.RELAY_STORAGE_AUTHORITY === "postgres",
      "STORAGE_AUTHORITY",
      "PostgreSQL write authority has not been enabled.",
      503,
    );
    assert(
      config.RELAY_WORKSPACE_ID &&
        config.RELAY_API_ORIGIN &&
        (config.RELAY_BRIDGE_SECRET?.length ?? 0) >= 32,
      "CONFIGURATION",
      "The agent connection is not configured.",
      503,
    );
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/agent\//, "");
    assert(
      (request.method === "GET" || request.method === "POST") &&
        routes[request.method].has(path),
      "NOT_FOUND",
      "Endpoint unavailable.",
      404,
    );
    if (request.method === "POST") {
      assert(
        request.headers.get("origin") === url.origin &&
          !["cross-site", "none"].includes(
            request.headers.get("sec-fetch-site") ?? "",
          ),
        "ORIGIN_NOT_ALLOWED",
        "This request is not allowed.",
        403,
      );
    }
    const target = new URL(config.RELAY_API_ORIGIN!);
    assert(
      target.protocol === "https:" ||
        (target.protocol === "http:" &&
          ["127.0.0.1", "localhost"].includes(target.hostname)),
      "CONFIGURATION",
      "The agent connection requires HTTPS.",
      503,
    );
    assert(
      !target.username && !target.password,
      "CONFIGURATION",
      "Invalid agent endpoint.",
      503,
    );
    target.pathname = "/v1/agent/" + path;
    target.search = url.search;
    target.hash = "";
    let payload: unknown;
    if (request.method === "POST") {
      const reader = request.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader)
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > bodyLimit(path)) {
            await reader.cancel();
            throw new DomainError(
              "BODY_TOO_LARGE",
              "Request is too large.",
              413,
            );
          }
          chunks.push(value);
        }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      try {
        payload = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new DomainError("INVALID_JSON", "Send a JSON object.");
      }
      assert(
        payload && typeof payload === "object" && !Array.isArray(payload),
        "INVALID_JSON",
        "Send a JSON object.",
      );
    }
    const key = request.headers.get("idempotency-key") ?? "";
    if (request.method === "POST")
      assert(
        key.length > 0 && key.length <= 200,
        "IDEMPOTENCY_REQUIRED",
        "Provide a request key.",
      );
    const client = clientOf(request);
    const proof = await new SignJWT({
      workspace: config.RELAY_WORKSPACE_ID,
      ...(session ? { session } : { principal }),
      // Phase 16 C3a: who's asking from where, and the address teammates use (for invitation links).
      ip: client.ip,
      ua: client.ua,
      origin: url.origin,
      inbox: true,
      method: request.method,
      path: target.pathname,
      query: target.search,
      ...(request.method === "POST"
        ? { digest: await digest(payload), key }
        : {}),
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("relay-sites")
      .setAudience("relay-agent")
      .setIssuedAt()
      .setExpirationTime("30s")
      .sign(new TextEncoder().encode(config.RELAY_BRIDGE_SECRET!));
    const response = await send(
      new Request(target, {
        method: request.method,
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: {
          authorization: "Bearer " + proof,
          "content-type": "application/json",
          "idempotency-key": key,
        },
        ...(request.method === "POST" ? { body: JSON.stringify(payload) } : {}),
      }),
    );
    const headers = new Headers({
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    });
    for (const name of [
      "content-type",
      "content-disposition",
      "content-security-policy",
      "server-timing",
      "x-relay-storage",
      "x-relay-transport",
    ]) {
      const value = response.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(response.body, { status: response.status, headers });
  } catch (error) {
    return Response.json(
      {
        error: {
          code: error instanceof DomainError ? error.code : "UNAVAILABLE",
          message:
            error instanceof DomainError
              ? error.message
              : "The agent connection is unavailable. Retry to reconnect.",
        },
      },
      {
        status: error instanceof DomainError ? error.status : 503,
        headers: { "cache-control": "private, no-store" },
      },
    );
  }
}

/**
 * Phase 16 C3a: signing in and out, and invitations, through the host (no principal yet). Each is
 * signed for the API like the agent bridge; a session it starts goes into an HttpOnly cookie, never
 * into the page. `/auth/signin`, `/auth/accept` and `/auth/signout` are POSTs from the host's own
 * origin; `/auth/invitation` reads an invitation by its token. C3b: a right password may instead
 * give a two-factor challenge, kept in its own HttpOnly cookie (`/auth` only, ten minutes) and sent
 * with `/auth/two-factor` (the code) and `/auth/two-factor-setup` (when it's required).
 */
export async function bridgeAuthRequest(request: Request, config: AgentBridgeConfig, send: (request: Request) => Promise<Response> = fetch) {
  const fail = (e: unknown) =>
    Response.json(
      { error: { code: e instanceof DomainError ? e.code : "UNAVAILABLE", message: e instanceof DomainError ? e.message : "Sign-in is unavailable. Try again." } },
      { status: e instanceof DomainError ? e.status : 503, headers: { "cache-control": "no-store" } },
    );
  try {
    const url = new URL(request.url);
    const action = url.pathname.replace(/^\/auth\//, "");
    assert(request.method === "POST" && ["signin", "accept", "signout", "invitation", "two-factor", "two-factor-setup", "sso-info"].includes(action), "NOT_FOUND", "Endpoint unavailable.", 404);
    assert(request.headers.get("origin") === url.origin && !["cross-site", "none"].includes(request.headers.get("sec-fetch-site") ?? ""), "ORIGIN_NOT_ALLOWED", "This request is not allowed.", 403);
    assert(config.RELAY_WORKSPACE_ID && config.RELAY_API_ORIGIN && (config.RELAY_BRIDGE_SECRET?.length ?? 0) >= 32, "CONFIGURATION", "Sign-in is not configured.", 503);
    const text = await request.text();
    assert(text.length <= 4000, "BODY_TOO_LARGE", "Request is too large.", 413);
    let body: Record<string, unknown> = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new DomainError("INVALID_JSON", "Send a JSON object.");
    }
    if (action === "signout") body = { token: sessionCookie(request) ?? "" };
    if (action.startsWith("two-factor")) body = { ...body, challenge: sessionCookie(request, CHALLENGE_COOKIE) ?? "" };
    const client = clientOf(request);
    const proof = await new SignJWT({ workspace: config.RELAY_WORKSPACE_ID, action, digest: await digest(body), ip: client.ip, ua: client.ua, origin: url.origin })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("relay-sites")
      .setAudience("relay-auth")
      .setIssuedAt()
      .setExpirationTime("30s")
      .sign(new TextEncoder().encode(config.RELAY_BRIDGE_SECRET!));
    const target = new URL(config.RELAY_API_ORIGIN!);
    target.pathname = "/v1/auth/" + action;
    const upstream = await send(
      new Request(target, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15000), headers: { authorization: "Bearer " + proof, "content-type": "application/json" }, body: JSON.stringify(body) }),
    );
    const data = (await upstream.json().catch(() => ({}))) as Record<string, unknown> & { token?: string; expiresAt?: string; challenge?: string };
    const headers = new Headers({ "cache-control": "no-store", "content-type": "application/json" });
    const secure = url.protocol === "https:" ? "; Secure" : "";
    if (upstream.ok && typeof data.token === "string") {
      const maxAge = Math.max(60, Math.floor((new Date(data.expiresAt ?? Date.now()).getTime() - Date.now()) / 1000));
      headers.append("set-cookie", `${SESSION_COOKIE}=${data.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
      delete data.token;
      if (action.startsWith("two-factor")) headers.append("set-cookie", `${CHALLENGE_COOKIE}=; Path=/auth; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
    }
    if (upstream.ok && typeof data.challenge === "string") {
      headers.append("set-cookie", `${CHALLENGE_COOKIE}=${data.challenge}; Path=/auth; HttpOnly; SameSite=Strict; Max-Age=600${secure}`);
      delete data.challenge;
    }
    if (action === "signout") headers.append("set-cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
    return new Response(JSON.stringify(data), { status: upstream.status, headers });
  } catch (e) {
    return fail(e);
  }
}

/** Phase 16 C4a: the browser's single sign-on login, between `/auth/sso` and the provider's return (on `/auth` only). */
export const SSO_COOKIE = "relay_sso";
/** Errors the sign-in page explains in its own words (never text from the address). */
export const SSO_ERRORS = ["SSO_OFF", "SSO_EXPIRED", "SSO_DENIED", "SSO_EMAIL", "SSO_DOMAIN", "SSO_NO_ROLE", "SSO_FAILED", "NETWORK_NOT_ALLOWED", "RATE_LIMITED", "UNAVAILABLE"];

/**
 * Phase 16 C4a: single sign-on through the host. `GET /auth/sso` asks the API where to send the
 * browser, keeps the login's token in an HttpOnly cookie (`relay_sso`, `/auth` only, ten minutes,
 * SameSite=Lax so the provider's redirect back carries it) and redirects to the provider.
 * `GET /auth/sso/callback` passes the provider's code and state with that cookie; the session goes
 * into the session cookie and the browser to the inbox. A failure goes back to `/signin?sso=<code>`.
 *
 * C4b, SAML: `POST /auth/saml/acs` takes the provider's form post (which can't carry the Lax
 * cookie): the API parks the response on the login its RelayState names, and the browser is sent
 * on (303) to `/auth/sso/callback?state=…`, which does carry it. `GET /auth/saml/metadata` is
 * Relay's service provider metadata.
 */
export async function bridgeSsoRequest(request: Request, config: AgentBridgeConfig, send: (request: Request) => Promise<Response> = fetch) {
  const url = new URL(request.url);
  const secure = url.protocol === "https:" ? "; Secure" : "";
  const back = (code: string) =>
    new Response(null, {
      status: 302,
      headers: { location: `/signin?sso=${SSO_ERRORS.includes(code) ? code : "SSO_FAILED"}`, "cache-control": "no-store", "set-cookie": `${SSO_COOKIE}=; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=0${secure}` },
    });
  const route = `${request.method} ${url.pathname}`;
  const call = async (action: string, body: Record<string, unknown>) => {
    const client = clientOf(request);
    const proof = await new SignJWT({ workspace: config.RELAY_WORKSPACE_ID, action, digest: await digest(body), ip: client.ip, ua: client.ua, origin: url.origin })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("relay-sites")
      .setAudience("relay-auth")
      .setIssuedAt()
      .setExpirationTime("30s")
      .sign(new TextEncoder().encode(config.RELAY_BRIDGE_SECRET!));
    const target = new URL(config.RELAY_API_ORIGIN!);
    target.pathname = "/v1/auth/" + action;
    const upstream = await send(
      new Request(target, { method: "POST", redirect: "error", signal: AbortSignal.timeout(30000), headers: { authorization: "Bearer " + proof, "content-type": "application/json" }, body: JSON.stringify(body) }),
    );
    return { ok: upstream.ok, status: upstream.status, data: (await upstream.json().catch(() => ({}))) as Record<string, unknown> & { error?: { code?: string } } };
  };
  try {
    assert(["GET /auth/sso", "GET /auth/sso/callback", "POST /auth/saml/acs", "GET /auth/saml/metadata"].includes(route), "NOT_FOUND", "Endpoint unavailable.", 404);
    assert(config.RELAY_WORKSPACE_ID && config.RELAY_API_ORIGIN && (config.RELAY_BRIDGE_SECRET?.length ?? 0) >= 32, "UNAVAILABLE", "Sign-in is not configured.", 503);
    if (route === "GET /auth/saml/metadata") {
      const r = await call("saml-metadata", {});
      if (!r.ok || typeof r.data.xml !== "string") return new Response("No SAML connection here.", { status: r.status === 200 ? 404 : r.status, headers: { "content-type": "text/plain" } });
      return new Response(r.data.xml, { headers: { "content-type": "application/samlmetadata+xml", "cache-control": "no-store" } });
    }
    if (route === "POST /auth/saml/acs") {
      const form = await request.formData().catch(() => null);
      const relayState = String(form?.get("RelayState") ?? "");
      const r = await call("saml-acs", { samlResponse: String(form?.get("SAMLResponse") ?? ""), relayState });
      if (!r.ok) return back(r.data.error?.code ?? "SSO_FAILED");
      return new Response(null, { status: 303, headers: { location: "/auth/sso/callback?state=" + encodeURIComponent(relayState), "cache-control": "no-store" } });
    }
    const start = route === "GET /auth/sso";
    // Starting is from this site (or typed in); the return comes from the provider's site.
    if (start) assert(["same-origin", "none", ""].includes(request.headers.get("sec-fetch-site") ?? ""), "SSO_EXPIRED", "Start from the sign-in page.", 403);
    const r = start
      ? await call("sso-start", { next: url.searchParams.get("next") ?? "" })
      : await call("sso-finish", {
          login: sessionCookie(request, SSO_COOKIE) ?? "",
          state: url.searchParams.get("state") ?? "",
          code: url.searchParams.get("code") ?? "",
          error: url.searchParams.get("error") ?? "",
        });
    const data = r.data as { url?: string; login?: string; token?: string; expiresAt?: string; next?: string; error?: { code?: string } };
    if (!r.ok) return back(data.error?.code ?? "SSO_FAILED");
    const headers = new Headers({ "cache-control": "no-store" });
    if (start) {
      if (typeof data.url !== "string" || typeof data.login !== "string" || !/^https?:\/\//.test(data.url)) return back("SSO_FAILED");
      headers.append("set-cookie", `${SSO_COOKIE}=${data.login}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=600${secure}`);
      headers.set("location", data.url);
      return new Response(null, { status: 302, headers });
    }
    if (typeof data.token !== "string") return back("SSO_FAILED");
    const maxAge = Math.max(60, Math.floor((new Date(data.expiresAt ?? Date.now()).getTime() - Date.now()) / 1000));
    headers.append("set-cookie", `${SESSION_COOKIE}=${data.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
    headers.append("set-cookie", `${SSO_COOKIE}=; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
    headers.set("location", typeof data.next === "string" && /^\/(?!\/)/.test(data.next) ? data.next : "/agent");
    return new Response(null, { status: 302, headers });
  } catch (e) {
    return back(e instanceof DomainError ? e.code : "SSO_FAILED");
  }
}

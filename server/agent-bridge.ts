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
    "help-centers",
    "realtime-ticket",
    "attachment/prepare",
    "attachment/complete",
  ]),
};

/** Principal comes exclusively from the hosting platform's authenticated session. */
export async function bridgeAgentRequest(
  request: Request,
  principal: string | undefined,
  config: AgentBridgeConfig,
  send: (request: Request) => Promise<Response> = fetch,
) {
  try {
    assert(principal, "AUTH_REQUIRED", "Sign in to open your inbox.", 401);
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
    const proof = await new SignJWT({
      workspace: config.RELAY_WORKSPACE_ID,
      principal,
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

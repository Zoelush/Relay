import { tenant, type Connect } from "./db";
import { portalScope } from "./portal";
import { palette } from "../lib/brand-colours";

export async function messengerAsset(
  request: Request,
  connect: Connect,
  load: (request: Request) => Promise<Response>,
  storageOrigins: string[] = [],
) {
  const url = new URL(request.url);
  if (!["/messenger/theme.css", "/messenger/frame.html"].includes(url.pathname))
    return load(request);
  const w = url.searchParams.get("workspace") ?? "",
    id = url.searchParams.get("brand") ?? "";
  const b = await tenant(
    connect,
    w,
    async (db) =>
      (
        await db.query<{ settings: Record<string, unknown> }>(
          "SELECT b.settings FROM brands b JOIN workspace_features f ON f.workspace_id=b.workspace_id AND f.name=$3 AND f.enabled WHERE b.workspace_id=$1 AND b.id=$2",
          [w, id, "messenger_v2"],
        )
      ).rows[0],
  );
  if (!b) return new Response("Messenger unavailable", { status: 404 });
  const headers = new Headers({
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  if (url.pathname.endsWith("theme.css")) {
    // The launcher in the brand's colour, with readable text on it (messenger settings M4).
    const { light } = palette(b.settings.color);
    headers.set("content-type", "text/css");
    return new Response(
      `:host{--relay-accent:${light.accent};--relay-on-accent:${light.onAccent}}`,
      { headers },
    );
  }
  const origins = (
    Array.isArray(b.settings.allowedOrigins) ? b.settings.allowedOrigins : []
  ).filter((x) => {
    try {
      return (
        typeof x === "string" && new URL(x).origin === x && /^https?:/.test(x)
      );
    } catch {
      return false;
    }
  });
  const parent = url.searchParams.get("parent");
  if (!origins.includes(parent))
    return new Response("Host origin unavailable", { status: 403 });
  const response = await load(request);
  const result = new Response(response.body, response);
  for (const [k, v] of headers) result.headers.set(k, v);
  const storage = storageOrigins
    .filter((x) =>
      /^https:\/\/[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(x),
    )
    .join(" ");
  result.headers.set(
    "content-security-policy",
    `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https:; connect-src 'self' ${url.origin.replace(/^http/, "ws")} ${storage}; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${origins.join(" ") || "'none'"}`,
  );
  return result;
}

/**
 * The customer portal page: /portal on a mapped domain, or /portal/{workspace}/{brand}. Served
 * only while the portal is enabled for that brand, with a strict CSP (same-origin script, style
 * and API; no framing, no inline code). Its script and stylesheet are ordinary static files.
 */
export async function portalAsset(
  request: Request,
  connect: Connect,
  load: (request: Request) => Promise<Response>,
) {
  const url = new URL(request.url);
  const match = url.pathname.match(
    /^\/portal(?:\/([A-Za-z0-9_-]{1,100})\/([A-Za-z0-9_-]{1,100}))?$/,
  );
  if (!match) return load(request);
  let enabled = false;
  try {
    const scope = await portalScope(connect, url.host, {
      workspace: match[1],
      brand: match[2],
    });
    enabled = await tenant(
      connect,
      scope.workspace,
      async (db) =>
        (
          await db.query(
            "SELECT 1 FROM workspace_features f JOIN brands b ON b.workspace_id=f.workspace_id AND b.id=$2 WHERE f.workspace_id=$1 AND f.name='portal_v1' AND f.enabled",
            [scope.workspace, scope.brand],
          )
        ).rows.length > 0,
    );
  } catch {
    enabled = false;
  }
  if (!enabled) return new Response("Portal unavailable", { status: 404 });
  const page = await load(new Request(new URL("/portal/index.html", url)));
  const response = new Response(page.body, page);
  for (const [k, v] of Object.entries({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy":
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  }))
    response.headers.set(k, v);
  return response;
}

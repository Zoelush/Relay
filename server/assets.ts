import { tenant, type Connect } from "./db";

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
    const color =
      typeof b.settings.color === "string" &&
      /^#[0-9a-fA-F]{6}$/.test(b.settings.color)
        ? b.settings.color
        : "#087a57";
    headers.set("content-type", "text/css");
    return new Response(
      `:root{--accent:${color}}:host button{background:${color}}`,
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

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

/**
 * A stand-in OpenID Connect provider on loopback (phase 16, step C4a; docs/SECURITY_STEP5.md), for
 * tests and the local relay: discovery, an authorize page that lists test people (choose one to
 * sign in, or cancel), a token endpoint that checks the client secret, the redirect address and
 * PKCE, and its signing keys. Never reachable from anywhere but this machine.
 */
export type IdpPerson = { id: string; name: string; email: string; emailVerified?: boolean; groups: string[] };
export const LOCAL_IDP_CLIENT = { id: "relay-local", secret: "local-idp-client-secret" };
export const LOCAL_IDP_PEOPLE: IdpPerson[] = [
  { id: "ada", name: "Ada Lovelace", email: "ada@example.test", groups: ["Everyone", "Support"] },
  { id: "lin", name: "Lin Chen", email: "lin@example.test", groups: ["Everyone", "Support leads"] },
  { id: "sam", name: "Sam Okafor", email: "sam@example.test", groups: ["Everyone", "Contractors"] },
  { id: "eve", name: "Eve Unverified", email: "eve@example.test", emailVerified: false, groups: ["Support"] },
  { id: "max", name: "Max Elsewhere", email: "max@elsewhere.test", groups: ["Support"] },
];

export async function startLocalIdp(options: { port: number; people?: IdpPerson[] }) {
  const origin = `http://127.0.0.1:${options.port}`;
  const people = options.people ?? LOCAL_IDP_PEOPLE;
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: "local-1", alg: "RS256", use: "sig" };
  const codes = new Map<string, { person: IdpPerson; clientId: string; redirectUri: string; nonce: string; challenge: string; expires: number }>();
  const html = (body: string) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Test identity provider</title><style>body{font:15px system-ui;margin:40px;max-width:520px}a{display:block;margin:8px 0}</style></head><body>${body}</body></html>`;
  const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const send = (res: ServerResponse, status: number, body: string, type = "application/json", extra: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...extra });
    res.end(body);
  };
  const read = async (req: IncomingMessage) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    return new URLSearchParams(raw);
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", origin);
      if (url.pathname === "/.well-known/openid-configuration")
        return send(
          res,
          200,
          JSON.stringify({
            issuer: origin,
            authorization_endpoint: origin + "/authorize",
            token_endpoint: origin + "/token",
            jwks_uri: origin + "/jwks",
            response_types_supported: ["code"],
            subject_types_supported: ["public"],
            id_token_signing_alg_values_supported: ["RS256"],
            code_challenge_methods_supported: ["S256"],
          }),
        );
      if (url.pathname === "/jwks") return send(res, 200, JSON.stringify({ keys: [jwk] }));
      if (url.pathname === "/authorize") {
        const q = url.searchParams;
        const redirect = q.get("redirect_uri") ?? "";
        if (q.get("client_id") !== LOCAL_IDP_CLIENT.id || !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(redirect) || q.get("code_challenge_method") !== "S256")
          return send(res, 400, html("<p>That request isn't valid for this test provider.</p>"), "text/html");
        const person = people.find((p) => p.id === q.get("person"));
        if (q.get("cancel")) return send(res, 302, "", "text/plain", { location: `${redirect}?error=access_denied&state=${encodeURIComponent(q.get("state") ?? "")}` });
        if (person) {
          const code = crypto.randomUUID();
          codes.set(code, { person, clientId: q.get("client_id")!, redirectUri: redirect, nonce: q.get("nonce") ?? "", challenge: q.get("code_challenge") ?? "", expires: Date.now() + 60_000 });
          return send(res, 302, "", "text/plain", { location: `${redirect}?code=${code}&state=${encodeURIComponent(q.get("state") ?? "")}` });
        }
        const link = (extra: string) => `/authorize?${q.toString()}&${extra}`;
        return send(
          res,
          200,
          html(
            `<h1>Test identity provider</h1><p>Choose who to sign in as.</p><nav aria-label="People">${people
              .map((p) => `<a href="${escape(link("person=" + p.id))}">${escape(p.name)} (${escape(p.email)})</a>`)
              .join("")}</nav><p><a href="${escape(link("cancel=1"))}">Cancel</a></p>`,
          ),
          "text/html",
        );
      }
      if (url.pathname === "/token" && req.method === "POST") {
        const form = await read(req);
        const [id, secret] = Buffer.from((req.headers.authorization ?? "").replace(/^Basic /, ""), "base64")
          .toString()
          .split(":")
          .map(decodeURIComponent);
        if (id !== LOCAL_IDP_CLIENT.id || secret !== LOCAL_IDP_CLIENT.secret) return send(res, 401, JSON.stringify({ error: "invalid_client" }));
        const grant = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
        if (!grant || grant.expires < Date.now() || grant.redirectUri !== form.get("redirect_uri") || grant.challenge !== challenge)
          return send(res, 400, JSON.stringify({ error: "invalid_grant" }));
        const p = grant.person;
        const idToken = await new SignJWT({ email: p.email, email_verified: p.emailVerified ?? true, name: p.name, groups: p.groups, nonce: grant.nonce })
          .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
          .setIssuer(origin)
          .setAudience(grant.clientId)
          .setSubject("local-" + p.id)
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(privateKey);
        return send(res, 200, JSON.stringify({ access_token: crypto.randomUUID(), token_type: "Bearer", expires_in: 300, id_token: idToken }));
      }
      send(res, 404, JSON.stringify({ error: "not_found" }));
    } catch {
      send(res, 500, JSON.stringify({ error: "server_error" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(options.port, "127.0.0.1", resolve));
  return {
    origin,
    host: `127.0.0.1:${options.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

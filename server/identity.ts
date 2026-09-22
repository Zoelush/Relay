import { decodeProtectedHeader, jwtVerify } from "jose";
import { assert, DomainError } from "./db";

export interface IdentityProof {
  userId: string;
  email: string;
  jwt?: string;
  hmac?: { kid: string; expiresAt: number; signature: string };
}
export interface IdentityPolicy {
  workspaceId: string;
  enforced: boolean;
  legacyHmacEnabled: boolean;
  keys: Record<string, Uint8Array>;
}
const encoder = new TextEncoder();
export const identityIssuer = (workspace: string) =>
  `relay-customer:${workspace}`;

export async function verifyIdentity(
  user: IdentityProof,
  policy: IdentityPolicy,
  now = Date.now(),
): Promise<boolean> {
  assert(
    typeof user.userId === "string" &&
      user.userId.length > 0 &&
      user.userId.length <= 200,
    "IDENTITY_INVALID",
    "A valid user ID is required.",
    401,
  );
  assert(
    typeof user.email === "string" &&
      user.email.length <= 254 &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email),
    "IDENTITY_INVALID",
    "A valid email is required.",
    401,
  );
  if (user.jwt) {
    try {
      assert(
        user.jwt.length <= 8192,
        "IDENTITY_INVALID",
        "Invalid identity token.",
        401,
      );
      const { kid, alg } = decodeProtectedHeader(user.jwt);
      assert(
        alg === "HS256" &&
          typeof kid === "string" &&
          Object.hasOwn(policy.keys, kid),
        "IDENTITY_INVALID",
        "Unknown identity key or algorithm.",
        401,
      );
      const { payload } = await jwtVerify(user.jwt, policy.keys[kid], {
        algorithms: ["HS256"],
        issuer: identityIssuer(policy.workspaceId),
        audience: "relay-messenger",
        currentDate: new Date(now),
        requiredClaims: ["exp", "iat", "sub", "email", "workspace_id"],
        clockTolerance: 0,
      });
      assert(
        payload.sub === user.userId &&
          payload.email === user.email &&
          payload.workspace_id === policy.workspaceId,
        "IDENTITY_INVALID",
        "Identity claims do not match this request.",
        401,
      );
      assert(
        typeof payload.iat === "number" &&
          typeof payload.exp === "number" &&
          payload.iat <= now / 1000 &&
          payload.exp - payload.iat <= 3600,
        "IDENTITY_INVALID",
        "Identity tokens must expire within one hour.",
        401,
      );
      return true;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        "IDENTITY_INVALID",
        "Your identity token is invalid or expired. Refresh it from your application server.",
        401,
      );
    }
  }
  if (user.hmac) {
    assert(
      policy.legacyHmacEnabled,
      "IDENTITY_HMAC_DISABLED",
      "Legacy identity verification is disabled.",
      401,
    );
    const p = user.hmac;
    assert(
      Object.hasOwn(policy.keys, p.kid) &&
        Number.isSafeInteger(p.expiresAt) &&
        p.expiresAt > now / 1000 &&
        p.expiresAt <= now / 1000 + 3600,
      "IDENTITY_INVALID",
      "Invalid or expired HMAC proof.",
      401,
    );
    const key = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(policy.keys[p.kid]),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    assert(
      /^[0-9a-f]{64}$/.test(p.signature),
      "IDENTITY_INVALID",
      "Invalid HMAC proof.",
      401,
    );
    const signature = Uint8Array.from(p.signature.match(/../g)!, (byte) =>
      parseInt(byte, 16),
    );
    const data = encoder.encode(
      JSON.stringify([
        "relay-identity-v1",
        policy.workspaceId,
        user.userId,
        user.email,
        p.expiresAt,
      ]),
    );
    assert(
      await crypto.subtle.verify("HMAC", key, signature, data),
      "IDENTITY_INVALID",
      "Invalid HMAC proof.",
      401,
    );
    return true;
  }
  assert(
    !policy.enforced,
    "IDENTITY_SIGNATURE_REQUIRED",
    "This workspace requires signed identity. Update this client to obtain a token from your application server.",
    401,
  );
  // Unverified profile details never authorize another user's private history.
  return false;
}
function base64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}
function unbase64(value: string) {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
async function wrappingKey(master: string) {
  return crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest("SHA-256", encoder.encode(master)),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}
export async function wrapIdentityKey(
  secret: Uint8Array,
  master: string,
  workspace: string,
  kid: string,
) {
  assert(
    master.length >= 32,
    "CONFIGURATION",
    "Identity wrapping secret is not configured.",
    503,
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: encoder.encode(JSON.stringify([workspace, kid])),
    },
    await wrappingKey(master),
    Uint8Array.from(secret),
  );
  return base64(iv) + "." + base64(new Uint8Array(encrypted));
}
export async function unwrapIdentityKey(
  wrapped: string,
  master: string,
  workspace: string,
  kid: string,
) {
  assert(
    master.length >= 32,
    "CONFIGURATION",
    "Identity wrapping secret is not configured.",
    503,
  );
  const [iv, data] = wrapped.split(".");
  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: unbase64(iv),
        additionalData: encoder.encode(JSON.stringify([workspace, kid])),
      },
      await wrappingKey(master),
      unbase64(data),
    ),
  );
}

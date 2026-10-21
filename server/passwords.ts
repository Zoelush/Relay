import { scrypt } from "@noble/hashes/scrypt";

/**
 * Teammates' passwords (phase 16, step C3a; docs/SECURITY_STEP3.md): scrypt (N=2^15, r=8, p=1, 32
 * bytes) with a 16-byte random salt, kept as `scrypt$<N>$<r>$<p>$<salt>$<hash>` (base64url), so the
 * cost can rise later and older hashes still verify. Compared in constant time.
 */
const COST = { N: 2 ** 15, r: 8, p: 1, dkLen: 32 } as const;
const b64 = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 200;

/** Why a password can't be used, or null. */
export function passwordProblem(password: unknown, email?: string): string | null {
  if (typeof password !== "string" || password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  const local = email?.split("@")[0]?.toLowerCase();
  if (local && local.length >= 4 && password.toLowerCase().includes(local)) return "Don't use your email address in your password.";
  if (new Set(password).size < 5) return "Use a password with more variety.";
  return null;
}

export function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = scrypt(new TextEncoder().encode(password), salt, COST);
  return `scrypt$${COST.N}$${COST.r}$${COST.p}$${b64(salt)}$${b64(hash)}`;
}

/** Whether the password matches; a malformed hash never does. */
export function verifyPassword(password: string, stored: string) {
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(stored);
  if (!m) return false;
  const [N, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (N > 2 ** 20 || r > 16 || p > 4) return false;
  const want = unb64(m[5]);
  const got = scrypt(new TextEncoder().encode(password), unb64(m[4]), { N, r, p, dkLen: want.length });
  let diff = got.length ^ want.length;
  for (let i = 0; i < want.length; i++) diff |= got[i] ^ want[i];
  return diff === 0;
}

/** Whether a stored hash is below today's cost (re-hashed at the next sign-in). */
export const needsRehash = (stored: string) => !stored.startsWith(`scrypt$${COST.N}$${COST.r}$${COST.p}$`);

/** A hash of nothing, so an unknown email costs the same as a wrong password. */
export const DUMMY_HASH = "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

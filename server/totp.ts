/**
 * Time-based one-time codes (RFC 6238; phase 16, step C3b, docs/SECURITY_STEP4.md): HMAC-SHA-1,
 * six digits, a 30-second step, as every authenticator app reads them. WebCrypto only, so the same
 * on Workers and locally. Also the recovery codes' shape.
 */
const STEP = 30;
const DIGITS = 6;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, without padding (what an authenticator app's "enter a key" expects). */
export function base32(bytes: Uint8Array) {
  let bits = 0,
    value = 0,
    out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
export function unbase32(s: string) {
  const clean = s.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0,
    value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error("Not base32.");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** A new key: 20 random bytes, in base32. */
export const newSecret = () => base32(crypto.getRandomValues(new Uint8Array(20)));
export const stepAt = (ms: number) => Math.floor(ms / 1000 / STEP);

/** The code for a key at a step (RFC 4226's dynamic truncation). */
export async function hotp(secret: string, step: number) {
  const key = await crypto.subtle.importKey("raw", unbase32(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const counter = new Uint8Array(8);
  new DataView(counter.buffer).setBigUint64(0, BigInt(step));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
  const at = mac[mac.length - 1] & 15;
  const n = ((mac[at] & 127) << 24) | (mac[at + 1] << 16) | (mac[at + 2] << 8) | mac[at + 3];
  return String(n % 10 ** DIGITS).padStart(DIGITS, "0");
}
/** The code for a key at a time (now by default). */
export const totp = (secret: string, ms = Date.now()) => hotp(secret, stepAt(ms));

/**
 * The step a code matches, one step either side of now, or null. Steps at or before `after` (the
 * last one used) never match, so a code works once.
 */
export async function matchStep(secret: string, code: string, after: number | null, ms = Date.now()) {
  const given = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(given)) return null;
  const now = stepAt(ms);
  for (const step of [now - 1, now, now + 1]) {
    if (after !== null && step <= after) continue;
    const want = await hotp(secret, step);
    let diff = 0;
    for (let i = 0; i < DIGITS; i++) diff |= want.charCodeAt(i) ^ given.charCodeAt(i);
    if (diff === 0) return step;
  }
  return null;
}

/** What an authenticator app scans: `otpauth://totp/…`. */
export function otpauthUri(secret: string, account: string, issuer: string) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP}`;
}

/** A recovery code: ten letters and digits that can't be misread, as `xxxxx-xxxxx`. */
const RECOVERY = "abcdefghjkmnpqrstuvwxyz23456789";
export function newRecoveryCode() {
  const pick = [...crypto.getRandomValues(new Uint8Array(10))].map((b) => RECOVERY[b % RECOVERY.length]).join("");
  return pick.slice(0, 5) + "-" + pick.slice(5);
}
/** A recovery code as it's compared: lower case, without spaces or the dash. */
export const normalRecoveryCode = (s: string) => s.toLowerCase().replace(/[\s-]/g, "");
export const looksLikeRecoveryCode = (s: string) => /^[a-z0-9]{10}$/.test(normalRecoveryCode(s));

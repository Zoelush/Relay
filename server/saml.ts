import { SAML, SamlStatusError, ValidateInResponseTo, type CacheProvider, type Profile } from "@node-saml/node-saml";
import { DomainError } from "./db";

/**
 * SAML 2.0 (phase 16, step C4b; docs/SECURITY_STEP6.md): the only module that uses
 * `@node-saml/node-saml` (pinned 5.1.0; signatures by `xml-crypto`), checked on workerd before it was
 * adopted. Relay is the service provider: its entity ID is its metadata address, its ACS takes the
 * HTTP-POST binding, and requests go by HTTP-Redirect, unsigned (Relay holds no SAML key).
 *
 * A response is accepted only with a signed assertion from the configured certificate, for Relay's
 * audience, from the configured issuer, in response to the login's own request, within its time.
 */
export type SamlSettings = { entryPoint: string; idpIssuer: string; idpCert: string; origin: string };
export const SAML_ACS_PATH = "/auth/saml/acs";
export const SAML_METADATA_PATH = "/auth/saml/metadata";
export const spEntityId = (origin: string) => origin + SAML_METADATA_PATH;

/** A certificate as PEM: pasted with or without its header, whitespace tidied. */
export function readCertificate(value: unknown) {
  const body = typeof value === "string" ? value.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "") : "";
  if (!/^[A-Za-z0-9+/]{200,16000}={0,2}$/.test(body))
    throw new DomainError("INVALID_FIELD", "Paste the identity provider's signing certificate (PEM, starting -----BEGIN CERTIFICATE-----).", 400, { field: "idpCert" });
  return `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----`;
}

/** A cache of one request ID: what this login asked for, so InResponseTo must match it. */
function oneRequest(id: string | null): CacheProvider & { saved: string | null } {
  const cache = {
    saved: null as string | null,
    async saveAsync(key: string, value: string) {
      cache.saved = key;
      return { createdAt: Date.now(), value };
    },
    async getAsync(key: string) {
      return key === id ? new Date().toISOString() : null;
    },
    async removeAsync(key: string | null) {
      return key;
    },
  };
  return cache;
}

function client(s: SamlSettings, cache: CacheProvider) {
  return new SAML({
    callbackUrl: s.origin + SAML_ACS_PATH,
    entryPoint: s.entryPoint,
    issuer: spEntityId(s.origin),
    audience: spEntityId(s.origin),
    idpIssuer: s.idpIssuer,
    idpCert: s.idpCert,
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: 10 * 60_000,
    cacheProvider: cache,
    acceptedClockSkewMs: 60_000,
    // Let the provider choose the NameID format, and don't ask for a particular way of signing in
    // (the provider's MFA, passkeys and so on would otherwise be refused).
    identifierFormat: null,
    disableRequestedAuthnContext: true,
  });
}

/** Where to send the browser (HTTP-Redirect), and the request's ID for InResponseTo. */
export async function samlAuthorize(s: SamlSettings, relayState: string) {
  const cache = oneRequest(null);
  const url = await client(s, cache).getAuthorizeUrlAsync(relayState, undefined, {});
  if (!cache.saved) throw new Error("The SAML request has no ID.");
  return { url, requestId: cache.saved };
}

const EMAIL_ATTRIBUTES = ["email", "mail", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress", "urn:oid:0.9.2342.19200300.100.1.3"];
const NAME_ATTRIBUTES = ["name", "displayName", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name", "http://schemas.microsoft.com/identity/claims/displayname"];
const first = (v: unknown) => (Array.isArray(v) ? v[0] : v);
const TRANSIENT = "urn:oasis:names:tc:SAML:2.0:nameid-format:transient";

/**
 * The parked response, checked: who it is (the NameID, never a transient one), their email (the
 * NameID when it is one, else an email attribute), name and groups (the named attribute). Throws a
 * DomainError for what the person can be told; anything else is a failed check.
 */
export async function samlProfile(s: SamlSettings, response: string, requestId: string | null, groupsAttribute: string) {
  let profile: Profile | null;
  try {
    profile = (await client(s, oneRequest(requestId)).validatePostResponseAsync({ SAMLResponse: response })).profile;
  } catch (e) {
    // The provider's own refusal (cancelled, not allowed): the person is told so.
    if (e instanceof SamlStatusError) throw new DomainError("SSO_DENIED", "Your identity provider didn't let you sign in.", 403);
    throw new Error("The SAML response was refused: " + String((e as Error)?.message ?? e).slice(0, 200));
  }
  if (!profile?.nameID) throw new Error("The SAML response names nobody.");
  if (profile.nameIDFormat === TRANSIENT) throw new DomainError("SSO_FAILED", "Your identity provider sends a temporary NameID. Ask it to send a persistent one or your email address.", 403);
  const fromNameId = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.nameID) ? profile.nameID : "";
  const fromAttribute = EMAIL_ATTRIBUTES.map((a) => first(profile![a])).find((v): v is string => typeof v === "string" && v.includes("@"));
  const name = NAME_ATTRIBUTES.map((a) => first(profile![a])).find((v): v is string => typeof v === "string" && !!v.trim());
  const raw = profile[groupsAttribute];
  const groups = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).filter((g): g is string => typeof g === "string").slice(0, 500);
  return { subject: profile.nameID.slice(0, 255), email: (fromNameId || fromAttribute || "").trim().toLowerCase(), name: name?.trim().slice(0, 80) ?? null, groups };
}

/** Relay's service provider metadata, for the identity provider to import. */
export function samlMetadata(s: SamlSettings) {
  return client(s, oneRequest(null)).generateServiceProviderMetadata(null, null);
}

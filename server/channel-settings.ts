import { assert, DomainError, type Sql } from "./db";
import { authorize } from "./policy";
import { requireSettings, validLanguage } from "./settings";

/**
 * Settings › Channels (S3b; docs/SETTINGS_STEP5.md): brands and each brand's messenger, for those
 * who manage the workspace. A brand's messenger settings live in `brands.settings`, which the
 * messenger reads on every boot (server/api.ts) and the frame's assets read on every load
 * (server/assets.ts), so a saved change applies to the next page that opens the messenger.
 *
 * Only the fields below are edited; anything else in a brand's settings (office hours, home
 * blocks) is kept as it is. Identity keys are listed (id, slot, age), never their secrets.
 * TODO(phase 16): creating and rotating identity keys from here, with an audit trail.
 */
export type Messenger = {
  color: string;
  theme: "auto" | "light" | "dark";
  position: "right" | "left";
  shape: "rounded" | "circle";
  logo: string;
  locale: string;
  teamIntroduction: string;
  outOfHours: string;
  allowVisitors: boolean;
  requireSearch: boolean;
  directConversation: boolean;
  allowedOrigins: string[];
};
export const DEFAULTS: Messenger = {
  color: "#087a57",
  theme: "auto",
  position: "right",
  shape: "rounded",
  logo: "",
  locale: "en",
  teamIntroduction: "Talk to our support team",
  outOfHours: "We are away. Leave a message and we will reply when we return.",
  allowVisitors: true,
  requireSearch: false,
  directConversation: false,
  allowedOrigins: [],
};
const invalid = (message: string): never => {
  throw new DomainError("INVALID_BRAND", message, 400);
};
const oneOf = <T extends string>(
  value: unknown,
  list: readonly T[],
  what: string,
) => (list.includes(value as T) ? (value as T) : invalid(`Choose ${what}.`));
const text = (value: unknown, max: number, what: string) => {
  const v = typeof value === "string" ? value.trim() : "";
  if (v.length > max) invalid(`Keep ${what} to ${max} characters.`);
  return v;
};

/** What a brand's stored settings mean, with defaults for anything missing or malformed. */
export function messengerOf(s: Record<string, unknown>): Messenger {
  const pick = <K extends keyof Messenger>(k: K, ok: (v: unknown) => boolean) =>
    (ok(s[k]) ? s[k] : DEFAULTS[k]) as Messenger[K];
  const str = (v: unknown) => typeof v === "string";
  return {
    color: pick(
      "color",
      (v) => str(v) && /^#[0-9a-fA-F]{6}$/.test(v as string),
    ),
    theme: pick("theme", (v) =>
      ["auto", "light", "dark"].includes(v as string),
    ),
    position: pick("position", (v) => v === "left" || v === "right"),
    shape: pick("shape", (v) => v === "rounded" || v === "circle"),
    logo: pick("logo", str),
    locale: pick("locale", str),
    teamIntroduction: pick("teamIntroduction", str),
    outOfHours: pick("outOfHours", str),
    allowVisitors: s.allowVisitors !== false,
    requireSearch: s.requireSearch === true,
    directConversation: s.directConversation === true,
    allowedOrigins: Array.isArray(s.allowedOrigins)
      ? s.allowedOrigins.filter(str)
      : [],
  };
}

/**
 * An exact website origin, such as https://shop.example.com. A trailing slash is dropped; paths,
 * queries and wildcards are refused. Plain http only for this machine (localhost), for testing.
 */
export function websiteOrigin(value: unknown) {
  const raw = typeof value === "string" ? value.trim() : "";
  let url: URL | null = null;
  try {
    url = new URL(raw);
  } catch {
    url = null;
  }
  const local =
    url && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    !url ||
    raw.includes("*") ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash ||
    url.username ||
    !(url.protocol === "https:" || (url.protocol === "http:" && local))
  )
    return invalid(
      `“${raw}” isn't a website address. Use the exact origin, such as https://shop.example.com, with no path.`,
    );
  return url.origin;
}

/** Checks and normalises a brand's messenger fields (Settings S3b; drafts in M1 use it too). */
export function validMessenger(m: Record<string, unknown>): Messenger {
  const logo = text(m.logo, 500, "the logo address");
  if (logo) {
    let ok = false;
    try {
      ok = new URL(logo).protocol === "https:";
    } catch {
      ok = false;
    }
    if (!ok) invalid("The logo needs an https:// image address.");
  }
  if (typeof m.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(m.color))
    invalid("Choose a colour such as #087a57.");
  if (!Array.isArray(m.allowedOrigins) || m.allowedOrigins.length > 50)
    invalid("List up to 50 websites.");
  const origins = [
    ...new Set((m.allowedOrigins as unknown[]).map(websiteOrigin)),
  ];
  return {
    color: (m.color as string).toLowerCase(),
    theme: oneOf(m.theme, ["auto", "light", "dark"] as const, "a theme"),
    position: oneOf(m.position, ["right", "left"] as const, "a side"),
    shape: oneOf(m.shape, ["rounded", "circle"] as const, "a shape"),
    logo,
    locale: validLanguage(m.locale),
    teamIntroduction:
      text(m.teamIntroduction, 200, "the greeting") ||
      invalid("Write a greeting."),
    outOfHours:
      text(m.outOfHours, 500, "the away message") ||
      invalid("Write an away message."),
    allowVisitors: m.allowVisitors === true,
    requireSearch: m.requireSearch === true,
    directConversation: m.directConversation === true,
    allowedOrigins: origins,
  } satisfies Messenger;
}

export async function listBrands(
  db: Sql,
  w: string,
  principal: string,
  apiOrigin: string,
) {
  await authorize(db, w, principal, "workspace.manage");
  await requireSettings(db, w);
  const brands = (
    await db.query<{
      id: string;
      name: string;
      settings: Record<string, unknown>;
      identity_enforced: boolean;
      legacy_hmac_enabled: boolean;
      conversations: number;
    }>(
      `SELECT b.id,b.name,b.settings,b.identity_enforced,b.legacy_hmac_enabled,
        (SELECT count(*) FROM conversations c WHERE c.workspace_id=b.workspace_id AND c.brand_id=b.id)::int AS conversations
       FROM brands b WHERE b.workspace_id=$1 ORDER BY b.id<>'default',lower(b.name),b.id`,
      [w],
    )
  ).rows;
  const keys = (
    await db.query<{ kid: string; slot: number; created_at: string }>(
      "SELECT kid,slot,created_at FROM identity_keys WHERE workspace_id=$1 ORDER BY slot",
      [w],
    )
  ).rows;
  const portal = (
    await db.query(
      "SELECT 1 FROM workspace_features WHERE workspace_id=$1 AND name='portal_v1' AND enabled",
      [w],
    )
  ).rows.length;
  return {
    workspaceId: w,
    apiOrigin,
    brands: brands.map((b) => ({
      id: b.id,
      name: b.name,
      conversations: b.conversations,
      messenger: messengerOf(b.settings ?? {}),
      identity: {
        enforced: b.identity_enforced,
        legacyHmac: b.legacy_hmac_enabled,
      },
      ...(portal
        ? {
            portalUrl: `${apiOrigin}/portal/${encodeURIComponent(w)}/${encodeURIComponent(b.id)}`,
          }
        : {}),
    })),
    // Which keys exist, so a manager can tell whether verification can work; never the secrets.
    identityKeys: keys.map((k) => ({
      kid: k.kid,
      slot: k.slot,
      createdAt: new Date(k.created_at).toISOString(),
    })),
  };
}

/**
 * Creates or renames a brand, or saves its messenger (`section: "messenger"`, every field) or
 * identity verification (`section: "identity"`). Brands aren't deleted: conversations point at
 * them.
 */
export async function saveBrand(
  db: Sql,
  w: string,
  principal: string,
  p: Record<string, unknown>,
) {
  await authorize(db, w, principal, "workspace.manage");
  await requireSettings(db, w);
  const existing =
    p.id === undefined
      ? null
      : (
          await db.query<{ id: string }>(
            "SELECT id FROM brands WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
            [w, String(p.id)],
          )
        ).rows[0];
  assert(
    p.id === undefined || existing,
    "BRAND_NOT_FOUND",
    "Brand unavailable.",
    404,
  );
  if (p.section === "messenger") {
    assert(existing, "BRAND_NOT_FOUND", "Brand unavailable.", 404);
    // With drafts (messenger_v3), the messenger is published from Settings › Messenger instead.
    assert(
      !(
        await db.query(
          "SELECT 1 FROM workspace_features WHERE workspace_id=$1 AND name='messenger_v3' AND enabled",
          [w],
        )
      ).rows.length,
      "MESSENGER_DRAFTS",
      "This workspace edits its messenger as drafts. Save and publish it from the Messenger page.",
      409,
    );
    const next = validMessenger((p.messenger ?? {}) as Record<string, unknown>);
    await db.query(
      "UPDATE brands SET settings=settings||$3::jsonb WHERE workspace_id=$1 AND id=$2",
      [w, existing.id, JSON.stringify(next)],
    );
    return { id: existing.id, messenger: next };
  }
  if (p.section === "identity") {
    assert(existing, "BRAND_NOT_FOUND", "Brand unavailable.", 404);
    if (typeof p.enforced !== "boolean" || typeof p.legacyHmac !== "boolean")
      invalid("Choose how identities are verified.");
    await db.query(
      "UPDATE brands SET identity_enforced=$3,legacy_hmac_enabled=$4 WHERE workspace_id=$1 AND id=$2",
      [w, existing.id, p.enforced, p.legacyHmac],
    );
    return { id: existing.id };
  }
  const name =
    typeof p.name === "string" ? p.name.trim().replace(/\s+/g, " ") : "";
  if (!name || name.length > 80)
    invalid("Give the brand a name of up to 80 characters.");
  const clash = (
    await db.query<{ name: string }>(
      "SELECT name FROM brands WHERE workspace_id=$1 AND lower(name)=lower($2) AND id<>$3",
      [w, name, existing?.id ?? ""],
    )
  ).rows[0];
  if (clash)
    throw new DomainError(
      "BRAND_EXISTS",
      `There's already a brand called “${clash.name}”.`,
      409,
    );
  if (existing) {
    await db.query(
      "UPDATE brands SET name=$3 WHERE workspace_id=$1 AND id=$2",
      [w, existing.id, name],
    );
    return { id: existing.id };
  }
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "brand";
  const taken = (
    await db.query("SELECT 1 FROM brands WHERE workspace_id=$1 AND id=$2", [
      w,
      base,
    ])
  ).rows.length;
  const id = taken ? `${base}-${crypto.randomUUID().slice(0, 6)}` : base;
  // A new brand starts with the default look and no websites: its messenger loads nowhere until
  // a website is added. Verification is enforced, as for every brand.
  await db.query(
    "INSERT INTO brands(workspace_id,id,name,settings) VALUES($1,$2,$3,$4)",
    [
      w,
      id,
      name,
      JSON.stringify({
        ...DEFAULTS,
        homeBlocks: [{ type: "start" }, { type: "recent" }],
      }),
    ],
  );
  return { id };
}

import { assert, DomainError, type Sql } from "./db";
import { authorize } from "./policy";
import { requireSettings, validLanguage } from "./settings";
import {
  messengerOf,
  validMessenger,
  type Messenger,
} from "./channel-settings";

/**
 * Messenger settings, step M1 (docs/MESSENGER_SETTINGS_STEP1.md), behind `messenger_v3`: each
 * brand's messenger is edited as a draft and published as a numbered version.
 *
 * Beyond the look and websites of Settings S3b, a messenger now has:
 * - **Audiences:** visitors and verified users each get their own spaces (and their order),
 *   "open straight into a conversation", start-button wording and launcher visibility (always,
 *   never, or by page address).
 * - **Home cards**, each for everyone, visitors or users: start a conversation, search help,
 *   recent conversations, a link, an announcement, your tickets.
 * - **A welcome** (greeting and introduction) per language; the greeting can use the customer's
 *   first name.
 * - **A special notice** shown to everyone, per language.
 *
 * Publishing copies the draft into a new version and writes the live settings the messenger reads
 * (`brands.settings`): the S3b fields at the top level, the rest under `messenger3`. The boot
 * response only includes `messenger3` while the flag is on, so switching it off falls back to the
 * earlier messenger.
 */
export const SPACES = ["home", "messages", "help", "tickets"] as const;
export type Space = (typeof SPACES)[number];
export const START_BUTTONS = [
  "send",
  "ask",
  "chat",
  "start",
  "contact",
  "support",
] as const;
export const CARD_TYPES = [
  "start",
  "search",
  "recent",
  "link",
  "announcement",
  "tickets",
] as const;
export type UrlRule = {
  op: "contains" | "starts_with" | "equals";
  value: string;
};
export type AudienceConfig = {
  spaces: Space[];
  launchToConversation: boolean;
  startButton: (typeof START_BUTTONS)[number];
  launcher: {
    show: "always" | "never" | "only_matching" | "except_matching";
    rules: UrlRule[];
  };
};
export type HomeCard = {
  id: string;
  type: (typeof CARD_TYPES)[number];
  audience: "everyone" | "visitors" | "users";
  title?: string;
  body?: string;
  url?: string;
};
export type Extras = {
  audiences: { visitors: AudienceConfig; users: AudienceConfig };
  home: HomeCard[];
  welcome: Record<string, { greeting: string; intro: string }>;
  notice: { enabled: boolean; text: Record<string, string> };
};
export type MessengerConfig = Messenger & Extras;

const invalid = (message: string): never => {
  throw new DomainError("INVALID_MESSENGER", message, 400);
};
const str = (v: unknown, max: number, what: string) => {
  const s = typeof v === "string" ? v.trim() : "";
  if (s.length > max) invalid(`Keep ${what} to ${max} characters.`);
  return s;
};
const audienceDefaults = (m: Messenger): AudienceConfig => ({
  spaces: ["home", "messages", "help"],
  launchToConversation: m.directConversation,
  startButton: "start",
  launcher: { show: "always", rules: [] },
});
/** What a brand's current settings describe, as a full config (the first draft's starting point). */
export function configOf(settings: Record<string, unknown>): MessengerConfig {
  const m = messengerOf(settings);
  const extras = settings.messenger3 as Extras | undefined;
  if (extras) return { ...m, ...extras };
  const blocks = Array.isArray(settings.homeBlocks)
    ? (settings.homeBlocks as { type: string }[])
    : [{ type: "start" }, { type: "recent" }];
  return {
    ...m,
    audiences: { visitors: audienceDefaults(m), users: audienceDefaults(m) },
    home: blocks
      .filter((b) => ["start", "recent", "search"].includes(b.type))
      .map((b, i) => ({
        id: `card-${i + 1}`,
        type: b.type as HomeCard["type"],
        audience: "everyone" as const,
      })),
    welcome: {
      [m.locale]: { greeting: "Hi {first_name} 👋", intro: "How can we help?" },
    },
    notice: { enabled: false, text: {} },
  };
}

function validAudience(v: unknown, who: "visitors" | "users"): AudienceConfig {
  const a = (v ?? {}) as Record<string, unknown>;
  const spaces = Array.isArray(a.spaces) ? (a.spaces as unknown[]) : [];
  if (!spaces.every((s) => SPACES.includes(s as Space)))
    invalid("Choose spaces from Home, Messages, Help and Tickets.");
  const list = [...new Set(spaces as Space[])];
  if (!list.includes("messages"))
    invalid(
      "Messages is always shown, so customers can reach their conversations.",
    );
  if (who === "visitors" && list.includes("tickets"))
    invalid("Tickets are for signed-in users, whose identity is verified.");
  const launcher = (a.launcher ?? {}) as Record<string, unknown>;
  const show = launcher.show ?? "always";
  if (
    !["always", "never", "only_matching", "except_matching"].includes(
      String(show),
    )
  )
    invalid("Choose when the launcher shows.");
  const rules = (Array.isArray(launcher.rules) ? launcher.rules : []).map(
    (r) => {
      const rule = (r ?? {}) as Record<string, unknown>;
      if (!["contains", "starts_with", "equals"].includes(String(rule.op)))
        invalid("Each page rule is contains, starts with or is exactly.");
      const value = str(rule.value, 300, "a page rule");
      if (!value) invalid("Each page rule needs an address or part of one.");
      return { op: rule.op as UrlRule["op"], value };
    },
  );
  if (rules.length > 20) invalid("Use up to 20 page rules.");
  if ((show === "only_matching" || show === "except_matching") && !rules.length)
    invalid("Add at least one page rule, or show the launcher always.");
  if (!START_BUTTONS.includes(a.startButton as never))
    invalid("Choose the start button's wording.");
  return {
    spaces: list,
    launchToConversation: a.launchToConversation === true,
    startButton: a.startButton as AudienceConfig["startButton"],
    launcher: { show: show as AudienceConfig["launcher"]["show"], rules },
  };
}

/** Checks and normalises a whole messenger config. */
export function validConfig(input: unknown): MessengerConfig {
  const c = (input ?? {}) as Record<string, unknown>;
  const base = validMessenger(c);
  const aud = (c.audiences ?? {}) as Record<string, unknown>;
  const audiences = {
    visitors: validAudience(aud.visitors, "visitors"),
    users: validAudience(aud.users, "users"),
  };
  const cards = Array.isArray(c.home)
    ? (c.home as Record<string, unknown>[])
    : [];
  if (cards.length > 12) invalid("Use up to 12 Home cards.");
  const ids = new Set<string>();
  const home = cards.map((raw, i): HomeCard => {
    const card = raw ?? {};
    if (!CARD_TYPES.includes(card.type as never))
      invalid("Choose each card's kind.");
    if (!["everyone", "visitors", "users"].includes(String(card.audience)))
      invalid("Choose who sees each card.");
    const id =
      typeof card.id === "string" &&
      /^[a-z0-9-]{1,40}$/.test(card.id) &&
      !ids.has(card.id)
        ? card.id
        : `card-${i + 1}-${crypto.randomUUID().slice(0, 4)}`;
    ids.add(id);
    const out: HomeCard = {
      id,
      type: card.type as HomeCard["type"],
      audience: card.audience as HomeCard["audience"],
    };
    if (card.type === "link" || card.type === "announcement") {
      out.title = str(card.title, 80, "a card's title");
      if (!out.title) invalid("Give each link and announcement a title.");
      out.body = str(card.body, 300, "a card's text");
    }
    if (card.type === "link") {
      const url = str(card.url, 500, "a link");
      let ok = false;
      try {
        ok = new URL(url).protocol === "https:";
      } catch {
        ok = false;
      }
      if (!ok) invalid(`“${out.title}” needs an https:// address.`);
      out.url = url;
    }
    if (card.type === "tickets" && card.audience !== "users")
      invalid("The tickets card is for signed-in users only.");
    return out;
  });
  const welcomeIn = (c.welcome ?? {}) as Record<string, unknown>;
  const welcome: Extras["welcome"] = {};
  for (const [locale, v] of Object.entries(welcomeIn)) {
    const w = (v ?? {}) as Record<string, unknown>;
    const greeting = str(w.greeting, 120, "a greeting");
    const intro = str(w.intro, 160, "an introduction");
    if (!greeting) invalid("Each language's welcome needs a greeting.");
    welcome[validLanguage(locale)] = { greeting, intro };
  }
  if (!welcome[base.locale])
    invalid("Write a welcome in the messenger's own language.");
  if (Object.keys(welcome).length > 30) invalid("Use up to 30 languages.");
  const n = (c.notice ?? {}) as Record<string, unknown>;
  const noticeText: Record<string, string> = {};
  for (const [locale, v] of Object.entries(
    (n.text ?? {}) as Record<string, unknown>,
  )) {
    const t = str(v, 300, "the notice");
    if (t) noticeText[validLanguage(locale)] = t;
  }
  if (n.enabled === true && !noticeText[base.locale])
    invalid(
      "Write the notice in the messenger's own language before switching it on.",
    );
  return {
    ...base,
    // The earlier single setting follows visitors (what the earlier messenger did for everyone).
    directConversation: audiences.visitors.launchToConversation,
    audiences,
    home,
    welcome,
    notice: { enabled: n.enabled === true, text: noticeText },
  };
}

/** Equal as data: PostgreSQL's jsonb doesn't keep key order, so keys are compared sorted. */
const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
        )
      : v;
const same = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export async function messengerV3(db: Sql, w: string) {
  return (
    (
      await db.query(
        "SELECT 1 FROM workspace_features WHERE workspace_id=$1 AND name='messenger_v3' AND enabled",
        [w],
      )
    ).rows.length > 0
  );
}
async function manage(db: Sql, w: string, principal: string, brandId: unknown) {
  const t = await authorize(db, w, principal, "workspace.manage");
  await requireSettings(db, w);
  assert(
    await messengerV3(db, w),
    "MESSENGER_V3_DISABLED",
    "Messenger drafts are not enabled for this workspace.",
    404,
  );
  const brand = (
    await db.query<{ id: string; settings: Record<string, unknown> }>(
      "SELECT id,settings FROM brands WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
      [w, String(brandId ?? "")],
    )
  ).rows[0];
  assert(brand, "BRAND_NOT_FOUND", "Brand unavailable.", 404);
  return { t, brand };
}
async function latest(db: Sql, w: string, brandId: string) {
  return (
    await db.query<{
      version: number;
      config: MessengerConfig;
      published_at: string;
    }>(
      "SELECT version,config,published_at FROM messenger_versions WHERE workspace_id=$1 AND brand_id=$2 ORDER BY version DESC LIMIT 1",
      [w, brandId],
    )
  ).rows[0];
}
/** The draft, created from what's live the first time it's asked for. */
async function draftOf(
  db: Sql,
  w: string,
  brand: { id: string; settings: Record<string, unknown> },
) {
  const row = (
    await db.query<{
      config: MessengerConfig;
      version: string;
      updated_at: string;
    }>(
      "SELECT config,version::text AS version,updated_at FROM messenger_drafts WHERE workspace_id=$1 AND brand_id=$2",
      [w, brand.id],
    )
  ).rows[0];
  if (row) return row;
  const config =
    (await latest(db, w, brand.id))?.config ?? configOf(brand.settings);
  await db.query(
    "INSERT INTO messenger_drafts(workspace_id,brand_id,config) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
    [w, brand.id, JSON.stringify(config)],
  );
  return (
    await db.query<{
      config: MessengerConfig;
      version: string;
      updated_at: string;
    }>(
      "SELECT config,version::text AS version,updated_at FROM messenger_drafts WHERE workspace_id=$1 AND brand_id=$2",
      [w, brand.id],
    )
  ).rows[0];
}

/** The Messenger page: the draft, what's live, and the versions to restore. */
export async function readMessenger(
  db: Sql,
  w: string,
  principal: string,
  brandId: unknown,
) {
  const { brand } = await manage(db, w, principal, brandId);
  const draft = await draftOf(db, w, brand);
  const live = await latest(db, w, brand.id);
  const liveConfig = live?.config ?? configOf(brand.settings);
  const versions = (
    await db.query<{
      version: number;
      published_at: string;
      published_by: string | null;
      name: string | null;
    }>(
      `SELECT v.version,v.published_at,v.published_by,t.name FROM messenger_versions v
       LEFT JOIN teammates t ON t.workspace_id=v.workspace_id AND t.id=v.published_by
       WHERE v.workspace_id=$1 AND v.brand_id=$2 ORDER BY v.version DESC LIMIT 10`,
      [w, brand.id],
    )
  ).rows;
  return {
    brandId: brand.id,
    draft: draft.config,
    draftVersion: draft.version,
    draftUpdatedAt: new Date(draft.updated_at).toISOString(),
    live: liveConfig,
    liveVersion: live?.version ?? null,
    // Unpublished changes: the draft differs from what's live.
    changed: !same(draft.config, liveConfig),
    versions: versions.map((v) => ({
      version: v.version,
      publishedAt: new Date(v.published_at).toISOString(),
      publishedBy: v.name,
    })),
  };
}

/**
 * Saves the draft (from the version the page loaded, or refused as changed elsewhere), publishes
 * it, discards it (back to what's live), or restores an earlier version into it.
 */
export async function changeMessenger(
  db: Sql,
  w: string,
  principal: string,
  p: Record<string, unknown>,
) {
  const { t, brand } = await manage(db, w, principal, p.brandId);
  const draft = await draftOf(db, w, brand);
  const fresh = () =>
    assert(
      String(p.draftVersion ?? "") === draft.version,
      "MESSENGER_CONFLICT",
      "The draft changed elsewhere. Reload to see the latest, then try again.",
      409,
    );
  const setDraft = async (config: MessengerConfig) =>
    db.query(
      "UPDATE messenger_drafts SET config=$3,version=version+1,updated_at=now(),updated_by=$4 WHERE workspace_id=$1 AND brand_id=$2",
      [w, brand.id, JSON.stringify(config), t.id],
    );
  if (p.action === "save") {
    fresh();
    await setDraft(validConfig(p.config));
  } else if (p.action === "publish") {
    fresh();
    // Re-checked: a draft saved before a rule changed must still be valid to go live.
    const config = validConfig(draft.config);
    const version = ((await latest(db, w, brand.id))?.version ?? 0) + 1;
    await db.query(
      "INSERT INTO messenger_versions(workspace_id,brand_id,version,config,published_by) VALUES($1,$2,$3,$4,$5)",
      [w, brand.id, version, JSON.stringify(config), t.id],
    );
    const { audiences, home, welcome, notice, ...base } = config;
    await db.query(
      "UPDATE brands SET settings=settings||$3::jsonb WHERE workspace_id=$1 AND id=$2",
      [
        w,
        brand.id,
        JSON.stringify({
          ...base,
          messenger3: { audiences, home, welcome, notice },
        }),
      ],
    );
    if (!same(config, draft.config))
      await setDraft(config);
  } else if (p.action === "discard") {
    const live = await latest(db, w, brand.id);
    await setDraft(live?.config ?? configOf(brand.settings));
  } else if (p.action === "restore") {
    const old = (
      await db.query<{ config: MessengerConfig }>(
        "SELECT config FROM messenger_versions WHERE workspace_id=$1 AND brand_id=$2 AND version=$3",
        [w, brand.id, Number(p.version)],
      )
    ).rows[0];
    assert(old, "VERSION_NOT_FOUND", "That version is unavailable.", 404);
    await setDraft(old.config);
  } else invalid("Choose save, publish, discard or restore.");
  return readMessenger(db, w, principal, brand.id);
}

/** Whether a page address matches a launcher rule (shared with the loader's copy of this logic). */
export function pageMatches(url: string, rules: UrlRule[]) {
  return rules.some((r) =>
    r.op === "equals"
      ? url === r.value
      : r.op === "starts_with"
        ? url.startsWith(r.value)
        : url.includes(r.value),
  );
}

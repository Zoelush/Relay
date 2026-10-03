import { INTERFACE_LANGUAGES } from "../lib/messenger-languages";
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
  /** Messenger settings M3: what this audience may start and reply to. */
  inbound: Inbound;
};
export type Inbound = {
  /** One open (or snoozed) conversation at a time: the messenger continues it instead. */
  oneConversation: boolean;
  /** "Talk to us" after saying a help article didn't help. */
  talkAfterUnhelpful: boolean;
  /** No replies to a closed conversation (a new one can be started). */
  blockClosedReplies: boolean;
  /** No replies to a closed ticket. */
  blockClosedTicketReplies: boolean;
};
export const DEFAULT_INBOUND: Inbound = {
  oneConversation: false,
  talkAfterUnhelpful: true,
  blockClosedReplies: false,
  blockClosedTicketReplies: false,
};
/** Messenger settings M3: for everyone. */
export type General = {
  /** Reply times and office hours on Home always, or only once a team has the conversation. */
  replyTimes: "always" | "after_team";
  /** Whether the reply sound starts switched on (customers can still change it). */
  soundDefault: boolean;
  /** Interface languages offered besides the messenger's own; others get its own. */
  languages: string[];
  /** A privacy notice when a conversation is started, with a link to the policy. */
  privacy: { enabled: boolean; url: string; text: Record<string, string> };
};
export const DEFAULT_GENERAL: General = {
  replyTimes: "always",
  soundDefault: false,
  languages: [],
  privacy: { enabled: false, url: "", text: {} },
};
export { INTERFACE_LANGUAGES } from "../lib/messenger-languages";
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
  /** Messenger settings M2: the look beyond colour, theme, side, shape and logo. */
  look: Look;
  general: General;
};
export type Look = {
  /** The primary colour in the dark theme (null: the light one). */
  darkColor: string | null;
  /** The background of Home's welcome, with its text colour, and a fade into the page. */
  header: {
    background: "none" | "solid" | "gradient" | "image";
    colors: string[];
    image: string;
    text: "light" | "dark";
    fade: boolean;
  };
  /** An image in the launcher instead of the ✦ (https). */
  launcherLogo: string;
  /** The launcher's distance from the side and bottom on computers and tablets, in pixels. */
  launcherSpacing: { side: number; bottom: number };
  /** Teammates' initials on Home, to put people behind the messenger. */
  showTeammates: boolean;
};
export const DEFAULT_LOOK: Look = {
  darkColor: null,
  header: {
    background: "none",
    colors: ["#087a57"],
    image: "",
    text: "light",
    fade: false,
  },
  launcherLogo: "",
  launcherSpacing: { side: 24, bottom: 24 },
  showTeammates: false,
};
/** A config from before M2 or M3 gets the defaults for what it lacks. */
export const withLook = <T extends Partial<Extras>>(
  c: T,
): T & { look: Look; general: General } => ({
  ...c,
  ...(c.audiences
    ? {
        audiences: {
          visitors: {
            ...c.audiences.visitors,
            inbound: c.audiences.visitors.inbound ?? DEFAULT_INBOUND,
          },
          users: {
            ...c.audiences.users,
            inbound: c.audiences.users.inbound ?? DEFAULT_INBOUND,
          },
        },
      }
    : {}),
  look: c.look ?? DEFAULT_LOOK,
  general: c.general ?? DEFAULT_GENERAL,
});
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
  inbound: DEFAULT_INBOUND,
});
/** What a brand's current settings describe, as a full config (the first draft's starting point). */
export function configOf(settings: Record<string, unknown>): MessengerConfig {
  const m = messengerOf(settings);
  const extras = settings.messenger3 as Extras | undefined;
  if (extras) return withLook({ ...m, ...extras });
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
    look: DEFAULT_LOOK,
    general: DEFAULT_GENERAL,
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
    inbound: validInbound(a.inbound ?? DEFAULT_INBOUND),
  };
}
function validInbound(v: unknown): Inbound {
  const i = (v ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(DEFAULT_INBOUND))
    if (typeof i[k] !== "boolean") invalid("Choose each conversation rule.");
  return {
    oneConversation: i.oneConversation === true,
    talkAfterUnhelpful: i.talkAfterUnhelpful === true,
    blockClosedReplies: i.blockClosedReplies === true,
    blockClosedTicketReplies: i.blockClosedTicketReplies === true,
  };
}
function validGeneral(v: unknown, own: string): General {
  const g = (v ?? {}) as Record<string, unknown>;
  if (g.replyTimes !== "always" && g.replyTimes !== "after_team")
    invalid("Choose when reply times show.");
  const languages = (Array.isArray(g.languages) ? g.languages : []).map(String);
  if (
    !languages.every((l) =>
      (INTERFACE_LANGUAGES as readonly string[]).includes(l),
    )
  )
    invalid("Choose interface languages the messenger has words for.");
  const p = (g.privacy ?? {}) as Record<string, unknown>;
  const url = str(p.url, 500, "the privacy policy address");
  if (url && !https(url))
    invalid("The privacy policy needs an https:// address.");
  const text: Record<string, string> = {};
  for (const [locale, t] of Object.entries(
    (p.text ?? {}) as Record<string, unknown>,
  )) {
    const v = str(t, 300, "the privacy notice");
    if (v) text[validLanguage(locale)] = v;
  }
  if (p.enabled === true && !text[own])
    invalid(
      "Write the privacy notice in the messenger's own language before switching it on.",
    );
  if (p.enabled === true && !url)
    invalid(
      "Give the privacy policy's address before switching the notice on.",
    );
  return {
    replyTimes: g.replyTimes as General["replyTimes"],
    soundDefault: g.soundDefault === true,
    languages: [...new Set(languages.filter((l) => l !== own))],
    privacy: { enabled: p.enabled === true, url, text },
  };
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const https = (v: string) => {
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
};
function validLook(input: unknown): Look {
  const l = (input ?? {}) as Record<string, unknown>;
  const h = (l.header ?? {}) as Record<string, unknown>;
  const darkColor =
    l.darkColor === null || l.darkColor === "" || l.darkColor === undefined
      ? null
      : String(l.darkColor);
  if (darkColor !== null && !HEX.test(darkColor))
    invalid("Choose a dark-theme colour such as #2bb88a.");
  const background = String(h.background ?? "none");
  if (!["none", "solid", "gradient", "image"].includes(background))
    invalid(
      "Choose Home's background: none, a colour, a gradient or an image.",
    );
  const colors = (Array.isArray(h.colors) ? h.colors : []).map(String);
  if (!colors.length || colors.length > 3 || !colors.every((x) => HEX.test(x)))
    invalid("Home's background takes one to three colours such as #087a57.");
  if (background === "gradient" && colors.length < 2)
    invalid("A gradient needs two or three colours.");
  const image = str(h.image, 500, "the background image address");
  if (background === "image" && !https(image))
    invalid("The background image needs an https:// address.");
  if (h.text !== "light" && h.text !== "dark")
    invalid("Choose light or dark text for Home's background.");
  const launcherLogo = str(l.launcherLogo, 500, "the launcher logo address");
  if (launcherLogo && !https(launcherLogo))
    invalid("The launcher logo needs an https:// image address.");
  const spacing = (l.launcherSpacing ?? {}) as Record<string, unknown>;
  const px = (v: unknown, what: string) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 120)
      invalid(`The launcher's ${what} spacing is 0 to 120 pixels.`);
    return n;
  };
  return {
    darkColor: darkColor?.toLowerCase() ?? null,
    header: {
      background: background as Look["header"]["background"],
      colors: colors.map((x) => x.toLowerCase()),
      image: background === "image" ? image : "",
      text: h.text as Look["header"]["text"],
      fade: h.fade === true,
    },
    launcherLogo,
    launcherSpacing: {
      side: px(spacing.side, "side"),
      bottom: px(spacing.bottom, "bottom"),
    },
    showTeammates: l.showTeammates === true,
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
    look: validLook(c.look ?? DEFAULT_LOOK),
    general: validGeneral(c.general ?? DEFAULT_GENERAL, base.locale),
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
  if (row) return { ...row, config: withLook(row.config) };
  const config = withLook(
    (await latest(db, w, brand.id))?.config ?? configOf(brand.settings),
  );
  await db.query(
    "INSERT INTO messenger_drafts(workspace_id,brand_id,config) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
    [w, brand.id, JSON.stringify(config)],
  );
  const created = (
    await db.query<{
      config: MessengerConfig;
      version: string;
      updated_at: string;
    }>(
      "SELECT config,version::text AS version,updated_at FROM messenger_drafts WHERE workspace_id=$1 AND brand_id=$2",
      [w, brand.id],
    )
  ).rows[0];
  return { ...created, config: withLook(created.config) };
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
  const liveConfig = withLook(live?.config ?? configOf(brand.settings));
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
  // Messenger M3: where the messenger ran in the last seven days, and failed verifications.
  const seen = (
    await db.query<{ origin: string; sessions: number; verified: number }>(
      `SELECT substring(s.page_url from '^[a-z]+://[^/]+') AS origin,count(*)::int AS sessions,
         count(*) FILTER (WHERE i.kind='user')::int AS verified
       FROM messenger_sessions s JOIN identities i ON i.workspace_id=s.workspace_id AND i.id=s.identity_id
       WHERE s.workspace_id=$1 AND s.brand_id=$2 AND s.expires_at>now()-interval '7 days'
       GROUP BY 1 ORDER BY 2 DESC LIMIT 20`,
      [w, brand.id],
    )
  ).rows.filter((r) => r.origin);
  const failures = (
    await db.query<{ reason: string; count: number; last_at: string }>(
      `SELECT reason,sum(count)::int AS count,max(last_at) AS last_at FROM identity_failures
       WHERE workspace_id=$1 AND brand_id=$2 AND hour>now()-interval '7 days'
       GROUP BY reason ORDER BY max(last_at) DESC`,
      [w, brand.id],
    )
  ).rows;
  return {
    install: {
      origins: seen,
      failures: failures.map((f) => ({
        reason: f.reason,
        count: f.count,
        lastAt: new Date(f.last_at).toISOString(),
      })),
    },
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
    const { audiences, home, welcome, notice, look, general, ...base } = config;
    await db.query(
      "UPDATE brands SET settings=settings||$3::jsonb WHERE workspace_id=$1 AND id=$2",
      [
        w,
        brand.id,
        JSON.stringify({
          ...base,
          messenger3: { audiences, home, welcome, notice, look, general },
        }),
      ],
    );
    if (!same(config, draft.config)) await setDraft(config);
  } else if (p.action === "discard") {
    const live = await latest(db, w, brand.id);
    await setDraft(withLook(live?.config ?? configOf(brand.settings)));
  } else if (p.action === "restore") {
    const old = (
      await db.query<{ config: MessengerConfig }>(
        "SELECT config FROM messenger_versions WHERE workspace_id=$1 AND brand_id=$2 AND version=$3",
        [w, brand.id, Number(p.version)],
      )
    ).rows[0];
    assert(old, "VERSION_NOT_FOUND", "That version is unavailable.", 404);
    await setDraft(withLook(old.config));
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

/**
 * The published inbound rules for a customer (messenger M3), or null when drafts are off or
 * nothing is published: the server enforces these, not just the messenger.
 */
export async function inboundRules(
  db: Sql,
  w: string,
  settings: Record<string, unknown>,
  verified: boolean,
): Promise<Inbound | null> {
  const m3 = settings.messenger3 as Partial<Extras> | undefined;
  if (!m3?.audiences || !(await messengerV3(db, w))) return null;
  return (
    m3.audiences[verified ? "users" : "visitors"]?.inbound ?? DEFAULT_INBOUND
  );
}
/** The published "for everyone" settings, or null when drafts are off or nothing is published. */
export async function generalOf(
  db: Sql,
  w: string,
  settings: Record<string, unknown>,
): Promise<General | null> {
  const m3 = settings.messenger3 as Partial<Extras> | undefined;
  if (!m3 || !(await messengerV3(db, w))) return null;
  return m3.general ?? DEFAULT_GENERAL;
}

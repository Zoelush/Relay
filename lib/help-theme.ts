/**
 * A help center's look and homepage (the November 2026 rebuild; docs/HELP_CENTER_DESIGN.md), as
 * data: everything "Configure and style" edits. Shared by the server (which checks it on save and
 * draws the pages from it) and the editor (which sends a draft of it to the live preview).
 *
 * - `themeOf` turns whatever is stored (or nothing, or the first design's `primaryColor`,
 *   `headerStyle` and `font`) into a complete theme; `checkTheme` does the same for input and
 *   refuses what it can't use, saying why.
 * - Images are ids of the help center's own uploads; whether each is one is the server's check.
 * - Text a visitor reads is kept per language (`Localized`); a missing language falls back along
 *   the help center's chain when drawn.
 */
export type Localized = Record<string, string>;
export type Background =
  | { type: "color"; color: string }
  | { type: "gradient"; colors: string[] }
  | { type: "image"; fileId: string };
export type NavLink = { title: string; url: string };
export type FooterLink = NavLink & { group: string };
export type Social = { platform: SocialPlatform; url: string };

/** The fonts on offer, each served by Relay itself (`public/help-fonts`); "system" loads nothing. */
export const FONTS = {
  system: { name: "System default", stack: 'system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif' },
  bitter: { name: "Bitter", stack: "Bitter,Georgia,serif" },
  inter: { name: "Inter", stack: "Inter,system-ui,sans-serif" },
  lato: { name: "Lato", stack: "Lato,system-ui,sans-serif" },
  lora: { name: "Lora", stack: "Lora,Georgia,serif" },
  montserrat: { name: "Montserrat", stack: "Montserrat,system-ui,sans-serif" },
  "open-sans": { name: "Open Sans", stack: '"Open Sans",system-ui,sans-serif' },
  oswald: { name: "Oswald", stack: "Oswald,system-ui,sans-serif" },
  "playfair-display": { name: "Playfair Display", stack: '"Playfair Display",Georgia,serif' },
  poppins: { name: "Poppins", stack: "Poppins,system-ui,sans-serif" },
  "noto-sans": { name: "Noto Sans", stack: '"Noto Sans",system-ui,sans-serif' },
  "noto-serif": { name: "Noto Serif", stack: '"Noto Serif",Georgia,serif' },
  raleway: { name: "Raleway", stack: "Raleway,system-ui,sans-serif" },
  roboto: { name: "Roboto", stack: "Roboto,system-ui,sans-serif" },
  "roboto-mono": { name: "Roboto Mono", stack: '"Roboto Mono",ui-monospace,monospace' },
  "roboto-slab": { name: "Roboto Slab", stack: '"Roboto Slab",Georgia,serif' },
} as const;
export type FontId = keyof typeof FONTS;
export const FONT_IDS = Object.keys(FONTS) as FontId[];

export const SOCIALS = {
  facebook: "Facebook",
  x: "X",
  instagram: "Instagram",
  linkedin: "LinkedIn",
  youtube: "YouTube",
  tiktok: "TikTok",
  github: "GitHub",
  discord: "Discord",
  threads: "Threads",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  pinterest: "Pinterest",
  twitch: "Twitch",
  mastodon: "Mastodon",
  bluesky: "Bluesky",
  website: "Website",
} as const;
export type SocialPlatform = keyof typeof SOCIALS;

export type HelpTheme = {
  /** Classic: search first, articles by collection. Modern: a left-hand navigation, like documentation. */
  template: "classic" | "modern";
  /* Shared elements */
  bodyBackground: string;
  actionColor: string;
  designStyle: "card" | "floating";
  radius: number;
  fontPrimary: FontId;
  fontSecondary: FontId;
  showAuthors: boolean;
  /* Header */
  logoFileId: string | null;
  pageTitle: Localized;
  headerLinks: Record<string, NavLink[]>;
  /** The header's own colour; null: it sits on the hero. */
  headerBackground: string | null;
  /* Hero block */
  welcome: Localized;
  heroBackground: Background;
  heroFade: boolean;
  heroText: string;
  heroHeight: number;
  searchLength: "short" | "medium" | "long";
  searchAlign: "left" | "center";
  searchPosition: "top" | "center" | "bottom";
  searchRadius: number;
  /* The collections section */
  collectionColumns: 1 | 2 | 3;
  collectionStyle: "classic" | "visual" | "compact";
  collectionDesign: "icons" | "images" | "none";
  iconColor: string;
  iconBackground: Background | null;
  /** With the images design: each collection's image, by collection id. */
  collectionImages: Record<string, string>;
  /* Collection page */
  showDescriptions: boolean;
  /* Article page */
  toc: boolean;
  related: boolean;
  markdown: boolean;
  /* Footer */
  footerLayout: "simple" | "classic" | "multilevel";
  footerLogoFileId: string | null;
  footerText: Localized;
  socials: Social[];
  footerLinks: Record<string, FooterLink[]>;
  footerBackground: string | null;
  footerTextColor: string | null;
  poweredBy: boolean;
  /* General */
  faviconFileId: string | null;
  socialImageFileId: string | null;
  /** Where a visitor who must sign in is sent; empty: the portal. */
  loginUrl: string;
};

export const LIMITS = {
  radius: [0, 24],
  heroHeight: [245, 600],
  searchRadius: [0, 30],
  headerLinks: 3,
  socials: 16,
  footerLinks: 24,
  articles: 12,
  line: 160,
} as const;

export const DEFAULT_ACTION = "#087a57";
export const DEFAULT_HELP_THEME: HelpTheme = {
  template: "classic",
  bodyBackground: "#f6f7f8",
  actionColor: DEFAULT_ACTION,
  designStyle: "card",
  radius: 14,
  fontPrimary: "system",
  fontSecondary: "system",
  showAuthors: false,
  logoFileId: null,
  pageTitle: {},
  headerLinks: {},
  headerBackground: null,
  welcome: {},
  heroBackground: { type: "gradient", colors: [DEFAULT_ACTION, "#054f39"] },
  heroFade: false,
  heroText: "#ffffff",
  heroHeight: 300,
  searchLength: "long",
  searchAlign: "left",
  searchPosition: "center",
  searchRadius: 12,
  collectionColumns: 3,
  collectionStyle: "classic",
  collectionDesign: "icons",
  iconColor: DEFAULT_ACTION,
  iconBackground: null,
  collectionImages: {},
  showDescriptions: true,
  toc: true,
  related: true,
  markdown: false,
  footerLayout: "simple",
  footerLogoFileId: null,
  footerText: {},
  socials: [],
  footerLinks: {},
  footerBackground: null,
  footerTextColor: null,
  poweredBy: true,
  faviconFileId: null,
  socialImageFileId: null,
  loginUrl: "",
};

/** The homepage's sections, in order. Collections are always there; the others are there when listed. */
export type LayoutBlock =
  /** Kept from the first design (the search box is the hero's now); drawn as nothing. */
  | { type: "search" }
  | { type: "collections" }
  /** The articles section: up to 12 chosen articles under a title. */
  | { type: "featured"; recordIds: string[]; title?: Localized; columns?: 1 | 2 | 3 }
  /** The content section: a title, a description and a button, to highlight something. */
  | { type: "content"; title: Localized; description: Localized; buttonLabel: Localized; buttonUrl: string; design: "card" | "full"; background: Background; textColor: string }
  /** The customer portal section: "Still need help?" with a link to the customer's requests. */
  | { type: "contact" };

export class ThemeError extends Error {}
const refuse = (message: string): never => {
  throw new ThemeError(message);
};

const HEX = /^#[0-9a-f]{6}$/i;
const LOCALE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;
const FILE = /^[A-Za-z0-9_-]{1,100}$/;

/** A darker (amount < 0) or lighter (amount > 0) shade of a #rrggbb colour. */
export function shade(hex: string, amount: number) {
  return (
    "#" +
    [1, 3, 5]
      .map((i) => {
        const c = parseInt(hex.slice(i, i + 2), 16);
        const to = amount >= 0 ? 255 : 0;
        return Math.round(c + (to - c) * Math.abs(amount))
          .toString(16)
          .padStart(2, "0");
      })
      .join("")
  );
}
/** Relative luminance (WCAG) of a #rrggbb colour, and the contrast of two. */
export function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
/** Black or white, whichever reads better on the colour. */
export const readableOn = (hex: string) => (contrast(hex, "#ffffff") >= contrast(hex, "#111111") ? "#ffffff" : "#111111");

type Raw = Record<string, unknown>;
const colour = (v: unknown, what: string) => (typeof v === "string" && HEX.test(v) ? v.toLowerCase() : refuse(`Choose a colour for ${what}, such as #087a57.`));
const optionalColour = (v: unknown, what: string) => (v === null || v === undefined || v === "" ? null : colour(v, what));
const oneOf = <T extends string | number>(v: unknown, options: readonly T[], what: string): T =>
  options.includes(v as T) ? (v as T) : refuse(`Choose ${what} from the list.`);
const within = (v: unknown, [min, max]: readonly [number, number], what: string) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) refuse(`${what} is between ${min} and ${max}.`);
  return Math.round(n);
};
const file = (v: unknown) => (v === null || v === undefined || v === "" ? null : typeof v === "string" && FILE.test(v) ? v : refuse("That image isn't valid. Upload it again."));
/** A web address a visitor may be sent to: https (or a mailto: address). */
export function linkUrl(v: unknown, what: string) {
  const t = typeof v === "string" ? v.trim() : "";
  if (t.length > 500) refuse(`Keep ${what} under 500 characters.`);
  if (/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(t)) return t;
  try {
    const u = new URL(t);
    if (u.protocol === "https:" && u.hostname.includes(".") && !u.username && !u.password) return u.toString();
  } catch {
    /* refused below */
  }
  return refuse(`Enter ${what} as an https address, such as https://example.com.`);
}
function localized(v: unknown, max: number, what: string): Localized {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) refuse(`${what} is one per language.`);
  const out: Localized = {};
  for (const [locale, line] of Object.entries(v as Raw)) {
    if (!LOCALE.test(locale) || typeof line !== "string") refuse(`${what} is one per language.`);
    const t = String(line).trim();
    if (t.length > max) refuse(`Keep ${what.toLowerCase()} under ${max} characters.`);
    if (/[\r\n\x00]/.test(t) && max <= 200) refuse(`Keep ${what.toLowerCase()} on one line.`);
    if (t) out[locale] = t;
  }
  return out;
}
export function background(v: unknown, what: string): Background {
  const b = (v ?? {}) as Raw;
  if (b.type === "color") return { type: "color", color: colour(b.color, what) };
  if (b.type === "gradient") {
    const colors = Array.isArray(b.colors) ? b.colors : [];
    if (colors.length < 2 || colors.length > 3) refuse(`A gradient for ${what} has two or three colours.`);
    return { type: "gradient", colors: colors.map((c) => colour(c, what)) };
  }
  if (b.type === "image") {
    const id = file(b.fileId);
    if (!id) refuse(`Upload an image for ${what}.`);
    return { type: "image", fileId: id! };
  }
  return refuse(`Choose a colour, a gradient or an image for ${what}.`);
}
function links<T extends NavLink>(v: unknown, max: number, what: string, each: (raw: Raw, link: NavLink) => T): Record<string, T[]> {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) refuse(`${what} are kept per language.`);
  const out: Record<string, T[]> = {};
  for (const [locale, list] of Object.entries(v as Raw)) {
    if (!LOCALE.test(locale) || !Array.isArray(list)) refuse(`${what} are kept per language.`);
    if ((list as unknown[]).length > max) refuse(`Add up to ${max} ${what.toLowerCase()}.`);
    const kept = (list as Raw[]).map((raw) => {
      const title = typeof raw?.title === "string" ? raw.title.trim() : "";
      if (!title || title.length > 60) refuse(`Give each of the ${what.toLowerCase()} a title of up to 60 characters.`);
      return each(raw, { title, url: linkUrl(raw.url, "each link") });
    });
    if (kept.length) out[locale] = kept;
  }
  return out;
}

/**
 * The first design's theme (`primaryColor`, `headerStyle`, `font`) as this one's fields, so a help
 * center saved before the rebuild looks as it did.
 */
function fromFirstDesign(t: Raw): Raw {
  if (t.actionColor !== undefined || typeof t.primaryColor !== "string" || !HEX.test(t.primaryColor)) return t;
  const primary = t.primaryColor.toLowerCase();
  const light = t.headerStyle === "light";
  return {
    ...t,
    actionColor: primary,
    iconColor: primary,
    heroBackground: light ? { type: "color", color: "#f6f7f8" } : { type: "gradient", colors: [primary, shade(primary, -0.35)] },
    heroText: light ? "#161a1d" : readableOn(primary),
    ...(t.font === "serif" ? { fontPrimary: "noto-serif", fontSecondary: "noto-serif" } : t.font === "rounded" ? { fontPrimary: "poppins", fontSecondary: "poppins" } : {}),
  };
}

/** Input as a complete theme, on top of `current`; refuses what it can't use (`ThemeError`). */
export function checkTheme(input: unknown, current: HelpTheme = DEFAULT_HELP_THEME): HelpTheme {
  if (input === undefined || input === null) return current;
  if (typeof input !== "object" || Array.isArray(input)) refuse("The theme isn't valid.");
  const t = { ...current, ...fromFirstDesign(input as Raw) } as Raw;
  const socials = Array.isArray(t.socials) ? (t.socials as Raw[]) : refuse("Social links are a list.");
  if (socials.length > LIMITS.socials) refuse(`Add up to ${LIMITS.socials} social links.`);
  const images = (t.collectionImages ?? {}) as Raw;
  if (typeof images !== "object" || Array.isArray(images) || Object.keys(images).length > 200) refuse("Collection images aren't valid.");
  const loginUrl = typeof t.loginUrl === "string" && t.loginUrl.trim() ? linkUrl(t.loginUrl, "the sign-in page") : "";
  return {
    template: oneOf(t.template, ["classic", "modern"] as const, "a template"),
    bodyBackground: colour(t.bodyBackground, "the page background"),
    actionColor: colour(t.actionColor, "buttons and links"),
    designStyle: oneOf(t.designStyle, ["card", "floating"] as const, "a design style"),
    radius: within(t.radius, LIMITS.radius, "The corner radius"),
    fontPrimary: oneOf(t.fontPrimary, FONT_IDS, "a font"),
    fontSecondary: oneOf(t.fontSecondary, FONT_IDS, "a font"),
    showAuthors: t.showAuthors === true,
    logoFileId: file(t.logoFileId),
    pageTitle: localized(t.pageTitle, 80, "The page title"),
    headerLinks: links(t.headerLinks, LIMITS.headerLinks, "Header links", (_raw, link) => link),
    headerBackground: optionalColour(t.headerBackground, "the header"),
    welcome: localized(t.welcome, LIMITS.line, "The welcome line"),
    heroBackground: background(t.heroBackground, "the hero"),
    heroFade: t.heroFade === true,
    heroText: colour(t.heroText, "the hero's text"),
    heroHeight: within(t.heroHeight, LIMITS.heroHeight, "The hero's height"),
    searchLength: oneOf(t.searchLength, ["short", "medium", "long"] as const, "a search bar length"),
    searchAlign: oneOf(t.searchAlign, ["left", "center"] as const, "a search bar alignment"),
    searchPosition: oneOf(t.searchPosition, ["top", "center", "bottom"] as const, "a search bar position"),
    searchRadius: within(t.searchRadius, LIMITS.searchRadius, "The search bar's corner radius"),
    collectionColumns: oneOf(Number(t.collectionColumns), [1, 2, 3] as const, "one, two or three columns"),
    collectionStyle: oneOf(t.collectionStyle, ["classic", "visual", "compact"] as const, "a card style"),
    collectionDesign: oneOf(t.collectionDesign, ["icons", "images", "none"] as const, "icons, images or neither"),
    iconColor: colour(t.iconColor, "icons"),
    iconBackground: t.iconBackground === null || t.iconBackground === undefined ? null : background(t.iconBackground, "the icons' background"),
    collectionImages: Object.fromEntries(
      Object.entries(images)
        .filter(([, v]) => v)
        .map(([k, v]) => [FILE.test(k) ? k : refuse("Collection images aren't valid."), file(v)!]),
    ),
    showDescriptions: t.showDescriptions !== false,
    toc: t.toc !== false,
    related: t.related !== false,
    markdown: t.markdown === true,
    footerLayout: oneOf(t.footerLayout, ["simple", "classic", "multilevel"] as const, "a footer layout"),
    footerLogoFileId: file(t.footerLogoFileId),
    footerText: localized(t.footerText, 300, "The footer's text"),
    socials: socials.map((s) => ({ platform: oneOf(s?.platform, Object.keys(SOCIALS) as SocialPlatform[], "a social network"), url: linkUrl(s?.url, "each social link") })),
    footerLinks: links(t.footerLinks, LIMITS.footerLinks, "Footer links", (raw, link) => {
      const group = typeof raw.group === "string" ? raw.group.trim() : "";
      if (group.length > 40) refuse("Keep each footer group's name under 40 characters.");
      return { ...link, group };
    }),
    footerBackground: optionalColour(t.footerBackground, "the footer"),
    footerTextColor: optionalColour(t.footerTextColor, "the footer's text"),
    poweredBy: t.poweredBy !== false,
    faviconFileId: file(t.faviconFileId),
    socialImageFileId: file(t.socialImageFileId),
    loginUrl,
  };
}

/** What's stored as a complete theme; anything it can't use falls back to the default look. */
export function themeOf(stored: unknown): HelpTheme {
  try {
    return checkTheme(stored ?? {});
  } catch {
    try {
      // One bad field shouldn't lose the rest: keep what checks out, field by field.
      const raw = fromFirstDesign((stored ?? {}) as Raw);
      let theme = DEFAULT_HELP_THEME;
      for (const [k, v] of Object.entries(raw))
        try {
          theme = checkTheme({ [k]: v }, theme);
        } catch {
          /* that field keeps its default */
        }
      return theme;
    } catch {
      return DEFAULT_HELP_THEME;
    }
  }
}

/** Every image the theme and layout use, with what each is for (the server checks each one). */
export function themeFiles(theme: HelpTheme, layout: LayoutBlock[] = []) {
  const out: { id: string; purposes: string[] }[] = [];
  const add = (id: string | null | undefined, ...purposes: string[]) => {
    if (id) out.push({ id, purposes });
  };
  add(theme.logoFileId, "theme_logo");
  add(theme.footerLogoFileId, "theme_logo", "theme_image");
  add(theme.faviconFileId, "theme_favicon");
  add(theme.socialImageFileId, "social_image");
  if (theme.heroBackground.type === "image") add(theme.heroBackground.fileId, "theme_image");
  if (theme.iconBackground?.type === "image") add(theme.iconBackground.fileId, "theme_image");
  for (const id of Object.values(theme.collectionImages)) add(id, "theme_image");
  for (const b of layout) if (b.type === "content" && b.background.type === "image") add(b.background.fileId, "theme_image");
  return out;
}

/** A content section as input; refuses what it can't use. */
export function checkContent(raw: Record<string, unknown>): Extract<LayoutBlock, { type: "content" }> {
  const buttonLabel = localized(raw.buttonLabel, 40, "The button's label");
  const buttonUrl = typeof raw.buttonUrl === "string" && raw.buttonUrl.trim() ? linkUrl(raw.buttonUrl, "the button's link") : "";
  if (Object.keys(buttonLabel).length && !buttonUrl) refuse("Give the content section's button a link.");
  return {
    type: "content",
    title: localized(raw.title, 120, "The content section's title"),
    description: localized(raw.description, 600, "The content section's description"),
    buttonLabel,
    buttonUrl,
    design: oneOf(raw.design ?? "card", ["card", "full"] as const, "card or full width"),
    background: background(raw.background ?? { type: "color", color: "#ffffff" }, "the content section"),
    textColor: colour(raw.textColor ?? "#161a1d", "the content section's text"),
  };
}
export const sectionTitle = (v: unknown) => localized(v, 80, "The section's title");

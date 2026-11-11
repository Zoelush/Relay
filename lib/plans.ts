/**
 * The plan policy (phase 16, step C8a; docs/SECURITY_STEP14.md): Relay's tiers, the features and
 * limits each has beyond Starter, and the seat prices. This is data; the only code that reads it
 * to decide anything is `server/plans.ts` (a test fails on a plan check elsewhere). The Plan page
 * shows it.
 *
 * Every plan has the inbox, messenger, email, a help center, tickets, macros, reports, Zoe (billed
 * per resolution), the API, data requests (a legal duty), two-factor, the audit log and the health
 * check: those aren't gated.
 */
export const PLAN_IDS = ["starter", "pro", "enterprise"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

/** Features beyond Starter, in plain words (`plural`: whether the label takes "are"). */
export const FEATURES = {
  workflows: { label: "Workflows", plan: "pro", plural: true },
  slas: { label: "SLAs and office hours", plan: "pro", plural: true },
  routing: { label: "Routing, teams and workload", plan: "pro", plural: false },
  outbound: { label: "Outbound messages and segments", plan: "pro", plural: true },
  channels: { label: "WhatsApp, SMS, Meta, voice, Slack and Discord", plan: "pro", plural: false },
  custom_roles: { label: "Custom roles", plan: "pro", plural: true },
  data_connectors: { label: "Zoe's data connectors and actions", plan: "pro", plural: true },
  sso: { label: "Single sign-on (OIDC and SAML)", plan: "enterprise", plural: false },
  ip_allowlists: { label: "IP allowlists", plan: "enterprise", plural: true },
  restricted_roles: { label: "Restricted roles", plan: "enterprise", plural: true },
  retention: { label: "Retention policies", plan: "enterprise", plural: true },
  redaction: { label: "Content redaction", plan: "enterprise", plural: false },
  support_access: { label: "Relay support access", plan: "enterprise", plural: false },
} as const satisfies Record<string, { label: string; plan: Exclude<PlanId, "starter">; plural: boolean }>;
export type Feature = keyof typeof FEATURES;

/**
 * Product features have rollout flags too; a flag and the plan must both allow them (`featureOn`).
 * Security features have no flag: a lower plan refuses changes, but what's configured keeps applying.
 */
export const FLAG_FEATURE: Record<string, Feature> = {
  workflows_v1: "workflows",
  sla_v1: "slas",
  routing_v1: "routing",
  outbound_v1: "outbound",
  segments_v1: "outbound",
  ai_actions_v1: "data_connectors",
  channel_whatsapp_v1: "channels",
  channel_sms_v1: "channels",
  channel_voice_v1: "channels",
  channel_facebook_v1: "channels",
  channel_instagram_v1: "channels",
  channel_slack_v1: "channels",
  channel_discord_v1: "channels",
};

export const LIMITS = {
  brands: { label: "Brands", of: { starter: 1, pro: 3, enterprise: null } },
  help_centers: { label: "Help centers", of: { starter: 1, pro: 3, enterprise: null } },
} as const satisfies Record<string, { label: string; of: Record<PlanId, number | null> }>;
export type Limit = keyof typeof LIMITS;

/**
 * Prices per full seat, in cents (USD). `null` is a placeholder: prices are set before launch, and
 * `npm run check:plans` (and `npm test`) fail while one remains with RELAY_BILLING_LIVE=true.
 * Limited seats are free on every plan (C8b).
 */
export const PLANS: Record<PlanId, { name: string; summary: string; monthlyCents: number | null; annualMonthlyCents: number | null }> = {
  starter: { name: "Starter", summary: "The inbox, messenger, email, a help center, tickets, reports and Zoe.", monthlyCents: null, annualMonthlyCents: null },
  pro: { name: "Pro", summary: "Automation, every channel and outbound, for growing teams.", monthlyCents: null, annualMonthlyCents: null },
  enterprise: { name: "Enterprise", summary: "Single sign-on, allowlists and data controls, for regulated teams.", monthlyCents: null, annualMonthlyCents: null },
};

/**
 * Phase 16 C9a: each meter's price per unit, in cents (USD), on every plan. `null` is a placeholder,
 * set before launch (`check:plans`). Fractions of a cent are allowed (an SMS segment).
 */
export const UNIT_PRICES: Record<import("./meters").MeterId, number | null> = {
  ai_resolutions: null,
  // Phase 16 C9d: lower than ai_resolutions (the workspace pays its provider); a placeholder too.
  ai_resolutions_own_key: null,
  emails: null,
  whatsapp: null,
  sms_segments: null,
  phone_minutes: null,
  outbound_chats: null,
  outbound_banners: null,
  connector_calls: null,
};

const RANK: Record<PlanId, number> = { starter: 0, pro: 1, enterprise: 2 };
/** Whether a plan includes a feature. */
export const includes = (plan: PlanId, feature: Feature) => RANK[plan] >= RANK[FEATURES[feature].plan];
/** The plan's number for a limit; null is unlimited. */
export const limitOf = (plan: PlanId, limit: Limit) => LIMITS[limit].of[plan];
/** Prices still to be set before launch. */
export const placeholders = () => [
  ...PLAN_IDS.flatMap((id) => [PLANS[id].monthlyCents === null ? `${id}.monthlyCents` : null, PLANS[id].annualMonthlyCents === null ? `${id}.annualMonthlyCents` : null]),
  ...Object.entries(UNIT_PRICES).map(([meter, cents]) => (cents === null ? `UNIT_PRICES.${meter}` : null)),
].filter((x): x is string => !!x);

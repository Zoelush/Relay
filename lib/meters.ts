/**
 * The meters (phase 16, step C9a; docs/SECURITY_STEP16.md): every billable unit, what it's read
 * from, and what counts. `server/meters.ts` reads each from its source record for a billing period;
 * meters never count (nothing is written). Unit prices are in the plan policy (`lib/plans.ts`).
 */
export const METERS = {
  ai_resolutions: { label: "AI resolutions", noun: "AI resolutions", unit: "resolution", source: "Zoe's resolution ledger, net of reversals, answered with Relay's AI" },
  // Phase 16 C9d: answered with the workspace's own AI provider, at their own price.
  ai_resolutions_own_key: {
    label: "AI resolutions on your own AI key",
    noun: "AI resolutions on your own AI key",
    unit: "resolution",
    source: "Zoe's resolution ledger, net of reversals, answered with the workspace's own AI provider",
  },
  emails: { label: "Emails sent", noun: "emails", unit: "email", source: "Email deliveries sent (failed and suppressed are free)" },
  whatsapp: { label: "WhatsApp messages sent", noun: "WhatsApp messages", unit: "message", source: "WhatsApp deliveries sent" },
  sms_segments: { label: "SMS segments sent", noun: "SMS segments", unit: "segment", source: "SMS deliveries sent, counted in segments" },
  phone_minutes: { label: "Phone minutes", noun: "phone minutes", unit: "minute", source: "Completed calls, each rounded up to the minute" },
  outbound_chats: { label: "Outbound chats", noun: "outbound chats", unit: "message", source: "Outbound chat messages sent" },
  outbound_banners: { label: "Outbound banners", noun: "outbound banners", unit: "banner", source: "Outbound banners shown" },
  connector_calls: { label: "Connector calls", noun: "connector calls", unit: "call", source: "Calls by Zoe or a workflow that succeeded (tests are free)" },
} as const satisfies Record<string, { label: string; noun: string; unit: string; source: string }>;
export type MeterId = keyof typeof METERS;
export const METER_IDS = Object.keys(METERS) as MeterId[];

/** One unit, traced to where it came from. */
export type Unit = { id: string; at: string; quantity: number; conversationId: string | null; contactId: string | null; detail: string };

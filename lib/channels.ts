/**
 * What a channel can do (phase 12, step E1; docs/OMNICHANNEL_STEP1.md), shared by the server's
 * adapters (`server/channels.ts`), the composer and the inbox. Nothing outside the adapters asks
 * which channel a conversation is on: it asks what the channel can do.
 */
export type Capabilities = {
  /** Formatting kept (else replies go as plain text). */
  richText: boolean;
  attachments: boolean;
  /** Reply buttons shown as buttons (else the adapter writes them out). */
  buttons: boolean;
  /** The longest message it takes, in characters. */
  maxLength: number;
  /** How long after the customer's last message a free-form reply may be sent (hours), if limited. */
  windowHours: number | null;
  /** Whether Zoe may answer on it. */
  ai: boolean;
  /** What the provider reports back: up to "delivered", or "read". */
  receipts: "none" | "delivered" | "read";
  /** What a customer's address is on it, for the suppression list and identities. */
  address: "session" | "email" | "phone" | "account";
  /** E4: a reply can copy others in (Cc and Bcc). */
  copies?: boolean;
};

/** Channels Relay has, by id. TODO(phase 12 E7–E9): Instagram, Facebook, Slack, Discord, voice. */
export const CHANNEL_LABELS: Record<string, string> = {
  messenger: "Messenger",
  email: "Email",
  whatsapp: "WhatsApp",
  sms: "SMS",
};
export const channelLabel = (id: string) => CHANNEL_LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1);

/** Delivery states, in the order they progress. */
export const DELIVERY_STATES = ["held", "queued", "sent", "delivered", "read", "failed", "suppressed"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATES)[number];
export const DELIVERY_LABELS: Record<DeliveryStatus, string> = {
  // E4: Zoe's draft on email, waiting for a teammate to send or discard it.
  held: "Waiting for a teammate's approval",
  queued: "Sending",
  sent: "Sent",
  delivered: "Delivered",
  read: "Read",
  failed: "Not delivered",
  suppressed: "Not sent: the address is suppressed",
};

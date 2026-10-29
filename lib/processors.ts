/**
 * Where customer data goes outside Relay (phase 16, step C5b; docs/SECURITY_STEP8.md): one
 * registry, shown on Settings › Security › Data requests and copied into every deletion
 * certificate. A new outside service that receives anything about a customer gets its entry here.
 *
 * - `relay-deletes`: Relay deletes the person there, through its API, as part of a deletion.
 * - `not-kept`: the service processes the data and keeps none of it.
 * - `provider-policy`: the provider keeps it for a while under its own terms; Relay can't delete one person there.
 * - `workspace-destination`: somewhere the workspace chose to send data (its own systems, apps or community);
 *   deleting it there is the workspace's to do.
 */
export type Deletion = "relay-deletes" | "not-kept" | "provider-policy" | "workspace-destination";
export type Processor = { id: string; name: string; receives: string; when: string; keeps: string; deletion: Deletion };

export const PROCESSORS: Processor[] = [
  {
    id: "twilio",
    name: "Twilio",
    receives: "Text messages sent and received, and calls (their recordings when recording is on)",
    when: "SMS and voice channels",
    keeps: "Message records and recordings, until deleted",
    deletion: "relay-deletes",
  },
  {
    id: "model-provider",
    name: "Anthropic (Claude)",
    receives: "Customer messages Zoe answers, with personal data redacted when the setting is on",
    when: "Zoe, the AI agent",
    keeps: "Under Anthropic's API data retention terms",
    deletion: "provider-policy",
  },
  {
    id: "workers-ai",
    name: "Cloudflare Workers AI",
    receives: "Knowledge content to embed, customers' questions to search it with, and call audio to transcribe",
    when: "Zoe's knowledge search, and call transcription",
    keeps: "Nothing after answering",
    deletion: "not-kept",
  },
  {
    id: "ses",
    name: "Amazon SES",
    receives: "Emails Relay sends to customers",
    when: "Email channel",
    keeps: "Sending and delivery events under Amazon's terms (not the email's content once delivered)",
    deletion: "provider-policy",
  },
  {
    id: "meta",
    name: "Meta (WhatsApp, Instagram, Messenger)",
    receives: "Messages sent and received on those channels",
    when: "WhatsApp, Instagram and Facebook Messenger channels",
    keeps: "Under Meta's terms; messages stay in the customer's own app",
    deletion: "provider-policy",
  },
  {
    id: "community",
    name: "Slack and Discord",
    receives: "Messages in the workspace's connected community spaces",
    when: "Slack and Discord channels",
    keeps: "In the workspace's own Slack or Discord",
    deletion: "workspace-destination",
  },
  {
    id: "webhooks",
    name: "The workspace's webhooks",
    receives: "Event payloads for the topics each webhook subscribes to",
    when: "Settings › Developers › Webhooks",
    keeps: "In the workspace's own systems",
    deletion: "workspace-destination",
  },
  {
    id: "connectors",
    name: "The workspace's data connectors and apps",
    receives: "The inputs each connector declares, and what installed apps read through the API",
    when: "Zoe's data connectors, Canvas and OAuth apps",
    keeps: "In the workspace's own systems or the app's",
    deletion: "workspace-destination",
  },
  {
    // Phase 16 C7a: link reputation (docs/SECURITY_STEP11.md).
    id: "safe-browsing",
    name: "Google Safe Browsing",
    receives: "The web addresses in customers' messages and emails (nothing else)",
    when: "Link safety, when Relay is deployed with a Safe Browsing key",
    keeps: "Under Google's Safe Browsing terms",
    deletion: "provider-policy",
  },
  {
    id: "hosting",
    name: "Cloudflare and Neon (Relay's hosting)",
    receives: "Everything Relay stores: the database, files and queued work",
    when: "Always",
    keeps: "Deleted with the person; PostgreSQL's point-in-time backups keep them until the backup window passes",
    deletion: "relay-deletes",
  },
];
export const DELETION_LABEL: Record<Deletion, string> = {
  "relay-deletes": "Deleted by Relay",
  "not-kept": "Not kept",
  "provider-policy": "Kept by the provider under its own terms",
  "workspace-destination": "The workspace's own destination",
};

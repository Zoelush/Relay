import { assert, DomainError, type Sql } from "./db";
import { authorize, can, type Capability } from "./policy";

/**
 * Settings (S1; docs/SETTINGS_STEP1.md). One area for everything a teammate or a workspace
 * manager can configure, behind `settings_v1`. This step holds the personal pages (your profile
 * and notifications) and the workspace's General page; the other pages either link to where a
 * feature is already managed (Knowledge, saved views) or arrive in S2 and S3.
 *
 * Personal settings follow the account, not the browser. Workspace settings need
 * `workspace.manage`. Every page a teammate may open is listed by `settingsOverview`, so the
 * client never offers a page the server would refuse.
 */
export type NotificationPrefs = { desktop: boolean; sound: boolean };
const invalid = (message: string): never => {
  throw new DomainError("INVALID_SETTINGS", message, 400);
};

export async function settingsEnabled(db: Sql, w: string) {
  return (
    (
      await db.query(
        "SELECT 1 FROM workspace_features WHERE workspace_id=$1 AND name='settings_v1' AND enabled",
        [w],
      )
    ).rows.length > 0
  );
}
export async function requireSettings(db: Sql, w: string) {
  assert(
    await settingsEnabled(db, w),
    "SETTINGS_DISABLED",
    "Settings are not enabled for this workspace.",
    404,
  );
}
const flag = async (db: Sql, w: string, name: string) =>
  (
    await db.query(
      "SELECT 1 FROM workspace_features WHERE workspace_id=$1 AND name=$2 AND enabled",
      [w, name],
    )
  ).rows.length > 0;

/** A valid IANA timezone, such as Europe/London. */
export function validTimezone(value: unknown) {
  if (typeof value !== "string" || !value || value.length > 64)
    return invalid("Choose a timezone, such as Europe/London.");
  try {
    return new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions()
      .timeZone;
  } catch {
    return invalid("Choose a timezone, such as Europe/London.");
  }
}
/** A language tag for the team's language, such as en or pt-BR. */
export function validLanguage(value: unknown) {
  if (typeof value !== "string" || value.length < 2 || value.length > 35)
    return invalid("Choose a language.");
  try {
    return Intl.getCanonicalLocales(value)[0];
  } catch {
    return invalid("Choose a language.");
  }
}
const name = (value: unknown, what: string) => {
  const v = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!v || v.length > 80)
    invalid(`Give ${what} a name of up to 80 characters.`);
  return v;
};
const prefs = (value: unknown): NotificationPrefs => {
  const v = (value ?? {}) as Partial<NotificationPrefs>;
  return { desktop: v.desktop === true, sound: v.sound === true };
};

/**
 * The pages this teammate may open, by id. Personal pages are everyone's; the rest follow the
 * permission (and flag) of what they configure.
 */
export async function settingsOverview(db: Sql, w: string, principal: string) {
  await authorize(db, w, principal, "conversations.read");
  await requireSettings(db, w);
  const has = (c: Capability) => can(db, w, principal, c);
  const knowledge = await flag(db, w, "knowledge_v1");
  const manageKnowledge = knowledge && (await has("knowledge.manage"));
  const pages: string[] = ["profile", "notifications", "appearance"];
  if (await has("workspace.manage")) pages.push("general");
  // People (S3a): teammates' roles, and the roles themselves.
  if (await has("teammates.manage")) pages.push("teammates", "roles");
  const manage = await has("workspace.manage");
  // Helpdesk (S2a): teams and routing, office hours and SLAs, each with its feature.
  if (manage && (await flag(db, w, "routing_v1"))) pages.push("teams");
  if (manage && (await flag(db, w, "sla_v1")))
    pages.push("office-hours", "slas");
  // Helpdesk data (S2b): tags and conversation attributes; ticket types with tickets.
  if (manage) pages.push("tags", "attributes");
  if ((await flag(db, w, "tickets_v1")) && (await has("tickets.manage")))
    pages.push("ticket-types");
  // Channels (S3b): brands, each brand's messenger, and the customer portal.
  if (manage) {
    pages.push("brands");
    if (await flag(db, w, "messenger_v2")) pages.push("messenger");
    if (await flag(db, w, "portal_v1")) pages.push("portal");
  }
  if (await has("macros.use")) pages.push("macros");
  if (await flag(db, w, "agent_inbox_views_v1")) pages.push("views");
  if (manageKnowledge) {
    pages.push("help-centers");
    if (await flag(db, w, "knowledge_sync_v1")) pages.push("websites");
    if (await flag(db, w, "knowledge_index_v1")) pages.push("ai-index");
    if (await flag(db, w, "knowledge_health_v1")) pages.push("content-health");
  }
  // TODO(phase 16): security, audit log, usage and billing. TODO(phase 15): API keys and
  // webhooks. TODO(phase 12): email and other channels. TODO(phase 08): the AI agent.
  return { pages };
}

export async function readSettings(
  db: Sql,
  w: string,
  principal: string,
  section: string,
) {
  await requireSettings(db, w);
  if (section === "profile") {
    const t = await authorize(db, w, principal, "conversations.read");
    const row = (
      await db.query<{
        name: string;
        timezone: string | null;
        signature: string;
        notification_prefs: unknown;
        role: string;
      }>(
        `SELECT t.name,t.timezone,t.signature,t.notification_prefs,r.name AS role FROM teammates t
         JOIN roles r ON r.workspace_id=t.workspace_id AND r.id=t.role_id WHERE t.workspace_id=$1 AND t.id=$2`,
        [w, t.id],
      )
    ).rows[0];
    return {
      name: row.name,
      role: row.role,
      timezone: row.timezone,
      signature: row.signature,
      notifications: prefs(row.notification_prefs),
    };
  }
  if (section === "general") {
    await authorize(db, w, principal, "workspace.manage");
    const row = (
      await db.query<{
        brand: string;
        timezone: string | null;
        locale: string | null;
        teammates: string;
        contacts: string;
        conversations: string;
      }>(
        `SELECT w.brand,w.timezone,w.locale,
          (SELECT count(*) FROM teammates WHERE workspace_id=w.id)::text AS teammates,
          (SELECT count(*) FROM contacts WHERE workspace_id=w.id AND merged_into_contact_id IS NULL)::text AS contacts,
          (SELECT count(*) FROM conversations WHERE workspace_id=w.id AND merged_into_id IS NULL)::text AS conversations
         FROM workspace w WHERE w.id=$1`,
        [w],
      )
    ).rows[0];
    return {
      id: w,
      name: row.brand,
      timezone: row.timezone ?? "UTC",
      language: row.locale ?? "en",
      counts: {
        teammates: Number(row.teammates),
        contacts: Number(row.contacts),
        conversations: Number(row.conversations),
      },
    };
  }
  return invalid("Choose a settings page.");
}

export async function saveSettings(
  db: Sql,
  w: string,
  principal: string,
  p: Record<string, unknown>,
) {
  await requireSettings(db, w);
  if (p.section === "profile") {
    const t = await authorize(db, w, principal, "conversations.read");
    const signature =
      typeof p.signature === "string"
        ? p.signature.replace(/\r\n/g, "\n").trim()
        : "";
    if (signature.length > 1000)
      invalid("Keep your signature to 1,000 characters.");
    await db.query(
      "UPDATE teammates SET name=$3,timezone=$4,signature=$5 WHERE workspace_id=$1 AND id=$2",
      [
        w,
        t.id,
        name(p.name, "yourself"),
        p.timezone === null || p.timezone === ""
          ? null
          : validTimezone(p.timezone),
        signature,
      ],
    );
    return readSettings(db, w, principal, "profile");
  }
  if (p.section === "notifications") {
    const t = await authorize(db, w, principal, "conversations.read");
    await db.query(
      "UPDATE teammates SET notification_prefs=$3 WHERE workspace_id=$1 AND id=$2",
      [w, t.id, JSON.stringify(prefs(p.notifications))],
    );
    return readSettings(db, w, principal, "profile");
  }
  if (p.section === "general") {
    await authorize(db, w, principal, "workspace.manage");
    await db.query(
      "UPDATE workspace SET brand=$2,timezone=$3,locale=$4 WHERE id=$1",
      [
        w,
        name(p.name, "the workspace"),
        validTimezone(p.timezone),
        validLanguage(p.language),
      ],
    );
    return readSettings(db, w, principal, "general");
  }
  return invalid("Choose a settings page.");
}

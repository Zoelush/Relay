import type { Sql } from "./db";
import { ticketContext } from "./tickets";
import { slaContext } from "./sla";
import { authorize, can } from "./policy";
import { access, conversation } from "./conversations";
import { resolveContact } from "./people";
import type { AppCard } from "../lib/app-slots";

/** Recent conversations shown for the customer, besides the open one. */
const RECENT_LIMIT = 5;

/**
 * Everything the context sidebar shows for a conversation: the customer (resolved through
 * merges), participants, the customer's other recent conversations, conversation attributes
 * and app cards. Personal data (names, emails, phones, external id, profile) is included only
 * for teammates with `contacts.personal_data`; customer type, times and timezone always are.
 */
export async function conversationContext(
  db: Sql,
  w: string,
  principal: string,
  conversationId: string,
) {
  await authorize(db, w, principal, "conversations.read");
  const c = await conversation(db, w, conversationId);
  await access(db, w, c, { type: "teammate", principal });
  const personal = await can(db, w, principal, "contacts.personal_data");
  const mapped = c.primary_identity_id
    ? (
        await db.query<{ contact_id: string }>(
          "SELECT contact_id FROM identity_contact_mappings WHERE workspace_id=$1 AND identity_id=$2",
          [w, c.primary_identity_id],
        )
      ).rows[0]?.contact_id
    : undefined;
  const contactId = mapped ? await resolveContact(db, w, mapped) : undefined;
  const contact = contactId
    ? (
        await db.query<{
          id: string;
          role: string;
          name: string;
          external_id: string | null;
          profile: Record<string, unknown>;
          first_seen_at: string;
          last_seen_at: string;
          signed_up_at: string | null;
          origin_timezone: string | null;
          global_unsubscribe: boolean;
        }>(
          "SELECT id,role,name,external_id,profile,first_seen_at,last_seen_at,signed_up_at,origin_timezone,global_unsubscribe FROM contacts WHERE workspace_id=$1 AND id=$2",
          [w, contactId],
        )
      ).rows[0]
    : undefined;
  // The customer's whole merged family: the surviving contact and every contact merged into it.
  const family = contact
    ? (
        await db.query<{ id: string }>(
          `WITH RECURSIVE family AS (SELECT id FROM contacts WHERE workspace_id=$1 AND id=$2
          UNION SELECT k.id FROM contacts k JOIN family f ON k.merged_into_contact_id=f.id WHERE k.workspace_id=$1)
          SELECT id FROM family`,
          [w, contact.id],
        )
      ).rows.map((r) => r.id)
    : [];
  const list = async (
    table: "contact_emails" | "contact_phones",
    column: "email" | "phone",
  ) =>
    personal && family.length
      ? (
          await db.query<{ value: string; verified: boolean }>(
            `SELECT DISTINCT ${column} AS value,verified FROM ${table} WHERE workspace_id=$1 AND contact_id=ANY($2::text[]) ORDER BY verified DESC,value`,
            [w, family],
          )
        ).rows
      : [];
  const recent = family.length
    ? (
        await db.query(
          `SELECT DISTINCT c.id,c.title,c.status,c.updated_at AS "updatedAt" FROM conversations c
          JOIN identity_contact_mappings m ON m.workspace_id=c.workspace_id AND m.identity_id=c.primary_identity_id
          WHERE c.workspace_id=$1 AND m.contact_id=ANY($2::text[]) AND c.id<>$3 AND c.merged_into_id IS NULL
          ORDER BY c.updated_at DESC,c.id LIMIT $4`,
          [w, family, c.id, RECENT_LIMIT],
        )
      ).rows
    : [];
  const participants = (
    await db.query<{
      contact_id: string | null;
      name: string | null;
      role: string | null;
    }>(
      `SELECT m.contact_id,k.name,k.role FROM conversation_participants p
      LEFT JOIN identity_contact_mappings m ON m.workspace_id=p.workspace_id AND m.identity_id=p.identity_id
      LEFT JOIN contacts k ON k.workspace_id=m.workspace_id AND k.id=m.contact_id
      WHERE p.workspace_id=$1 AND p.conversation_id=$2 ORDER BY k.name NULLS LAST,m.contact_id`,
      [w, c.id],
    )
  ).rows.map((p) => ({
    role: p.role ?? "visitor",
    ...(personal ? { name: p.name ?? "" } : {}),
  }));
  const attributes = (
    await db.query<{
      id: string;
      name: string;
      value_type: string;
      options: string[] | null;
    }>(
      // Ticket fields are shown with the ticket, not with the general attributes.
      "SELECT id,name,value_type,options FROM attribute_definitions a WHERE workspace_id=$1 AND owner_type='conversation' AND archived_at IS NULL AND NOT EXISTS(SELECT 1 FROM ticket_type_attributes f WHERE f.workspace_id=a.workspace_id AND f.attribute_id=a.id) ORDER BY name,id",
      [w],
    )
  ).rows.map((a) => ({
    id: a.id,
    name: a.name,
    valueType: a.value_type,
    options: a.options ?? [],
    value: (c.attributes as Record<string, unknown>)[a.id] ?? null,
  }));
  // TODO(phase 1): company and custom object cards, once the people service has them.
  // TODO(phase 15): app cards come from installed apps through lib/app-slots.ts.
  const apps: AppCard[] = [];
  return {
    personalData: personal,
    customer: contact
      ? {
          id: contact.id,
          role: contact.role,
          firstSeenAt: contact.first_seen_at,
          lastSeenAt: contact.last_seen_at,
          signedUpAt: contact.signed_up_at,
          timezone: contact.origin_timezone,
          unsubscribed: contact.global_unsubscribe,
          ...(personal
            ? {
                name: contact.name,
                externalId: contact.external_id,
                emails: await list("contact_emails", "email"),
                phones: await list("contact_phones", "phone"),
              }
            : {}),
        }
      : null,
    participants,
    recent,
    attributes,
    canEditAttributes: await can(db, w, principal, "conversations.manage"),
    tickets: await ticketContext(db, w, c),
    sla: await slaContext(db, w, c),
    apps,
  };
}

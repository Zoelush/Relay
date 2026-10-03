import { assert, digest, type Sql } from "./db";
import { capabilities } from "./policy";
import { wrapIdentityKey } from "./identity";
import { refreshIdentityUnread } from "./unread";

export async function seedFoundation(
  db: Sql,
  workspace: string,
  owner: string,
  options: {
    origins: string[];
    master: string;
    identitySecret: Uint8Array;
    enable?: boolean;
  },
) {
  await db.query(
    `INSERT INTO workspace(id,workspace_id,owner_id,brand,greeting,color,availability,timezone,locale) VALUES($1,$1,$2,'Relay','How can we help?','#087a57','', 'UTC','en') ON CONFLICT DO NOTHING`,
    [workspace, owner],
  );
  for (const role of ["owner", "admin", "agent"]) {
    await db.query(
      "INSERT INTO roles(workspace_id,id,name) VALUES($1,$2,$2) ON CONFLICT DO NOTHING",
      [workspace, role],
    );
    for (const cap of capabilities.filter(
      (c) =>
        role !== "agent" ||
        [
          "conversations.reply",
          "conversations.note",
          "conversations.read",
          "conversations.manage",
          "contacts.personal_data",
          "macros.use",
        ].includes(c),
    ))
      await db.query(
        "INSERT INTO role_capabilities(workspace_id,role_id,capability) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [workspace, role, cap],
      );
  }
  await db.query(
    `INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES($1,'owner',$2,'Support teammate','owner') ON CONFLICT DO NOTHING`,
    [workspace, owner],
  );
  await db.query(
    "INSERT INTO brands(workspace_id,id,name,settings) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
    [
      workspace,
      "default",
      "Relay",
      JSON.stringify({
        allowedOrigins: options.origins,
        color: "#087a57",
        theme: "auto",
        position: "right",
        shape: "rounded",
        locale: "en",
        allowVisitors: true,
        requireSearch: false,
        directConversation: false,
        teamIntroduction: "Talk to our support team",
        outOfHours:
          "We are away. Leave a message and we will reply when we return.",
        officeHours: {
          timezone: "UTC",
          weekly: {
            "1": [["09:00", "17:00"]],
            "2": [["09:00", "17:00"]],
            "3": [["09:00", "17:00"]],
            "4": [["09:00", "17:00"]],
            "5": [["09:00", "17:00"]],
          },
        },
        homeBlocks: [{ type: "start" }, { type: "recent" }],
      }),
    ],
  );
  await db.query(
    "INSERT INTO identity_keys(workspace_id,kid,slot,wrapped_key) VALUES($1,$2,1,$3) ON CONFLICT DO NOTHING",
    [
      workspace,
      "initial",
      await wrapIdentityKey(
        options.identitySecret,
        options.master,
        workspace,
        "initial",
      ),
    ],
  );
  await db.query(
    "INSERT INTO business_calendars(workspace_id,id,version,timezone,schedule) SELECT workspace_id,'default',1,settings->'officeHours'->>'timezone',settings->'officeHours' FROM brands WHERE workspace_id=$1 AND id='default' ON CONFLICT DO NOTHING",
    [workspace],
  );
  await db.query(
    "UPDATE brands SET settings=settings||jsonb_build_object('calendarId','default','calendarVersion',1) WHERE workspace_id=$1 AND id='default' AND NOT settings ? 'calendarId'",
    [workspace],
  );
  // Named, so it can be listed and republished (migration 0024 named older ones the same way).
  await db.query(
    "INSERT INTO calendars(workspace_id,id,name,current_version) SELECT $1,'default','Office hours',1 WHERE EXISTS(SELECT 1 FROM business_calendars WHERE workspace_id=$1 AND id='default' AND version=1) ON CONFLICT DO NOTHING",
    [workspace],
  );
  for (const name of [
    "storage_postgres",
    "people_v1",
    "conversations_v1",
    "messenger_v2",
    "agent_inbox_v1",
  ])
    await db.query(
      "INSERT INTO workspace_features(workspace_id,name,enabled) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [workspace, name, options.enable ?? false],
    );
  for (const name of [
    "agent_inbox_views_v1",
    "tickets_v1",
    "sla_v1",
    "portal_v1",
    "routing_v1",
    "knowledge_v1",
    "help_center_v1",
    "knowledge_sync_v1",
    "knowledge_index_v1",
  ])
    await db.query(
      "INSERT INTO workspace_features(workspace_id,name,enabled) VALUES($1,$2,false) ON CONFLICT DO NOTHING",
      [workspace, name],
    );
}

export async function resolveContact(
  db: Sql,
  workspace: string,
  contactId: string,
): Promise<string> {
  const seen = new Set<string>();
  let id = contactId;
  while (!seen.has(id) && seen.size < 32) {
    seen.add(id);
    const row = (
      await db.query<{ merged_into_contact_id: string | null }>(
        "SELECT merged_into_contact_id FROM contacts WHERE workspace_id=$1 AND id=$2",
        [workspace, id],
      )
    ).rows[0];
    assert(row, "CONTACT_NOT_FOUND", "Contact unavailable.", 404);
    if (!row.merged_into_contact_id) return id;
    id = row.merged_into_contact_id;
  }
  throw new Error("Contact redirect cycle");
}
export async function getIdentity(
  db: Sql,
  workspace: string,
  kind: "anonymous" | "user",
  identifier: string,
  profile: { name?: string; email?: string } = {},
) {
  const hash = await digest(identifier);
  // A transaction-scoped advisory lock serializes creation across worker requests.
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    workspace + ":" + kind + ":" + hash,
  ]);
  const existing = (
    await db.query<{ id: string; contact_id: string }>(
      "SELECT i.id,m.contact_id FROM identities i JOIN identity_contact_mappings m ON m.workspace_id=i.workspace_id AND m.identity_id=i.id WHERE i.workspace_id=$1 AND i.kind=$2 AND i.identifier_hash=$3",
      [workspace, kind, hash],
    )
  ).rows[0];
  if (existing)
    return {
      identityId: existing.id,
      contactId: await resolveContact(db, workspace, existing.contact_id),
    };
  const contactId = crypto.randomUUID(),
    identityId = crypto.randomUUID();
  await db.query(
    "INSERT INTO contacts(workspace_id,id,role,name,external_id) VALUES($1,$2,$3,$4,$5)",
    [
      workspace,
      contactId,
      kind === "user" ? "user" : profile.email ? "lead" : "visitor",
      profile.name ?? "",
      kind === "user" ? identifier : null,
    ],
  );
  if (profile.email)
    await db.query(
      "INSERT INTO contact_emails(workspace_id,contact_id,email,verified) VALUES($1,$2,$3,$4)",
      [workspace, contactId, profile.email, kind === "user"],
    );
  await db.query(
    "INSERT INTO identities(workspace_id,id,kind,identifier_hash) VALUES($1,$2,$3,$4)",
    [workspace, identityId, kind, hash],
  );
  await db.query(
    "INSERT INTO identity_contact_mappings(workspace_id,identity_id,contact_id) VALUES($1,$2,$3)",
    [workspace, identityId, contactId],
  );
  return { identityId, contactId };
}
export async function mergeVisitorIdentity(
  db: Sql,
  workspace: string,
  identityId: string,
  survivor: string,
) {
  const mapping = (
    await db.query<{ contact_id: string; version: number }>(
      "SELECT contact_id,version FROM identity_contact_mappings WHERE workspace_id=$1 AND identity_id=$2 FOR UPDATE",
      [workspace, identityId],
    )
  ).rows[0];
  assert(mapping, "IDENTITY_NOT_FOUND", "Identity unavailable.", 404);
  survivor = await resolveContact(db, workspace, survivor);
  const loser = await resolveContact(db, workspace, mapping.contact_id);
  if (loser === survivor) return null;
  const rows = (
    await db.query<{
      id: string;
      role: string;
      profile: Record<string, unknown>;
      version: number;
    }>(
      "SELECT id,role,profile,version FROM contacts WHERE workspace_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE",
      [workspace, [loser, survivor]],
    )
  ).rows;
  const a = rows.find((r) => r.id === loser)!,
    b = rows.find((r) => r.id === survivor)!;
  assert(
    a.role !== "user" && b.role === "user",
    "MERGE_NOT_ALLOWED",
    "Only anonymous/lead identity can merge into a verified user.",
    409,
  );
  const after = { ...a.profile, ...b.profile }; // Existing survivor values, including false/0/empty, win.
  const changes = {
    identityId,
    mappingBefore: mapping,
    loserBefore: a,
    survivorBefore: b,
    survivorProfileAfter: after,
  };
  await db.query(
    "UPDATE identity_contact_mappings SET contact_id=$3,version=version+1 WHERE workspace_id=$1 AND identity_id=$2",
    [workspace, identityId, survivor],
  );
  await db.query(
    "UPDATE contacts SET merged_into_contact_id=$3,version=version+1 WHERE workspace_id=$1 AND id=$2",
    [workspace, loser, survivor],
  );
  await db.query(
    "UPDATE contacts SET profile=$3,version=version+1 WHERE workspace_id=$1 AND id=$2",
    [workspace, survivor, JSON.stringify(after)],
  );
  const id = crypto.randomUUID();
  await db.query(
    "INSERT INTO contact_merges(workspace_id,id,loser_id,survivor_id,changes) VALUES($1,$2,$3,$4,$5)",
    [
      workspace,
      id,
      loser,
      survivor,
      JSON.stringify({
        ...changes,
        mappingAfter: {
          contact_id: survivor,
          version: Number(mapping.version) + 1,
        },
        loserAfter: {
          merged_into_contact_id: survivor,
          version: Number(a.version) + 1,
        },
        survivorAfter: { profile: after, version: Number(b.version) + 1 },
      }),
    ],
  );
  await refreshIdentityUnread(db, workspace, identityId);
  return id;
}

/** No time limit: retained loser rows and the changelog make reversal non-destructive. */
export async function reverseContactMerge(
  db: Sql,
  workspace: string,
  id: string,
) {
  const audit = (
    await db.query<{
      id: string;
      loser_id: string;
      survivor_id: string;
      changes: {
        identityId: string;
        mappingBefore: { contact_id: string; version: number };
        mappingAfter: { contact_id: string; version: number };
        loserAfter: { version: number };
        survivorAfter: { profile: Record<string, unknown>; version: number };
        survivorBefore: { profile: Record<string, unknown>; version: number };
      };
      reversed_at: string | null;
    }>(
      "SELECT * FROM contact_merges WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
      [workspace, id],
    )
  ).rows[0];
  assert(audit, "MERGE_NOT_FOUND", "Merge unavailable.", 404);
  if (audit.reversed_at) return { id, reversed: true };
  const log = audit.changes;
  const mapping = (
    await db.query<{ contact_id: string; version: string }>(
      "SELECT contact_id,version FROM identity_contact_mappings WHERE workspace_id=$1 AND identity_id=$2 FOR UPDATE",
      [workspace, log.identityId],
    )
  ).rows[0];
  const contacts = (
    await db.query<{
      id: string;
      version: string;
      merged_into_contact_id: string | null;
      profile: unknown;
    }>(
      "SELECT id,version,merged_into_contact_id,profile FROM contacts WHERE workspace_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE",
      [workspace, [audit.loser_id, audit.survivor_id]],
    )
  ).rows;
  const loser = contacts.find((c) => c.id === audit.loser_id),
    survivor = contacts.find((c) => c.id === audit.survivor_id);
  assert(
    mapping?.contact_id === log.mappingAfter.contact_id &&
      String(mapping.version) === String(log.mappingAfter.version) &&
      loser?.merged_into_contact_id === audit.survivor_id &&
      String(loser.version) === String(log.loserAfter.version) &&
      String(survivor?.version) === String(log.survivorAfter.version) &&
      (await digest(survivor?.profile)) ===
        (await digest(log.survivorAfter.profile)),
    "MERGE_REVERSAL_CONFLICT",
    "Later edits changed the identity mapping or a contact. Review the merge changelog before resolving this conflict.",
    409,
  );
  await db.query(
    "UPDATE identity_contact_mappings SET contact_id=$3,version=version+1 WHERE workspace_id=$1 AND identity_id=$2",
    [workspace, log.identityId, log.mappingBefore.contact_id],
  );
  await db.query(
    "UPDATE contacts SET merged_into_contact_id=NULL,version=version+1 WHERE workspace_id=$1 AND id=$2",
    [workspace, audit.loser_id],
  );
  await db.query(
    "UPDATE contacts SET profile=$3,version=version+1 WHERE workspace_id=$1 AND id=$2",
    [workspace, audit.survivor_id, JSON.stringify(log.survivorBefore.profile)],
  );
  await db.query(
    "UPDATE contact_merges SET reversed_at=now(),changes=changes||jsonb_build_object('reversal',jsonb_build_object('mappingBefore',$3::jsonb,'survivorBefore',$4::jsonb,'restoredProfile',$5::jsonb)) WHERE workspace_id=$1 AND id=$2",
    [
      workspace,
      id,
      JSON.stringify(mapping),
      JSON.stringify(survivor),
      JSON.stringify(log.survivorBefore.profile),
    ],
  );
  await refreshIdentityUnread(db, workspace, log.identityId);
  return { id, reversed: true };
}

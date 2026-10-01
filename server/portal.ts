import {
  assert,
  digest,
  DomainError,
  tenant,
  type Connect,
  type Sql,
} from "./db";
import { authorize, can } from "./policy";
import {
  unwrapIdentityKey,
  verifyIdentity,
  type IdentityProof,
} from "./identity";
import { getIdentity } from "./people";
import {
  command,
  conversation,
  recentTimeline,
  type Actor,
} from "./conversations";

/**
 * The customer ticket portal (phase 05, step C). Verified customers only: a session starts from
 * the workspace's signed identity token (the one the messenger verifies) or a one-time, 60-second
 * hand-over code from a verified messenger session. The session secret lives in an HttpOnly
 * cookie; only its hash is stored. Everything a customer reads goes through the same access
 * check and delivery policy as the messenger, so internal notes and events never appear, and
 * back-office and tracker tickets (internal conversations) are never listed or opened.
 */
export const SESSION_MS = 12 * 3_600_000;
const HANDOFF_MS = 60_000;
export const PORTAL_COOKIE = "relay_portal";

export type PortalScope = { workspace: string; brand: string };
export type PortalSession = { id: string; identityId: string; brandId: string };

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const random = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

async function requirePortal(db: Sql, w: string, brand: string) {
  assert(
    (
      await db.query(
        `SELECT 1 FROM workspace_features f JOIN brands b ON b.workspace_id=f.workspace_id AND b.id=$2
        WHERE f.workspace_id=$1 AND f.name='portal_v1' AND f.enabled`,
        [w, brand],
      )
    ).rows.length,
    "PORTAL_DISABLED",
    "The support portal is not available.",
    404,
  );
}

/** Which workspace and brand a portal request is for: a mapped domain first, else the path's. */
export async function portalScope(
  connect: Connect,
  host: string,
  given: { workspace?: unknown; brand?: unknown },
): Promise<PortalScope> {
  const mapped = await tenant(
    connect,
    "_routing",
    async (db) =>
      (
        await db.query<{ workspace_id: string; brand_id: string }>(
          "SELECT workspace_id,brand_id FROM portal_domains WHERE host=$1",
          [host.toLowerCase()],
        )
      ).rows[0],
  );
  if (mapped) return { workspace: mapped.workspace_id, brand: mapped.brand_id };
  assert(
    typeof given.workspace === "string" &&
      ID.test(given.workspace) &&
      typeof given.brand === "string" &&
      ID.test(given.brand),
    "PORTAL_DISABLED",
    "The support portal is not available.",
    404,
  );
  return { workspace: given.workspace, brand: given.brand };
}

/** The portal's public face: brand name, colour and locale, and whether this browser is signed in. */
export async function portalContext(
  db: Sql,
  scope: PortalScope,
  session: PortalSession | null,
) {
  await requirePortal(db, scope.workspace, scope.brand);
  const b = (
    await db.query<{ name: string; settings: Record<string, unknown> }>(
      "SELECT name,settings FROM brands WHERE workspace_id=$1 AND id=$2",
      [scope.workspace, scope.brand],
    )
  ).rows[0];
  // Mounted as a section of the brand's public help center (phase 07, B1), the portal takes
  // the help center's colour and links back to it.
  const help = (
    await db.query<{ color: string | null; slug: string }>(
      `SELECT c.theme->>'primaryColor' AS color,c.slug FROM help_centers c
      WHERE c.workspace_id=$1 AND c.brand_id=$2 AND (SELECT count(*) FROM workspace_features f
        WHERE f.workspace_id=c.workspace_id AND f.name IN ('knowledge_v1','help_center_v1') AND f.enabled)=2`,
      [scope.workspace, scope.brand],
    )
  ).rows[0];
  const valid = (c: unknown): c is string =>
    typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c);
  const color = valid(help?.color)
    ? help.color
    : valid(b.settings.color)
      ? b.settings.color
      : "#087a57";
  return {
    brand: {
      name: b.name,
      color,
      locale: typeof b.settings.locale === "string" ? b.settings.locale : "en",
    },
    signedIn: !!session,
    helpCenter: help ? { slug: help.slug } : null,
  };
}

/**
 * Starts a session from a signed identity token or a hand-over code. Anonymous visitors cannot
 * sign in: the portal is for verified customers only.
 */
export async function startSession(
  db: Sql,
  scope: PortalScope,
  master: string,
  p: { user?: unknown; handoff?: unknown },
) {
  const w = scope.workspace;
  await requirePortal(db, w, scope.brand);
  let identityId: string | undefined;
  if (typeof p.handoff === "string" && p.handoff.length <= 100) {
    identityId = (
      await db.query<{ identity_id: string }>(
        `UPDATE portal_handoffs SET used_at=now() WHERE workspace_id=$1 AND code_hash=$2 AND brand_id=$3
        AND used_at IS NULL AND expires_at>now() RETURNING identity_id`,
        [w, await digest(p.handoff), scope.brand],
      )
    ).rows[0]?.identity_id;
  } else if (p.user && typeof p.user === "object") {
    const user = p.user as IdentityProof & { name?: string };
    const brand = (
      await db.query<{ legacy_hmac_enabled: boolean }>(
        "SELECT legacy_hmac_enabled FROM brands WHERE workspace_id=$1 AND id=$2",
        [w, scope.brand],
      )
    ).rows[0];
    const keys: Record<string, Uint8Array> = {};
    for (const key of (
      await db.query<{ kid: string; wrapped_key: string }>(
        "SELECT kid,wrapped_key FROM identity_keys WHERE workspace_id=$1",
        [w],
      )
    ).rows)
      keys[key.kid] = await unwrapIdentityKey(
        key.wrapped_key,
        master,
        w,
        key.kid,
      );
    let verified = false;
    try {
      verified = await verifyIdentity(user, {
        workspaceId: w,
        enforced: true,
        legacyHmacEnabled: brand?.legacy_hmac_enabled === true,
        keys,
      });
    } catch {
      verified = false;
    }
    if (verified)
      identityId = (
        await getIdentity(db, w, "user", user.userId, {
          ...(typeof user.name === "string" ? { name: user.name } : {}),
          email: user.email,
        })
      ).identityId;
  }
  assert(
    identityId,
    "PORTAL_SIGN_IN_FAILED",
    "Sign-in failed or expired. Open the portal again from our website or messenger.",
    401,
  );
  const id = crypto.randomUUID(),
    secret = random();
  const expires = new Date(Date.now() + SESSION_MS);
  await db.query(
    "INSERT INTO portal_sessions(workspace_id,id,brand_id,identity_id,secret_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6)",
    [
      w,
      id,
      scope.brand,
      identityId,
      await digest(secret),
      expires.toISOString(),
    ],
  );
  return { token: `${id}.${secret}`, expires };
}

/** The signed-in session for this scope, or null. */
export async function currentSession(
  db: Sql,
  scope: PortalScope,
  cookie: string | null,
): Promise<PortalSession | null> {
  const value = (cookie ?? "")
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(PORTAL_COOKIE + "="))
    ?.slice(PORTAL_COOKIE.length + 1);
  const [id, secret] = (value ?? "").split(".");
  if (!id || !secret || !/^[0-9a-f-]{36}$/.test(id)) return null;
  const row = (
    await db.query<{
      identity_id: string;
      brand_id: string;
      secret_hash: string;
    }>(
      `SELECT identity_id,brand_id,secret_hash FROM portal_sessions
      WHERE workspace_id=$1 AND id=$2 AND brand_id=$3 AND revoked_at IS NULL AND expires_at>now()`,
      [scope.workspace, id, scope.brand],
    )
  ).rows[0];
  if (!row || row.secret_hash !== (await digest(secret))) return null;
  return { id, identityId: row.identity_id, brandId: row.brand_id };
}
export function requirePortalSession(
  session: PortalSession | null,
): PortalSession {
  assert(
    session,
    "PORTAL_SIGN_IN_REQUIRED",
    "Sign in to see your requests.",
    401,
  );
  return session;
}
export async function endSession(
  db: Sql,
  scope: PortalScope,
  session: PortalSession | null,
) {
  if (session)
    await db.query(
      "UPDATE portal_sessions SET revoked_at=now() WHERE workspace_id=$1 AND id=$2",
      [scope.workspace, session.id],
    );
  return { ok: true };
}

const actorOf = (s: PortalSession): Actor => ({
  type: "contact",
  identityId: s.identityId,
  brandId: s.brandId,
  verified: true,
});

/** The customer's requests. TODO(phase 01): 'company' visibility, once companies exist. */
export async function listRequests(
  db: Sql,
  scope: PortalScope,
  s: PortalSession,
) {
  const w = scope.workspace;
  await requirePortal(db, w, scope.brand);
  const rows = (
    await db.query<{
      id: string;
      title: string;
      status: string;
      updated_at: string;
      number: string | null;
      type_name: string | null;
      label: string | null;
    }>(
      `WITH RECURSIVE up AS (
        SELECT k.id,k.merged_into_contact_id,0 AS d FROM identity_contact_mappings m JOIN contacts k ON k.workspace_id=m.workspace_id AND k.id=m.contact_id
        WHERE m.workspace_id=$1 AND m.identity_id=$2
        UNION ALL SELECT k.id,k.merged_into_contact_id,u.d+1 FROM contacts k JOIN up u ON k.id=u.merged_into_contact_id WHERE k.workspace_id=$1 AND u.d<32
      ), family AS (
        SELECT id FROM up WHERE merged_into_contact_id IS NULL
        UNION SELECT k.id FROM contacts k JOIN family f ON k.merged_into_contact_id=f.id WHERE k.workspace_id=$1
      ), eligible AS (
        SELECT $2::text AS id UNION SELECT identity_id FROM identity_contact_mappings WHERE workspace_id=$1 AND contact_id IN (SELECT id FROM family)
      )
      SELECT c.id,c.title,c.status,c.updated_at,t.number::text AS number,y.name AS type_name,s.customer_label AS label
      FROM conversations c
      LEFT JOIN tickets t ON t.workspace_id=c.workspace_id AND t.conversation_id=c.id
      LEFT JOIN ticket_types y ON y.workspace_id=t.workspace_id AND y.id=t.type_id
      LEFT JOIN ticket_states s ON s.workspace_id=t.workspace_id AND s.id=t.state_id
      WHERE c.workspace_id=$1 AND c.brand_id=$3 AND c.merged_into_id IS NULL AND c.visibility='customer'
        AND (c.primary_identity_id IN (SELECT id FROM eligible)
          OR EXISTS(SELECT 1 FROM conversation_participants p WHERE p.workspace_id=$1 AND p.conversation_id=c.id AND p.identity_id IN (SELECT id FROM eligible)))
        AND (t.conversation_id IS NULL OR (y.category='customer' AND y.portal_visible))
      ORDER BY c.updated_at DESC,c.id LIMIT 200`,
      [w, s.identityId, scope.brand],
    )
  ).rows;
  return {
    requests: rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      updatedAt: new Date(r.updated_at).toISOString(),
      ticket: r.number
        ? { number: Number(r.number), typeName: r.type_name, label: r.label }
        : null,
    })),
  };
}

/** A request's ticket, if it has one the portal may show; throws if the portal must not show it. */
async function visibleTicket(db: Sql, w: string, id: string) {
  const t = (
    await db.query<{
      number: string;
      type_name: string;
      label: string;
      category: string;
      portal_visible: boolean;
    }>(
      `SELECT t.number::text AS number,y.name AS type_name,s.customer_label AS label,y.category,y.portal_visible FROM tickets t
      JOIN ticket_types y ON y.workspace_id=t.workspace_id AND y.id=t.type_id
      JOIN ticket_states s ON s.workspace_id=t.workspace_id AND s.id=t.state_id
      WHERE t.workspace_id=$1 AND t.conversation_id=$2`,
      [w, id],
    )
  ).rows[0];
  if (!t) return null;
  assert(
    t.category === "customer" && t.portal_visible,
    "CONVERSATION_NOT_FOUND",
    "Conversation unavailable.",
    404,
  );
  return { number: Number(t.number), typeName: t.type_name, label: t.label };
}

/** One request with its newest 100 customer-visible parts, oldest first. */
export async function readRequest(
  db: Sql,
  scope: PortalScope,
  s: PortalSession,
  id: string,
) {
  const w = scope.workspace;
  await requirePortal(db, w, scope.brand);
  // The same access check and delivery policy as the messenger.
  const data = await recentTimeline(db, w, id, actorOf(s), 100);
  const ticket = await visibleTicket(db, w, data.conversation.id);
  return {
    id: data.conversation.id,
    title: data.conversation.title,
    status: data.conversation.status,
    ticket,
    parts: data.parts.map((p) => {
      const d = p.data as Record<string, unknown>;
      return {
        id: p.id,
        kind: p.kind,
        author: p.author_type === "contact" ? "you" : p.author_type,
        authorName:
          p.author_type === "teammate" && typeof d.authorName === "string"
            ? d.authorName
            : null,
        body: ["customer_message", "teammate_reply", "ai_reply"].includes(
          p.kind,
        )
          ? p.body
          : "",
        createdAt: new Date(p.created_at).toISOString(),
        // Only what the customer's event lines need.
        event:
          p.kind === "state_change"
            ? { to: String(d.to ?? "") }
            : p.kind === "system_event" && d.event === "ticket_status"
              ? {
                  ticket: {
                    number: d.number,
                    typeName: d.typeName,
                    label: d.label,
                  },
                }
              : p.kind === "system_event" && d.event === "human_joined"
                ? { joined: true }
                : null,
      };
    }),
  };
}

/** A plain-text reply from the customer (reopening a closed request, as in the messenger). */
export async function replyToRequest(
  db: Sql,
  scope: PortalScope,
  s: PortalSession,
  key: string,
  p: { id?: unknown; text?: unknown },
) {
  const w = scope.workspace;
  await requirePortal(db, w, scope.brand);
  const c = await conversation(db, w, String(p.id ?? ""));
  await visibleTicket(db, w, c.id);
  await command(db, w, actorOf(s), key, {
    action: "reply",
    conversationId: c.id,
    text: typeof p.text === "string" ? p.text : "",
  });
  return { ok: true };
}

/**
 * A one-time code (valid 60 seconds) that opens the portal from a verified messenger session.
 * The URL carries it in the fragment, which is never sent to a server or in a referrer.
 */
export async function createHandoff(
  db: Sql,
  session: {
    workspace: string;
    brandId: string;
    identityId: string;
    verified: boolean;
  },
  apiOrigin: string,
) {
  const w = session.workspace;
  await requirePortal(db, w, session.brandId);
  assert(
    session.verified,
    "PORTAL_VERIFIED_ONLY",
    "Sign in to our website to see your requests.",
    403,
  );
  const code = random();
  await db.query(
    "INSERT INTO portal_handoffs(workspace_id,code_hash,brand_id,identity_id,expires_at) VALUES($1,$2,$3,$4,$5)",
    [
      w,
      await digest(code),
      session.brandId,
      session.identityId,
      new Date(Date.now() + HANDOFF_MS).toISOString(),
    ],
  );
  const domain = (
    await db.query<{ host: string }>(
      "SELECT host FROM portal_domains WHERE workspace_id=$1 AND brand_id=$2 ORDER BY host LIMIT 1",
      [w, session.brandId],
    )
  ).rows[0]?.host;
  const base = domain
    ? `https://${domain}/portal`
    : `${apiOrigin}/portal/${encodeURIComponent(w)}/${encodeURIComponent(session.brandId)}`;
  return { url: `${base}#handoff=${code}` };
}

/** Portal settings for teammates: visibility and custom domains. */
export async function portalSettings(
  db: Sql,
  w: string,
  principal: string,
  p?: Record<string, unknown>,
) {
  if (p) await authorize(db, w, principal, "workspace.manage");
  else await authorize(db, w, principal, "conversations.read");
  assert(
    (
      await db.query(
        "SELECT 1 FROM workspace_features WHERE workspace_id=$1 AND name='portal_v1' AND enabled",
        [w],
      )
    ).rows.length,
    "PORTAL_DISABLED",
    "The support portal is not enabled for this workspace.",
    404,
  );
  if (p?.op === "visibility") {
    assert(
      p.visibility === "individual" || p.visibility === "company",
      "INVALID_PORTAL_SETTINGS",
      "Choose individual or company.",
    );
    await db.query(
      `INSERT INTO portal_settings(workspace_id,visibility) VALUES($1,$2) ON CONFLICT(workspace_id) DO UPDATE SET visibility=$2,updated_at=now()`,
      [w, p.visibility],
    );
  } else if (p?.op === "add_domain" || p?.op === "remove_domain") {
    const host = String(p.host ?? "").toLowerCase();
    assert(
      /^[a-z0-9.-]{1,253}(:[0-9]{1,5})?$/.test(host) && host.includes("."),
      "INVALID_PORTAL_SETTINGS",
      "Give a host name such as help.example.com.",
    );
    if (p.op === "remove_domain")
      await db.query(
        "DELETE FROM portal_domains WHERE workspace_id=$1 AND host=$2",
        [w, host],
      );
    else {
      const brand = String(p.brandId ?? "");
      assert(
        (
          await db.query(
            "SELECT 1 FROM brands WHERE workspace_id=$1 AND id=$2",
            [w, brand],
          )
        ).rows.length,
        "INVALID_PORTAL_SETTINGS",
        "Brand unavailable.",
        404,
      );
      // Another workspace's row is invisible here, so the primary key decides: a taken host
      // (by any workspace) inserts nothing.
      const added = (
        await db.query(
          "INSERT INTO portal_domains(host,workspace_id,brand_id) VALUES($1,$2,$3) ON CONFLICT(host) DO NOTHING RETURNING host",
          [host, w, brand],
        )
      ).rows.length;
      assert(added, "PORTAL_DOMAIN_TAKEN", "This host is already in use.", 409);
    }
  } else if (p)
    throw new DomainError(
      "INVALID_PORTAL_SETTINGS",
      "Choose visibility, add_domain or remove_domain.",
      400,
    );
  const visibility =
    (
      await db.query<{ visibility: string }>(
        "SELECT visibility FROM portal_settings WHERE workspace_id=$1",
        [w],
      )
    ).rows[0]?.visibility ?? "individual";
  return {
    visibility,
    ...(visibility === "company"
      ? {
          notice:
            "Company-wide visibility applies once companies exist; until then customers see their own requests.",
        }
      : {}),
    domains: (
      await db.query<{ host: string; brand_id: string }>(
        "SELECT host,brand_id FROM portal_domains WHERE workspace_id=$1 ORDER BY host",
        [w],
      )
    ).rows.map((d) => ({ host: d.host, brandId: d.brand_id })),
    canManage: await can(db, w, principal, "workspace.manage"),
  };
}

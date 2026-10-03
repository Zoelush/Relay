import { SignJWT, jwtVerify, decodeJwt } from "jose";
import {
  assert,
  DomainError,
  tenant,
  once,
  digest,
  type Connect,
  type Sql,
} from "./db";
import {
  verifyIdentity,
  unwrapIdentityKey,
  type IdentityProof,
} from "./identity";
import { getIdentity, mergeVisitorIdentity } from "./people";
import {
  command,
  timeline,
  recentTimeline,
  olderTimeline,
  conversation,
  access,
  agentConversation,
  listPreviews,
  type Actor,
  type Command,
  type Conversation,
  type OlderBounds,
} from "./conversations";
import { authorize, can } from "./policy";
import { readDrafts, saveDraft } from "./drafts";
import { applyMacro, listMacros, saveMacro } from "./macros";
import { commitBulk, prepareBulk, readBulk, undoBulk } from "./bulk";
import { listTicketTypes, previewTypeChange, saveTicketType } from "./tickets";
import {
  commitBroadcast,
  createInternalTicket,
  listTrackers,
  prepareBroadcast,
  readBroadcast,
} from "./ticket-links";
import {
  assignCalendar,
  conversationCalendar,
  listCalendars,
  publishCalendar,
} from "./calendars";
import { listPolicies, savePolicy } from "./sla";
import {
  createHandoff,
  currentSession,
  endSession,
  listRequests,
  portalContext,
  portalScope,
  portalSettings,
  PORTAL_COOKIE,
  readRequest,
  replyToRequest,
  requirePortalSession,
  SESSION_MS,
  startSession,
} from "./portal";
import {
  queuePosition,
  listTeams,
  myWorkload,
  nextConversation,
  saveTeam,
  saveTeammateLimits,
  setPresence,
} from "./routing";
import { changeKnowledge, listKnowledge, readKnowledge } from "./knowledge";
import {
  readSettings,
  saveSettings,
  settingsEnabled,
  settingsOverview,
} from "./settings";
import {
  indexStatus,
  rebuildIndex,
  tryRetrieval,
  type IndexEnvironment,
} from "./knowledge-index";
import {
  changeSource,
  listSources,
  readSource,
  type SyncEnvironment,
} from "./knowledge-sync";
import {
  articleImage,
  completeKnowledgeFile,
  deleteKnowledgeObjects,
  fileResponse,
  prepareKnowledgeFile,
  removeKnowledgeFile,
  teammateFile,
  verifyFileUrl,
} from "./knowledge-files";
import {
  changeHelpCenter,
  listHelpCenters,
  readHelpCenter,
} from "./help-centers";
import {
  helpAvailable,
  helpContextArticle,
  messengerArticle,
  messengerCollection,
  messengerFeedback,
  messengerHelp,
  messengerSearch,
  type MessengerScope,
} from "./help-messenger";
import { helpInsights, linkFeedback, verifyReceipt } from "./help-search";
import { bodyLimit } from "./agent-bridge";
import { conversationContext } from "./context";
import {
  listNotifications,
  markNotifications,
  unreadNotifications,
} from "./mentions";
import {
  customerRead,
  customerUnreadSnapshots,
  customerAudience,
} from "./unread";
import { availabilityFor, expectedReply } from "./office-hours";
import {
  prepareAttachment,
  completeAttachment,
  downloadAttachment,
  type AttachmentStorage,
} from "./attachments";
import { readJob, enqueueJob } from "./jobs";
import { searchConversations } from "./search";
import {
  viewCounts,
  viewsEnabled,
  viewSnapshot,
  mutateView,
  viewPage,
} from "./inbox-views";

export interface ApiEnvironment {
  connect: Connect;
  storageTransport?: "hyperdrive" | "local-pglite";
  sessionSecret: string;
  identityMaster: string;
  bridgeSecret: string;
  notify?: (workspace: string, resource: string) => Promise<void>;
  realtimeUrl?: string;
  attachments?: AttachmentStorage;
  dispatchJobs?: (workspace: string) => Promise<void>;
  /** Website sync (phase 07 C1b): fetch policy and page renderer. */
  sync?: SyncEnvironment;
  /** The AI index (phase 07 C2a): embedding models and the vector store. */
  knowledgeIndex?: IndexEnvironment;
}
export type Session = {
  workspace: string;
  brandId: string;
  identityId: string;
  sessionId: string;
  verified: boolean;
  originTimezone?: string;
  locale?: string;
  expiresAt?: number;
};
export type AgentSession = {
  kind: "agent";
  inbox?: boolean;
  workspace: string;
  principal: string;
  teammateId: string;
  expiresAt: number;
};
export type RealtimeSession = Session | AgentSession;
export function isAgent(s: RealtimeSession): s is AgentSession {
  return "kind" in s && s.kind === "agent";
}
type Brand = {
  id: string;
  name: string;
  settings: Record<string, unknown> & { locale?: string };
  identity_enforced: boolean;
  legacy_hmac_enabled: boolean;
};
const bytes = (s: string) => new TextEncoder().encode(s);
async function sign(
  payload: Record<string, unknown>,
  env: ApiEnvironment,
  expires: number,
  audience: string,
) {
  assert(
    env.sessionSecret.length >= 32,
    "CONFIGURATION",
    "Session signing is unavailable.",
    503,
  );
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("relay")
    .setAudience(audience)
    .setExpirationTime(expires)
    .sign(bytes(env.sessionSecret));
}
async function claims(token: string, env: ApiEnvironment, audience: string) {
  try {
    return (
      await jwtVerify(token, bytes(env.sessionSecret), {
        algorithms: ["HS256"],
        issuer: "relay",
        audience,
      })
    ).payload;
  } catch {
    throw new DomainError(
      "SESSION_EXPIRED",
      "Your session expired. Refresh your identity and try again.",
      401,
    );
  }
}
async function readBody(req: Request, limit = 20000) {
  assert(
    Number(req.headers.get("content-length") ?? 0) <= limit,
    "BODY_TOO_LARGE",
    "Request is too large.",
    413,
  );
  const reader = req.body?.getReader();
  let size = 0,
    raw = "";
  const decoder = new TextDecoder();
  if (reader)
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new DomainError("BODY_TOO_LARGE", "Request is too large.", 413);
      }
      raw += decoder.decode(value, { stream: true });
    }
  raw += decoder.decode();
  try {
    const value = JSON.parse(raw);
    assert(
      value && typeof value === "object" && !Array.isArray(value),
      "INVALID_JSON",
      "Send a JSON object.",
    );
    return value;
  } catch {
    throw new DomainError("INVALID_JSON", "Send a JSON object.");
  }
}
function pageUrl(value: unknown) {
  try {
    const url = new URL(String(value));
    assert(
      ["https:", "http:"].includes(url.protocol),
      "PAGE_URL_INVALID",
      "Use an HTTP page URL.",
    );
    return url.origin + url.pathname;
  } catch {
    throw new DomainError("PAGE_URL_INVALID", "Provide the current page URL.");
  }
}
function originTimezone(value: unknown) {
  if (value === undefined) return undefined;
  assert(
    typeof value === "string" && value.length <= 100,
    "TIMEZONE_INVALID",
    "Use an IANA timezone.",
  );
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return value;
  } catch {
    throw new DomainError("TIMEZONE_INVALID", "Use an IANA timezone.");
  }
}
async function brand(db: Sql, w: string, id: string) {
  const b = (
    await db.query<Brand>(
      "SELECT * FROM brands WHERE workspace_id=$1 AND id=$2",
      [w, id],
    )
  ).rows[0];
  assert(b, "BRAND_NOT_FOUND", "Brand unavailable.", 404);
  return b;
}
function allowedOrigin(b: Brand, origin: string | null) {
  assert(
    origin &&
      Array.isArray(b.settings.allowedOrigins) &&
      b.settings.allowedOrigins.includes(origin),
    "ORIGIN_NOT_ALLOWED",
    "This website is not enabled for this brand.",
    403,
  );
}
async function sessionClaims(
  req: Request,
  env: ApiEnvironment,
): Promise<Session> {
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const c = await claims(token, env, "messenger");
  assert(
    typeof c.workspace === "string" &&
      typeof c.brandId === "string" &&
      typeof c.identityId === "string" &&
      typeof c.sessionId === "string",
    "SESSION_INVALID",
    "Session unavailable.",
    401,
  );
  return { ...(c as unknown as Session), expiresAt: Number(c.exp) };
}
async function validateSession(db: Sql, s: Session) {
  assert(
    (
      await db.query(
        "SELECT s.id FROM messenger_sessions s JOIN workspace_features f ON f.workspace_id=s.workspace_id AND f.name='messenger_v2' AND f.enabled WHERE s.workspace_id=$1 AND s.id=$2 AND s.identity_id=$3 AND s.brand_id=$4 AND s.revoked_at IS NULL AND s.expires_at>now()",
        [s.workspace, s.sessionId, s.identityId, s.brandId],
      )
    ).rows.length,
    "SESSION_EXPIRED",
    "Your session expired. Please reconnect.",
    401,
  );
}
export async function requireSession(
  req: Request,
  env: ApiEnvironment,
): Promise<Session> {
  const s = await sessionClaims(req, env);
  await tenant(env.connect, s.workspace, (db) => validateSession(db, s));
  return s;
}
async function inboxEnabled(db: Sql, workspace: string) {
  assert(
    (
      await db.query(
        "SELECT name FROM workspace_features WHERE workspace_id=$1 AND name='agent_inbox_v1' AND enabled",
        [workspace],
      )
    ).rows.length,
    "FEATURE_DISABLED",
    "The new agent inbox is not enabled.",
    404,
  );
}
export async function socketContext(
  token: string,
  env: ApiEnvironment,
): Promise<{ session: RealtimeSession; token: string }> {
  const c = await claims(token, env, "realtime");
  if (c.agent && typeof c.agent === "object") {
    const a = c.agent as Record<string, unknown>;
    assert(
      typeof a.workspace === "string" && typeof a.principal === "string",
      "SESSION_INVALID",
      "Agent session unavailable.",
      401,
    );
    const workspace = a.workspace,
      principal = a.principal;
    const teammate = await tenant(env.connect, workspace, async (db) => {
      if (a.inbox === true) await inboxEnabled(db, workspace);
      return authorize(db, workspace, principal, "conversations.read");
    });
    return {
      session: {
        kind: "agent",
        inbox: a.inbox === true,
        workspace,
        principal,
        teammateId: teammate.id,
        expiresAt: Math.floor(Date.now() / 1000) + 300,
      },
      token,
    };
  }
  assert(
    typeof c.sessionToken === "string",
    "SESSION_INVALID",
    "Session unavailable.",
    401,
  );
  const req = new Request("https://relay.invalid", {
    headers: { authorization: "Bearer " + c.sessionToken },
  });
  return { session: await requireSession(req, env), token: c.sessionToken };
}
export async function validateRealtime(
  env: ApiEnvironment,
  s: RealtimeSession,
  token: string,
) {
  if (!isAgent(s))
    return requireSession(
      new Request("https://relay.invalid", {
        headers: { authorization: "Bearer " + token },
      }),
      env,
    );
  assert(
    s.expiresAt > Math.floor(Date.now() / 1000),
    "SESSION_EXPIRED",
    "Refresh agent authorization.",
    401,
  );
  await tenant(env.connect, s.workspace, async (db) => {
    if (s.inbox) await inboxEnabled(db, s.workspace);
    await authorize(db, s.workspace, s.principal, "conversations.read");
  });
  return s;
}
export async function realtimeUnread(env: ApiEnvironment, s: RealtimeSession) {
  if (!isAgent(s)) return unreadSnapshot(env, s);
  return tenant(env.connect, s.workspace, async (db) => ({
    viewCounts: s.inbox
      ? await viewCounts(db, s.workspace, [s.teammateId])
      : [],
    ...(s.inbox
      ? {
          notifications: await unreadNotifications(
            db,
            s.workspace,
            s.teammateId,
          ),
        }
      : {}),
    views: (
      await db.query(
        "SELECT view,count::int,version FROM inbox_counters WHERE workspace_id=$1 AND teammate_id=$2",
        [s.workspace, s.teammateId],
      )
    ).rows,
  }));
}
/** Parts in the inbox's first screen, and in each older page loaded by scrolling back. */
const FIRST_SCREEN_PARTS = 50,
  OLDER_PAGE_PARTS = 100;
/** One page of older history for the inbox, below a signed cursor from the first screen. */
export async function agentOlderPage(
  env: ApiEnvironment,
  workspace: string,
  principal: string,
  id: string,
  token: string,
) {
  const c = await claims(token, env, "agent-older");
  assert(
    c.workspace === workspace &&
      c.principal === principal &&
      c.requestedId === id,
    "CURSOR_INVALID",
    "Cursor belongs to another agent.",
    403,
  );
  const { result, personalData } = await tenant(
    env.connect,
    workspace,
    async (db) => {
      await inboxEnabled(db, workspace);
      const result = await olderTimeline(
        db,
        workspace,
        id,
        { type: "teammate", principal },
        c.before as OlderBounds,
        OLDER_PAGE_PARTS,
      );
      assert(
        result.revision === c.revision,
        "CURSOR_INVALID",
        "This conversation changed. Reopen it.",
        409,
      );
      const personalData = await can(
        db,
        workspace,
        principal,
        "contacts.personal_data",
      );
      return { result, personalData };
    },
  );
  return {
    conversation: agentConversation(result.conversation, personalData),
    parts: result.parts,
    older: result.older
      ? await sign(
          {
            workspace,
            principal,
            requestedId: id,
            revision: result.revision,
            before: result.older,
          },
          env,
          Math.floor(Date.now() / 1000) + 86400,
          "agent-older",
        )
      : null,
  };
}
export async function agentHistoryPage(
  env: ApiEnvironment,
  s: AgentSession,
  id: string,
  cursor?: string,
) {
  assert(
    s.expiresAt > Date.now() / 1000,
    "SESSION_EXPIRED",
    "Refresh agent authorization.",
    401,
  );
  let after:
    { revision: string; positions: Record<string, string> } | undefined;
  if (cursor) {
    const c = await claims(cursor, env, "agent-timeline");
    assert(
      c.workspace === s.workspace &&
        c.principal === s.principal &&
        c.requestedId === id,
      "CURSOR_INVALID",
      "Cursor belongs to another agent.",
      403,
    );
    after = c.after as typeof after;
  }
  const { result, personalData } = await tenant(
    env.connect,
    s.workspace,
    async (db) => {
      assert(
        (
          await db.query(
            "SELECT name FROM workspace_features WHERE workspace_id=$1 AND name='conversations_v1' AND enabled",
            [s.workspace],
          )
        ).rows.length,
        "FEATURE_DISABLED",
        "Conversation core is not enabled.",
        404,
      );
      if (s.inbox) await inboxEnabled(db, s.workspace);
      const actor: Actor = { type: "teammate", principal: s.principal };
      // The inbox opens on the newest parts; older history loads on demand from
      // /v1/agent/history. Other agent clients keep the full forward replay.
      const result =
        s.inbox && !after
          ? await recentTimeline(db, s.workspace, id, actor, FIRST_SCREEN_PARTS)
          : await timeline(db, s.workspace, id, actor, after);
      const personalData = await can(
        db,
        s.workspace,
        s.principal,
        "contacts.personal_data",
      );
      return { result, personalData };
    },
  );
  const older =
    "older" in result && result.older
      ? await sign(
          {
            workspace: s.workspace,
            principal: s.principal,
            requestedId: id,
            revision: result.revision,
            before: result.older,
          },
          env,
          Math.floor(Date.now() / 1000) + 86400,
          "agent-older",
        )
      : null;
  const recent = "older" in result;
  return {
    ...result,
    hasMore: recent ? false : result.hasMore,
    reset: recent ? true : result.reset,
    older,
    revision: undefined,
    conversation: agentConversation(result.conversation, personalData),
    positions: undefined,
    cursor: await sign(
      {
        workspace: s.workspace,
        principal: s.principal,
        requestedId: id,
        after: {
          revision:
            result.conversation.id +
            ":" +
            String(result.conversation.timeline_revision),
          positions: result.positions,
        },
      },
      env,
      Math.floor(Date.now() / 1000) + 86400,
      "agent-timeline",
    ),
  };
}
export async function unreadSnapshot(env: ApiEnvironment, s: Session) {
  return tenant(env.connect, s.workspace, async (db) => {
    const row = (await customerUnreadSnapshots(db, s.workspace, [s]))[0];
    return {
      unread_count: row?.unread_count ?? 0,
      version: row?.version ?? "0",
    };
  });
}
export async function historyPage(
  env: ApiEnvironment,
  session: Session,
  id: string,
  cursor?: string,
) {
  let after:
    { revision: string; positions: Record<string, string> } | undefined;
  if (cursor) {
    const payload = await claims(cursor, env, "timeline");
    assert(
      payload.sessionId === session.sessionId &&
        payload.workspace === session.workspace &&
        payload.requestedId === id,
      "CURSOR_INVALID",
      "Cursor belongs to a different session.",
      403,
    );
    after = payload.after as typeof after;
  }
  const data = await tenant(env.connect, session.workspace, async (db) => {
    const page = await timeline(
      db,
      session.workspace,
      id,
      {
        type: "contact",
        identityId: session.identityId,
        brandId: session.brandId,
        verified: session.verified,
      },
      after,
    );
    // While waiting: the customer's place in line, and when their team is next open.
    const c = page.conversation;
    return {
      ...page,
      waiting: {
        queue: await queuePosition(db, session.workspace, c.id),
        availability:
          c.status === "open" && c.team_id
            ? await availabilityFor(
                db,
                session.workspace,
                { brandId: c.brand_id, teamId: c.team_id },
                session.locale ?? "en",
              )
            : null,
      },
    };
  });
  const {
    id: canonicalId,
    title,
    status,
    brand_id,
    timeline_revision,
  } = data.conversation;
  return {
    ...data,
    parts: data.parts.map((p) => ({
      ...p,
      display_time: new Intl.DateTimeFormat(session.locale ?? "en", {
        timeZone: session.originTimezone ?? "UTC",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(new Date(p.created_at)),
    })),
    conversation: {
      id: canonicalId,
      title,
      status,
      brand_id,
      timeline_revision,
    },
    waiting: data.waiting,
    positions: undefined,
    cursor: await sign(
      {
        workspace: session.workspace,
        sessionId: session.sessionId,
        requestedId: id,
        after: {
          revision:
            data.conversation.id +
            ":" +
            String(data.conversation.timeline_revision),
          positions: data.positions,
        },
      },
      env,
      Math.floor(Date.now() / 1000) + 86400,
      "timeline",
    ),
  };
}

/**
 * What an unexpected error log may say: the error class, a PostgreSQL SQLSTATE code if there is
 * one (for example 40P01, a deadlock), and the source file and line where it was thrown. Never
 * the message or any request data, which can contain customer details.
 */
export function errorFingerprint(error: unknown) {
  const type = error instanceof Error ? error.name : typeof error;
  const raw = (error as { code?: unknown } | null)?.code;
  const code =
    typeof raw === "string" && /^[0-9A-Z]{5}$/.test(raw) ? raw : undefined;
  const frame = (error instanceof Error ? (error.stack ?? "") : "")
    .split("\n")
    .slice(1)
    .map((line) =>
      line.match(
        /((?:server|scripts|workers|app|lib)\/[\w./-]+\.[jt]sx?):(\d+)/,
      ),
    )
    .find((m) => m);
  return {
    type,
    ...(code ? { code } : {}),
    ...(frame ? { at: `${frame[1]}:${frame[2]}` } : {}),
  };
}
export async function handleApi(
  req: Request,
  env: ApiEnvironment,
): Promise<Response> {
  const started = performance.now(),
    url = new URL(req.url),
    origin = req.headers.get("origin");
  let corsOrigin: string | undefined;
  const json = (data: unknown, status = 200) =>
    Response.json(data, {
      status,
      headers: {
        "cache-control": "no-store",
        "server-timing": `relay;dur=${(performance.now() - started).toFixed(3)}`,
        ...(url.pathname.startsWith("/v1/agent/")
          ? {
              "x-relay-storage": "postgresql",
              "x-relay-transport": env.storageTransport ?? "hyperdrive",
            }
          : {}),
        ...(corsOrigin
          ? { "access-control-allow-origin": corsOrigin, vary: "Origin" }
          : {}),
      },
    });
  try {
    if (req.method === "OPTIONS")
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": origin ?? "null",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers":
            "Content-Type, Authorization, Idempotency-Key",
          vary: "Origin",
        },
      });
    if (url.pathname.startsWith("/v1/portal/")) {
      // Same-origin only: the portal page and its API share the Relay origin (or a mapped
      // domain). Every change must come from that origin; the session cookie is SameSite=Lax.
      const post = req.method === "POST";
      if (post)
        assert(
          origin === url.origin,
          "FORBIDDEN",
          "Cross-site request refused.",
          403,
        );
      const body = post ? await readBody(req) : {};
      const scope = await portalScope(env.connect, url.host, {
        workspace: post ? body.workspace : url.searchParams.get("workspace"),
        brand: post ? body.brand : url.searchParams.get("brand"),
      });
      const cookie = req.headers.get("cookie");
      const route = url.pathname.slice("/v1/portal/".length);
      const cookieAttributes = `HttpOnly; SameSite=Lax; Path=/${url.protocol === "https:" ? "; Secure" : ""}`;
      if (post && route === "session") {
        const started = await tenant(env.connect, scope.workspace, (db) =>
          startSession(db, scope, env.identityMaster, body),
        );
        const response = json({
          ok: true,
          expiresAt: started.expires.toISOString(),
        });
        response.headers.append(
          "set-cookie",
          `${PORTAL_COOKIE}=${started.token}; Max-Age=${Math.floor(SESSION_MS / 1000)}; ${cookieAttributes}`,
        );
        return response;
      }
      return await tenant(env.connect, scope.workspace, async (db) => {
        const session = await currentSession(db, scope, cookie);
        if (!post && route === "context")
          return json(await portalContext(db, scope, session));
        if (post && route === "logout") {
          const response = json(await endSession(db, scope, session));
          response.headers.append(
            "set-cookie",
            `${PORTAL_COOKIE}=; Max-Age=0; ${cookieAttributes}`,
          );
          return response;
        }
        const signedIn = requirePortalSession(session);
        if (!post && route === "requests")
          return json(await listRequests(db, scope, signedIn));
        if (!post && route === "request")
          return json(
            await readRequest(
              db,
              scope,
              signedIn,
              url.searchParams.get("id") ?? "",
            ),
          );
        if (post && route === "reply")
          return json(
            await replyToRequest(
              db,
              scope,
              signedIn,
              req.headers.get("idempotency-key") ?? "",
              body,
            ),
          );
        throw new DomainError("NOT_FOUND", "Endpoint unavailable.", 404);
      });
    }
    if (url.pathname === "/v1/messenger/boot" && req.method === "POST") {
      const p = await readBody(req);
      assert(
        typeof p.workspaceId === "string" && typeof p.brandId === "string",
        "BOOT_INVALID",
        "Workspace and brand are required.",
      );
      const result = await tenant(env.connect, p.workspaceId, async (db) => {
        const b = await brand(db, p.workspaceId, p.brandId);
        allowedOrigin(b, origin);
        corsOrigin = origin!;
        assert(
          (
            await db.query(
              "SELECT name FROM workspace_features WHERE workspace_id=$1 AND name=$2 AND enabled=true",
              [p.workspaceId, "messenger_v2"],
            )
          ).rows.length,
          "FEATURE_DISABLED",
          "Messenger is not enabled for this workspace.",
          404,
        );
        assert(
          typeof p.deviceToken === "string" &&
            p.deviceToken.length >= 32 &&
            p.deviceToken.length <= 200,
          "DEVICE_TOKEN_REQUIRED",
          "A device token is required.",
        );
        const keys: Record<string, Uint8Array> = {};
        for (const key of (
          await db.query<{ kid: string; wrapped_key: string }>(
            "SELECT kid,wrapped_key FROM identity_keys WHERE workspace_id=$1",
            [p.workspaceId],
          )
        ).rows)
          keys[key.kid] = await unwrapIdentityKey(
            key.wrapped_key,
            env.identityMaster,
            p.workspaceId,
            key.kid,
          );
        const verified = p.user
          ? await verifyIdentity(p.user as IdentityProof, {
              workspaceId: p.workspaceId,
              enforced: b.identity_enforced,
              legacyHmacEnabled: b.legacy_hmac_enabled,
              keys,
            })
          : false;
        return once(
          db,
          p.workspaceId,
          "boot:" + (await digest(p.deviceToken)),
          req.headers.get("idempotency-key") ?? "",
          p,
          async () => {
            const visitor = await getIdentity(
              db,
              p.workspaceId,
              "anonymous",
              p.deviceToken,
              p.user && !verified
                ? { name: p.user.name, email: p.user.email }
                : {},
            );
            let identity = visitor;
            if (verified) {
              identity = await getIdentity(
                db,
                p.workspaceId,
                "user",
                p.user.userId,
                { name: p.user.name, email: p.user.email },
              );
              await mergeVisitorIdentity(
                db,
                p.workspaceId,
                visitor.identityId,
                identity.contactId,
              );
            }
            const sessionId = crypto.randomUUID(),
              proofExpiry = verified
                ? p.user.jwt
                  ? Number(decodeJwt(p.user.jwt).exp)
                  : Number(p.user.hmac.expiresAt)
                : Infinity;
            const expires = Math.min(
              Math.floor(Date.now() / 1000) + (verified ? 900 : 86400),
              proofExpiry,
            );
            let locale =
              typeof p.locale === "string" && p.locale.length < 50
                ? p.locale
                : (b.settings.locale ?? "en");
            try {
              locale = Intl.getCanonicalLocales(locale)[0];
            } catch {
              locale = "en";
            }
            const timezone = originTimezone(p.timezone);
            await db.query(
              "INSERT INTO messenger_sessions(workspace_id,id,brand_id,identity_id,secret_hash,expires_at,page_url,locale,origin_timezone) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
              [
                p.workspaceId,
                sessionId,
                b.id,
                identity.identityId,
                await digest(sessionId),
                new Date(expires * 1000).toISOString(),
                pageUrl(p.pageUrl),
                locale,
                timezone ?? null,
              ],
            );
            return {
              session: {
                workspace: p.workspaceId,
                brandId: b.id,
                identityId: identity.identityId,
                sessionId,
                verified,
                originTimezone: timezone,
                locale,
              },
              expires,
              brand: { id: b.id, name: b.name, ...b.settings },
              locale,
              // One source for office hours: the calendar that applies (phase 06, step C).
              availability: await availabilityFor(
                db,
                p.workspaceId,
                { brandId: b.id },
                locale,
              ),
              replyTime: await expectedReply(db, p.workspaceId, b.id),
              capabilities: {
                // The brand's help center in the messenger's Help space (phase 07, B2).
                help: await helpAvailable(db, p.workspaceId, b.id),
                // The portal is for verified customers; the messenger links to it for them.
                tickets:
                  verified &&
                  (
                    await db.query(
                      "SELECT 1 FROM workspace_features WHERE workspace_id=$1 AND name='portal_v1' AND enabled",
                      [p.workspaceId],
                    )
                  ).rows.length > 0,
                queue: true,
                attachments: !!env.attachments,
                realtime: !!env.realtimeUrl,
              },
            };
          },
        );
      });
      const token = await sign(
        result.session,
        env,
        result.expires,
        "messenger",
      );
      return json({
        ...result,
        token,
        realtime: env.realtimeUrl
          ? {
              url: env.realtimeUrl,
              ticket: await sign(
                { sessionToken: token },
                env,
                Math.floor(Date.now() / 1000) + 60,
                "realtime",
              ),
            }
          : null,
      });
    }
    if (url.pathname.startsWith("/v1/agent/")) {
      assert(
        (req.method === "GET" &&
          [
            "/v1/agent/inbox",
            "/v1/agent/views",
            "/v1/agent/view-page",
            "/v1/agent/search",
            "/v1/agent/job",
            "/v1/agent/attachment/content",
            "/v1/agent/history",
            "/v1/agent/drafts",
            "/v1/agent/notifications",
            "/v1/agent/macros",
            "/v1/agent/context",
            "/v1/agent/bulk",
            "/v1/agent/ticket-types",
            "/v1/agent/ticket-preview",
            "/v1/agent/tickets",
            "/v1/agent/ticket-broadcast",
            "/v1/agent/calendars",
            "/v1/agent/calendar-resolve",
            "/v1/agent/sla-policies",
            "/v1/agent/portal-settings",
            "/v1/agent/teams",
            "/v1/agent/workload",
            "/v1/agent/knowledge",
            "/v1/agent/knowledge-record",
            "/v1/agent/knowledge-file",
            "/v1/agent/knowledge-sources",
            "/v1/agent/knowledge-source",
            "/v1/agent/knowledge-index",
            "/v1/agent/knowledge-retrieve",
            "/v1/agent/settings",
            "/v1/agent/help-centers",
            "/v1/agent/help-center",
            "/v1/agent/help-insights",
          ].includes(url.pathname)) ||
          (req.method === "POST" &&
            [
              "/v1/agent/command",
              "/v1/agent/views",
              "/v1/agent/drafts",
              "/v1/agent/notifications",
              "/v1/agent/macros",
              "/v1/agent/bulk",
              "/v1/agent/ticket-types",
              "/v1/agent/tickets",
              "/v1/agent/calendars",
              "/v1/agent/sla-policies",
              "/v1/agent/portal-settings",
              "/v1/agent/teams",
              "/v1/agent/teammate-limits",
              "/v1/agent/presence",
              "/v1/agent/next",
              "/v1/agent/knowledge",
              "/v1/agent/knowledge-files",
              "/v1/agent/knowledge-sources",
              "/v1/agent/knowledge-index",
              "/v1/agent/settings",
              "/v1/agent/help-centers",
              "/v1/agent/realtime-ticket",
              "/v1/agent/search/reindex",
              "/v1/agent/unread/rebuild",
              "/v1/agent/attachment/prepare",
              "/v1/agent/attachment/complete",
            ].includes(url.pathname)),
        "NOT_FOUND",
        "Endpoint unavailable.",
        404,
      );
      const proof =
        req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      let c;
      try {
        c = (
          await jwtVerify(proof, bytes(env.bridgeSecret), {
            algorithms: ["HS256"],
            audience: "relay-agent",
            issuer: "relay-sites",
          })
        ).payload;
      } catch {
        throw new DomainError(
          "FORBIDDEN",
          "Agent authentication required.",
          401,
        );
      }
      assert(
        typeof c.workspace === "string" && typeof c.principal === "string",
        "FORBIDDEN",
        "Agent authentication required.",
        401,
      );
      const workspace = c.workspace,
        principal = c.principal;
      const inbox = c.inbox === true;
      const actor: Actor = {
        type: "teammate",
        principal,
        originTimezone: originTimezone(c.timezone),
      };
      await tenant(env.connect, workspace, async (db) => {
        if (
          inbox ||
          url.pathname.startsWith("/v1/agent/attachment/") ||
          url.pathname === "/v1/agent/history" ||
          url.pathname === "/v1/agent/drafts" ||
          url.pathname === "/v1/agent/notifications" ||
          url.pathname === "/v1/agent/macros" ||
          url.pathname === "/v1/agent/context" ||
          url.pathname === "/v1/agent/bulk" ||
          url.pathname.startsWith("/v1/agent/ticket") ||
          url.pathname.startsWith("/v1/agent/calendar") ||
          url.pathname === "/v1/agent/sla-policies" ||
          url.pathname === "/v1/agent/portal-settings" ||
          url.pathname === "/v1/agent/teams" ||
          url.pathname === "/v1/agent/teammate-limits" ||
          url.pathname === "/v1/agent/workload" ||
          url.pathname === "/v1/agent/presence" ||
          url.pathname === "/v1/agent/next" ||
          url.pathname.startsWith("/v1/agent/knowledge") ||
          url.pathname.startsWith("/v1/agent/help-center") ||
          url.pathname === "/v1/agent/help-insights" ||
          ["/v1/agent/views", "/v1/agent/view-page"].includes(url.pathname)
        )
          await inboxEnabled(db, workspace);
        assert(
          (
            await db.query(
              "SELECT name FROM workspace_features WHERE workspace_id=$1 AND name='conversations_v1' AND enabled",
              [workspace],
            )
          ).rows.length,
          "FEATURE_DISABLED",
          "Conversation core is not enabled.",
          404,
        );
      });
      if (req.method === "POST") {
        const p = await readBody(
          req,
          bodyLimit(url.pathname.replace("/v1/agent/", "")),
        );
        assert(
          c.digest === (await digest(p)) &&
            c.method === req.method &&
            c.path === url.pathname &&
            c.key === req.headers.get("idempotency-key"),
          "FORBIDDEN",
          "Request signature does not match.",
          401,
        );
        if (url.pathname === "/v1/agent/realtime-ticket") {
          await tenant(env.connect, workspace, (db) =>
            authorize(db, workspace, principal, "conversations.read"),
          );
          return json({
            url: env.realtimeUrl,
            ticket: await sign(
              { agent: { workspace, principal, inbox } },
              env,
              Math.floor(Date.now() / 1000) + 60,
              "realtime",
            ),
          });
        }
        if (url.pathname === "/v1/agent/help-centers")
          return json(
            await tenant(env.connect, workspace, (db) =>
              once(
                db,
                workspace,
                "help-centers:" + principal,
                req.headers.get("idempotency-key") ?? "",
                p,
                () => changeHelpCenter(db, workspace, principal, p),
              ),
            ),
          );
        if (url.pathname === "/v1/agent/knowledge")
          return json(
            await tenant(env.connect, workspace, (db) =>
              // A retried create or publish returns the first result instead of repeating it.
              once(
                db,
                workspace,
                "knowledge:" + principal,
                req.headers.get("idempotency-key") ?? "",
                p,
                () => changeKnowledge(db, workspace, principal, p),
              ),
            ),
          );
        if (url.pathname === "/v1/agent/settings")
          // Settings (S1): your profile, notifications, and the workspace's General page.
          return json(
            await tenant(env.connect, workspace, (db) =>
              once(
                db,
                workspace,
                "settings:" + principal,
                req.headers.get("idempotency-key") ?? "",
                p,
                () => saveSettings(db, workspace, principal, p),
              ),
            ),
          );
        if (url.pathname === "/v1/agent/knowledge-index") {
          // Phase 07 C2a: re-embed everything beside the active index version.
          assert(
            p.action === "rebuild",
            "INVALID_ACTION",
            "Choose an index action.",
          );
          const result = await tenant(env.connect, workspace, (db) =>
            once(
              db,
              workspace,
              "knowledge-index:" + principal,
              req.headers.get("idempotency-key") ?? "",
              p,
              () => rebuildIndex(db, workspace, principal, env.knowledgeIndex),
            ),
          );
          await env.dispatchJobs?.(workspace);
          return json(result, 202);
        }
        if (url.pathname === "/v1/agent/knowledge-sources") {
          // Phase 07 C1b: websites synced into knowledge.
          const result = await tenant(env.connect, workspace, (db) =>
            once(
              db,
              workspace,
              "knowledge-sources:" + principal,
              req.headers.get("idempotency-key") ?? "",
              p,
              () => changeSource(db, workspace, principal, env.sync ?? {}, p),
            ),
          );
          if ("jobId" in result) await env.dispatchJobs?.(workspace);
          return json(result, "jobId" in result ? 202 : 200);
        }
        if (url.pathname === "/v1/agent/knowledge-files") {
          // Phase 07 C1a: uploads for file records, article images and help center images.
          assert(
            env.attachments,
            "ATTACHMENTS_UNAVAILABLE",
            "File uploads are unavailable.",
            503,
          );
          const storage = env.attachments;
          const key = req.headers.get("idempotency-key") ?? "";
          const result = await tenant(env.connect, workspace, (db) =>
            once(
              db,
              workspace,
              "knowledge-files:" + principal,
              key,
              p,
              (): Promise<Record<string, unknown>> =>
                p.op === "prepare"
                  ? prepareKnowledgeFile(db, workspace, principal, storage, p)
                  : p.op === "complete"
                    ? completeKnowledgeFile(db, workspace, principal, p)
                    : p.op === "remove"
                      ? removeKnowledgeFile(db, workspace, principal, p)
                      : Promise.reject(
                          new DomainError(
                            "INVALID_FILE",
                            "Choose prepare, complete or remove.",
                            400,
                          ),
                        ),
            ),
          );
          if (Array.isArray(result.keys)) {
            // Stored objects go only after the removal committed; storage keys stay server-side.
            const keys = result.keys as string[];
            await deleteKnowledgeObjects(storage, keys);
            return json({ recordId: result.recordId, removed: keys.length });
          }
          if (p.op === "complete") await env.dispatchJobs?.(workspace);
          return json(result, p.op === "complete" ? 202 : 200);
        }
        if (
          url.pathname === "/v1/agent/presence" ||
          url.pathname === "/v1/agent/next"
        ) {
          const result = await tenant(
            env.connect,
            workspace,
            (db): Promise<unknown> =>
              url.pathname === "/v1/agent/presence"
                ? setPresence(db, workspace, principal, p)
                : nextConversation(db, workspace, principal),
          );
          await env.notify?.(workspace, "");
          return json(result);
        }
        if (
          url.pathname === "/v1/agent/teams" ||
          url.pathname === "/v1/agent/teammate-limits"
        ) {
          // A retried save (a new team, say) is applied once and answers the same.
          const result = await tenant(env.connect, workspace, (db) =>
            once(
              db,
              workspace,
              url.pathname.slice(10) + ":" + principal,
              req.headers.get("idempotency-key") ?? "",
              p,
              (): Promise<Record<string, unknown>> =>
                url.pathname === "/v1/agent/teams"
                  ? saveTeam(db, workspace, principal, p)
                  : saveTeammateLimits(db, workspace, principal, p),
            ),
          );
          await env.notify?.(workspace, "");
          return json(result);
        }
        if (url.pathname === "/v1/agent/portal-settings")
          return json(
            await tenant(env.connect, workspace, (db) =>
              portalSettings(db, workspace, principal, p),
            ),
          );
        if (url.pathname === "/v1/agent/sla-policies") {
          const result = await tenant(env.connect, workspace, (db) =>
            once(
              db,
              workspace,
              "sla-policies:" + principal,
              req.headers.get("idempotency-key") ?? "",
              p,
              () => savePolicy(db, workspace, principal, p),
            ),
          );
          await env.dispatchJobs?.(workspace);
          return json(result);
        }
        if (url.pathname === "/v1/agent/calendars")
          return json(
            await tenant(env.connect, workspace, (db) =>
              once(
                db,
                workspace,
                "calendars:" + principal,
                req.headers.get("idempotency-key") ?? "",
                p,
                (): Promise<Record<string, unknown>> =>
                  p.op === "assign"
                    ? assignCalendar(db, workspace, principal, p)
                    : publishCalendar(db, workspace, principal, p),
              ),
            ),
          );
        if (url.pathname === "/v1/agent/tickets") {
          const key = req.headers.get("idempotency-key") ?? "";
          const result = await tenant(
            env.connect,
            workspace,
            (db): Promise<unknown> =>
              p.op === "create"
                ? createInternalTicket(db, workspace, principal, key, p)
                : p.op === "broadcast-prepare"
                  ? prepareBroadcast(db, workspace, principal, p)
                  : p.op === "broadcast-commit"
                    ? commitBroadcast(db, workspace, principal, key, p)
                    : Promise.reject(
                        new DomainError(
                          "INVALID_TICKET_OPERATION",
                          "Choose create, broadcast-prepare or broadcast-commit.",
                        ),
                      ),
          );
          if (p.op === "broadcast-commit") await env.dispatchJobs?.(workspace);
          await env.notify?.(workspace, "");
          return json(result);
        }
        if (url.pathname === "/v1/agent/ticket-types")
          return json(
            await tenant(env.connect, workspace, (db) =>
              saveTicketType(db, workspace, principal, p),
            ),
          );
        if (url.pathname === "/v1/agent/bulk") {
          const key = req.headers.get("idempotency-key") ?? "";
          const result = await tenant(
            env.connect,
            workspace,
            (db): Promise<unknown> =>
              p.op === "prepare"
                ? prepareBulk(db, workspace, principal, p)
                : p.op === "commit"
                  ? commitBulk(db, workspace, principal, key, {
                      ...p,
                      timezone: actor.originTimezone ?? "UTC",
                    })
                  : p.op === "undo"
                    ? undoBulk(db, workspace, principal, key, p)
                    : Promise.reject(
                        new DomainError(
                          "INVALID_BULK",
                          "Choose prepare, commit or undo.",
                        ),
                      ),
          );
          if (p.op !== "prepare") await env.dispatchJobs?.(workspace);
          return json(result, p.op === "prepare" ? 200 : 202);
        }
        if (url.pathname === "/v1/agent/macros") {
          if (p.action === "apply") {
            const result = await tenant(env.connect, workspace, (db) =>
              applyMacro(
                db,
                workspace,
                principal,
                req.headers.get("idempotency-key") ?? "",
                p,
              ),
            );
            // Published only after the actions' transaction has committed.
            await env.notify?.(workspace, String(p.conversationId ?? ""));
            return json(result);
          }
          return json(
            await tenant(env.connect, workspace, (db) =>
              saveMacro(db, workspace, principal, p),
            ),
          );
        }
        if (url.pathname === "/v1/agent/notifications") {
          const result = await tenant(env.connect, workspace, (db) =>
            markNotifications(db, workspace, principal, p),
          );
          await env.notify?.(workspace, "");
          return json(result);
        }
        if (url.pathname === "/v1/agent/drafts") {
          const result = await tenant(env.connect, workspace, (db) =>
            saveDraft(db, workspace, principal, p),
          );
          return result.conflict
            ? json(
                {
                  error: {
                    code: "DRAFT_CONFLICT",
                    message: "This draft changed in another tab or device.",
                  },
                  draft: result.draft,
                },
                409,
              )
            : json({ version: result.version });
        }
        if (url.pathname === "/v1/agent/views") {
          const result = await tenant(env.connect, workspace, (db) =>
            mutateView(
              db,
              workspace,
              principal,
              req.headers.get("idempotency-key") ?? "",
              p,
            ),
          );
          await env.dispatchJobs?.(workspace);
          await env.notify?.(workspace, "");
          return json(result, "jobId" in result ? 202 : 200);
        }
        if (url.pathname === "/v1/agent/attachment/prepare") {
          assert(
            env.attachments,
            "ATTACHMENTS_UNAVAILABLE",
            "File uploads are unavailable.",
            503,
          );
          const attachment = await tenant(env.connect, workspace, (db) =>
            prepareAttachment(
              db,
              workspace,
              actor,
              req.headers.get("idempotency-key") ?? "",
              p,
            ),
          );
          return json({
            attachmentId: attachment.id,
            ...(await env.attachments.signUpload(
              attachment.objectKey,
              attachment.type,
              attachment.size,
            )),
          });
        }
        if (url.pathname === "/v1/agent/attachment/complete") {
          assert(
            env.attachments,
            "ATTACHMENTS_UNAVAILABLE",
            "File uploads are unavailable.",
            503,
          );
          const result = await tenant(env.connect, workspace, (db) =>
            completeAttachment(
              db,
              workspace,
              actor,
              req.headers.get("idempotency-key") ?? "",
              p,
            ),
          );
          await env.dispatchJobs?.(workspace);
          return json(result, 202);
        }
        if (url.pathname === "/v1/agent/search/reindex") {
          const jobId = await tenant(env.connect, workspace, async (db) => {
            const t = await authorize(
              db,
              workspace,
              principal,
              "workspace.manage",
            );
            return once(
              db,
              workspace,
              "search.reindex:" + t.id,
              req.headers.get("idempotency-key") ?? "",
              {},
              () =>
                enqueueJob(
                  db,
                  workspace,
                  "search.reindex",
                  {},
                  { teammateId: t.id },
                ),
            );
          });
          await env.dispatchJobs?.(workspace);
          return json({ jobId }, 202);
        }
        if (url.pathname === "/v1/agent/unread/rebuild") {
          const jobId = await tenant(env.connect, workspace, async (db) => {
            const t = await authorize(
              db,
              workspace,
              principal,
              "workspace.manage",
            );
            return once(
              db,
              workspace,
              "unread.rebuild:" + t.id,
              req.headers.get("idempotency-key") ?? "",
              {},
              () =>
                enqueueJob(
                  db,
                  workspace,
                  "customer.unread.rebuild",
                  {},
                  { teammateId: t.id },
                ),
            );
          });
          await env.dispatchJobs?.(workspace);
          return json({ jobId }, 202);
        }
        const result = await tenant(env.connect, workspace, (db) =>
          command(
            db,
            workspace,
            actor,
            req.headers.get("idempotency-key") ?? "",
            p,
          ),
        );
        await env.notify?.(
          workspace,
          "aliases" in result
            ? ""
            : "conversationId" in result
              ? String(result.conversationId)
              : "",
        );
        if ("metricsJobId" in result) await env.dispatchJobs?.(workspace);
        return json(result);
      }
      assert(
        c.method === "GET" && c.path === url.pathname && c.query === url.search,
        "FORBIDDEN",
        "Request signature does not match.",
        401,
      );
      if (url.pathname === "/v1/agent/knowledge-file") {
        assert(
          env.attachments?.readClean,
          "ATTACHMENTS_UNAVAILABLE",
          "File downloads are unavailable.",
          503,
        );
        const file = await tenant(env.connect, workspace, (db) =>
          teammateFile(
            db,
            workspace,
            principal,
            url.searchParams.get("id") ?? "",
          ),
        );
        return fileResponse(env.attachments, file, {
          download: !file.image || url.searchParams.get("download") === "1",
          cache: "private, max-age=300",
        });
      }
      if (url.pathname === "/v1/agent/attachment/content") {
        assert(
          env.attachments?.readClean,
          "ATTACHMENTS_UNAVAILABLE",
          "File downloads are unavailable.",
          503,
        );
        const preview = url.searchParams.get("preview") === "true";
        const key = await tenant(env.connect, workspace, (db) =>
          downloadAttachment(
            db,
            workspace,
            actor,
            url.searchParams.get("id") ?? "",
            preview,
          ),
        );
        const file = await env.attachments.readClean(key);
        const headers = new Headers({
          "cache-control": "private, no-store",
          "content-type":
            file.headers.get("content-type") ?? "application/octet-stream",
          "content-disposition": preview ? "inline" : "attachment",
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; sandbox",
        });
        return new Response(file.body, { status: file.status, headers });
      }
      if (url.pathname === "/v1/agent/context")
        return json(
          await tenant(env.connect, workspace, (db) =>
            conversationContext(
              db,
              workspace,
              principal,
              url.searchParams.get("conversation") ?? "",
            ),
          ),
        );
      if (url.pathname === "/v1/agent/ticket-types")
        return json(
          await tenant(env.connect, workspace, (db) =>
            listTicketTypes(db, workspace, principal),
          ),
        );
      if (url.pathname === "/v1/agent/calendars")
        return json(
          await tenant(env.connect, workspace, (db) =>
            listCalendars(db, workspace, principal),
          ),
        );
      if (url.pathname === "/v1/agent/portal-settings")
        return json(
          await tenant(env.connect, workspace, (db) =>
            portalSettings(db, workspace, principal),
          ),
        );
      if (url.pathname === "/v1/agent/teams")
        return json(
          await tenant(env.connect, workspace, (db) =>
            listTeams(db, workspace, principal),
          ),
        );
      if (url.pathname === "/v1/agent/knowledge")
        return json(
          await tenant(env.connect, workspace, (db) =>
            listKnowledge(db, workspace, principal, url.searchParams),
          ),
        );
      if (url.pathname === "/v1/agent/help-centers")
        return json(
          await tenant(env.connect, workspace, (db) =>
            listHelpCenters(db, workspace, principal),
          ),
        );
      if (url.pathname === "/v1/agent/help-insights")
        return json(
          await tenant(env.connect, workspace, (db) =>
            helpInsights(
              db,
              workspace,
              principal,
              url.searchParams.get("centerId") ?? "",
              Number(url.searchParams.get("days") ?? 30),
            ),
          ),
        );
      if (url.pathname === "/v1/agent/help-center")
        return json(
          await tenant(env.connect, workspace, (db) =>
            readHelpCenter(
              db,
              workspace,
              principal,
              url.searchParams.get("id") ?? "",
            ),
          ),
        );
      if (url.pathname === "/v1/agent/knowledge-sources")
        return json(
          await tenant(env.connect, workspace, (db) =>
            listSources(db, workspace, principal),
          ),
        );
      if (url.pathname === "/v1/agent/settings") {
        const section = url.searchParams.get("section") ?? "overview";
        return json(
          await tenant(
            env.connect,
            workspace,
            (db): Promise<Record<string, unknown>> =>
              section === "overview"
                ? settingsOverview(db, workspace, principal)
                : readSettings(db, workspace, principal, section),
          ),
        );
      }
      if (url.pathname === "/v1/agent/knowledge-index")
        return json(
          await tenant(env.connect, workspace, (db) =>
            indexStatus(db, workspace, principal, env.knowledgeIndex),
          ),
        );
      if (url.pathname === "/v1/agent/knowledge-retrieve")
        return json(
          await tryRetrieval(
            env.connect,
            env.knowledgeIndex,
            workspace,
            principal,
            url.searchParams.get("q") ?? "",
            url.searchParams.get("purpose") ?? "ai",
          ),
        );
      if (url.pathname === "/v1/agent/knowledge-source")
        return json(
          await tenant(env.connect, workspace, (db) =>
            readSource(
              db,
              workspace,
              principal,
              url.searchParams.get("id") ?? "",
            ),
          ),
        );
      if (url.pathname === "/v1/agent/knowledge-record")
        return json(
          await tenant(env.connect, workspace, (db) =>
            readKnowledge(
              db,
              workspace,
              principal,
              url.searchParams.get("id") ?? "",
            ),
          ),
        );
      if (url.pathname === "/v1/agent/workload")
        return json(
          await tenant(env.connect, workspace, (db) =>
            myWorkload(db, workspace, principal),
          ),
        );
      if (url.pathname === "/v1/agent/sla-policies")
        return json(
          await tenant(env.connect, workspace, (db) =>
            listPolicies(db, workspace, principal),
          ),
        );
      if (url.pathname === "/v1/agent/calendar-resolve")
        return json(
          await tenant(env.connect, workspace, async (db) =>
            conversationCalendar(
              db,
              workspace,
              principal,
              await conversation(
                db,
                workspace,
                url.searchParams.get("conversation") ?? "",
              ),
            ),
          ),
        );
      if (url.pathname === "/v1/agent/tickets")
        return json(
          await tenant(env.connect, workspace, (db) =>
            listTrackers(db, workspace, principal),
          ),
        );
      if (url.pathname === "/v1/agent/ticket-broadcast")
        return json(
          await tenant(env.connect, workspace, (db) =>
            readBroadcast(
              db,
              workspace,
              principal,
              url.searchParams.get("id") ?? "",
            ),
          ),
        );
      if (url.pathname === "/v1/agent/ticket-preview")
        return json(
          await tenant(env.connect, workspace, async (db) => {
            await authorize(db, workspace, principal, "conversations.manage");
            let mapping: unknown = {};
            try {
              mapping = JSON.parse(url.searchParams.get("mapping") || "{}");
            } catch {
              throw new DomainError("TICKET_MAPPING", "Invalid field mapping.");
            }
            return previewTypeChange(
              db,
              workspace,
              await conversation(
                db,
                workspace,
                url.searchParams.get("conversation") ?? "",
              ),
              {
                typeId: url.searchParams.get("type") ?? "",
                stateId: url.searchParams.get("state") ?? undefined,
                mapping,
              },
            );
          }),
        );
      if (url.pathname === "/v1/agent/bulk")
        return json(
          await tenant(env.connect, workspace, (db) =>
            readBulk(
              db,
              workspace,
              principal,
              url.searchParams.get("id") ?? "",
            ),
          ),
        );
      if (url.pathname === "/v1/agent/macros")
        return json(
          await tenant(env.connect, workspace, (db) =>
            listMacros(db, workspace, principal),
          ),
        );
      if (url.pathname === "/v1/agent/notifications")
        return json(
          await tenant(env.connect, workspace, (db) =>
            listNotifications(db, workspace, principal),
          ),
        );
      if (url.pathname === "/v1/agent/drafts")
        return json(
          await tenant(env.connect, workspace, (db) =>
            readDrafts(
              db,
              workspace,
              principal,
              url.searchParams.get("conversation") ?? "",
            ),
          ),
        );
      if (url.pathname === "/v1/agent/history") {
        const id = url.searchParams.get("conversation") ?? "",
          before = url.searchParams.get("before");
        // Without `before`: the first screen, as the socket would send it, for prefetching.
        // Its cursor resumes live replay on subscribe; `older` pages back from it.
        return json(
          before === null
            ? await agentHistoryPage(
                env,
                {
                  kind: "agent",
                  inbox: true,
                  workspace,
                  principal,
                  teammateId: "",
                  expiresAt: Date.now() / 1000 + 60,
                },
                id,
              )
            : await agentOlderPage(env, workspace, principal, id, before),
        );
      }
      return json(
        await tenant(env.connect, workspace, async (db) => {
          const t = await authorize(
            db,
            workspace,
            principal,
            "conversations.read",
          );
          if (
            ["/v1/agent/views", "/v1/agent/view-page"].includes(url.pathname)
          ) {
            await viewsEnabled(db, workspace);
            return url.pathname.endsWith("view-page")
              ? viewPage(db, workspace, t, principal, url.searchParams)
              : viewSnapshot(db, workspace, t);
          }
          if (url.pathname === "/v1/agent/search")
            return searchConversations(db, workspace, url.searchParams);
          if (url.pathname === "/v1/agent/job")
            return readJob(db, workspace, url.searchParams.get("id") ?? "", {
              teammateId: t.id,
            });
          const personalData = await can(
            db,
            workspace,
            principal,
            "contacts.personal_data",
          );
          const id = url.searchParams.get("conversation");
          if (id) {
            const data = await timeline(db, workspace, id, actor);
            return {
              ...data,
              conversation: agentConversation(data.conversation, personalData),
            };
          }
          const listed = (
            await db.query<Conversation & { activity_at: string }>(
              `SELECT c.*,COALESCE(GREATEST(c.last_contact_reply_at,c.last_teammate_reply_at),c.created_at) AS activity_at
               FROM conversations c WHERE c.workspace_id=$1 AND c.merged_into_id IS NULL ORDER BY c.updated_at DESC,c.id LIMIT 100`,
              [workspace],
            )
          ).rows;
          const previews = await listPreviews(
            db,
            workspace,
            listed.map((c) => c.id),
          );
          const conversations = listed.map((c) => ({
            ...agentConversation(c, personalData),
            activity_at: c.activity_at,
            preview: previews.get(c.id) ?? null,
          }));
          const counters = (
            await db.query(
              "SELECT view,count::int,version FROM inbox_counters WHERE workspace_id=$1 AND teammate_id=$2",
              [workspace, t.id],
            )
          ).rows;
          // Workspace directory for names in the timeline and targets in the command palette.
          const directory = async (table: "teammates" | "teams" | "tags") =>
            (
              await db.query<{ id: string; name: string }>(
                `SELECT id,name FROM ${table} WHERE workspace_id=$1 ORDER BY name,id LIMIT 500`,
                [workspace],
              )
            ).rows;
          // The account menu: the teammate's role and the workspace's name.
          const account = (
            await db.query<{ role: string; workspace_name: string }>(
              `SELECT r.name AS role,w.brand AS workspace_name FROM teammates t
              JOIN roles r ON r.workspace_id=t.workspace_id AND r.id=t.role_id
              JOIN workspace w ON w.id=t.workspace_id
              WHERE t.workspace_id=$1 AND t.id=$2`,
              [workspace, t.id],
            )
          ).rows[0];
          return {
            conversations,
            counters,
            teammate: t,
            account: {
              role: account?.role ?? t.role_id,
              workspace: {
                id: workspace,
                name: account?.workspace_name ?? workspace,
              },
            },
            teammates: await directory("teammates"),
            teams: await directory("teams"),
            tags: await directory("tags"),
            storage: {
              engine: "postgresql",
              transport: env.storageTransport ?? "hyperdrive",
              workspaceId: workspace,
            },
            capabilities: {
              views: !!(
                await db.query(
                  "SELECT name FROM workspace_features WHERE workspace_id=$1 AND name='agent_inbox_views_v1' AND enabled",
                  [workspace],
                )
              ).rows.length,
              reply: await can(db, workspace, principal, "conversations.reply"),
              note: await can(db, workspace, principal, "conversations.note"),
              manage: await can(
                db,
                workspace,
                principal,
                "conversations.manage",
              ),
              macros: await can(db, workspace, principal, "macros.use"),
              // Phase 07: the Knowledge section, when the workspace has it.
              knowledge: !!(
                await db.query(
                  "SELECT name FROM workspace_features WHERE workspace_id=$1 AND name='knowledge_v1' AND enabled",
                  [workspace],
                )
              ).rows.length,
              attachments: !!env.attachments,
              // Settings (S1), when the workspace has it.
              settings: await settingsEnabled(db, workspace),
            },
            // Your own preferences: the signature added to replies, and how you're notified.
            profile: (
              await db.query<{
                signature: string;
                notification_prefs: unknown;
              }>(
                "SELECT signature,notification_prefs FROM teammates WHERE workspace_id=$1 AND id=$2",
                [workspace, t.id],
              )
            ).rows.map((r) => ({
              signature: r.signature,
              notifications: {
                desktop:
                  (r.notification_prefs as { desktop?: boolean })?.desktop ===
                  true,
                sound:
                  (r.notification_prefs as { sound?: boolean })?.sound === true,
              },
            }))[0],
          };
        }),
      );
    }
    if (url.pathname === "/v1/messenger/command" && req.method === "POST") {
      const s = await sessionClaims(req, env);
      const p = await readBody(req);
      const result = await tenant(env.connect, s.workspace, async (db) => {
        await validateSession(db, s);
        const b = await brand(db, s.workspace, s.brandId);
        if (origin) {
          if (origin !== url.origin) allowedOrigin(b, origin);
          corsOrigin = origin;
        }
        // Help context is never taken from the client: it is rebuilt from a verified search
        // receipt and an article this customer may read (phase 07, B2).
        const started = p as Command & {
          searchReceipt?: unknown;
          helpArticleId?: unknown;
          helpFeedbackId?: unknown;
        };
        delete started.helpContext;
        if (started.action === "start") {
          const scope = helpScope(s);
          const searched = await verifyReceipt(
            env.sessionSecret,
            started.searchReceipt,
            {
              workspace: s.workspace,
              brand: s.brandId,
              identity: s.identityId,
            },
          );
          const article = await helpContextArticle(
            db,
            scope,
            started.helpArticleId,
          );
          if (searched || article)
            started.helpContext = {
              ...(searched ? { searched } : {}),
              ...(article
                ? {
                    article,
                    ...(started.helpFeedbackId
                      ? { feedback: "not_helpful" as const }
                      : {}),
                  }
                : {}),
            };
        }
        const result = await command(
          db,
          s.workspace,
          {
            type: "contact",
            identityId: s.identityId,
            brandId: s.brandId,
            verified: s.verified,
            originTimezone: s.originTimezone,
          },
          req.headers.get("idempotency-key") ?? "",
          started,
        );
        if (
          started.action === "start" &&
          typeof started.helpFeedbackId === "string" &&
          "conversationId" in result
        )
          await linkFeedback(
            db,
            s.workspace,
            started.helpFeedbackId,
            String(result.conversationId),
            s.identityId,
          );
        return result;
      });
      await env.notify?.(
        s.workspace,
        "conversationId" in result ? String(result.conversationId) : "",
      );
      return json(result);
    }
    if (url.pathname === "/v1/messenger/help/file" && req.method === "GET") {
      // An image in a help article. An <img> cannot send the session token, so the article
      // response hands out short-lived signed addresses instead (phase 07 C1a).
      const signed = await verifyFileUrl(env.sessionSecret, url.searchParams);
      if (!signed || !env.attachments?.readClean)
        return new Response("Not found", { status: 404 });
      const file = await tenant(env.connect, signed.workspace, (db) =>
        articleImage(db, signed.workspace, signed.id),
      );
      if (!file) return new Response("Not found", { status: 404 });
      return fileResponse(env.attachments, file, {
        download: false,
        cache: "private, max-age=3600",
      });
    }
    const s = await requireSession(req, env);
    await tenant(env.connect, s.workspace, async (db) => {
      const b = await brand(db, s.workspace, s.brandId);
      if (origin) {
        if (origin !== url.origin) allowedOrigin(b, origin);
        corsOrigin = origin;
      }
    });
    const actor: Actor = {
      type: "contact",
      identityId: s.identityId,
      brandId: s.brandId,
      verified: s.verified,
      originTimezone: s.originTimezone,
    };
    if (url.pathname === "/v1/messenger/job" && req.method === "GET")
      return json(
        await tenant(env.connect, s.workspace, (db) =>
          readJob(db, s.workspace, url.searchParams.get("id") ?? "", {
            identityId: s.identityId,
          }),
        ),
      );
    if (url.pathname === "/v1/messenger/attachment" && req.method === "GET") {
      assert(
        env.attachments,
        "ATTACHMENTS_UNAVAILABLE",
        "File uploads are unavailable.",
        503,
      );
      const preview = url.searchParams.get("preview") === "true";
      const key = await tenant(env.connect, s.workspace, (db) =>
        downloadAttachment(
          db,
          s.workspace,
          actor,
          url.searchParams.get("id") ?? "",
          preview,
        ),
      );
      return json(await env.attachments.signDownload(key, preview));
    }
    if (url.pathname.startsWith("/v1/messenger/help") && req.method === "GET") {
      const scope = helpScope(s);
      const route = url.pathname.slice("/v1/messenger/help".length);
      return json(
        await tenant(env.connect, s.workspace, async (db) => {
          if (route === "") return messengerHelp(db, scope);
          if (route === "/collection")
            return messengerCollection(
              db,
              scope,
              url.searchParams.get("id") ?? "",
            );
          if (route === "/article")
            return messengerArticle(
              db,
              scope,
              url.searchParams.get("id") ?? "",
              url.searchParams.get("query"),
              env.sessionSecret,
            );
          if (route === "/search")
            return messengerSearch(
              db,
              scope,
              url.searchParams.get("q") ?? "",
              env.sessionSecret,
            );
          throw new DomainError("NOT_FOUND", "Route not found.", 404);
        }),
      );
    }
    if (url.pathname === "/v1/messenger/unread" && req.method === "GET")
      return json(await unreadSnapshot(env, s));
    if (url.pathname === "/v1/messenger/history" && req.method === "GET")
      return json(
        await historyPage(
          env,
          s,
          url.searchParams.get("conversation") ?? "",
          url.searchParams.get("cursor") ?? undefined,
        ),
      );
    if (
      url.pathname === "/v1/messenger/conversations" &&
      req.method === "GET"
    ) {
      return json(
        await tenant(env.connect, s.workspace, async (db) => {
          const audience = await customerAudience(
            db,
            s.workspace,
            s.identityId,
            s.verified,
          );
          const rows = (
            await db.query<{
              id: string;
              title: string;
              updated_at: string;
              status: string;
              unread: boolean;
            }>(
              `WITH RECURSIVE related AS (
     SELECT id FROM contacts WHERE workspace_id=$1 AND id=$5 AND $4::boolean
     UNION ALL SELECT c.id FROM contacts c JOIN related r ON c.merged_into_contact_id=r.id WHERE c.workspace_id=$1
    ), eligible AS (SELECT $2::text AS id UNION SELECT identity_id FROM identity_contact_mappings WHERE workspace_id=$1 AND $4::boolean AND contact_id IN(SELECT id FROM related))
    SELECT c.id,c.title,c.updated_at,c.status,EXISTS(SELECT 1 FROM customer_unread_threads u WHERE u.workspace_id=$1 AND u.audience_type=$6 AND u.audience_id=$5 AND u.conversation_id=c.id) AS unread
    FROM conversations c WHERE c.workspace_id=$1 AND c.brand_id=$3 AND c.merged_into_id IS NULL AND c.visibility='customer' AND (c.primary_identity_id IN(SELECT id FROM eligible) OR EXISTS(SELECT 1 FROM conversation_participants cp WHERE cp.workspace_id=$1 AND cp.conversation_id=c.id AND cp.identity_id IN(SELECT id FROM eligible)))
    ORDER BY c.updated_at DESC,c.id LIMIT 100`,
              [
                s.workspace,
                s.identityId,
                s.brandId,
                s.verified,
                audience.id,
                audience.type,
              ],
            )
          ).rows;
          return { conversations: rows };
        }),
      );
    }
    if (req.method === "POST") {
      const p = await readBody(req),
        key = req.headers.get("idempotency-key") ?? "";
      if (url.pathname === "/v1/messenger/help/feedback")
        return json(
          await tenant(env.connect, s.workspace, (db) =>
            once(db, s.workspace, "help-feedback:" + s.identityId, key, p, () =>
              messengerFeedback(db, helpScope(s), p),
            ),
          ),
        );
      if (url.pathname === "/v1/messenger/attachment/prepare") {
        assert(
          env.attachments,
          "ATTACHMENTS_UNAVAILABLE",
          "File uploads are unavailable.",
          503,
        );
        const a = await tenant(env.connect, s.workspace, (db) =>
          prepareAttachment(db, s.workspace, actor, key, p),
        );
        return json({
          attachmentId: a.id,
          ...(await env.attachments.signUpload(a.objectKey, a.type, a.size)),
        });
      }
      if (url.pathname === "/v1/messenger/attachment/complete") {
        assert(
          env.attachments,
          "ATTACHMENTS_UNAVAILABLE",
          "File uploads are unavailable.",
          503,
        );
        const result = await tenant(env.connect, s.workspace, (db) =>
          completeAttachment(db, s.workspace, actor, key, p),
        );
        await env.dispatchJobs?.(s.workspace);
        return json(result, 202);
      }
      if (url.pathname === "/v1/messenger/read") {
        const result = await tenant(env.connect, s.workspace, (db) =>
          once(db, s.workspace, "read:" + s.sessionId, key, p, async () => {
            const c = await conversation(
              db,
              s.workspace,
              p.conversationId,
              true,
            );
            await access(db, s.workspace, c, actor);
            await customerRead(
              db,
              s.workspace,
              s.identityId,
              s.brandId,
              p.conversationId,
              p.partId,
              s.verified,
            );
            return { ok: true };
          }),
        );
        await env.notify?.(s.workspace, "");
        return json(result);
      }
      if (url.pathname === "/v1/messenger/context")
        return json(
          await tenant(env.connect, s.workspace, (db) =>
            once(
              db,
              s.workspace,
              "session:" + s.sessionId,
              key,
              p,
              async () => {
                await db.query(
                  "UPDATE messenger_sessions SET page_url=$3,version=version+1 WHERE workspace_id=$1 AND id=$2",
                  [s.workspace, s.sessionId, pageUrl(p.pageUrl)],
                );
                return { ok: true };
              },
            ),
          ),
        );
      if (url.pathname === "/v1/messenger/logout") {
        const result = await tenant(env.connect, s.workspace, (db) =>
          once(db, s.workspace, "logout:" + s.sessionId, key, {}, async () => {
            await db.query(
              "UPDATE messenger_sessions SET revoked_at=now() WHERE workspace_id=$1 AND id=$2",
              [s.workspace, s.sessionId],
            );
            return { ok: true };
          }),
        );
        await env.notify?.(s.workspace, "");
        return json(result);
      }
      if (url.pathname === "/v1/messenger/portal-handoff")
        return json(
          await tenant(env.connect, s.workspace, (db) =>
            createHandoff(db, s, url.origin),
          ),
        );
      if (url.pathname === "/v1/messenger/realtime-ticket")
        return json({
          ticket: await sign(
            { sessionToken: req.headers.get("authorization")!.slice(7) },
            env,
            Math.floor(Date.now() / 1000) + 60,
            "realtime",
          ),
          url: env.realtimeUrl,
        });
    }
    throw new DomainError("NOT_FOUND", "Endpoint unavailable.", 404);
  } catch (error) {
    if (error instanceof DomainError)
      return json(
        {
          error: {
            code: error.code,
            message: error.message,
            ...(error.details ? { details: error.details } : {}),
          },
        },
        error.status,
      );
    console.error("Relay API failed", errorFingerprint(error));
    return json(
      {
        error: {
          code: "UNAVAILABLE",
          message: "Support is temporarily unavailable. Please try again.",
        },
      },
      503,
    );
  }
}

/** The messenger session as a help center visitor (phase 07, B2). */
const helpScope = (s: Session): MessengerScope => ({
  workspace: s.workspace,
  brand: s.brandId,
  identity: s.identityId,
  verified: s.verified,
  locale: s.locale ?? "en",
});

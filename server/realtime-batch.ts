import { viewCounts } from "./inbox-views";
import { tenant, type Connect } from "./db";
import { isAgent, type RealtimeSession, type Session } from "./api";
import type { RealtimeClient } from "./realtime";
import { customerUnreadSnapshots } from "./unread";

export function sessionKey(s: RealtimeSession) {
  return (
    s.workspace +
    ":" +
    (isAgent(s)
      ? "agent:" + s.principal + ":" + s.expiresAt + ":" + !!s.inbox
      : "contact:" + s.sessionId)
  );
}
/** One authorization/counter snapshot per workspace fanout, not one database round trip per socket. */
export async function notifyWorkspace(
  connect: Connect,
  w: string,
  clients: Iterable<RealtimeClient>,
  conversationId: string | string[],
) {
  const peers = [...clients].filter((c) => c.session?.workspace === w),
    sessions = peers.map((c) => c.session!);
  if (!peers.length) return;
  const agents = sessions.filter(isAgent),
    customers = sessions.filter((s): s is Session => !isAgent(s));
  const snapshot = await tenant(connect, w, async (db) => {
    const hints =
      typeof conversationId === "string" ? [conversationId] : conversationId;
    const aliases = hints.includes("")
      ? [""]
      : (
          await db.query<{ id: string }>(
            `WITH RECURSIVE roots AS (
   SELECT id,merged_into_id FROM conversations WHERE workspace_id=$1 AND id=ANY($2::text[])
   UNION SELECT c.id,c.merged_into_id FROM conversations c JOIN roots r ON r.merged_into_id=c.id WHERE c.workspace_id=$1
  ), family AS (SELECT id FROM roots WHERE merged_into_id IS NULL UNION SELECT c.id FROM conversations c JOIN family f ON c.merged_into_id=f.id WHERE c.workspace_id=$1) SELECT id FROM family`,
            [w, hints],
          )
        ).rows.map((r) => r.id);
    const inboxEnabled =
      !agents.some((s) => s.inbox) ||
      !!(
        await db.query(
          "SELECT name FROM workspace_features WHERE workspace_id=$1 AND name='agent_inbox_v1' AND enabled",
          [w],
        )
      ).rows.length;
    const roles = (
      await db.query<{ id: string; principal_id: string }>(
        "SELECT t.id,t.principal_id FROM teammates t JOIN role_capabilities c ON c.workspace_id=t.workspace_id AND c.role_id=t.role_id AND c.capability='conversations.read' JOIN workspace_features f ON f.workspace_id=t.workspace_id AND f.name='conversations_v1' AND f.enabled WHERE t.workspace_id=$1 AND t.id=ANY($2::text[])",
        [w, [...new Set(agents.map((s) => s.teammateId))]],
      )
    ).rows;
    const active = (
      await db.query<{ id: string }>(
        "SELECT s.id FROM messenger_sessions s JOIN workspace_features f ON f.workspace_id=s.workspace_id AND f.name='messenger_v2' AND f.enabled WHERE s.workspace_id=$1 AND s.id=ANY($2::text[]) AND s.revoked_at IS NULL AND s.expires_at>now()",
        [w, customers.map((s) => s.sessionId)],
      )
    ).rows;
    const agentCounts = (
      await db.query<{
        teammate_id: string;
        view: string;
        count: number;
        version: string;
      }>(
        "SELECT teammate_id,view,count::int,version FROM inbox_counters WHERE workspace_id=$1 AND teammate_id=ANY($2::text[]) ORDER BY teammate_id,view",
        [w, roles.map((r) => r.id)],
      )
    ).rows;
    const customerCounts = await customerUnreadSnapshots(db, w, [
      ...new Map(customers.map((s) => [s.sessionId, s])).values(),
    ]);
    return {
      roles,
      inboxEnabled,
      active: new Set(active.map((s) => s.id)),
      viewCounts: agents.some((s) => s.inbox)
        ? await viewCounts(
            db,
            w,
            roles.map((r) => r.id),
          )
        : [],
      agentCounts,
      customerCounts,
      aliases,
    };
  });
  const byAgent = new Map<
    string,
    { view: string; count: number; version: string }[]
  >();
  for (const c of snapshot.agentCounts) {
    const rows = byAgent.get(c.teammate_id) ?? [];
    rows.push({ view: c.view, count: c.count, version: c.version });
    byAgent.set(c.teammate_id, rows);
  }
  const byCustomer = new Map(
    snapshot.customerCounts.map((c) => [c.session_id, c]),
  );
  const roles = new Set(snapshot.roles.map((r) => r.id + ":" + r.principal_id));
  await Promise.all(
    peers.map((client, i) => {
      const s = sessions[i],
        key = sessionKey(s);
      if (isAgent(s)) {
        const allowed =
          (!s.inbox || snapshot.inboxEnabled) &&
          s.expiresAt > Date.now() / 1000 &&
          roles.has(s.teammateId + ":" + s.principal);
        if (!allowed) return client.rejectSession(key);
        return client.notify(snapshot.aliases, {
          sessionKey: key,
          unread: {
            views: byAgent.get(s.teammateId) ?? [],
            viewCounts: s.inbox
              ? snapshot.viewCounts.filter(
                  (v) => v.shared || v.owner_id === s.teammateId,
                )
              : [],
          },
        });
      }
      if (!snapshot.active.has(s.sessionId)) return client.rejectSession(key);
      const unread = byCustomer.get(s.sessionId);
      return client.notify(snapshot.aliases, {
        sessionKey: key,
        unread: {
          unread_count: unread?.unread_count ?? 0,
          version: unread?.version ?? "0",
        },
      });
    }),
  );
}

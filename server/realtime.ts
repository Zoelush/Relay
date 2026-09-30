import {
  historyPage,
  agentHistoryPage,
  validateRealtime,
  isAgent,
  socketContext,
  realtimeUnread,
  type ApiEnvironment,
  type RealtimeSession,
} from "./api";
import { assert, DomainError } from "./db";
import { tenant } from "./db";
import { readJob } from "./jobs";
import { sessionKey } from "./realtime-batch";

export interface Wire {
  send(data: string): void;
  close(code: number, reason: string): void;
}
export class RealtimeClient {
  token = "";
  session?: RealtimeSession;
  subscriptions = new Map<string, string | undefined>();
  jobs = new Set<string>();
  presence = "active";
  private ephemeralAt = 0;
  private viewingAt = new Map<string, number>();
  private lastUnread = "";
  private chain: Promise<void> = Promise.resolve();
  constructor(
    private wire: Wire,
    private env: ApiEnvironment,
    private ephemeral: (
      sender: RealtimeClient,
      data: Record<string, unknown>,
    ) => void,
    private workspace?: string,
  ) {}
  receive(raw: string) {
    this.chain = this.chain
      .then(() => this.process(raw))
      .catch((error) => this.fail(error));
    return this.chain;
  }
  notify(
    id: string | string[],
    prepared?: { sessionKey: string; unread: Record<string, unknown> },
  ) {
    this.chain = this.chain
      .then(async () => {
        if (this.session) {
          if (prepared && prepared.sessionKey !== sessionKey(this.session))
            return;
          if (!prepared)
            this.session = await validateRealtime(
              this.env,
              this.session,
              this.token,
            );
          const ids = new Set(typeof id === "string" ? [id] : id);
          for (const conversationId of this.subscriptions.keys())
            if (ids.has("") || ids.has(conversationId))
              await this.replay(conversationId);
          this.emitUnread(
            prepared?.unread ?? (await realtimeUnread(this.env, this.session)),
          );
          if (isAgent(this.session) && this.session.inbox)
            this.emit({ type: "inbox_changed" });
        }
      })
      .catch((error) => this.fail(error));
    return this.chain;
  }
  rejectSession(expected: string) {
    this.chain = this.chain.then(() => {
      if (this.session && sessionKey(this.session) === expected)
        this.wire.close(4401, "Session expired");
    });
    return this.chain;
  }
  private async process(raw: string) {
    if (raw.length > 20000)
      throw new DomainError("FRAME_TOO_LARGE", "Frame too large.");
    const message = JSON.parse(raw);
    if (message.type === "authenticate") {
      this.session = undefined;
      this.token = "";
      this.subscriptions.clear();
      this.jobs.clear();
      this.lastUnread = "";
      const { session, token } = await socketContext(
        String(message.ticket),
        this.env,
      );
      assert(
        !this.workspace || this.workspace === session.workspace,
        "FORBIDDEN",
        "Workspace mismatch.",
        403,
      );
      this.session = session;
      this.token = token;
      this.emit({ type: "ready" });
      this.emitUnread(await realtimeUnread(this.env, session));
      return;
    }
    if (!this.session)
      throw new DomainError(
        "AUTH_REQUIRED",
        "Authenticate the connection.",
        401,
      );
    if (this.session.expiresAt && this.session.expiresAt <= Date.now() / 1000)
      throw new DomainError(
        "SESSION_EXPIRED",
        "Refresh session authorization.",
        401,
      );
    if (message.type === "subscribe") {
      if (
        this.subscriptions.size >= 20 &&
        !this.subscriptions.has(message.conversationId)
      )
        throw new DomainError("SUBSCRIPTION_LIMIT", "Too many subscriptions.");
      this.subscriptions.set(
        String(message.conversationId),
        message.cursor || undefined,
      );
      await this.replay(String(message.conversationId));
      // Teammates see each other arrive; `joined` asks peers to announce themselves back.
      if (isAgent(this.session))
        this.ephemeral(this, {
          ...this.viewing(String(message.conversationId), true),
          joined: true,
        });
      return;
    }
    if (message.type === "unsubscribe") {
      const id = String(message.conversationId);
      if (this.subscriptions.delete(id) && isAgent(this.session))
        this.ephemeral(this, this.viewing(id, false));
      return;
    }
    if (
      message.type === "viewing" &&
      isAgent(this.session) &&
      this.subscriptions.has(message.conversationId)
    ) {
      // Refreshes "viewing" before it expires; the inbox sends this every 30 seconds.
      const id = String(message.conversationId);
      if (Date.now() - (this.viewingAt.get(id) ?? 0) < 5000) return;
      this.viewingAt.set(id, Date.now());
      this.ephemeral(this, this.viewing(id, true));
      return;
    }
    if (message.type === "subscribe_job") {
      assert(
        this.jobs.size < 20 || this.jobs.has(message.jobId),
        "SUBSCRIPTION_LIMIT",
        "Too many job subscriptions.",
      );
      await this.pushJob(String(message.jobId));
      this.jobs.add(String(message.jobId));
      return;
    }
    if (
      message.type === "typing" &&
      this.subscriptions.has(message.conversationId)
    ) {
      // Only "active" typing is throttled: a stop signal must never be dropped, and must not use
      // up the window for the active signal that often follows it (for example, a mode switch).
      if (message.active) {
        if (Date.now() - this.ephemeralAt < 200) return;
        this.ephemeralAt = Date.now();
      }
      const s = this.session;
      this.ephemeral(this, {
        type: "typing",
        conversationId: message.conversationId,
        authorType: isAgent(s) ? "teammate" : "contact",
        authorId: isAgent(s) ? s.teammateId : s.identityId,
        // A teammate's typing is a note unless it says reply, so a missing or unknown mode
        // can never reach the customer.
        ...(isAgent(s)
          ? { mode: message.mode === "reply" ? "reply" : "note" }
          : {}),
        active: !!message.active,
        expiresAt: Date.now() + 5000,
      });
      return;
    }
    if (message.type === "presence" && isAgent(this.session)) {
      assert(
        ["active", "away", "away_reassigning"].includes(message.status),
        "INVALID_PRESENCE",
        "Choose a supported presence.",
      );
      this.presence = message.status;
      this.ephemeral(this, {
        type: "presence",
        teammateId: this.session.teammateId,
        status: message.status,
        expiresAt: Date.now() + 45000,
      });
      return;
    }
    if (message.type === "ping") {
      this.session = await validateRealtime(this.env, this.session, this.token);
      this.emit({ type: "pong" });
      return;
    }
    throw new DomainError("INVALID_FRAME", "Unsupported realtime frame.");
  }
  private viewing(conversationId: string, active: boolean) {
    return {
      type: "viewing",
      conversationId,
      teammateId: isAgent(this.session!) ? this.session.teammateId : "",
      active,
      expiresAt: Date.now() + VIEWING_TTL_MS,
    };
  }
  /** Announces that this teammate left every conversation it had open (socket closed). */
  leave() {
    if (!this.session || !isAgent(this.session)) return;
    for (const id of this.subscriptions.keys())
      this.ephemeral(this, this.viewing(id, false));
    this.subscriptions.clear();
  }
  private async replay(id: string) {
    assert(this.session, "AUTH_REQUIRED", "Authenticate the connection.", 401);
    // Agent expiry, feature flag, capabilities and history are checked together
    // inside agentHistoryPage's tenant transaction, rather than in three transactions.
    if (!isAgent(this.session))
      this.session = await validateRealtime(this.env, this.session, this.token);
    let more = true;
    while (more) {
      const data = await (isAgent(this.session)
        ? agentHistoryPage(
            this.env,
            this.session,
            id,
            this.subscriptions.get(id),
          )
        : historyPage(this.env, this.session, id, this.subscriptions.get(id)));
      this.emit({ type: "timeline", conversationId: id, ...data });
      this.subscriptions.set(id, data.cursor);
      more = data.hasMore;
    }
  }
  emit(data: unknown) {
    this.wire.send(JSON.stringify(data));
  }
  private emitUnread(data: Record<string, unknown>) {
    const signature = JSON.stringify(data);
    if (signature !== this.lastUnread) {
      this.lastUnread = signature;
      this.emit({ type: "unread", ...data });
    }
  }
  async jobChanged(id: string) {
    if (this.jobs.has(id))
      this.chain = this.chain
        .then(() => this.pushJob(id))
        .catch((error) => this.fail(error));
    return this.chain;
  }
  private async pushJob(id: string) {
    this.session = await validateRealtime(this.env, this.session!, this.token);
    const s = this.session;
    const status = await tenant(this.env.connect, s.workspace, (db) =>
      readJob(
        db,
        s.workspace,
        id,
        isAgent(s)
          ? { teammateId: s.teammateId }
          : { identityId: s.identityId },
      ),
    );
    this.emit({ type: "job", ...status });
  }
  private fail(error: unknown) {
    const code = error instanceof DomainError ? error.code : "REALTIME_ERROR";
    this.emit({
      type: "error",
      code,
      message:
        error instanceof DomainError
          ? error.message
          : "Reconnect to resume your conversation.",
    });
    if (error instanceof DomainError && error.status === 401)
      this.wire.close(4401, "Session expired");
  }
}

/** "Viewing" expires this long after its last refresh (the inbox refreshes every 30 seconds). */
export const VIEWING_TTL_MS = 45_000;
/**
 * Routes an ephemeral signal from one connection to the others. Used by the Worker and the local
 * relay, so both follow one table:
 * - presence: teammates in the workspace;
 * - viewing, and a teammate's note typing: teammates subscribed to the conversation, never customers;
 * - a teammate's reply typing and customer typing: everyone subscribed to the conversation;
 * never the sender, never another workspace. Teammates receive other teammates' typing marked as
 * a collision. When a teammate joins, each teammate already viewing is announced back to them.
 */
export function fanOutSignal(
  clients: Iterable<RealtimeClient>,
  sender: RealtimeClient,
  data: Record<string, unknown>,
) {
  const from = sender.session;
  if (!from) return;
  const conversationId = String(data.conversationId ?? "");
  const agentOnly =
    data.type === "presence" ||
    data.type === "viewing" ||
    (data.type === "typing" &&
      data.authorType === "teammate" &&
      data.mode !== "reply");
  for (const target of clients) {
    const to = target.session;
    if (target === sender || !to || to.workspace !== from.workspace) continue;
    const agent = isAgent(to);
    if (agentOnly && !agent) continue;
    if (data.type !== "presence" && !target.subscriptions.has(conversationId))
      continue;
    target.emit({
      ...data,
      ...(data.type === "typing" && data.authorType === "teammate" && agent
        ? { collision: true }
        : {}),
    });
    if (data.type === "viewing" && data.joined && agent && isAgent(from))
      sender.emit({
        type: "viewing",
        conversationId,
        teammateId: to.teammateId,
        active: true,
        expiresAt: Date.now() + VIEWING_TTL_MS,
      });
  }
}

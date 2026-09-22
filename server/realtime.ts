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
      return;
    }
    if (message.type === "unsubscribe") {
      this.subscriptions.delete(String(message.conversationId));
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
      if (Date.now() - this.ephemeralAt < 200) return;
      this.ephemeralAt = Date.now();
      this.ephemeral(this, {
        type: "typing",
        conversationId: message.conversationId,
        authorType: isAgent(this.session) ? "teammate" : "contact",
        authorId: isAgent(this.session)
          ? this.session.teammateId
          : this.session.identityId,
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

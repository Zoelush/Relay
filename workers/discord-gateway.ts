import { DurableObject } from "cloudflare:workers";
import { DiscordGatewaySession, gatewayCredentials, ingestDiscordMessage, reportGateway } from "../server/community";
import type { Connect } from "../server/db";

/**
 * Discord's gateway connection (phase 12, step E8; docs/OMNICHANNEL_STEP8.md): one Durable
 * Object per connected bot (named `<workspace>:<connection id>`) holds the WebSocket Discord
 * delivers messages over, since it has no webhook for them. The protocol is
 * `DiscordGatewaySession` (tested apart from any socket); this object connects, heartbeats on
 * the interval Discord gives, resumes when it can, and, when the socket drops, reconnects from an
 * alarm with backoff. Each MESSAGE_CREATE goes to `ingestDiscordMessage` (kept, then the
 * `community.receive` job). It stops when the connection is disconnected or the flag is off.
 */
export type GatewayEnv = { RELAY_CONNECTOR_KEY?: string };
export class DiscordGatewayObject<E extends GatewayEnv> extends DurableObject<E> {
  private socket: WebSocket | null = null;
  private session: DiscordGatewaySession | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private failures = 0;
  /** Set by the Worker's subclass: how this object reaches PostgreSQL. */
  protected connectDb(): Connect {
    throw new Error("No database connection.");
  }

  /** Starts (or keeps) the connection for a workspace's bot; called when it's checked, and by the sweep. */
  async ensure(workspace: string, connectionId: string) {
    await this.ctx.storage.put("target", { workspace, connectionId });
    if (!this.socket) await this.openSocket();
  }
  async alarm() {
    if (!this.socket) await this.openSocket();
  }

  private async openSocket() {
    const target = await this.ctx.storage.get<{ workspace: string; connectionId: string }>("target");
    const key = this.env.RELAY_CONNECTOR_KEY;
    if (!target || !key) return;
    const db = this.connectDb();
    const creds = await gatewayCredentials(db, key, target.workspace, target.connectionId);
    // Disconnected, or the flag is off: stop, and don't come back.
    if (!creds) {
      await reportGateway(db, target.workspace, target.connectionId, "stopped").catch(() => {});
      await this.ctx.storage.delete("target");
      return;
    }
    if (!this.session) this.session = new DiscordGatewaySession(creds.token, (type, d) => this.dispatch(db, target.workspace, target.connectionId, type, d));
    const res = await fetch(this.session.url().replace(/^wss:/, "https:"), { headers: { Upgrade: "websocket" } });
    const ws = res.webSocket;
    if (!ws) return this.retry(db, target, `Discord didn't accept the connection (${res.status}).`);
    ws.accept();
    this.socket = ws;
    this.session.attach({ send: (data) => ws.send(data), close: (code, reason) => ws.close(code, reason) });
    ws.addEventListener("message", (e) => {
      void this.session!.receive(String(e.data)).then(() => this.startHeartbeat());
    });
    ws.addEventListener("close", (e) => {
      this.stopHeartbeat();
      this.socket = null;
      // 4004 (bad token), 4013/4014 (intents not allowed): reconnecting won't help.
      if ([4004, 4010, 4011, 4012, 4013, 4014].includes(e.code)) void reportGateway(db, target.workspace, target.connectionId, `stopped: Discord closed it (${e.code} ${e.reason})`);
      else void this.retry(db, target, `reconnecting (${e.code})`);
    });
  }
  private startHeartbeat() {
    if (this.heartbeat || !this.session?.heartbeatMs) return;
    this.heartbeat = setInterval(() => this.session?.beat(), this.session.heartbeatMs);
  }
  private stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
  private async retry(db: Connect, target: { workspace: string; connectionId: string }, state: string) {
    this.failures++;
    await reportGateway(db, target.workspace, target.connectionId, state).catch(() => {});
    // 2s, 4s … at most 5 minutes between attempts.
    await this.ctx.storage.setAlarm(Date.now() + Math.min(300_000, 1000 * 2 ** Math.min(this.failures, 8)));
  }
  private async dispatch(db: Connect, w: string, connectionId: string, type: string, d: Record<string, unknown>) {
    if (type === "READY") {
      this.failures = 0;
      await reportGateway(db, w, connectionId, "connected");
    } else if (type === "MESSAGE_CREATE") await ingestDiscordMessage(db, w, connectionId, d);
  }
}

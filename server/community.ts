import { assert, DomainError, once, tenant, type Connect, type Sql } from "./db";
import { enqueueJob, type Job } from "./jobs";
import { authorize } from "./policy";
import { receiveInbound, registerChannel, type ChannelAdapter, type ChannelEnvironment, type SendResult } from "./channels";
import { seal, unseal } from "./connectors";
import { MAX_ATTACHMENT_BYTES, type AttachmentStorage } from "./attachments";
import { CommunityRejected, type DiscordApi, type SlackApi } from "./community-api";
import { scrubPayload } from "./redaction";

/**
 * Slack and Discord (phase 12, step E8; docs/OMNICHANNEL_STEP8.md), behind `channels_v1` and
 * `channel_slack_v1` / `channel_discord_v1`: a community's messages become conversations, and
 * replies go back into their thread.
 *
 * - **Slack:** the workspace's own Slack app (its bot token and signing secret, sealed). Events
 *   come to `/v1/hooks/slack/<workspace>`, kept only when Slack's signature (over the timestamp and
 *   body, within 5 minutes) checks out, each event once. A message starts a conversation; replies
 *   in its thread join it; ours go into the thread.
 * - **Discord:** the server's bot (its token, sealed). Discord has no webhook for messages: a
 *   Durable Object holds the gateway connection (`DiscordGatewaySession`, here, is its protocol)
 *   and hands each message to `ingestDiscordMessage`. Ours reply to the person's message.
 * - **Both:** bots (ours included) and edits are ignored; people are the platforms' own accounts
 *   (verified by them, joining no other contact); Zoe stays out of public community spaces.
 */
export type CommunityEnvironment = { slack?: SlackApi; discord?: DiscordApi; key?: string; storage?: AttachmentStorage };
const envOf = (env: ChannelEnvironment) => env.providers?.community as CommunityEnvironment | undefined;
type Platform = "slack" | "discord";
const sealId = (id: string) => `community:${id}`;
const KEPT = new Set(["image/png", "image/jpeg", "application/pdf", "text/plain"]);

async function enabled(db: Sql, w: string, platform?: Platform) {
  const on = (await db.query<{ name: string }>("SELECT name FROM workspace_features WHERE workspace_id=$1 AND enabled AND name LIKE 'channel%'", [w])).rows.map((r) => r.name);
  if (!on.includes("channels_v1")) return false;
  return platform ? on.includes(`channel_${platform}_v1`) : on.includes("channel_slack_v1") || on.includes("channel_discord_v1");
}
/** The latest message from the person in a conversation: where (and to what) a reply goes. */
async function lastFrom(db: Sql, w: string, platform: Platform, conversationId: string) {
  return (
    await db.query<{ data: Record<string, Record<string, string>> }>(
      "SELECT data FROM conversation_parts WHERE workspace_id=$1 AND conversation_id=$2 AND kind='customer_message' AND channel=$3 ORDER BY seq DESC LIMIT 1",
      [w, conversationId, platform],
    )
  ).rows[0]?.data[platform];
}
async function connection(db: Sql, w: string, id: string) {
  return (
    await db.query<{ id: string; status: string; token_sealed: string; secret_sealed: string | null; external_id: string; bot_user_id: string; brand_id: string }>(
      "SELECT id,status,token_sealed,secret_sealed,external_id,bot_user_id,brand_id FROM community_connections WHERE workspace_id=$1 AND id=$2",
      [w, id],
    )
  ).rows[0];
}
/** Options a channel without buttons writes out. */
const withOptions = (text: string, options?: string[]) => (options?.length ? `${text}\n${options.map((o, i) => `${i + 1}. ${o}`).join("\n")}` : text);

type Prepared = { platform: Platform; token: string; channel: string; text: string; threadTs?: string; replyTo?: string };

function adapter(platform: Platform): ChannelAdapter {
  const name = platform === "slack" ? "Slack" : "Discord";
  return {
    id: platform,
    flag: `channel_${platform}_v1`,
    // Plain text (each platform's markdown passes through as written), 4,000 (Slack) or 2,000
    // (Discord) characters, no files out (a link instead), no receipts; Zoe stays out of
    // community spaces.
    capabilities: { richText: false, attachments: false, buttons: false, maxLength: platform === "slack" ? 4000 : 2000, windowHours: null, ai: false, receipts: "none", address: "account" },
    /** Slack: `<team>:<user>`; Discord: the user's id (a snowflake). */
    address: (raw) =>
      platform === "slack" ? (/^T[A-Z0-9]{2,20}:[UW][A-Z0-9]{2,20}$/.test(raw.trim()) ? raw.trim() : null) : /^\d{15,25}$/.test(raw.trim()) ? raw.trim() : null,
    async refuses(_db, _w, _conversationId, part) {
      return part?.kind === "attachment" ? `Files can't be posted to ${name} from Relay yet: send a link instead.` : null;
    },
    async prepare(db, w, out, env) {
      const e = envOf(env);
      if (!e?.key || !(platform === "slack" ? e.slack : e.discord)) return { refuse: `${name} isn't set up for Relay yet.` };
      const at = await lastFrom(db, w, platform, out.conversationId);
      const c = at ? await connection(db, w, at.connectionId) : undefined;
      if (!at || !c || c.status !== "connected") return { refuse: `The ${name} connection isn't connected.` };
      return {
        data: {
          platform,
          token: await unseal(e.key, w, sealId(c.id), "token", c.token_sealed),
          channel: at.channel,
          text: withOptions(out.text, out.options),
          ...(platform === "slack" ? { threadTs: at.threadTs } : { replyTo: at.messageId }),
        } satisfies Prepared,
      };
    },
    async send(out, env): Promise<SendResult> {
      const e = envOf(env);
      const p = out.prepared as Prepared | undefined;
      if (!e || !p) return { status: "failed", error: `${name} isn't set up for Relay yet.`, permanent: true };
      try {
        if (p.platform === "slack") {
          const r = await e.slack!.postMessage(p.token, { channel: p.channel, text: p.text, threadTs: p.threadTs });
          return { status: "sent", providerId: r.ts };
        }
        const r = await e.discord!.send(p.token, p.channel, {
          content: p.text,
          // A reply to their message; nobody is pinged by what a teammate wrote.
          ...(p.replyTo ? { message_reference: { message_id: p.replyTo, fail_if_not_exists: false } } : {}),
          allowed_mentions: { parse: [] },
        });
        return { status: "sent", providerId: r.id };
      } catch (err) {
        if (err instanceof CommunityRejected) return { status: "failed", error: err.message.slice(0, 300), permanent: true };
        throw err;
      }
    },
  };
}
export const slackChannel = adapter("slack");
export const discordChannel = adapter("discord");
registerChannel(slackChannel);
registerChannel(discordChannel);

/* ------------------------------------------------------------------------------------------ */
/* Slack's Events API                                                                          */

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
export async function slackSignature(secret: string, timestamp: string, body: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return "v0=" + hex(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`v0:${timestamp}:${body}`)));
}
const same = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

/**
 * `POST /v1/hooks/slack/<workspace>`: Slack's URL check answered, events kept once their
 * signature checks out (a request older than 5 minutes is refused: it could be a replay).
 */
export async function receiveSlackWebhook(connect: Connect, key: string | undefined, w: string, raw: string, timestamp: string, signature: string, now = Date.now()) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(w) || !key) return { status: 404, body: {} };
  if (!/^\d{9,11}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300) return { status: 403, body: { error: "Stale or missing timestamp." } };
  try {
    return await tenant(connect, w, async (db) => {
      if (!(await enabled(db, w, "slack"))) return { status: 404, body: {} };
      const conns = (
        await db.query<{ id: string; secret_sealed: string; external_id: string; status: string }>(
          "SELECT id,secret_sealed,external_id,status FROM community_connections WHERE workspace_id=$1 AND platform='slack' AND status<>'disconnected' ORDER BY (status='connected') DESC,created_at",
          [w],
        )
      ).rows;
      const signers: (typeof conns)[number][] = [];
      for (const c of conns) if (same(await slackSignature(await unseal(key, w, sealId(c.id), "secret", c.secret_sealed), timestamp, raw), signature)) signers.push(c);
      if (!signers.length) return { status: 403, body: { error: "The signature doesn't check out." } };
      let p: { type?: string; challenge?: string; event_id?: string; team_id?: string; event?: Record<string, unknown> };
      try {
        p = JSON.parse(raw);
      } catch {
        return { status: 400, body: { error: "Not JSON." } };
      }
      // Slack checks the URL while the app is set up: any connection's secret may answer it.
      if (p.type === "url_verification") return { status: 200, body: { challenge: String(p.challenge ?? "") } };
      if (p.type !== "event_callback" || !p.event) return { status: 200, body: { ignored: true } };
      // Events only for a connected workspace, and only from its own team.
      const signedBy = signers.find((c) => c.status === "connected" && c.external_id === p.team_id);
      if (!signedBy) return { status: 403, body: { error: "Not a connected Slack workspace." } };
      const id = crypto.randomUUID();
      // Slack retries what it thinks wasn't received: each event once.
      const added = await db.query(
        "INSERT INTO community_inbound(workspace_id,id,platform,connection_id,event_id,payload) VALUES($1,$2,'slack',$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id",
        [w, id, signedBy.id, p.event_id ?? null, JSON.stringify(p)],
      );
      if (added.rows.length) await enqueueJob(db, w, "community.receive", { inboundId: id }, {});
      return { status: 200, body: { received: true } };
    });
  } catch (e) {
    if (e instanceof DomainError) throw e;
    return { status: 404, body: {} };
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Discord's gateway                                                                           */

/** What the gateway session needs from a socket: the Durable Object's WebSocket, or a test's. */
export type GatewaySocket = { send(data: string): void; close(code?: number, reason?: string): void };
/** Guild messages, direct messages and their content. */
export const DISCORD_INTENTS = (1 << 9) | (1 << 12) | (1 << 15);
export const DISCORD_GATEWAY = "wss://gateway.discord.gg/?v=10&encoding=json";
/**
 * Discord's gateway protocol (v10), apart from any socket: HELLO starts the heartbeat and
 * IDENTIFY (or RESUME, with the session and last sequence); dispatches are passed on (READY
 * keeps the session and where to resume); a missed heartbeat ACK (a zombie connection),
 * RECONNECT and INVALID_SESSION close the socket so its owner reconnects, resuming when it can.
 */
export class DiscordGatewaySession {
  seq: number | null = null;
  sessionId: string | null = null;
  resumeUrl: string | null = null;
  heartbeatMs: number | null = null;
  private acked = true;
  private socket: GatewaySocket | null = null;
  constructor(
    private token: string,
    private onDispatch: (type: string, data: Record<string, unknown>) => void | Promise<void>,
  ) {}
  /** Where to connect: where Discord said to resume, else the gateway. */
  url() {
    return this.sessionId && this.resumeUrl ? `${this.resumeUrl}/?v=10&encoding=json` : DISCORD_GATEWAY;
  }
  attach(socket: GatewaySocket) {
    this.socket = socket;
    this.acked = true;
  }
  /** Each heartbeat interval: a heartbeat, or (no ACK since the last) close the zombie. */
  beat() {
    if (!this.socket) return;
    if (!this.acked) {
      this.socket.close(4000, "No heartbeat ACK");
      this.socket = null;
      return;
    }
    this.acked = false;
    this.socket.send(JSON.stringify({ op: 1, d: this.seq }));
  }
  async receive(raw: string) {
    const m = JSON.parse(raw) as { op: number; d?: unknown; s?: number | null; t?: string | null };
    if (typeof m.s === "number") this.seq = m.s;
    switch (m.op) {
      case 10: {
        this.heartbeatMs = Number((m.d as { heartbeat_interval?: number }).heartbeat_interval ?? 41250);
        if (this.sessionId) this.socket?.send(JSON.stringify({ op: 6, d: { token: this.token, session_id: this.sessionId, seq: this.seq } }));
        else
          this.socket?.send(JSON.stringify({ op: 2, d: { token: this.token, intents: DISCORD_INTENTS, properties: { os: "linux", browser: "relay", device: "relay" } } }));
        return;
      }
      case 11:
        this.acked = true;
        return;
      case 1:
        this.socket?.send(JSON.stringify({ op: 1, d: this.seq }));
        return;
      case 7:
        this.socket?.close(4000, "Reconnect requested");
        this.socket = null;
        return;
      case 9:
        // Not resumable: start a new session.
        if (!m.d) {
          this.sessionId = null;
          this.seq = null;
          this.resumeUrl = null;
        }
        this.socket?.close(4000, "Invalid session");
        this.socket = null;
        return;
      case 0: {
        const d = (m.d ?? {}) as Record<string, unknown>;
        if (m.t === "READY") {
          this.sessionId = String(d.session_id ?? "");
          this.resumeUrl = typeof d.resume_gateway_url === "string" ? d.resume_gateway_url : null;
        }
        await this.onDispatch(String(m.t), d);
        return;
      }
    }
  }
}

/**
 * A MESSAGE_CREATE from the gateway: kept (each once) and read by the job. People's messages
 * only: not bots' (ours included).
 */
export async function ingestDiscordMessage(connect: Connect, w: string, connectionId: string, d: Record<string, unknown>) {
  const author = (d.author ?? {}) as { id?: string; bot?: boolean };
  if (!author.id || author.bot || typeof d.id !== "string") return { kept: false };
  return tenant(connect, w, async (db) => {
    if (!(await enabled(db, w, "discord"))) return { kept: false };
    const c = await connection(db, w, connectionId);
    if (!c || c.status === "disconnected" || author.id === c.bot_user_id) return { kept: false };
    const id = crypto.randomUUID();
    const added = await db.query(
      "INSERT INTO community_inbound(workspace_id,id,platform,connection_id,event_id,payload) VALUES($1,$2,'discord',$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id",
      [w, id, connectionId, d.id, JSON.stringify(d)],
    );
    if (added.rows.length) await enqueueJob(db, w, "community.receive", { inboundId: id }, {});
    return { kept: added.rows.length > 0 };
  });
}
/** The Durable Object reports the gateway's state (connected, reconnecting, why it stopped). */
export async function reportGateway(connect: Connect, w: string, connectionId: string, state: string) {
  await tenant(connect, w, (db) =>
    db.query("UPDATE community_connections SET gateway_state=$3,gateway_at=now() WHERE workspace_id=$1 AND id=$2", [w, connectionId, state.slice(0, 200)]),
  );
}
/** The sweep: the workspace's connected Discord bots, whose gateways should be running. */
export async function discordConnections(connect: Connect, w: string) {
  return tenant(connect, w, async (db) =>
    (await enabled(db, w, "discord"))
      ? (await db.query<{ id: string }>("SELECT id FROM community_connections WHERE workspace_id=$1 AND platform='discord' AND status='connected'", [w])).rows.map((r) => r.id)
      : [],
  );
}
/** The gateway's credentials for its Durable Object: the bot token, when the connection is on. */
export async function gatewayCredentials(connect: Connect, key: string, w: string, connectionId: string) {
  return tenant(connect, w, async (db) => {
    if (!(await enabled(db, w, "discord"))) return null;
    const c = await connection(db, w, connectionId);
    return c && c.status === "connected" ? { token: await unseal(key, w, sealId(c.id), "token", c.token_sealed) } : null;
  });
}

/* ------------------------------------------------------------------------------------------ */
/* Reading events                                                                              */

/** The `community.receive` job: one Slack event or Discord message, into its conversation. */
export async function receiveCommunityJob(connect: Connect, env: CommunityEnvironment, job: Job) {
  const w = job.workspace_id;
  const { inboundId } = job.payload as { inboundId: string };
  const ready = await tenant(connect, w, async (db) => {
    const row = (
      await db.query<{ status: string; platform: Platform; connection_id: string; payload: Record<string, unknown> }>(
        "SELECT status,platform,connection_id,payload FROM community_inbound WHERE workspace_id=$1 AND id=$2",
        [w, inboundId],
      )
    ).rows[0];
    if (!row || row.status !== "received") return null;
    return { row, c: await connection(db, w, row.connection_id) };
  });
  if (!ready?.c) return { done: true, result: { skipped: true } };
  const { row, c } = ready;
  const done = () =>
    tenant(connect, w, async (db) => {
      await db.query("UPDATE community_inbound SET status='read',read_at=now() WHERE workspace_id=$1 AND id=$2", [w, inboundId]);
      await scrubPayload(db, w, "community_inbound", inboundId);
    });
  const token = env.key ? await unseal(env.key, w, sealId(c.id), "token", c.token_sealed) : null;
  let m: {
    externalId: string;
    address: string;
    user: string;
    name: string;
    text: string;
    threadKeys: string[];
    ownKeys: string[];
    fallback: { key: string; days: number } | null;
    data: Record<string, unknown>;
    files: { url: string }[];
  };
  if (row.platform === "slack") {
    const e = (row.payload.event ?? {}) as {
      type?: string;
      subtype?: string;
      bot_id?: string;
      user?: string;
      text?: string;
      ts?: string;
      thread_ts?: string;
      channel?: string;
      channel_type?: string;
      files?: { url_private?: string; mimetype?: string }[];
    };
    // People's messages only: not bots', edits, deletions or joins (all have a subtype but files).
    if (e.type !== "message" || e.bot_id || !e.user || !e.ts || !e.channel || (e.subtype && e.subtype !== "file_share") || e.user === c.bot_user_id) {
      await done();
      return { done: true, result: { ignored: true } };
    }
    const root = e.thread_ts ?? e.ts;
    m = {
      externalId: `${c.external_id}:${e.channel}:${e.ts}`,
      address: `${c.external_id}:${e.user}`,
      user: e.user,
      name: "",
      text: (e.text ?? "").slice(0, 4000) || (e.files?.length ? "[A file]" : "[An empty message]"),
      // The thread is the conversation (its root's timestamp).
      threadKeys: [`slack:${c.external_id}:${e.channel}:${root}`],
      ownKeys: [],
      fallback: null,
      data: { slack: { connectionId: c.id, channel: e.channel, threadTs: root, channelType: e.channel_type ?? "" } },
      files: (e.files ?? []).filter((f) => f.url_private && KEPT.has(f.mimetype ?? "")).map((f) => ({ url: f.url_private! })),
    };
    if (env.slack && token) m.name = await env.slack.userName(token, e.user);
  } else {
    const d = row.payload as {
      id: string;
      channel_id?: string;
      guild_id?: string;
      content?: string;
      author?: { id?: string; username?: string; global_name?: string };
      message_reference?: { message_id?: string };
      attachments?: { url?: string; content_type?: string }[];
    };
    if (!d.author?.id || !d.channel_id) {
      await done();
      return { done: true, result: { ignored: true } };
    }
    m = {
      externalId: d.id,
      address: d.author.id,
      user: d.author.id,
      name: d.author.global_name || d.author.username || "",
      text: (d.content ?? "").slice(0, 2000) || (d.attachments?.length ? "[An attachment]" : "[An empty message]"),
      // A reply to a message joins its conversation; otherwise the same person in the same channel within a day.
      threadKeys: d.message_reference?.message_id ? [`discord:msg:${d.message_reference.message_id}`] : [],
      ownKeys: [`discord:msg:${d.id}`],
      fallback: { key: `discord:${d.channel_id}:${d.author.id}`, days: 1 },
      data: { discord: { connectionId: c.id, channel: d.channel_id, messageId: d.id, guild: d.guild_id ?? "" } },
      files: (d.attachments ?? []).filter((a) => a.url && /^https:\/\/(cdn|media)\.discordapp\.(com|net)\//.test(a.url) && KEPT.has((a.content_type ?? "").split(";")[0])).map((a) => ({ url: a.url! })),
    };
  }
  // Files, outside any transaction: Slack's with the bot's token (files.slack.com only); Discord's CDN is public.
  const kept: { key: string; name: string; mime: string; size: number }[] = [];
  if (env.storage?.putQuarantine)
    for (const [i, f] of m.files.slice(0, 10).entries()) {
      try {
        const got =
          row.platform === "slack"
            ? env.slack && token
              ? await env.slack.download(token, f.url)
              : null
            : await (async () => {
                const r = await fetch(f.url, { redirect: "error" });
                return r.ok ? { bytes: new Uint8Array(await r.arrayBuffer()), mime: (r.headers.get("content-type") ?? "").split(";")[0] } : null;
              })();
        if (!got || !KEPT.has(got.mime) || !got.bytes.length || got.bytes.length > MAX_ATTACHMENT_BYTES) continue;
        const id = crypto.randomUUID();
        const k = `${encodeURIComponent(w)}/${id}/quarantine`;
        await env.storage.putQuarantine(k, got.bytes, got.mime);
        kept.push({ key: k, name: `file-${i + 1}.${got.mime.split("/")[1]}`, mime: got.mime, size: got.bytes.length });
      } catch {
        // A file that can't be fetched is shown by the message's text only.
      }
    }
  await tenant(connect, w, async (db) => {
    const r = await receiveInbound(db, w, row.platform === "slack" ? slackChannel : discordChannel, {
      externalId: m.externalId,
      address: m.address,
      verified: true,
      name: m.name,
      text: m.text,
      threadKeys: m.threadKeys,
      ownKeys: m.ownKeys,
      fallback: m.fallback,
      brandId: c.brand_id,
      data: m.data,
    });
    if (r.partId && !("duplicate" in r && r.duplicate))
      for (const f of kept) {
        const id = f.key.split("/")[1];
        await db.query(
          "INSERT INTO attachments(workspace_id,id,conversation_id,owner_identity_id,object_key,name,size,mime,audience,purpose,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'customer_visible','part','scanning')",
          [w, id, r.conversationId, r.identityId, f.key, f.name, f.size, f.mime],
        );
        const jobId = await enqueueJob(db, w, "attachment.scan", { attachmentId: id }, { identityId: r.identityId ?? undefined });
        await db.query("UPDATE attachments SET job_id=$3 WHERE workspace_id=$1 AND id=$2", [w, id, jobId]);
      }
    await db.query("UPDATE community_inbound SET status='read',read_at=now() WHERE workspace_id=$1 AND id=$2", [w, inboundId]);
    // Phase 16 C6b: read, so its text is redacted (the original isn't kept).
    await scrubPayload(db, w, "community_inbound", inboundId);
  });
  return { done: true, result: { read: true } };
}

/* ------------------------------------------------------------------------------------------ */
/* Settings › Slack & Discord                                                                  */

export async function readCommunity(db: Sql, w: string, principal: string, origin: string) {
  await authorize(db, w, principal, "workspace.manage");
  assert(await enabled(db, w), "COMMUNITY_DISABLED", "Slack and Discord are not enabled for this workspace.", 404);
  const rows = (
    await db.query<{
      id: string;
      platform: Platform;
      brand: string;
      external_id: string;
      name: string;
      bot_user_id: string;
      token_hint: string;
      status: string;
      error: string;
      gateway_state: string;
      gateway_at: string | null;
      checked_at: string | null;
    }>(
      `SELECT c.id,c.platform,b.name AS brand,c.external_id,c.name,c.bot_user_id,c.token_hint,c.status,c.error,c.gateway_state,c.gateway_at,c.checked_at
       FROM community_connections c JOIN brands b ON b.workspace_id=c.workspace_id AND b.id=c.brand_id WHERE c.workspace_id=$1 AND c.status<>'disconnected' ORDER BY c.created_at`,
      [w],
    )
  ).rows;
  return {
    platforms: { slack: await enabled(db, w, "slack"), discord: await enabled(db, w, "discord") },
    slackEventsUrl: `${origin}/v1/hooks/slack/${w}`,
    brands: (await db.query<{ id: string; name: string }>("SELECT id,name FROM brands WHERE workspace_id=$1 ORDER BY lower(name),id", [w])).rows,
    connections: rows.map((r) => ({
      id: r.id,
      platform: r.platform,
      brandName: r.brand,
      externalId: r.external_id,
      name: r.name,
      botUserId: r.bot_user_id,
      tokenHint: r.token_hint,
      status: r.status,
      error: r.error,
      gateway: r.platform === "discord" ? { state: r.gateway_state, at: r.gateway_at ? new Date(r.gateway_at).toISOString() : null } : null,
      checkedAt: r.checked_at ? new Date(r.checked_at).toISOString() : null,
    })),
  };
}

/** Connect a Slack workspace or Discord server (sealed, then checked by a job), check it again, or disconnect it. */
export async function changeCommunity(db: Sql, w: string, principal: string, key: string, p: Record<string, unknown>, origin: string, master: string | undefined) {
  const t = await authorize(db, w, principal, "workspace.manage");
  assert(await enabled(db, w), "COMMUNITY_DISABLED", "Slack and Discord are not enabled for this workspace.", 404);
  return once(db, w, "community:" + principal, key, p, async () => {
    const invalid = (m: string): never => {
      throw new DomainError("INVALID_COMMUNITY", m, 400);
    };
    const existing = async (id: unknown) => {
      const r = (await db.query<{ id: string }>("SELECT id FROM community_connections WHERE workspace_id=$1 AND id=$2 AND status<>'disconnected'", [w, String(id ?? "")])).rows[0];
      assert(r, "COMMUNITY_NOT_FOUND", "That connection isn't there.", 404);
      return r.id;
    };
    if (p.action === "connect") {
      assert(master, "COMMUNITY_UNAVAILABLE", "Credentials can't be stored here: RELAY_CONNECTOR_KEY isn't configured.", 503);
      const platform = String(p.platform ?? "") as Platform;
      if (platform !== "slack" && platform !== "discord") invalid("Choose Slack or Discord.");
      if (!(await enabled(db, w, platform))) invalid(`${platform === "slack" ? "Slack" : "Discord"} isn't on for this workspace.`);
      const brandId = String(p.brandId ?? "");
      if (!(await db.query("SELECT 1 FROM brands WHERE workspace_id=$1 AND id=$2", [w, brandId])).rows.length) invalid("Choose a brand.");
      const token = String(p.token ?? "").trim();
      const secret = String(p.signingSecret ?? "").trim();
      if (platform === "slack") {
        if (!/^xoxb-[A-Za-z0-9-]{10,200}$/.test(token)) invalid("Paste the Slack app's bot token (it starts xoxb-).");
        if (!/^[0-9a-f]{32}$/.test(secret)) invalid("Paste the Slack app's signing secret (Basic Information, 32 characters).");
      } else if (!/^[A-Za-z0-9._-]{50,100}$/.test(token)) invalid("Paste the Discord bot's token (Developer Portal › Bot).");
      const id = crypto.randomUUID();
      await db.query(
        "INSERT INTO community_connections(workspace_id,id,platform,brand_id,token_sealed,token_hint,secret_sealed,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [w, id, platform, brandId, await seal(master!, w, sealId(id), "token", token), token.slice(-4), platform === "slack" ? await seal(master!, w, sealId(id), "secret", secret) : null, t.id],
      );
      await enqueueJob(db, w, "community.check", { connectionId: id }, {});
    } else if (p.action === "check") await enqueueJob(db, w, "community.check", { connectionId: await existing(p.connectionId) }, {});
    else if (p.action === "disconnect") await db.query("UPDATE community_connections SET status='disconnected' WHERE workspace_id=$1 AND id=$2", [w, await existing(p.connectionId)]);
    else invalid("Unknown change.");
    return readCommunity(db, w, principal, origin);
  });
}

/**
 * `community.check`: the bot, from its platform (which proves the token): Slack's team and bot
 * user, Discord's bot user. A second connection to the same team or server is refused.
 */
export async function checkCommunityJob(connect: Connect, env: CommunityEnvironment, job: Job, onDiscordConnected?: (w: string, id: string) => Promise<void>) {
  const w = job.workspace_id;
  const { connectionId } = job.payload as { connectionId: string };
  const row = await tenant(connect, w, async (db) => (await db.query<{ platform: Platform; token_sealed: string }>("SELECT platform,token_sealed FROM community_connections WHERE workspace_id=$1 AND id=$2", [w, connectionId])).rows[0]);
  if (!row) return { done: true, result: { skipped: true } };
  const save = (status: string, error: string, d?: { externalId: string; name: string; botUserId: string }) =>
    tenant(connect, w, async (db) => {
      if (d && (await db.query("SELECT 1 FROM community_connections WHERE workspace_id=$1 AND platform=$2 AND external_id=$3 AND id<>$4 AND status<>'disconnected'", [w, row.platform, d.externalId, connectionId])).rows.length) {
        status = "failed";
        error = "That workspace or server is already connected.";
        d = undefined;
      }
      await db.query(
        `UPDATE community_connections SET status=$3,error=$4,external_id=COALESCE($5,external_id),name=COALESCE($6,name),bot_user_id=COALESCE($7,bot_user_id),checked_at=now()
         WHERE workspace_id=$1 AND id=$2 AND status<>'disconnected'`,
        [w, connectionId, status, error, d?.externalId ?? null, d?.name ?? null, d?.botUserId ?? null],
      );
      return status;
    });
  const api = row.platform === "slack" ? env.slack : env.discord;
  if (!api || !env.key) {
    await save("failed", "This platform isn't set up for Relay yet.");
    return { done: true, result: { checked: false } };
  }
  try {
    const token = await unseal(env.key, w, sealId(connectionId), "token", row.token_sealed);
    const status =
      row.platform === "slack"
        ? await (async () => {
            const a = await env.slack!.authTest(token);
            return save("connected", "", { externalId: a.teamId, name: a.team, botUserId: a.botUserId });
          })()
        : await (async () => {
            const me = await env.discord!.me(token);
            return save("connected", "", { externalId: me.id, name: me.username, botUserId: me.id });
          })();
    // Discord's gateway (its Durable Object, when deployed) starts once the bot is known.
    if (status === "connected" && row.platform === "discord") await onDiscordConnected?.(w, connectionId);
    return { done: true, result: { checked: status === "connected" } };
  } catch (e) {
    if (e instanceof CommunityRejected) {
      await save("failed", e.message.slice(0, 300));
      return { done: true, result: { checked: false } };
    }
    throw e;
  }
}

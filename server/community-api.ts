/**
 * Slack's and Discord's providers (phase 12, step E8; docs/OMNICHANNEL_STEP8.md), behind ports:
 * Slack's Web API and Discord's REST API, each with the workspace's bot token. Tests and the local
 * relay use the stand-ins in `scripts/local-community.ts`.
 */
export class CommunityRejected extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
  }
}
export interface SlackApi {
  /** The bot's team and user (which also proves the token). */
  authTest(token: string): Promise<{ teamId: string; team: string; botUserId: string }>;
  /** A message, in a thread when `threadTs` is given; its timestamp (Slack's id). */
  postMessage(token: string, m: { channel: string; text: string; threadTs?: string }): Promise<{ ts: string }>;
  /** A person's display name (best effort). */
  userName(token: string, user: string): Promise<string>;
  /** A shared file's bytes, from files.slack.com only. */
  download(token: string, url: string): Promise<{ bytes: Uint8Array; mime: string }>;
}
export interface DiscordApi {
  /** The bot user (which also proves the token). */
  me(token: string): Promise<{ id: string; username: string }>;
  /** A message to a channel (a reply when it references one); its id. */
  send(token: string, channelId: string, body: Record<string, unknown>): Promise<{ id: string }>;
}

export function slackWebApi(options: { fetch?: typeof fetch; base?: string } = {}): SlackApi {
  const f = options.fetch ?? fetch;
  const base = options.base ?? "https://slack.com/api";
  // Slack answers 200 with {ok:false,error} for refusals; 429 and 5xx are worth retrying.
  const call = async (token: string, method: string, body?: Record<string, unknown>, query = "") => {
    const r = await f(`${base}/${method}${query}`, {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json; charset=utf-8" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (r.status === 429 || r.status >= 500) throw new Error(`Slack answered ${r.status}.`);
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (j.ok !== true) throw new CommunityRejected(`Slack refused: ${String(j.error ?? r.status)}`, String(j.error ?? r.status));
    return j;
  };
  return {
    async authTest(token) {
      const j = await call(token, "auth.test", {});
      return { teamId: String(j.team_id), team: String(j.team ?? ""), botUserId: String(j.user_id ?? "") };
    },
    async postMessage(token, m) {
      const j = await call(token, "chat.postMessage", { channel: m.channel, text: m.text, ...(m.threadTs ? { thread_ts: m.threadTs } : {}), unfurl_links: false });
      return { ts: String(j.ts) };
    },
    async userName(token, user) {
      try {
        const j = await call(token, "users.info", undefined, `?user=${encodeURIComponent(user)}`);
        const u = j.user as { real_name?: string; name?: string; profile?: { display_name?: string } } | undefined;
        return u?.profile?.display_name || u?.real_name || u?.name || "";
      } catch {
        return "";
      }
    },
    async download(token, url) {
      if (!/^https:\/\/files\.slack\.com\//.test(url)) throw new CommunityRejected("Not Slack's file host.", "bad_url");
      const r = await f(url, { headers: { authorization: `Bearer ${token}` }, redirect: "error" });
      if (!r.ok) throw new Error(`The file couldn't be downloaded (${r.status}).`);
      return { bytes: new Uint8Array(await r.arrayBuffer()), mime: (r.headers.get("content-type") ?? "application/octet-stream").split(";")[0] };
    },
  };
}

export function discordRestApi(options: { fetch?: typeof fetch; base?: string } = {}): DiscordApi {
  const f = options.fetch ?? fetch;
  const base = options.base ?? "https://discord.com/api/v10";
  const call = async (token: string, path: string, body?: Record<string, unknown>) => {
    const r = await f(base + path, {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bot ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (r.ok) return j;
    if (r.status === 429 || r.status >= 500) throw new Error(`Discord answered ${r.status}.`);
    throw new CommunityRejected(`Discord refused: ${String(j.message ?? r.status)}`, String(j.code ?? r.status));
  };
  return {
    async me(token) {
      const j = await call(token, "/users/@me");
      return { id: String(j.id), username: String(j.username ?? "") };
    },
    async send(token, channelId, body) {
      const j = await call(token, `/channels/${encodeURIComponent(channelId)}/messages`, body);
      return { id: String(j.id) };
    },
  };
}

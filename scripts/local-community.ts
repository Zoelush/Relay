import { CommunityRejected, type DiscordApi, type SlackApi } from "../server/community-api";
import { slackSignature } from "../server/community";

/**
 * Slack's and Discord's stand-ins (phase 12, step E8), for tests and the local relay: their APIs
 * as far as Relay uses them, in memory, and Slack's calls signed as Slack signs them. Discord's
 * messages arrive from its gateway, which only runs deployed (a Durable Object): locally they're
 * handed to `ingestDiscordMessage` as the gateway would, and the protocol is tested apart.
 */
export const LOCAL_SLACK = { teamId: "T0LOCAL01", team: "Relay Community", botUserId: "U0RELAYBOT", token: "xoxb-local-stand-in-0000000000", signingSecret: "abcdef0123456789abcdef0123456789" };
export const LOCAL_DISCORD = { botId: "900000000000000001", username: "Relay", token: "local.discord.stand-in.token-00000000000000000000000000000000000" };
export function localCommunity() {
  const slackSent: { channel: string; text: string; threadTs?: string; ts: string }[] = [];
  const discordSent: { channel: string; body: Record<string, unknown>; id: string }[] = [];
  const slackFiles = new Map<string, { bytes: Uint8Array; mime: string }>();
  const people = new Map<string, string>();
  const state = { fail: false };
  let seq = 0;
  const slack: SlackApi = {
    async authTest(token) {
      if (state.fail) throw new Error("The stand-in Slack is down.");
      if (token !== LOCAL_SLACK.token) throw new CommunityRejected("Slack refused: invalid_auth", "invalid_auth");
      return { teamId: LOCAL_SLACK.teamId, team: LOCAL_SLACK.team, botUserId: LOCAL_SLACK.botUserId };
    },
    async postMessage(_token, m) {
      if (state.fail) throw new Error("The stand-in Slack is down.");
      if (m.channel === "C0ARCHIVED") throw new CommunityRejected("Slack refused: is_archived", "is_archived");
      const ts = `${Math.floor(Date.now() / 1000)}.${String(++seq).padStart(6, "0")}`;
      slackSent.push({ ...m, ts });
      return { ts };
    },
    async userName(_token, user) {
      return people.get(user) ?? "";
    },
    async download(_token, url) {
      const f = slackFiles.get(url);
      if (!f) throw new CommunityRejected("Slack refused: file_not_found", "file_not_found");
      return f;
    },
  };
  const discord: DiscordApi = {
    async me(token) {
      if (token !== LOCAL_DISCORD.token) throw new CommunityRejected("Discord refused: 401: Unauthorized", "0");
      return { id: LOCAL_DISCORD.botId, username: LOCAL_DISCORD.username };
    },
    async send(_token, channel, body) {
      if (state.fail) throw new Error("The stand-in Discord is down.");
      const id = String(BigInt("1000000000000000000") + BigInt(++seq));
      discordSent.push({ channel, body, id });
      return { id };
    },
  };
  return {
    slack,
    discord,
    slackSent,
    discordSent,
    slackFiles,
    people,
    state,
    /** A Slack call as Slack makes it: the body, its timestamp and its signature. */
    async slackSigned(payload: unknown, secret = LOCAL_SLACK.signingSecret, at = Math.floor(Date.now() / 1000)) {
      const body = JSON.stringify(payload);
      return { body, timestamp: String(at), signature: await slackSignature(secret, String(at), body) };
    },
    /** A person's message in a Slack channel (or a thread, with `thread_ts`). */
    slackMessage(o: { channel: string; user: string; text: string; ts?: string; thread_ts?: string; files?: { url_private: string; mimetype: string }[]; subtype?: string; bot_id?: string }) {
      const ts = o.ts ?? `${Math.floor(Date.now() / 1000)}.${String(++seq).padStart(6, "0")}`;
      return {
        type: "event_callback",
        team_id: LOCAL_SLACK.teamId,
        event_id: "Ev" + crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase(),
        event: { type: "message", channel: o.channel, user: o.user, text: o.text, ts, channel_type: "channel", ...(o.thread_ts ? { thread_ts: o.thread_ts } : {}), ...(o.files ? { files: o.files } : {}), ...(o.subtype ? { subtype: o.subtype } : {}), ...(o.bot_id ? { bot_id: o.bot_id } : {}) },
      };
    },
    /** A MESSAGE_CREATE as the gateway delivers it. */
    discordMessage(o: { channel: string; author: string; username?: string; content: string; id?: string; replyTo?: string; bot?: boolean }) {
      return {
        id: o.id ?? String(BigInt("2000000000000000000") + BigInt(++seq)),
        channel_id: o.channel,
        guild_id: "800000000000000001",
        content: o.content,
        author: { id: o.author, username: o.username ?? "", global_name: o.username ?? "", ...(o.bot ? { bot: true } : {}) },
        ...(o.replyTo ? { message_reference: { message_id: o.replyTo } } : {}),
      };
    },
  };
}
export type LocalCommunity = ReturnType<typeof localCommunity>;

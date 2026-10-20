import {
  rebuildViews,
  projectionJob,
  scheduleInboxProjection,
} from "../server/inbox-views";
import { processKnowledgeFile } from "../server/knowledge-files";
import { processBrandAsset } from "../server/brand-assets";
import { resolveQuiet } from "../server/ai-resolutions";
import { sampleForReview } from "../server/zoe-review";
import { checkMonitors } from "../server/zoe-monitors";
import { runConnectorTest } from "../server/connectors";
import { expireApprovals } from "../server/procedures";
import { resumeDueWorkflows, resumeWorkflow, startWorkflows } from "../server/workflow-engine";
import { checkTimedWorkflows, runTimedWorkflows } from "../server/workflow-triggers";
import { releaseDeferred, runDelivery } from "../server/channels";
import { acceptEmail, receiveEmailJob, type EmailEnvironment } from "../server/email-in";
import { checkAwayEmails, checkDomainJob, scheduleDomainChecks, sendAlert, type EmailOutEnvironment } from "../server/email-out";
import { dohResolver, sesSender } from "../server/email-providers";
import { checkWhatsAppNumberJob, receiveWhatsAppJob, submitTemplateJob, syncTemplatesJob, type WhatsAppEnvironment } from "../server/whatsapp";
import { graphApi } from "../server/whatsapp-api";
import { checkSmsAccountJob, connectSmsNumberJob, receiveSmsJob, type SmsEnvironment } from "../server/sms";
import { twilioApi } from "../server/sms-api";
import { checkMetaPageJob, receiveMetaJob, type MetaEnvironment } from "../server/meta-messaging";
import { graphMessaging } from "../server/meta-api";
import { checkCommunityJob, discordConnections, receiveCommunityJob, type CommunityEnvironment } from "../server/community";
import { discordRestApi, slackWebApi } from "../server/community-api";
import { DiscordGatewayObject } from "./discord-gateway";
import { launchJob, outboundSweep } from "../server/outbound";
import { projectJob, scheduleProjection } from "../server/analytics";
import { buyNumberJob, configureVoiceNumberJob, readRecordingJob, searchNumbersJob, startRecordingJob, type VoiceEnvironment } from "../server/voice";
import { workersAiTranscriber, type WorkersAiSpeech } from "../server/voice-transcribe";
/** Voice (phase 12 E9): Twilio (the SMS account) and Workers AI's Whisper for transcripts. */
const voiceEnvironment = (env: Env, storage: VoiceEnvironment["storage"]): VoiceEnvironment => ({
  api: twilioApi(),
  key: env.RELAY_CONNECTOR_KEY,
  storage,
  transcriber: env.AI ? workersAiTranscriber(env.AI as unknown as WorkersAiSpeech) : undefined,
});
/** Slack and Discord (phase 12 E8): their Web and REST APIs, with each workspace's bot token (sealed). */
const communityEnvironment = (env: Env, storage: CommunityEnvironment["storage"]): CommunityEnvironment => ({
  slack: slackWebApi(),
  discord: discordRestApi(),
  key: env.RELAY_CONNECTOR_KEY,
  storage,
});
/** Phase 12 E8: a connected Discord bot's gateway, kept running (idempotent: an open socket stays). */
const ensureGateway = (env: Env, w: string, connectionId: string) => env.DISCORD_GATEWAY.getByName(`${w}:${connectionId}`).ensure(w, connectionId);
/** Instagram and Facebook Messenger (phase 12 E7): the Graph API, with each workspace's Page token (sealed). */
const metaEnvironment = (env: Env, storage: MetaEnvironment["storage"]): MetaEnvironment => ({ api: graphMessaging(), key: env.RELAY_CONNECTOR_KEY, storage });
/** SMS (phase 12 E6): Twilio, with each workspace's account (sealed with RELAY_CONNECTOR_KEY); status callbacks to the public origin. */
const smsEnvironment = (env: Env, storage: SmsEnvironment["storage"]): SmsEnvironment => ({ api: twilioApi(), key: env.RELAY_CONNECTOR_KEY, storage, hookOrigin: env.PUBLIC_ORIGIN });
/** WhatsApp (phase 12 E5): Meta's Cloud API; credentials are each workspace's, sealed with RELAY_CONNECTOR_KEY. */
const whatsappEnvironment = (env: Env, storage: WhatsAppEnvironment["storage"]): WhatsAppEnvironment => ({ api: graphApi(), key: env.RELAY_CONNECTOR_KEY, storage });
const emailEnvironment = (env: Env, storage: EmailEnvironment["storage"]): EmailEnvironment => ({
  storage,
  domain: env.RELAY_INBOUND_DOMAIN ?? "",
  trustedAuthServ: (env.RELAY_EMAIL_AUTHSERV ?? "mx.cloudflare.net").split(",").map((x) => x.trim()),
});
/** Email out (phase 12 E3): SES when its credentials are set; without them, email replies fail with a reason. */
const emailOutEnvironment = (env: Env, storage: EmailOutEnvironment["storage"]): EmailOutEnvironment => {
  const region = env.RELAY_SES_REGION ?? "eu-west-2";
  return {
    sender:
      env.RELAY_SES_ACCESS_KEY_ID && env.RELAY_SES_SECRET_ACCESS_KEY
        ? sesSender({ region, accessKeyId: env.RELAY_SES_ACCESS_KEY_ID, secretAccessKey: env.RELAY_SES_SECRET_ACCESS_KEY, configurationSet: env.RELAY_SES_CONFIGURATION_SET })
        : undefined,
    dns: dohResolver(),
    storage,
    inboundDomain: env.RELAY_INBOUND_DOMAIN ?? "",
    sendingDomain: env.RELAY_SENDING_DOMAIN ?? env.RELAY_INBOUND_DOMAIN ?? "",
    region,
  };
};
import { purgeModelCalls } from "../server/ai-privacy";
import { runSync, scheduleDueSyncs } from "../server/knowledge-sync";
import {
  runIndex,
  scheduleIndex,
  vectorizeStore,
  workersAiEmbedder,
  type IndexEnvironment,
  type VectorizeIndex,
  type WorkersAi,
} from "../server/knowledge-index";
import {
  runDuplicates,
  scheduleDuplicateCheck,
} from "../server/knowledge-health";
import { runAiReply, runProcedureResume, type AiEnvironment } from "../server/ai-agent";
import {
  claudeAnswerModel,
  claudeClassifier,
  workersAiReranker,
  type WorkersAiRerank,
} from "../server/ai-model";
import { purgeDrafts } from "../server/drafts";
import { purgeHelpSearches } from "../server/help-search";
import { purgeInlineImages } from "../server/attachments";
import { DurableObject } from "cloudflare:workers";
import { handleApi, isAgent, type ApiEnvironment } from "../server/api";
import { hyperdriveConnection } from "../server/postgres";
import { RealtimeClient, fanOutSignal } from "../server/realtime";
import { messengerAsset, portalAsset } from "../server/assets";
import { helpSite } from "../server/help-site";
import {
  drainConversationOutbox,
  drainJobStatusOutbox,
} from "../server/outbox";
import {
  dispatchJobs,
  runJob,
  type WorkMessage,
  type JobHandler,
} from "../server/jobs";
import { attachmentScan } from "../server/attachments";
import { r2Attachments, type StorageEnv } from "./storage";
import { tenant } from "../server/db";
import { wakeConversation } from "../server/conversations";
import { reindexSearch } from "../server/search";
import { rebuildCustomerUnread } from "../server/unread";
import { computeResponseMetrics } from "../server/business-time";
import { notifyWorkspace } from "../server/realtime-batch";
import { runBulkApply, runBulkUndo } from "../server/bulk";
import { runBroadcast } from "../server/ticket-links";
import { reevaluateJob, syncSla } from "../server/sla";
import { drainAll } from "../server/routing";
import { CoalescedPublisher } from "../server/publication";

interface Env extends Partial<StorageEnv> {
  HYPERDRIVE: Hyperdrive;
  /** Phase 14 R1: the analytical store, its own database (reporting is off without it). */
  ANALYTICS_HYPERDRIVE?: Hyperdrive;
  RELAY_HUB: DurableObjectNamespace<RelayHub>;
  /** Phase 12 E8: Discord's gateway connections. */
  DISCORD_GATEWAY: DurableObjectNamespace<DiscordGateway>;
  CONVERSATION_CLOCK: DurableObjectNamespace<ConversationClock>;
  ASSETS: Fetcher;
  SESSION_SECRET: string;
  IDENTITY_MASTER: string;
  /** Encrypts data connectors' credentials (phase 09 D1); connectors are unavailable without it. */
  RELAY_CONNECTOR_KEY?: string;
  BRIDGE_SECRET: string;
  RELAY_ENABLED?: string;
  ATTACHMENTS_ENABLED?: string;
  PUBLIC_ORIGIN: string;
  JOBS: Queue<WorkMessage>;
  JOBS_DLQ: Queue<WorkMessage>;
  WORKSPACE_REGISTRY: KVNamespace;
  DEAD_LETTER_QUEUE_NAME: string;
  /**
   * The AI index (phase 07, C2a): Workers AI for embeddings and a Vectorize index (cosine,
   * 1,024 dimensions). Both optional; without them the index can't run and its flag stays off.
   * TODO(phase 17): provision both and add them to the generated Worker config.
   */
  AI?: WorkersAi & WorkersAiRerank;
  KNOWLEDGE_VECTORS?: VectorizeIndex;
  /**
   * The AI agent's answering model (phase 08): Claude through Anthropic's API. A Worker secret
   * (`wrangler secret put ANTHROPIC_API_KEY`), never in config. Without it the agent can't run.
   */
  ANTHROPIC_API_KEY?: string;
  /**
   * Email in (phase 12 E2): the domain brands' inbound addresses are on (Cloudflare Email Routing
   * sends it to this Worker's `email` handler), and the receivers whose Authentication-Results are
   * believed (Email Routing's, `mx.cloudflare.net`, unless set). TODO(phase 17): the routing rule.
   */
  RELAY_INBOUND_DOMAIN?: string;
  RELAY_EMAIL_AUTHSERV?: string;
  /**
   * Email out (phase 12 E3): Amazon SES. The keys are secrets (`wrangler secret put`); the
   * configuration set publishes deliveries, bounces and complaints to the SNS topic, whose
   * subscription is `/v1/hooks/ses`. Brands send from Relay's own domain (the inbound one, unless
   * set) until theirs is proven.
   */
  RELAY_SES_REGION?: string;
  RELAY_SES_ACCESS_KEY_ID?: string;
  RELAY_SES_SECRET_ACCESS_KEY?: string;
  RELAY_SES_CONFIGURATION_SET?: string;
  RELAY_SES_TOPIC_ARN?: string;
  RELAY_SENDING_DOMAIN?: string;
}
/** The AI index's model and store, when both bindings exist. */
const knowledgeIndex = (env: Env): IndexEnvironment | undefined =>
  env.AI && env.KNOWLEDGE_VECTORS
    ? {
        embedders: [workersAiEmbedder(env.AI)],
        vectors: vectorizeStore(env.KNOWLEDGE_VECTORS),
      }
    : undefined;
/** The AI agent's models, when the index and the answering model's key both exist. */
const aiAgent = (env: Env): AiEnvironment | undefined => {
  const index = knowledgeIndex(env);
  return index && env.AI && env.ANTHROPIC_API_KEY
    ? {
        model: claudeAnswerModel(env.ANTHROPIC_API_KEY),
        rerank: workersAiReranker(env.AI),
        // Handover triggers (phase 08 A2a): Claude Haiku, with the same key.
        classify: claudeClassifier(env.ANTHROPIC_API_KEY),
        index,
      }
    : undefined;
};
async function scheduleClock(env: Env, w: string, id: string) {
  const row = await tenant(
    hyperdriveConnection(env.HYPERDRIVE),
    w,
    async (db) =>
      (
        await db.query<{
          id: string;
          snooze_until: string | null;
          snooze_version: string;
          status: string;
          sla_next_due_at: string | null;
        }>(
          "SELECT id,snooze_until,snooze_version,status,sla_next_due_at FROM conversations WHERE workspace_id=$1 AND id=$2",
          [w, id],
        )
      ).rows[0],
  );
  if (!row) return;
  const clock = env.CONVERSATION_CLOCK.getByName(w + ":" + id);
  await clock.schedule(
    w,
    id,
    String(row.snooze_version),
    row.status === "snoozed" ? row.snooze_until : null,
  );
  await clock.scheduleSla(
    w,
    id,
    row.sla_next_due_at ? new Date(row.sla_next_due_at).toISOString() : null,
  );
}
function environment(env: Env, ctx?: ExecutionContext): ApiEnvironment {
  const connect = hyperdriveConnection(env.HYPERDRIVE),
    background = (promise: Promise<unknown>) => {
      if (ctx) {
        ctx.waitUntil(promise);
        return Promise.resolve();
      }
      return promise.then(() => {});
    };
  const register = async (w: string) => {
    const key = "workspace:" + w;
    if (!(await env.WORKSPACE_REGISTRY.get(key)))
      await env.WORKSPACE_REGISTRY.put(key, "active");
  };
  const attachments =
    env.ATTACHMENTS_ENABLED === "true" &&
    env.ATTACHMENT_QUARANTINE &&
    env.ATTACHMENT_CLEAN &&
    env.SCANNER &&
    env.SCAN_SERVICE_TOKEN &&
    env.IMAGE_PREVIEW &&
    env.R2_ACCOUNT_ID &&
    env.R2_ACCESS_KEY_ID &&
    env.R2_SECRET_ACCESS_KEY &&
    env.R2_QUARANTINE_BUCKET &&
    env.R2_CLEAN_BUCKET
      ? r2Attachments(env as StorageEnv)
      : undefined;
  const analytics = env.ANALYTICS_HYPERDRIVE ? { connect: hyperdriveConnection(env.ANALYTICS_HYPERDRIVE) } : undefined;
  return {
    analytics,
    connect,
    attachments,
    knowledgeIndex: knowledgeIndex(env),
    // Procedures (phase 09 D2) call connectors from the reply job.
    ai: (() => {
      const ai = aiAgent(env);
      return ai && env.RELAY_CONNECTOR_KEY ? { ...ai, connectors: { key: env.RELAY_CONNECTOR_KEY } } : ai;
    })(),
    sessionSecret: env.SESSION_SECRET,
    identityMaster: env.IDENTITY_MASTER,
    connectors: env.RELAY_CONNECTOR_KEY ? { key: env.RELAY_CONNECTOR_KEY } : undefined,
    emailDomain: env.RELAY_INBOUND_DOMAIN,
    emailSending: { sendingDomain: env.RELAY_SENDING_DOMAIN ?? env.RELAY_INBOUND_DOMAIN ?? "", region: env.RELAY_SES_REGION ?? "eu-west-2" },
    sesReports: env.RELAY_SES_TOPIC_ARN ? { topicArn: env.RELAY_SES_TOPIC_ARN } : undefined,
    whatsapp: { api: graphApi() },
    voice: { api: twilioApi() },
    bridgeSecret: env.BRIDGE_SECRET,
    realtimeUrl: env.PUBLIC_ORIGIN.replace(/^http/, "ws") + "/realtime",
    notify: (workspace, id) =>
      background(
        register(workspace).then(async () => {
          await scheduleInboxProjection(connect, workspace);
          await dispatchJobs(connect, workspace, async (message) => {
            await env.JOBS.send(message);
          });
          await env.RELAY_HUB.getByName(workspace).notify(id);
          if (id) await scheduleClock(env, workspace, id);
        }),
      ),
    dispatchJobs: (workspace) =>
      background(
        register(workspace).then(() =>
          dispatchJobs(connect, workspace, async (message) => {
            await env.JOBS.send(message);
          }),
        ),
      ),
  };
}
/** Phase 12 E8: Discord's gateway connection for one bot (`workers/discord-gateway.ts`), on Hyperdrive. */
export class DiscordGateway extends DiscordGatewayObject<Env> {
  protected connectDb() {
    return hyperdriveConnection(this.env.HYPERDRIVE);
  }
}

export class ConversationClock extends DurableObject<Env> {
  async schedule(
    workspace: string,
    id: string,
    version: string,
    wakeAt: string | null,
  ) {
    const before = await this.ctx.storage.get<{ version: string }>("timer");
    if (before && BigInt(before.version) > BigInt(version)) return;
    await this.ctx.storage.put("timer", { workspace, id, version, wakeAt });
    await this.arm();
  }
  /** The SLA due time shares this object's one alarm with the snooze timer. */
  async scheduleSla(workspace: string, id: string, dueAt: string | null) {
    await this.ctx.storage.put("sla", { workspace, id, dueAt });
    await this.arm();
  }
  private async arm() {
    const snooze = await this.ctx.storage.get<{ wakeAt: string | null }>(
      "timer",
    );
    const sla = await this.ctx.storage.get<{ dueAt: string | null }>("sla");
    const times = [snooze?.wakeAt, sla?.dueAt]
      .filter((t): t is string => !!t)
      .map((t) => new Date(t).getTime());
    if (times.length)
      await this.ctx.storage.setAlarm(
        Math.max(Date.now() + 1, Math.min(...times)),
      );
    else await this.ctx.storage.deleteAlarm();
  }
  async alarm() {
    const timer = await this.ctx.storage.get<{
      workspace: string;
      id: string;
      version: string;
      wakeAt: string | null;
    }>("timer");
    const sla = await this.ctx.storage.get<{
      workspace: string;
      id: string;
      dueAt: string | null;
    }>("sla");
    const connect = hyperdriveConnection(this.env.HYPERDRIVE);
    if (timer?.wakeAt && new Date(timer.wakeAt).getTime() <= Date.now()) {
      const result = await tenant(connect, timer.workspace, (db) =>
        wakeConversation(db, timer.workspace, timer.id, timer.version),
      );
      if (result.woke)
        await this.env.RELAY_HUB.getByName(timer.workspace).notify(timer.id);
    }
    if (sla?.dueAt && new Date(sla.dueAt).getTime() <= Date.now()) {
      // Recomputing records the breach (once) and moves the due time on.
      const result = await tenant(connect, sla.workspace, (db) =>
        syncSla(db, sla.workspace, sla.id),
      );
      if (result.breached)
        await this.env.RELAY_HUB.getByName(sla.workspace).notify(sla.id);
      await scheduleClock(this.env, sla.workspace, sla.id);
      return;
    }
    await this.arm();
  }
}
export class RelayHub extends DurableObject<Env> {
  clients = new Map<WebSocket, RealtimeClient>();
  publisher = new CoalescedPublisher(async (ids) => {
    for (const socket of this.ctx.getWebSockets())
      if (!this.clients.has(socket))
        socket.send(JSON.stringify({ type: "reauthenticate" }));
    const workspace = [...this.clients.values()].find((c) => c.session)?.session
      ?.workspace;
    if (workspace)
      await drainConversationOutbox(
        hyperdriveConnection(this.env.HYPERDRIVE),
        workspace,
        (all) =>
          notifyWorkspace(
            hyperdriveConnection(this.env.HYPERDRIVE),
            workspace,
            this.clients.values(),
            all,
          ),
        ids,
      );
  });
  async fetch(request: Request) {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return new Response("WebSocket required", { status: 426 });
    const pair = new WebSocketPair(),
      client = pair[0],
      server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      workspace: new URL(request.url).searchParams.get("workspace"),
    });
    this.attach(server);
    return new Response(null, { status: 101, webSocket: client });
  }
  private attach(socket: WebSocket) {
    let client = this.clients.get(socket);
    if (client) return client;
    client = new RealtimeClient(
      {
        send: (data) => socket.send(data),
        close: (code, reason) => socket.close(code, reason),
      },
      environment(this.env),
      (sender, data) => fanOutSignal(this.clients.values(), sender, data),
      socket.deserializeAttachment()?.workspace,
    );
    this.clients.set(socket, client);
    return client;
  }
  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (this.env.RELAY_ENABLED !== "true") {
      socket.close(4403, "Feature disabled");
      return;
    }
    const data =
      typeof message === "string" ? message : new TextDecoder().decode(message);
    const client = this.attach(socket);
    // A hibernated connection must authenticate and replay again; no ephemeral state is reconstructed from PostgreSQL.
    await client.receive(data);
    if (client.session) {
      await this.ctx.storage.put("workspace", client.session.workspace);
      if ((await this.ctx.storage.getAlarm()) === null)
        await this.ctx.storage.setAlarm(Date.now() + 1000);
    }
  }
  webSocketClose(socket: WebSocket) {
    this.clients.get(socket)?.leave();
    this.clients.delete(socket);
  }
  webSocketError(socket: WebSocket) {
    this.clients.get(socket)?.leave();
    this.clients.delete(socket);
  }
  notify(id: string) {
    const done = this.publisher.publish(id);
    this.ctx.waitUntil(done);
    return done;
  }
  async jobChanged(id: string) {
    await Promise.all(
      [...this.clients.values()].map((client) => client.jobChanged(id)),
    );
  }
  async alarm() {
    const workspace = await this.ctx.storage.get<string>("workspace");
    if (!workspace) return;
    try {
      await drainConversationOutbox(
        hyperdriveConnection(this.env.HYPERDRIVE),
        workspace,
        (ids) => Promise.all(ids.map((id) => this.notify(id))).then(() => {}),
      );
      await drainJobStatusOutbox(
        hyperdriveConnection(this.env.HYPERDRIVE),
        workspace,
        (id) => this.jobChanged(id),
      );
    } finally {
      if (this.ctx.getWebSockets().length)
        await this.ctx.storage.setAlarm(Date.now() + 1000);
    }
  }
}
const relayWorker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/v1/") || url.pathname === "/realtime") {
      if (env.RELAY_ENABLED !== "true")
        return Response.json(
          {
            error: {
              code: "FEATURE_DISABLED",
              message: "Relay is not enabled.",
            },
          },
          { status: 404 },
        );
      if (url.pathname === "/realtime") {
        const workspace = url.searchParams.get("workspace");
        if (!workspace || workspace.length > 100)
          return new Response("Workspace required", { status: 400 });
        return env.RELAY_HUB.getByName(workspace).fetch(request);
      }
      return handleApi(request, environment(env, ctx));
    }
    return messengerAsset(
      request,
      hyperdriveConnection(env.HYPERDRIVE),
      (req) =>
        portalAsset(req, hyperdriveConnection(env.HYPERDRIVE), (r) =>
          // The public help center: /help/… here, or a mapped custom domain (phase 07, B1).
          helpSite(
            r,
            hyperdriveConnection(env.HYPERDRIVE),
            env.PUBLIC_ORIGIN,
            (x) => env.ASSETS.fetch(x),
            (w, id) => environment(env, ctx).notify?.(w, id),
            environment(env, ctx).attachments,
          ),
        ),
      env.R2_ACCOUNT_ID
        ? [`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`]
        : [],
    );
  },
  async queue(batch: MessageBatch<WorkMessage>, env: Env) {
    const runtime = environment(env);
    const handlers: Record<string, JobHandler> = {
      "inbox.views.rebuild": (job) => rebuildViews(runtime.connect, job),
      "inbox.views.project": (job) =>
        projectionJob(runtime.connect, job, (w) =>
          env.RELAY_HUB.getByName(w).notify(""),
        ),
      "customer.unread.rebuild": (job) =>
        rebuildCustomerUnread(runtime.connect, job),
      "search.reindex": (job) => reindexSearch(runtime.connect, job),
      "conversation.metrics": (job) =>
        computeResponseMetrics(runtime.connect, job),
      "bulk.apply": (job) => runBulkApply(runtime.connect, job),
      "bulk.undo": (job) => runBulkUndo(runtime.connect, job),
      "ticket.broadcast": (job) => runBroadcast(runtime.connect, job),
      "sla.reevaluate": (job) => reevaluateJob(runtime.connect, job),
      // Phase 11: workflows triggered, and waiting runs resumed.
      // W3: read connectors, when their key is set.
      "workflow.start": (job) => startWorkflows(runtime.connect, job, { connectors: runtime.connectors }),
      "workflow.resume": (job) => resumeWorkflow(runtime.connect, job, { connectors: runtime.connectors }),
      // W4: schedules, unanswered customers and SLAs about to breach.
      "workflow.timed": (job) => runTimedWorkflows(runtime.connect, job),
      // Phase 12: a reply delivered on its conversation's channel (E3: email through SES).
      "channel.deliver": (job) =>
        runDelivery(
          runtime.connect,
          {
            providers: {
              email: emailOutEnvironment(env, runtime.attachments),
              whatsapp: whatsappEnvironment(env, runtime.attachments),
              sms: smsEnvironment(env, runtime.attachments),
              meta: metaEnvironment(env, runtime.attachments),
              community: communityEnvironment(env, runtime.attachments),
            },
          },
          job,
        ),
      // Phase 12 E6: Twilio's calls read, the account checked, numbers pointed at Relay.
      "sms.receive": (job) => receiveSmsJob(runtime.connect, smsEnvironment(env, runtime.attachments), job),
      "sms.check": (job) => checkSmsAccountJob(runtime.connect, smsEnvironment(env, runtime.attachments), job),
      "sms.number": (job) => connectSmsNumberJob(runtime.connect, smsEnvironment(env, runtime.attachments), job),
      // Phase 12 E7: Meta's Messenger and Instagram calls read, Pages checked.
      "meta.receive": (job) => receiveMetaJob(runtime.connect, metaEnvironment(env, runtime.attachments), job),
      "meta.check": (job) => checkMetaPageJob(runtime.connect, metaEnvironment(env, runtime.attachments), job),
      // Phase 12 E8: Slack's events and Discord's messages read; bots checked (Discord's gateway then started).
      "community.receive": (job) => receiveCommunityJob(runtime.connect, communityEnvironment(env, runtime.attachments), job),
      "community.check": (job) => checkCommunityJob(runtime.connect, communityEnvironment(env, runtime.attachments), job, (w, id) => ensureGateway(env, w, id)),
      // Phase 12 E9: calls recorded (with consent), recordings stored and transcribed, numbers set up and bought.
      "voice.record": (job) => startRecordingJob(runtime.connect, voiceEnvironment(env, runtime.attachments), job),
      "voice.recording": (job) => readRecordingJob(runtime.connect, voiceEnvironment(env, runtime.attachments), job),
      "voice.number": (job) => configureVoiceNumberJob(runtime.connect, voiceEnvironment(env, runtime.attachments), job),
      "voice.search": (job) => searchNumbersJob(runtime.connect, voiceEnvironment(env, runtime.attachments), job),
      "voice.buy": (job) => buyNumberJob(runtime.connect, voiceEnvironment(env, runtime.attachments), job),
      // Phase 13 O2: a fixed audience (a one-off, or an occurrence) entered, in batches.
      "outbound.launch": (job) => launchJob(runtime.connect, job),
      // Phase 14 R1: reporting's store fed from the application (also its backfill).
      "analytics.project": (job) =>
        runtime.analytics ? projectJob(runtime.connect, runtime.analytics, job) : Promise.resolve({ done: true, result: { skipped: "No analytical store." } }),
      // Phase 12 E5: WhatsApp's webhook calls read, numbers checked, templates submitted and synced.
      "whatsapp.receive": (job) => receiveWhatsAppJob(runtime.connect, whatsappEnvironment(env, runtime.attachments), job),
      "whatsapp.check": (job) => checkWhatsAppNumberJob(runtime.connect, whatsappEnvironment(env, runtime.attachments), job),
      "whatsapp.template": (job) => submitTemplateJob(runtime.connect, whatsappEnvironment(env, runtime.attachments), job),
      "whatsapp.sync": (job) => syncTemplatesJob(runtime.connect, whatsappEnvironment(env, runtime.attachments), job),
      // Phase 12 E3: a sending domain's records and the provider's identity, checked.
      "email.domain.check": (job) => checkDomainJob(runtime.connect, emailOutEnvironment(env, runtime.attachments), job),
      // Phase 12 E4: Zoe's incident alerts by email.
      "email.alert": (job) => sendAlert(runtime.connect, emailOutEnvironment(env, runtime.attachments), job),
      // Phase 12 E2: an email received at an inbound address, read into its conversation.
      "email.receive": (job) => receiveEmailJob(runtime.connect, emailEnvironment(env, runtime.attachments), job),
    };
    if (runtime.attachments)
      handlers["attachment.scan"] = (job) =>
        attachmentScan(runtime.connect, runtime.attachments!, job);
    if (runtime.attachments)
      handlers["knowledge.file.process"] = (job) =>
        processKnowledgeFile(runtime.connect, runtime.attachments!, job);
      handlers["messenger.asset.process"] = (job) =>
        processBrandAsset(runtime.connect, runtime.attachments!, job);
    // Website sync (phase 07, C1b). TODO(phase 17): a Browser Rendering renderer for JavaScript sites.
    handlers["knowledge.sync.run"] = (job) => runSync(runtime.connect, {}, job);
    // The AI index (phase 07, C2a), when its bindings exist.
    if (runtime.knowledgeIndex)
      handlers["knowledge.index"] = (job) =>
        runIndex(runtime.connect, runtime.knowledgeIndex!, job);
    // The AI agent (phase 08) answers customers, when its models are bound.
    if (runtime.ai)
      handlers["ai.reply"] = (job) =>
        runAiReply(runtime.connect, runtime.ai!, job);
    // A procedure resumed after a teammate's decision on a write (phase 09 D3).
    if (runtime.ai)
      handlers["procedure.resume"] = (job) =>
        runProcedureResume(runtime.connect, runtime.ai!, job);
    // A data connector's test console (phase 09 D1), when its key is set.
    if (runtime.connectors)
      handlers["connector.test"] = (job) =>
        runConnectorTest(runtime.connect, runtime.connectors!, job);
    // Content health's near-duplicate check (phase 07, C2b) reads the same vector store.
    if (runtime.knowledgeIndex)
      handlers["knowledge.duplicates"] = (job) =>
        runDuplicates(runtime.connect, runtime.knowledgeIndex!, job);
    for (const message of batch.messages) {
      const work = message.body;
      try {
        if ("sweep" in work) {
          if (batch.queue === env.DEAD_LETTER_QUEUE_NAME) {
            console.error("Workspace recovery exhausted retries", {
              workspace: work.workspace,
            });
            message.ack();
            continue;
          }
          await scheduleInboxProjection(runtime.connect, work.workspace);
          await dispatchJobs(runtime.connect, work.workspace, async (m) => {
            await env.JOBS.send(m);
          });
          await drainConversationOutbox(
            runtime.connect,
            work.workspace,
            (ids) =>
              Promise.all(
                ids.map((id) =>
                  env.RELAY_HUB.getByName(work.workspace).notify(id),
                ),
              ).then(() => {}),
          );
          await drainJobStatusOutbox(runtime.connect, work.workspace, (id) =>
            env.RELAY_HUB.getByName(work.workspace).jobChanged(id),
          );
          const overdue = await tenant(
            runtime.connect,
            work.workspace,
            async (db) =>
              (
                await db.query<{ id: string }>(
                  "SELECT id FROM conversations WHERE workspace_id=$1 AND ((status='snoozed' AND snooze_until<now()+interval '1 minute') OR sla_next_due_at<now()+interval '1 minute') ORDER BY id LIMIT 100",
                  [work.workspace],
                )
              ).rows,
          );
          for (const c of overdue)
            await scheduleClock(env, work.workspace, c.id);
          // Websites due a sync (phase 07, C1b).
          await scheduleDueSyncs(runtime.connect, work.workspace);
          // Published knowledge waiting for the AI index (phase 07, C2a).
          if (runtime.knowledgeIndex)
            await scheduleIndex(runtime.connect, work.workspace);
          // AI answers the customer didn't come back to: resolved (phase 08 A3).
          await resolveQuiet(runtime.connect, work.workspace);
          // Answers for Zoe's review queue: pushbacks, and yesterday's sample once (phase 08 C2a).
          await sampleForReview(runtime.connect, work.workspace);
          // Zoe's monitors, once an hour (phase 08 C2b).
          await checkMonitors(runtime.connect, work.workspace);
          // Approvals for writes expire after 24 hours (phase 09 D3).
          await expireApprovals(runtime.connect, work.workspace);
          // Workflow runs whose wait is over (phase 11).
          await resumeDueWorkflows(runtime.connect, work.workspace);
          // Time triggers (phase 11 W4), checked once a minute.
          await checkTimedWorkflows(runtime.connect, work.workspace);
          // Outbound (phase 13 O2): one-offs that started, and recurring messages' occurrences.
          await outboundSweep(runtime.connect, work.workspace);
          // Reporting (phase 14 R1): the store kept current, once a sweep.
          if (runtime.analytics) await scheduleProjection(runtime.connect, work.workspace);
          // Email out (phase 12 E3): rate-limited deliveries whose minute came, away emails,
          // and sending domains due a check.
          await releaseDeferred(runtime.connect, work.workspace);
          await checkAwayEmails(runtime.connect, work.workspace);
          await scheduleDomainChecks(runtime.connect, work.workspace);
          // Phase 12 E8: every connected Discord bot's gateway running.
          for (const id of await discordConnections(runtime.connect, work.workspace)) await ensureGateway(env, work.workspace, id);
          // Queues left waiting (a missed trigger): route what now fits.
          for (const r of await drainAll(runtime.connect, work.workspace))
            await env.RELAY_HUB.getByName(work.workspace).notify(
              r.conversationId,
            );
          // Daily draft retention: during 03:00 UTC each sweep removes up to 500 expired drafts.
          if (new Date().getUTCHours() === 3) {
            await purgeDrafts(runtime.connect, work.workspace);
            // Help center searches are kept for 180 days (phase 07, B2).
            await purgeHelpSearches(runtime.connect, work.workspace);
            // What was sent to model providers is kept 90 days (phase 08, B2b).
            await purgeModelCalls(runtime.connect, work.workspace);
            await purgeInlineImages(
              runtime.connect,
              runtime.attachments,
              work.workspace,
            );
            // The nightly near-duplicate check (phase 07, C2b); at most one per 20 hours.
            if (runtime.knowledgeIndex)
              await scheduleDuplicateCheck(runtime.connect, work.workspace);
          }
          message.ack();
          continue;
        }
        if (batch.queue === env.DEAD_LETTER_QUEUE_NAME) {
          await tenant(runtime.connect, work.workspace, (db) =>
            db.query(
              "UPDATE jobs SET state='dead_letter',lease_until=NULL,lease_token=NULL,version=version+1 WHERE workspace_id=$1 AND id=$2 AND state<>'succeeded'",
              [work.workspace, work.jobId],
            ),
          );
          await env.RELAY_HUB.getByName(work.workspace).jobChanged(work.jobId);
          message.ack();
          continue;
        }
        const result = await runJob(
          runtime.connect,
          work.workspace,
          work.jobId,
          handlers,
        );
        await env.RELAY_HUB.getByName(work.workspace).jobChanged(work.jobId);
        await scheduleInboxProjection(runtime.connect, work.workspace);
        await dispatchJobs(runtime.connect, work.workspace, async (m) => {
          await env.JOBS.send(m);
        });
        await env.RELAY_HUB.getByName(work.workspace).notify("");
        if (result.state === "dead_letter") {
          await env.JOBS_DLQ.send(work);
          message.ack();
        } else if ("continued" in result && result.continued) {
          await env.JOBS.send(work);
          message.ack();
        } else if (result.retry)
          message.retry({ delaySeconds: Math.min(60, 2 ** message.attempts) });
        else message.ack();
      } catch {
        message.retry({ delaySeconds: 30 });
      }
    }
  },
  /** Phase 12 E2: mail from Cloudflare Email Routing, at a brand's inbound address. */
  async email(message: ForwardableEmailMessage, env: Env) {
    if (env.RELAY_ENABLED !== "true" || !env.RELAY_INBOUND_DOMAIN) {
      message.setReject("This address isn't accepting mail.");
      return;
    }
    const runtime = environment(env);
    const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
    const result = await acceptEmail(runtime.connect, emailEnvironment(env, runtime.attachments), { raw, to: message.to, from: message.from });
    if (!result.accepted) message.setReject(result.reason);
    else await runtime.notify?.(message.to.split("+")[0], "");
  },
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ) {
    if (env.RELAY_ENABLED !== "true") return;
    ctx.waitUntil(
      (async () => {
        let cursor: string | undefined;
        do {
          const page = await env.WORKSPACE_REGISTRY.list({
            prefix: "workspace:",
            cursor,
            limit: 1000,
          });
          for (let i = 0; i < page.keys.length; i += 100)
            await env.JOBS.sendBatch(
              page.keys.slice(i, i + 100).map((k) => ({
                body: {
                  workspace: k.name.slice("workspace:".length),
                  sweep: true,
                },
              })),
            );
          cursor = page.list_complete ? undefined : page.cursor;
        } while (cursor);
      })(),
    );
  },
};
export default relayWorker;

import {
  rebuildViews,
  projectionJob,
  scheduleInboxProjection,
  mutateView,
} from "../server/inbox-views";
/** Loopback-only development fixture. Never imported by the deployed Worker. */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { resolve, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { WebSocketServer } from "ws";
import { SignJWT, jwtVerify } from "jose";
import { bodyLimit, bridgeAgentRequest } from "../server/agent-bridge";
import {
  attachmentScan,
  purgeInlineImages,
  type AttachmentStorage,
} from "../server/attachments";
import { localDatabase } from "./local-db";
import {
  localAttachmentStorage,
  LOCAL_STORAGE_PATH,
  LOCAL_UPLOAD_LIMIT,
} from "./local-storage";
import { getIdentity, seedFoundation } from "../server/people";
import { tenant, digest, type Sql } from "../server/db";
import { normalizeDoc, plainText, type RichDoc } from "../lib/rich-doc";
import { handleApi, type ApiEnvironment } from "../server/api";
import { RealtimeClient, fanOutSignal } from "../server/realtime";
import { messengerAsset, portalAsset } from "../server/assets";
import { helpSite } from "../server/help-site";
import { identityIssuer, unwrapIdentityKey } from "../server/identity";
import { notifyWorkspace } from "../server/realtime-batch";
import { runBulkApply, runBulkUndo } from "../server/bulk";
import { runBroadcast } from "../server/ticket-links";
import { checkDueSlas, reevaluateJob } from "../server/sla";
import { drainAll } from "../server/routing";
import { saveTicketType } from "../server/tickets";
import { CoalescedPublisher } from "../server/publication";
import { processKnowledgeFile } from "../server/knowledge-files";
import { processBrandAsset } from "../server/brand-assets";
import { resolveQuiet } from "../server/ai-resolutions";
import { sampleForReview } from "../server/zoe-review";
import { checkMonitors } from "../server/zoe-monitors";
import { runConnectorTest } from "../server/connectors";
import { expireApprovals } from "../server/procedures";
import { resumeDueWorkflows, resumeWorkflow, startWorkflows } from "../server/workflow-engine";
import { changeWorkflow } from "../server/workflows";
import { checkTimedWorkflows, runTimedWorkflows } from "../server/workflow-triggers";
import { registerChannel, releaseDeferred, runDelivery, type ChannelAdapter } from "../server/channels";
import { checkAwayEmails, checkDomainJob, domainRecords, ensureDomain, queueDomainCheck, scheduleDomainChecks, sendAlert, type EmailOutEnvironment } from "../server/email-out";
import { localEmailProvider, localSns } from "./local-email";
import { acceptEmail, receiveEmailJob, type EmailEnvironment } from "../server/email-in";
/** Phase 12 E2: local inbound addresses (`<workspace>+<token>@` this), and the receiver believed. */
export const LOCAL_EMAIL_DOMAIN = "inbound.relay.localhost";
export const LOCAL_AUTHSERV = "relay.localhost";
/** Relay's own sending domain locally (phase 12 E3): the same as the inbound one. */
export const LOCAL_SENDING_DOMAIN = LOCAL_EMAIL_DOMAIN;
export const LOCAL_SES_REGION = "eu-west-2";
import type { FetchPolicy } from "../server/safe-fetch";
import { purgeModelCalls } from "../server/ai-privacy";
import {
  runIndex,
  scheduleIndex,
  type IndexEnvironment,
} from "../server/knowledge-index";
import {
  runDuplicates,
  scheduleDuplicateCheck,
} from "../server/knowledge-health";
import { runAiReply, runProcedureResume } from "../server/ai-agent";
import {
  claudeAnswerModel,
  claudeClassifier,
  standInAnswerModel,
  standInClassifier,
  standInReranker,
  type AnswerModel,
  type ClassifierPort,
  type RerankPort,
} from "../server/ai-model";
import { localIndex } from "./local-vectors";
import {
  runSync,
  scheduleDueSyncs,
  type SyncEnvironment,
} from "../server/knowledge-sync";
import { runJob, type JobHandler } from "../server/jobs";
import { reindexSearch } from "../server/search";
import { rebuildCustomerUnread } from "../server/unread";
import { computeResponseMetrics } from "../server/business-time";
import {
  drainConversationOutbox,
  drainJobStatusOutbox,
} from "../server/outbox";
import { command, wakeConversation } from "../server/conversations";
import { purgeDrafts } from "../server/drafts";
import { purgeHelpSearches, reindexKnowledge } from "../server/help-search";

export async function startLocalRelay(
  options: {
    apiPort?: number;
    hostPort?: number;
    directory?: string;
    /** Storage for uploads; defaults to in-memory loopback storage. */
    attachments?: AttachmentStorage;
    agentInbox?: boolean;
    inboxViews?: boolean;
    /** Tickets are on locally unless turned off; deployed workspaces default to off. */
    tickets?: boolean;
    /** Business hours and SLAs, likewise on locally unless turned off. */
    sla?: boolean;
    /** The customer portal, likewise. */
    portal?: boolean;
    /** Routing and workload, likewise. */
    routing?: boolean;
    knowledge?: boolean;
    helpCenter?: boolean;
    /** Website sync, likewise. */
    knowledgeSync?: boolean;
    /** The Settings area, likewise on locally unless turned off. */
    settings?: boolean;
    /** The AI index (phase 07, C2a), likewise on locally unless turned off. */
    knowledgeIndex?: boolean;
    /** The content health report (phase 07, C2b). */
    knowledgeHealth?: boolean;
    /** Zoe's review queue (phase 08, C2a). */
    zoeReview?: boolean;
    /** Zoe's monitors and incidents (phase 08, C2b). */
    zoeMonitors?: boolean;
    /** Data connectors (phase 09, D1): on unless turned off; tests pass a fetch with recorded responses. */
    aiActions?: boolean;
    connectors?: { policy?: FetchPolicy; sleep?: (ms: number) => Promise<void> };
    /** Workflows (phase 11), likewise on unless turned off. */
    workflows?: boolean;
    /** Its model and vector store; by default the test embedder and a local store. */
    index?: IndexEnvironment;
    /** The AI agent's models (phase 08); stand-ins by default. */
    ai?: { model?: AnswerModel; rerank?: RerankPort; classify?: ClassifierPort };
    /** The AI agent (phase 08), likewise on locally unless turned off. */
    aiAgent?: boolean;
    /** Messenger drafts (messenger settings M1), likewise on locally unless turned off. */
    messengerV3?: boolean;
    /** Website sync's fetch policy and renderer (tests reach a local test site this way). */
    sync?: SyncEnvironment;
    longTimeline?: boolean;
    /** Phase 12: channels besides the messenger (tests register stand-ins; each step adds its own). */
    channels?: ChannelAdapter[];
    /** Channels (phase 12), likewise on unless turned off. */
    channelsFlag?: boolean;
    /** Email in (phase 12 E2), likewise on unless turned off. */
    emailFlag?: boolean;
    /** Development seed (phase 12 E2): two example emails in the demo workspace. */
    exampleEmail?: boolean;
    /** Development seed (phase 11 W2): a draft workflow to open in the builder. */
    exampleWorkflow?: boolean;
  } = {},
) {
  const db = await localDatabase(
      options.directory ? resolve(options.directory, "postgres") : undefined,
    ),
    apiPort = options.apiPort ?? 8788,
    hostPort = options.hostPort ?? 8789;
  const localFiles = localAttachmentStorage();
  const apiOrigin = `http://127.0.0.1:${apiPort}`,
    hostOrigin = `http://127.0.0.1:${hostPort}`,
    clients = new Set<RealtimeClient>(),
    sockets = new Map<import("ws").WebSocket, RealtimeClient>();
  const secret = () => crypto.randomUUID() + crypto.randomUUID();
  let keys = { session: secret(), identity: secret(), bridge: secret(), connector: secret() };
  if (options.directory) {
    await mkdir(options.directory, { recursive: true });
    const path = resolve(options.directory, "local-secrets.json");
    try {
      keys = JSON.parse(await readFile(path, "utf8"));
      // Data connectors (phase 09 D1) arrived later: add their key to an older file, once.
      if (!keys.connector) {
        keys.connector = secret();
        await writeFile(path, JSON.stringify(keys), { mode: 0o600 });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await writeFile(path, JSON.stringify(keys), { mode: 0o600, flag: "wx" });
    }
  }
  /** Signs a demo customer's identity token with the demo workspace's stored key. */
  const demoIdentity = async (userId: string) => {
    const wrapped = await tenant(
      db.connect,
      "demo",
      async (sql) =>
        (
          await sql.query<{ wrapped_key: string }>(
            "SELECT wrapped_key FROM identity_keys WHERE workspace_id='demo' AND kid='initial'",
          )
        ).rows[0].wrapped_key,
    );
    const key = await unwrapIdentityKey(
      wrapped,
      keys.identity,
      "demo",
      "initial",
    );
    return new SignJWT({
      email: userId + "@example.test",
      workspace_id: "demo",
    })
      .setProtectedHeader({ alg: "HS256", kid: "initial" })
      .setSubject(userId)
      .setIssuer(identityIssuer("demo"))
      .setAudience("relay-messenger")
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(key);
  };
  const publishers = new Map<string, CoalescedPublisher>(),
    background = new Set<Promise<void>>();
  const publishBatch = (w: string, ids: string[]) => {
    let publisher = publishers.get(w);
    if (!publisher) {
      publisher = new CoalescedPublisher((ids) =>
        drainConversationOutbox(
          db.connect,
          w,
          (all) => notifyWorkspace(db.connect, w, clients, all),
          ids,
        ).then(() => {}),
      );
      publishers.set(w, publisher);
    }
    return Promise.all(ids.map((id) => publisher!.publish(id))).then(() => {});
  };
  const publish = (w: string, id: string) => {
    const task = scheduleInboxProjection(db.connect, w)
      .then(() => publishBatch(w, [id]))
      .catch(() => {})
      .finally(() => background.delete(task));
    background.add(task);
    return Promise.resolve();
  };
  const env: ApiEnvironment = {
    connect: db.connect,
    storageTransport: "local-pglite",
    attachments: options.attachments ?? localFiles.storage,
    sessionSecret: keys.session,
    identityMaster: keys.identity,
    bridgeSecret: keys.bridge,
    realtimeUrl: apiOrigin.replace("http", "ws") + "/realtime",
    notify: publish,
    sync: options.sync ?? {},
    knowledgeIndex: options.index ?? localIndex(options.directory),
    // Data connectors (phase 09 D1): a local key; calls go only where the policy allows.
    connectors: { key: keys.connector, ...options.connectors },
    emailDomain: LOCAL_EMAIL_DOMAIN,
    emailSending: { sendingDomain: LOCAL_SENDING_DOMAIN, region: LOCAL_SES_REGION },
  };
  const emailEnv: EmailEnvironment = { storage: env.attachments, domain: LOCAL_EMAIL_DOMAIN, trustedAuthServ: [LOCAL_AUTHSERV] };
  // Email out (phase 12 E3): stand-in providers; nothing leaves the machine. SNS reports are
  // signed by a local key and checked by the real route.
  const email = localEmailProvider();
  const sns = await localSns();
  env.sesReports = sns.environment;
  const emailOut: EmailOutEnvironment = {
    sender: email.sender,
    dns: email.dns,
    storage: env.attachments,
    inboundDomain: LOCAL_EMAIL_DOMAIN,
    sendingDomain: LOCAL_SENDING_DOMAIN,
    region: LOCAL_SES_REGION,
  };
  // The AI agent (phase 08): offline stand-ins locally, unless a test passes its own.
  env.ai = {
    model: options.ai?.model ?? standInAnswerModel(),
    rerank: options.ai?.rerank ?? standInReranker(),
    classify: options.ai?.classify ?? standInClassifier(),
    index: env.knowledgeIndex!,
    // Procedures (phase 09 D2) call connectors from the reply job.
    connectors: env.connectors,
  };
  for (const w of ["demo", "other"])
    await tenant(db.connect, w, (sql) =>
      seedFoundation(sql, w, "local-owner", {
        origins: [hostOrigin],
        master: env.identityMaster,
        identitySecret: new TextEncoder().encode(secret()),
        enable: true,
      }),
    );
  // Directory seed: a team and two tags per workspace, for assignment and tagging locally.
  for (const w of ["demo", "other"])
    await tenant(db.connect, w, async (sql) => {
      await sql.query(
        "INSERT INTO teams(workspace_id,id,name) VALUES($1,'billing','Billing') ON CONFLICT DO NOTHING",
        [w],
      );
      // Conversation attributes for the details sidebar.
      await sql.query(
        `INSERT INTO attribute_definitions(workspace_id,id,name,owner_type,value_type,options) VALUES
        ($1,'order_number','Order number','conversation','string',NULL),
        ($1,'plan','Plan','conversation','options','["Free","Pro","Enterprise"]'),
        ($1,'refund_approved','Refund approved','conversation','boolean',NULL)
        ON CONFLICT DO NOTHING`,
        [w],
      );
      // A second teammate, in Billing, so mentions and notifications can be tried locally.
      await sql.query(
        "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES($1,'grace','local-grace','Grace','agent') ON CONFLICT DO NOTHING",
        [w],
      );
      await sql.query(
        "INSERT INTO teammate_teams(workspace_id,teammate_id,team_id) VALUES($1,'grace','billing') ON CONFLICT DO NOTHING",
        [w],
      );
      // Two sample macros: shared (variable plus actions) and the owner's personal one.
      const p = (...content: unknown[]) => ({
        type: "doc",
        content: [{ type: "paragraph", content }],
      });
      await sql.query(
        `INSERT INTO macros(workspace_id,id,owner_id,shared,name,mode,body,actions) VALUES
        ($1,'refund-approved','owner',true,'Refund approved','reply',$2,$3),
        ($1,'ask-order','owner',false,'Ask for order number','reply',$4,'[]')
        ON CONFLICT DO NOTHING`,
        [
          w,
          JSON.stringify(
            p(
              { type: "text", text: "Hi " },
              {
                type: "variable",
                attrs: { name: "contact.first_name", fallback: "there" },
              },
              {
                type: "text",
                text: ", your refund is approved and should arrive within 5 working days.",
              },
            ),
          ),
          JSON.stringify([
            { type: "tag_add", tagId: "refund" },
            { type: "close" },
          ]),
          JSON.stringify(
            p({
              type: "text",
              text: "Could you share your order number so I can look into this?",
            }),
          ),
        ],
      );
      await sql.query(
        "INSERT INTO tags(workspace_id,id,name) VALUES($1,'vip','VIP'),($1,'refund','Refund') ON CONFLICT DO NOTHING",
        [w],
      );
      // A custom role (Settings S3a), held by nobody yet.
      await sql.query(
        "INSERT INTO roles(workspace_id,id,name) VALUES($1,'team_lead','Team lead') ON CONFLICT DO NOTHING",
        [w],
      );
      await sql.query(
        `INSERT INTO role_capabilities(workspace_id,role_id,capability)
        SELECT $1,'team_lead',c FROM unnest(ARRAY['conversations.read','conversations.reply','conversations.note','conversations.manage','conversations.assign','contacts.personal_data','macros.use','macros.create','macros.edit','tickets.manage']) c
        ON CONFLICT DO NOTHING`,
        [w],
      );
      // An archived tag (Settings S2b): kept for history, left out of pickers.
      await sql.query(
        "INSERT INTO tags(workspace_id,id,name,archived_at) VALUES($1,'legacy','Legacy',now()) ON CONFLICT DO NOTHING",
        [w],
      );
      // Two sample customer ticket types, with their own fields (kept out of the general
      // attributes above, which stay usable on any conversation).
      await sql.query(
        `INSERT INTO attribute_definitions(workspace_id,id,name,owner_type,value_type,options) VALUES
        ($1,'severity','Severity','conversation','options','["Low","Medium","High"]'),
        ($1,'affected_version','Affected version','conversation','string',NULL),
        ($1,'refund_amount','Refund amount','conversation','float',NULL),
        ($1,'refund_reason','Refund reason','conversation','string',NULL)
        ON CONFLICT DO NOTHING`,
        [w],
      );
      await sql.query(
        "UPDATE workspace_features SET enabled=true WHERE workspace_id=$1 AND name='tickets_v1'",
        [w],
      );
      const seeded = (
        await sql.query("SELECT 1 FROM ticket_types WHERE workspace_id=$1", [w])
      ).rows.length;
      if (!seeded) {
        await saveTicketType(sql, w, "local-owner", {
          name: "Bug report",
          icon: "bug",
          category: "customer",
          states: [
            {
              key: "new",
              name: "New",
              customerLabel: "Received",
              kind: "submitted",
            },
            {
              key: "investigating",
              name: "Investigating",
              customerLabel: "In progress",
              kind: "in_progress",
            },
            {
              key: "waiting",
              name: "Waiting on customer",
              customerLabel: "Waiting for you",
              kind: "waiting_on_customer",
            },
            {
              key: "fixed",
              name: "Fixed",
              customerLabel: "Resolved",
              kind: "resolved",
            },
          ],
          transitions: [
            ["new", "investigating"],
            ["investigating", "waiting"],
            ["waiting", "investigating"],
            ["investigating", "fixed"],
            ["fixed", "investigating"],
          ],
          fields: [
            { attributeId: "severity", requiredToClose: true },
            { attributeId: "affected_version", requiredToClose: false },
          ],
        });
        await saveTicketType(sql, w, "local-owner", {
          name: "Refund request",
          icon: "coins",
          category: "customer",
          states: [
            { key: "submitted", name: "Submitted", kind: "submitted" },
            { key: "reviewing", name: "Reviewing", kind: "in_progress" },
            { key: "refunded", name: "Refunded", kind: "resolved" },
          ],
          transitions: [
            ["submitted", "reviewing"],
            ["reviewing", "refunded"],
          ],
          fields: [
            { attributeId: "refund_amount", requiredToClose: true },
            { attributeId: "refund_reason", requiredToClose: false },
          ],
        });
        // Back-office: finance approves refunds without talking to the customer.
        await saveTicketType(sql, w, "local-owner", {
          name: "Refund approval",
          icon: "wallet",
          category: "back_office",
          states: [
            { key: "pending", name: "Pending finance", kind: "submitted" },
            { key: "approved", name: "Approved", kind: "resolved" },
            { key: "declined", name: "Declined", kind: "resolved" },
          ],
          transitions: [
            ["pending", "approved"],
            ["pending", "declined"],
          ],
          fields: [],
        });
        // Tracker: one incident, many affected customers.
        await saveTicketType(sql, w, "local-owner", {
          name: "Incident",
          icon: "siren",
          category: "tracker",
          states: [
            {
              key: "investigating",
              name: "Investigating",
              kind: "in_progress",
            },
            { key: "monitoring", name: "Monitoring", kind: "in_progress" },
            { key: "resolved", name: "Resolved", kind: "resolved" },
          ],
          transitions: [
            ["investigating", "monitoring"],
            ["monitoring", "resolved"],
            ["investigating", "resolved"],
          ],
          fields: [],
        });
      }
      await sql.query(
        "UPDATE workspace_features SET enabled=$2 WHERE workspace_id=$1 AND name='sla_v1'",
        [w, options.sla !== false],
      );
      await sql.query(
        "UPDATE workspace_features SET enabled=$2 WHERE workspace_id=$1 AND name='portal_v1'",
        [w, options.portal !== false],
      );
      // Routing: Billing is a balanced team inbox (limit 20) with the owner (5) and Grace (3).
      await sql.query(
        "UPDATE workspace_features SET enabled=$2 WHERE workspace_id=$1 AND name='routing_v1'",
        [w, options.routing !== false],
      );
      await sql.query(
        "UPDATE teams SET method='balanced',conversation_limit=20 WHERE workspace_id=$1 AND id='billing' AND method='manual' AND conversation_limit IS NULL",
        [w],
      );
      await sql.query(
        "INSERT INTO teammate_teams(workspace_id,teammate_id,team_id) VALUES($1,'owner','billing') ON CONFLICT DO NOTHING",
        [w],
      );
      await sql.query(
        "UPDATE teammates SET conversation_limit=CASE id WHEN 'owner' THEN 5 ELSE 3 END WHERE workspace_id=$1 AND id IN ('owner','grace') AND conversation_limit IS NULL",
        [w],
      );
      // A sample SLA policy on the seeded office hours (Mon–Fri 09:00–17:00 UTC).
      await sql.query(
        `INSERT INTO sla_policies(workspace_id,id,name,position,conditions,targets,hours,pause)
        VALUES($1,'standard','Standard support',10,NULL,$2,'business','{"snoozed":true,"waiting_on_customer":true}')
        ON CONFLICT DO NOTHING`,
        [
          w,
          JSON.stringify({
            first_response: 60 * 60_000,
            next_response: 2 * 60 * 60_000,
            time_to_close: 8 * 60 * 60_000,
            time_to_resolve: 24 * 60 * 60_000,
          }),
        ],
      );
      // Knowledge (phase 07): a published public article and an internal draft to try editing.
      await sql.query(
        "UPDATE workspace_features SET enabled=$2 WHERE workspace_id=$1 AND name='knowledge_v1'",
        [w, options.knowledge !== false],
      );
      // The public help center (phase 07, B1): /help/{workspace}/relay-help.
      await sql.query(
        "UPDATE workspace_features SET enabled=$2 WHERE workspace_id=$1 AND name='help_center_v1'",
        [w, options.helpCenter !== false],
      );
      // Website sync (phase 07, C1b).
      await sql.query(
        "UPDATE workspace_features SET enabled=$2 WHERE workspace_id=$1 AND name='knowledge_sync_v1'",
        [w, options.knowledgeSync !== false],
      );
      // The Settings area (S1).
      await sql.query(
        "UPDATE workspace_features SET enabled=$2 WHERE workspace_id=$1 AND name='settings_v1'",
        [w, options.settings !== false],
      );
      // The AI index (phase 07, C2a).
      await sql.query(
        "UPDATE workspace_features SET enabled=$2 WHERE workspace_id=$1 AND name='knowledge_index_v1'",
        [w, options.knowledgeIndex !== false],
      );
      // Messenger drafts (messenger settings M1).
      await sql.query(
        "UPDATE workspace_features SET enabled=$2 WHERE workspace_id=$1 AND name='messenger_v3'",
        [w, options.messengerV3 !== false],
      );
      // The AI agent (phase 08).
      await sql.query(
        "UPDATE workspace_features SET enabled=$2 WHERE workspace_id=$1 AND name='ai_agent_v1'",
        [w, options.aiAgent !== false],
      );
      // Content health (phase 07, C2b).
      await sql.query(
        "UPDATE workspace_features SET enabled=$2 WHERE workspace_id=$1 AND name='knowledge_health_v1'",
        [w, options.knowledgeHealth !== false],
      );
      // Zoe's review queue (phase 08, C2a).
      await sql.query(
        "UPDATE workspace_features SET enabled=$2 WHERE workspace_id=$1 AND name='zoe_review_v1'",
        [w, options.zoeReview !== false],
      );
      // Zoe's monitors and incidents (phase 08, C2b).
      await sql.query(
        "UPDATE workspace_features SET enabled=$2 WHERE workspace_id=$1 AND name='zoe_monitors_v1'",
        [w, options.zoeMonitors !== false],
      );
      // Data connectors (phase 09, D1).
      await sql.query(
        "UPDATE workspace_features SET enabled=$2 WHERE workspace_id=$1 AND name='ai_actions_v1'",
        [w, options.aiActions !== false],
      );
      // Workflows (phase 11, W1).
      await sql.query(
        "UPDATE workspace_features SET enabled=$2 WHERE workspace_id=$1 AND name='workflows_v1'",
        [w, options.workflows !== false],
      );
      // Channels (phase 12, E1).
      await sql.query(
        "UPDATE workspace_features SET enabled=$2 WHERE workspace_id=$1 AND name='channels_v1'",
        [w, options.channelsFlag !== false],
      );
      // Email in (phase 12, E2): each brand an inbound address; the demo's default brand's is fixed,
      // `demo+support@inbound.relay.localhost`, to send to locally.
      await sql.query(
        "UPDATE workspace_features SET enabled=$2 WHERE workspace_id=$1 AND name='channel_email_v1'",
        [w, options.emailFlag !== false],
      );
      await sql.query(
        "INSERT INTO email_settings(workspace_id,brand_id,token) VALUES($1,'default',$2) ON CONFLICT DO NOTHING",
        [w, "support"],
      );
      await seedKnowledge(sql, w);
      await seedKnowledgeFile(
        sql,
        w,
        options.attachments ?? localFiles.storage,
      );
      // Seeded articles bypass publishing, so they are indexed for search here.
      await reindexKnowledge(sql, w);
      if (options.tickets === false)
        await sql.query(
          "UPDATE workspace_features SET enabled=false WHERE workspace_id=$1 AND name='tickets_v1'",
          [w],
        );
    });
  // Explicit local seed opt-in. Deployed flags remain off by default.
  for (const w of ["demo", "other"])
    await tenant(db.connect, w, (sql) =>
      sql.query(
        "UPDATE workspace_features SET enabled=$2 WHERE workspace_id=$1 AND name='agent_inbox_v1'",
        [w, options.agentInbox !== false],
      ),
    );
  for (const w of ["demo", "other"])
    await tenant(db.connect, w, (sql) =>
      sql.query(
        "UPDATE workspace_features SET enabled=$2 WHERE workspace_id=$1 AND name='agent_inbox_views_v1'",
        [w, options.inboxViews === true],
      ),
    );
  // Development seed: one 200-part conversation per workspace, to try scrolling back.
  // Fixed idempotency keys make this a no-op on restart.
  if (options.longTimeline)
    for (const w of ["demo", "other"])
      await tenant(db.connect, w, async (sql) => {
        const identity = await getIdentity(sql, w, "anonymous", "long-history");
        const { conversationId } = (await command(
          sql,
          w,
          {
            type: "contact",
            identityId: identity.identityId,
            brandId: "default",
          },
          "local-seed-long-start",
          { action: "start", text: "Long history demo" },
        )) as { conversationId: string };
        for (let i = 1; i <= 200; i++)
          await command(
            sql,
            w,
            { type: "teammate", principal: "local-owner" },
            "local-seed-long-" + i,
            {
              action: i % 10 === 0 ? "note" : "reply",
              conversationId,
              text: (i % 10 === 0 ? "Team note " : "Reply ") + i,
            },
          );
        // The same customer, with details and two earlier conversations, for the sidebar.
        await sql.query(
          `UPDATE contacts SET name='Jo Bloggs',role='lead',origin_timezone='Europe/London'
          WHERE workspace_id=$1 AND id=(SELECT contact_id FROM identity_contact_mappings WHERE workspace_id=$1 AND identity_id=$2)`,
          [w, identity.identityId],
        );
        await sql.query(
          `INSERT INTO contact_emails(workspace_id,contact_id,email,verified)
          SELECT $1,contact_id,'jo@example.test',true FROM identity_contact_mappings WHERE workspace_id=$1 AND identity_id=$2
          ON CONFLICT DO NOTHING`,
          [w, identity.identityId],
        );
        for (const text of ["Where is my order?", "Change my plan"])
          await command(
            sql,
            w,
            {
              type: "contact",
              identityId: identity.identityId,
              brandId: "default",
            },
            "local-seed-earlier-" + text,
            { action: "start", text },
          );
      });
  // Development seed (phase 11 W2): a draft workflow in the demo workspace, to open in the builder.
  // Its fixed idempotency key makes this a no-op on restart, even after it's renamed or archived.
  if (options.exampleWorkflow && options.workflows !== false)
    await tenant(db.connect, "demo", (sql) =>
      changeWorkflow(sql, "demo", "local-owner", "local-seed-workflow", {
        action: "create",
        name: "Example: route refund requests",
        definition: {
          trigger: { type: "first_message", options: {} },
          when: { match: "all", items: [] },
          paths: [
            {
              id: "A",
              label: "Start",
              steps: [],
              next: {
                type: "branch",
                branches: [
                  {
                    label: "Asks for a refund",
                    when: { match: "any", items: [{ field: "message.text", op: "contains", value: "refund" }] },
                    path: "B",
                  },
                ],
                else: "C",
              },
            },
            {
              id: "B",
              label: "Refunds",
              steps: [
                { id: "seed-tag", type: "tag_add", options: { tagId: "refund" } },
                { id: "seed-assign", type: "assign", options: { teamId: "billing" } },
                { id: "seed-priority", type: "priority", options: { value: true } },
              ],
              next: { type: "end" },
            },
            {
              id: "C",
              label: "Everyone else",
              steps: [{ id: "seed-note", type: "note", options: { text: "Not a refund: triage as usual." } }],
              next: { type: "end" },
            },
          ],
        },
      }),
    );
  // W3: a draft that talks to the customer (reply buttons), to test against a conversation.
  if (options.exampleWorkflow && options.workflows !== false)
    await tenant(db.connect, "demo", (sql) =>
      changeWorkflow(sql, "demo", "local-owner", "local-seed-workflow-buttons", {
        action: "create",
        name: "Example: ask what they need",
        definition: {
          trigger: { type: "first_message", options: {} },
          when: { match: "all", items: [] },
          paths: [
            {
              id: "A",
              label: "Start",
              steps: [{ id: "seed-hello", type: "message", options: { text: "Hi! Let's get you to the right place." } }],
              next: {
                type: "buttons",
                text: "What can we help with?",
                buttons: [
                  { label: "Billing", path: "B" },
                  { label: "Something else", path: "C" },
                ],
                other: "C",
                timeoutSeconds: 86_400,
                timedOut: "C",
              },
            },
            {
              id: "B",
              label: "Billing",
              steps: [
                { id: "seed-billing-tag", type: "tag_add", options: { tagId: "refund" } },
                { id: "seed-billing-team", type: "assign", options: { teamId: "billing" } },
                { id: "seed-reply-time", type: "reply_time", options: {} },
              ],
              next: { type: "end" },
            },
            { id: "C", label: "Zoe", steps: [], next: { type: "zoe", resolved: "D", handedOver: "D", timeoutSeconds: 86_400, timedOut: "D" } },
            { id: "D", label: "Done", steps: [], next: { type: "end" } },
          ],
        },
      }),
    );
  // Two-workspace views seed: the owner's default views plus one shared view each. Fixed
  // idempotency keys make this a no-op on restart; queued rebuilds run in the loop below.
  if (options.inboxViews)
    for (const w of ["demo", "other"])
      await tenant(db.connect, w, async (sql) => {
        await mutateView(sql, w, "local-owner", "local-seed-views-init", {
          action: "initialize",
        });
        await mutateView(sql, w, "local-owner", "local-seed-views-shared", {
          action: "save",
          name: "Open priority (shared)",
          shared: true,
          filter: {
            and: [
              { field: "state", op: "eq", value: "open" },
              { field: "priority", op: "eq", value: true },
            ],
          },
        });
      });
  // Loopback substitutes for Queues/Cron/alarms. Status is persisted and pushed, never polled by the browser.
  const handlers: Record<string, JobHandler> = {
    "inbox.views.rebuild": (job) => rebuildViews(db.connect, job),
    "inbox.views.project": (job) =>
      projectionJob(db.connect, job, (w) => publishBatch(w, [""])),
    "search.reindex": (job) => reindexSearch(db.connect, job),
    "customer.unread.rebuild": (job) => rebuildCustomerUnread(db.connect, job),
    "conversation.metrics": (job) => computeResponseMetrics(db.connect, job),
    "bulk.apply": (job) => runBulkApply(db.connect, job),
    "bulk.undo": (job) => runBulkUndo(db.connect, job),
    "ticket.broadcast": (job) => runBroadcast(db.connect, job),
    "sla.reevaluate": (job) => reevaluateJob(db.connect, job),
  };
  if (env.attachments)
    handlers["attachment.scan"] = (job) =>
      attachmentScan(db.connect, env.attachments!, job);
  if (env.attachments)
    handlers["knowledge.file.process"] = (job) =>
      processKnowledgeFile(db.connect, env.attachments!, job);
    handlers["messenger.asset.process"] = (job) =>
      processBrandAsset(db.connect, env.attachments!, job);
  handlers["knowledge.sync.run"] = (job) =>
    runSync(db.connect, env.sync ?? {}, job);
  handlers["knowledge.index"] = (job) =>
    runIndex(db.connect, env.knowledgeIndex!, job);
  handlers["knowledge.duplicates"] = (job) =>
    runDuplicates(db.connect, env.knowledgeIndex!, job);
  handlers["ai.reply"] = (job) => runAiReply(db.connect, env.ai!, job);
  handlers["connector.test"] = (job) => runConnectorTest(db.connect, env.connectors!, job);
  handlers["procedure.resume"] = (job) => runProcedureResume(db.connect, env.ai!, job);
  // Phase 11: workflows triggered, and waiting runs resumed.
  // W3: workflows call read connectors with the same key and fetch policy as Zoe.
  handlers["workflow.start"] = (job) => startWorkflows(db.connect, job, { connectors: env.connectors });
  handlers["workflow.resume"] = (job) => resumeWorkflow(db.connect, job, { connectors: env.connectors });
  handlers["workflow.timed"] = (job) => runTimedWorkflows(db.connect, job);
  // Phase 12: replies delivered on their conversation's channel.
  const unregister = (options.channels ?? []).map(registerChannel);
  handlers["channel.deliver"] = (job) => runDelivery(db.connect, { providers: { email: emailOut } }, job);
  handlers["email.domain.check"] = (job) => checkDomainJob(db.connect, emailOut, job);
  handlers["email.alert"] = (job) => sendAlert(db.connect, emailOut, job);
  // Phase 12 E2: emails received at inbound addresses, read into their conversations.
  handlers["email.receive"] = (job) => receiveEmailJob(db.connect, emailEnv, job);
  // Development seed (phase 12 E2): a Gmail reply with its quote, and one with attachments, sent to
  // the demo's inbound address once (their Message-IDs are checked first).
  if (options.exampleEmail && options.emailFlag !== false && options.channelsFlag !== false)
    for (const file of ["01-gmail-reply.eml", "47-attachments.eml"]) {
      const raw = new Uint8Array(await readFile(new URL(`../tests/fixtures/email/${file}`, import.meta.url)));
      const seen = await tenant(db.connect, "demo", async (q) =>
        (await q.query("SELECT 1 FROM email_inbound WHERE workspace_id='demo' AND envelope_from=$1", ["seed:" + file])).rows.length,
      );
      if (!seen) await acceptEmail(db.connect, emailEnv, { raw, to: `demo+support@${LOCAL_EMAIL_DOMAIN}`, from: "seed:" + file });
    }
  // Development seed (phase 12 E3): the demo brand's support address is help@acme.example, and
  // its records are in the stand-in DNS (kept in memory, so published at every start), so replies
  // go from it once the first check runs.
  if (options.exampleEmail && options.emailFlag !== false && options.channelsFlag !== false)
    await tenant(db.connect, "demo", async (q) => {
      await q.query("UPDATE email_settings SET support_address='help@acme.example' WHERE workspace_id='demo' AND brand_id='default' AND support_address IS NULL");
      const support = (await q.query<{ support_address: string | null }>("SELECT support_address FROM email_settings WHERE workspace_id='demo' AND brand_id='default'")).rows[0]
        ?.support_address;
      const domain = await ensureDomain(q, "demo", support ?? null);
      if (domain !== "acme.example") return;
      const d = (await q.query<{ ownership_token: string; status: string }>("SELECT ownership_token,status FROM email_domains WHERE workspace_id='demo' AND domain=$1", [domain])).rows[0];
      email.publishAll(domainRecords(domain, d.ownership_token, (await email.sender.identity(domain)).dkimTokens, LOCAL_SES_REGION));
      if (d.status !== "verified") await queueDomainCheck(q, "demo", domain);
    });
  const lastSyncCheck = new Map<string, number>();
  const lastPurge = new Map<string, number>();
  let maintenance: Promise<void> | undefined,
    stopped = false;
  const maintain = () => {
    if (maintenance || stopped) return;
    maintenance = (async () => {
      for (const w of ["demo", "other"]) {
        await scheduleInboxProjection(db.connect, w);
        const pending = await tenant(
          db.connect,
          w,
          async (sql) =>
            (
              await sql.query<{ id: string; kind: string }>(
                "SELECT id,kind FROM jobs WHERE workspace_id=$1 AND state IN ('queued','running') AND (lease_until IS NULL OR lease_until<now()) ORDER BY created_at,id LIMIT 20",
                [w],
              )
            ).rows,
        );
        for (const job of pending) {
          await runJob(db.connect, w, job.id, handlers);
          // Indexing knowledge changes nothing a teammate's inbox shows: no workspace refresh.
          if (
            job.kind !== "knowledge.index" &&
            job.kind !== "knowledge.duplicates"
          )
            await publishBatch(w, [""]);
        }
        const timers = await tenant(
          db.connect,
          w,
          async (sql) =>
            (
              await sql.query<{ id: string; snooze_version: string }>(
                "SELECT id,snooze_version FROM conversations WHERE workspace_id=$1 AND status='snoozed' AND snooze_until<=now() ORDER BY snooze_until,id LIMIT 100",
                [w],
              )
            ).rows,
        );
        for (const timer of timers)
          await tenant(db.connect, w, (sql) =>
            wakeConversation(sql, w, timer.id, timer.snooze_version),
          );
        // SLA due times that have passed: record breaches and push them live.
        const breached = await checkDueSlas(db.connect, w);
        if (breached.length) await publishBatch(w, breached);
        // Queues left waiting (a missed trigger): route what now fits.
        const routed = await drainAll(db.connect, w);
        if (routed.length)
          await publishBatch(
            w,
            routed.map((r) => r.conversationId),
          );
        // Published knowledge waiting for the AI index (phase 07, C2a).
        await scheduleIndex(db.connect, w);
        // AI answers the customer didn't come back to: resolved (phase 08 A3).
        await resolveQuiet(db.connect, w);
        // Answers for Zoe's review queue: pushbacks, and yesterday's sample once (phase 08 C2a).
        await sampleForReview(db.connect, w);
        // Zoe's monitors, once an hour (phase 08 C2b).
        await checkMonitors(db.connect, w);
        // Approvals for writes expire after 24 hours (phase 09 D3).
        await expireApprovals(db.connect, w);
        // Workflow runs whose wait is over (phase 11).
        await resumeDueWorkflows(db.connect, w);
        // Time triggers (phase 11 W4), checked once a minute.
        await checkTimedWorkflows(db.connect, w);
        // Email out (phase 12 E3): rate-limited deliveries whose minute came, away emails,
        // and sending domains due a check.
        await releaseDeferred(db.connect, w);
        await checkAwayEmails(db.connect, w);
        await scheduleDomainChecks(db.connect, w);
        // Websites due a sync (phase 07, C1b), checked once a minute.
        if (Date.now() - (lastSyncCheck.get(w) ?? 0) > 60_000) {
          lastSyncCheck.set(w, Date.now());
          await scheduleDueSyncs(db.connect, w);
        }
        // Draft retention, at most once a day per workspace (the Worker runs it at 03:00 UTC).
        if (Date.now() - (lastPurge.get(w) ?? 0) > 86_400_000) {
          lastPurge.set(w, Date.now());
          await purgeDrafts(db.connect, w);
          await purgeHelpSearches(db.connect, w);
          // What was sent to model providers is kept 90 days (phase 08, B2b).
          await purgeModelCalls(db.connect, w);
          await purgeInlineImages(db.connect, env.attachments, w);
          // The nightly near-duplicate check (phase 07, C2b).
          await scheduleDuplicateCheck(db.connect, w);
        }
        await drainConversationOutbox(db.connect, w, (ids) =>
          publishBatch(w, ids),
        );
        await drainJobStatusOutbox(db.connect, w, (id) =>
          Promise.all(
            [...clients]
              .filter((c) => c.session?.workspace === w)
              .map((c) => c.jobChanged(id)),
          ).then(() => {}),
        );
      }
    })()
      .catch(() => {
        console.error("Local recovery failed; persisted work will retry.");
      })
      .finally(() => {
        maintenance = undefined;
      });
  };
  const maintenanceTimer = setInterval(maintain, 1000);
  maintenanceTimer.unref();
  env.dispatchJobs = async () => {
    maintain();
  };
  async function agent(
    body?: unknown,
    workspace = "demo",
    search = "",
    route?: string,
  ) {
    const method = body ? "POST" : "GET",
      path = route ?? (body ? "/v1/agent/command" : "/v1/agent/inbox"),
      key = crypto.randomUUID();
    const token = await new SignJWT({
      workspace,
      principal: "local-owner",
      method,
      path,
      query: search,
      ...(body ? { digest: await digest(body), key } : {}),
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("relay-sites")
      .setAudience("relay-agent")
      .setIssuedAt()
      .setExpirationTime("30s")
      .sign(new TextEncoder().encode(env.bridgeSecret));
    return handleApi(
      new Request(apiOrigin + path + search, {
        method,
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          "idempotency-key": key,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      env,
    );
  }
  const staticResponse = async (req: Request) => {
    const path = decodeURIComponent(new URL(req.url).pathname),
      file = resolve("public", "." + path);
    if (!file.startsWith(resolve("public") + "/"))
      return new Response("Not found", { status: 404 });
    try {
      return new Response(await readFile(file), {
        headers: {
          "content-type":
            (
              {
                ".html": "text/html",
                ".js": "text/javascript",
                ".css": "text/css",
                ".svg": "image/svg+xml",
              } as Record<string, string>
            )[extname(file)] ?? "application/octet-stream",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  };
  // Requests still being handled. Closing waits for them before the database closes, so one
  // that arrives during shutdown never reaches a closed database (the one-off "Relay API failed"
  // in the browser suite, from scripts/local-db.ts at teardown).
  const requests = new Set<Promise<void>>();
  const tracked =
    (handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>) =>
    (req: IncomingMessage, res: ServerResponse) => {
      if (stopped) {
        res.writeHead(503);
        res.end();
        return;
      }
      const task: Promise<void> = handle(req, res).finally(() =>
        requests.delete(task),
      );
      requests.add(task);
    };
  const serve = (origin: string, handler: (r: Request) => Promise<Response>) =>
    createServer(
      tracked(async (req: IncomingMessage, res: ServerResponse) => {
        try {
          // Raw bytes: uploads to local storage are binary and up to 20 MB. Agent routes use the
          // same per-route limits as the server (knowledge saves up to 1 MB, bulk 256 KB);
          // everything else 24 KB.
          const agentRoute = req.url?.match(
            /^\/(?:api\/agent|v1\/agent)\/([^?]*)/,
          );
          const limit = req.url?.startsWith(LOCAL_STORAGE_PATH)
            ? LOCAL_UPLOAD_LIMIT
            : req.url === "/dev/email"
              ? 25 * 1024 * 1024 + 4096
            : agentRoute
              ? Math.max(24000, bodyLimit(agentRoute[1]) + 4096)
              : 24000;
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of req) {
            size += (chunk as Buffer).length;
            if (size > limit) {
              res.writeHead(413);
              res.end();
              return;
            }
            chunks.push(chunk as Buffer);
          }
          const body = Buffer.concat(chunks);
          const request = new Request(origin + req.url, {
            method: req.method,
            headers: req.headers as HeadersInit,
            ...(body.length ? { body } : {}),
          });
          const r =
            (await localFiles.handle(request)) ?? (await handler(request));
          res.writeHead(r.status, Object.fromEntries(r.headers));
          res.end(Buffer.from(await r.arrayBuffer()));
        } catch {
          res.writeHead(500);
          res.end("Local fixture failed");
        }
      }),
    );
  const api = serve(apiOrigin, async (req) => {
    // Phase 12 E2: a raw email posted here arrives as if by Email Routing (loopback only):
    // `X-Envelope-To` is the inbound address, `X-Envelope-From` the sender.
    if (new URL(req.url).pathname === "/dev/email" && req.method === "POST") {
      const result = await acceptEmail(db.connect, emailEnv, {
        raw: new Uint8Array(await req.arrayBuffer()),
        to: req.headers.get("x-envelope-to") ?? "",
        from: req.headers.get("x-envelope-from") ?? "",
      });
      if (result.accepted) void publish(String(req.headers.get("x-envelope-to")).split("+")[0], "");
      return Response.json(result, { status: result.accepted ? 202 : 550 });
    }
    // Phase 12 E3: what the stand-in provider was given to send (newest first), read back.
    if (new URL(req.url).pathname === "/dev/outbox" && req.method === "GET")
      return Response.json({ sent: await Promise.all([...email.outbox].reverse().slice(0, 50).map((m) => email.read(m))) });
    // A DNS record, as a domain's owner would add it: {name, type, value}.
    if (new URL(req.url).pathname === "/dev/dns" && req.method === "POST") {
      const r = (await req.json()) as { name?: string; type?: string; value?: string };
      if (!r.name || !["TXT", "CNAME", "MX"].includes(String(r.type)) || typeof r.value !== "string") return Response.json({ error: "name, type and value" }, { status: 400 });
      email.publish(r.name, r.type as "TXT", r.value);
      return Response.json({ published: true });
    }
    const { value: response, timing } = await db.measure(() =>
      new URL(req.url).pathname.startsWith("/v1/")
        ? handleApi(req, env)
        : messengerAsset(req, db.connect, (r) =>
            portalAsset(r, db.connect, (x) =>
              helpSite(
                x,
                db.connect,
                apiOrigin,
                staticResponse,
                env.notify,
                env.attachments,
              ),
            ),
          ),
    );
    response.headers.append(
      "server-timing",
      `dbqueue;dur=${timing.queueMs.toFixed(3)}, dbtransaction;dur=${timing.transactionMs.toFixed(3)}, dbsql;dur=${timing.sqlMs.toFixed(3)}`,
    );
    return response;
  });
  const ws = new WebSocketServer({ server: api, path: "/realtime" });
  ws.on("connection", (socket, request) => {
    const w =
      new URL(request.url!, apiOrigin).searchParams.get("workspace") ?? "";
    const c = new RealtimeClient(
      {
        send: (data) => {
          if (socket.readyState === 1) socket.send(data);
        },
        close: (code, reason) => socket.close(code, reason),
      },
      env,
      // The same routing as the deployed Worker (server/realtime.ts).
      (sender, data) => fanOutSignal(clients, sender, data),
      w,
    );
    clients.add(c);
    sockets.set(socket, c);
    socket.on("message", (data) => void c.receive(data.toString()));
    socket.on("close", () => {
      c.leave();
      clients.delete(c);
      sockets.delete(socket);
    });
  });
  const host = serve(hostOrigin, async (req) => {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/agent/")) {
      let principal: string | undefined;
      const cookie = req.headers
        .get("cookie")
        ?.split(";")
        .map((s) => s.trim())
        .find((s) => s.startsWith("relay_local_agent="))
        ?.slice("relay_local_agent=".length);
      if (cookie)
        try {
          principal = (
            await jwtVerify(cookie, new TextEncoder().encode(keys.bridge), {
              algorithms: ["HS256"],
              issuer: "relay-local-fixture",
              audience: "agent-browser",
            })
          ).payload.sub;
        } catch {
          /* Missing/expired local session must fail closed. */
        }
      return bridgeAgentRequest(
        req,
        principal,
        {
          RELAY_AGENT_INBOX_V1: options.agentInbox === false ? "false" : "true",
          RELAY_STORAGE_AUTHORITY: "postgres",
          RELAY_API_ORIGIN: apiOrigin,
          RELAY_WORKSPACE_ID: "demo",
          RELAY_BRIDGE_SECRET: keys.bridge,
        },
        (upstream) => handleApi(upstream, env),
      );
    }
    if (url.pathname === "/demo/agent" || url.pathname === "/demo/agent.js")
      return new Response("Use the authenticated agent inbox.", {
        status: 404,
      });
    if (url.pathname.startsWith("/agent/")) return staticResponse(req);
    // The messenger's own page and files, for Settings' live preview (messenger settings M2).
    if (
      ["/messenger/frame.html", "/messenger/frame.js", "/messenger/frame.css"].includes(
        url.pathname,
      )
    )
      return staticResponse(req);
    if (url.pathname === "/agent") {
      // Development-only identity, issued only on the loopback fixture, never in app/ or workers/.
      // `?as=grace` signs in as the seeded second teammate, to try mentions between two people.
      const token = await new SignJWT({})
        .setSubject(
          url.searchParams.get("as") === "grace"
            ? "local-grace"
            : "local-owner",
        )
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer("relay-local-fixture")
        .setAudience("agent-browser")
        .setExpirationTime("1h")
        .sign(new TextEncoder().encode(keys.bridge));
      return new Response(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Relay agent inbox</title><link rel="stylesheet" href="/agent/entry.css"></head><body style="margin:0"><div id="agent-root"></div><script src="/agent/entry.js" defer></script></body></html>`,
        {
          headers: {
            "content-type": "text/html",
            "cache-control": "no-store",
            "set-cookie":
              "relay_local_agent=" +
              token +
              "; HttpOnly; SameSite=Strict; Path=/api/agent; Max-Age=3600",
            "content-security-policy": `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ${apiOrigin.replace("http", "ws")}; img-src 'self' https:; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'`,
          },
        },
      );
    }
    // Development-only signed customer (loopback fixture): `?user=jo` boots the messenger as a
    // verified customer, and /demo/portal-link?user=jo is a signed link into the portal, as the
    // customer's own site would build them with its identity key.
    const demoUser = url.searchParams.get("user");
    if (url.pathname === "/demo/portal-link" && demoUser) {
      const token = await demoIdentity(demoUser);
      return new Response(null, {
        status: 302,
        headers: {
          location: `${apiOrigin}/portal/demo/default#${new URLSearchParams({ token, user: demoUser, email: demoUser + "@example.test" })}`,
        },
      });
    }
    if (url.pathname === "/demo/boot.js")
      return new Response(
        `window.relayViolations=[];document.addEventListener('securitypolicyviolation',e=>window.relayViolations.push(e.violatedDirective));window.Relay=window.Relay||function(){(window.Relay.q=window.Relay.q||[]).push(arguments)};Relay('boot',{api:${JSON.stringify(apiOrigin)},workspaceId:'demo',brandId:'default',locale:new URLSearchParams(location.search).get('locale')||'en'${demoUser ? `,user:${JSON.stringify({ userId: demoUser, email: demoUser + "@example.test", jwt: await demoIdentity(demoUser) })}` : ""}});document.getElementById('open-support').onclick=()=>Relay('open');document.getElementById('notifications').onclick=()=>Relay('enableNotifications');`,
        { headers: { "content-type": "text/javascript" } },
      );
    if (url.pathname === "/demo/hostile.css")
      return new Response(
        `*{font-family:monospace!important;color:#ee3355!important;line-height:2!important;border-radius:0!important}button{background:yellow!important;padding:30px!important;font-size:28px!important}iframe{border:30px solid red!important;width:75px!important;height:75px!important}body{background:#e9f1f4;margin:40px}article{max-width:650px}`,
        { headers: { "content-type": "text/css" } },
      );
    const baseline = url.searchParams.has("baseline");
    // The test site allows images from Relay, as the install guide asks for an uploaded launcher
    // logo (messenger M5).
    const body = `<article><p>Relay / integration test</p><h1>A deliberately unfriendly host page</h1><p>This page applies aggressive styles to every element, button and iframe. Relay's controls stay inside their own document and shadow root.</p><button id="open-support">Open support</button><button id="notifications">Enable reply notifications</button><p><a href="/agent">Open the local agent inbox</a></p><p id="anchor">This paragraph must not move when the messenger boots or opens.</p></article>${baseline ? "" : `<script src="/demo/boot.js${url.searchParams.get("user") ? "?user=" + encodeURIComponent(url.searchParams.get("user")!) : ""}" defer></script><script src="${apiOrigin}/messenger/loader.js" async></script>`}`;
    return new Response(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Relay hostile host</title><link rel="stylesheet" href="/demo/hostile.css"></head><body>${body}</body></html>`,
      {
        headers: {
          "content-type": "text/html",
          "content-security-policy": `default-src 'none'; script-src 'self' ${apiOrigin}; style-src 'self' ${apiOrigin}; frame-src ${apiOrigin}; connect-src 'self' ${apiOrigin} ${apiOrigin.replace("http", "ws")}; img-src 'self' ${apiOrigin}; object-src 'none'; base-uri 'none'; form-action 'none'`,
        },
      },
    );
  });
  await Promise.all([
    new Promise<void>((r) => api.listen(apiPort, "127.0.0.1", r)),
    new Promise<void>((r) => host.listen(hostPort, "127.0.0.1", r)),
  ]);
  return {
    db,
    env,
    agent,
    apiOrigin,
    hostOrigin,
    /** Email out's stand-ins (phase 12 E3): the outbox and DNS, and SNS's signing. */
    email,
    sns,
    clients,
    disconnect(conversationId: string) {
      for (const [socket, client] of sockets)
        if (client.subscriptions.has(conversationId)) socket.terminate();
    },
    async close() {
      for (const off of unregister) off();
      stopped = true;
      clearInterval(maintenanceTimer);
      await maintenance;
      for (const s of ws.clients) s.terminate();
      ws.close();
      await Promise.all([
        new Promise<void>((r) => {
          api.close(() => r());
          api.closeAllConnections();
        }),
        new Promise<void>((r) => {
          host.close(() => r());
          host.closeAllConnections();
        }),
      ]);
      while (requests.size || background.size)
        await Promise.allSettled([...requests, ...background]);
      await db.close();
    },
  };
}
/**
 * The Anthropic key in `.dev.vars`, if there is one (phase 08 Z2): with it, the local demo's Zoe
 * answers and classifies with Claude, so her tone, formality and guidance show. It is read here
 * only, never printed or stored, and tests (which start the relay themselves) keep the stand-ins.
 */
function anthropicKey() {
  try {
    return parseEnv(readFileSync(".dev.vars", "utf8")).ANTHROPIC_API_KEY?.trim() || null;
  } catch {
    return null;
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const key = anthropicKey();
  const app = await startLocalRelay({
    directory: resolve(process.env.RELAY_LOCAL_DIRECTORY ?? "work/local-relay"),
    // Saved views, with the status and sort pickers, are on locally unless turned off
    // (RELAY_LOCAL_INBOX_VIEWS=false). Deployed workspaces default to off.
    inboxViews: process.env.RELAY_LOCAL_INBOX_VIEWS !== "false",
    longTimeline: true,
    exampleEmail: true,
    exampleWorkflow: true,
    apiPort: Number(process.env.RELAY_LOCAL_API_PORT ?? 8788),
    hostPort: Number(process.env.RELAY_LOCAL_HOST_PORT ?? 8789),
    // Reranking stays offline: Workers AI isn't reachable from here.
    ai: key ? { model: claudeAnswerModel(key), classify: claudeClassifier(key) } : undefined,
  });
  console.log(
    "Local Relay demo: " +
      app.hostOrigin +
      " (loopback only; persisted in " +
      (process.env.RELAY_LOCAL_DIRECTORY ?? "work/local-relay") +
      ").",
  );
  console.log(
    key
      ? "Zoe answers with Claude (the key in .dev.vars); reranking stays offline."
      : "Zoe answers with the offline stand-in. Add ANTHROPIC_API_KEY to .dev.vars to hear her tone and guidance.",
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => void app.close().then(() => process.exit()));
}

/** Two sample knowledge records per workspace, with fixed ids so a restart adds nothing. */
/**
 * A file record (phase 07, C1a): a Markdown file already read, for the inbox. Local storage is in
 * memory, so its bytes are put back on every start.
 */
async function seedKnowledgeFile(
  sql: Sql,
  w: string,
  storage: AttachmentStorage,
) {
  const recordId = "00000000-0000-4000-8000-00000000a003",
    fileId = "00000000-0000-4000-8000-00000000f001",
    name = "Shipping and returns.md";
  const text =
    "# Shipping and returns\n\nOrders ship within two working days. Customers can return unused items within 30 days for a full refund; the return label is in their order email.";
  const bytes = new TextEncoder().encode(text);
  const key = `${w}/knowledge/${fileId}/seed/clean`;
  await storage.putClean(key, bytes, "text/markdown", name);
  const added = await sql.query(
    `INSERT INTO knowledge_records(workspace_id,id,source,owner_id,audience,for_ai,for_help_center,for_inbox) VALUES($1,$2,'file','owner','internal',false,false,true) ON CONFLICT DO NOTHING RETURNING id`,
    [w, recordId],
  );
  if (!added.rows.length) return;
  await sql.query(
    `INSERT INTO knowledge_locales(workspace_id,record_id,locale,status,draft_title,draft_updated_by,published_title,published_text,published_revision,published_at,published_by)
    VALUES($1,$2,'en','published','Shipping and returns','owner','Shipping and returns',$3,1,now(),'owner')`,
    [w, recordId, text],
  );
  await sql.query(
    `INSERT INTO knowledge_files(workspace_id,id,purpose,record_id,locale,version,name,size,mime,object_key,clean_key,checksum,status,chars,uploaded_by,ready_at)
    VALUES($1,$2,'source',$3,'en',1,$4,$5,'text/markdown',$6,$7,'seed','ready',$8,'owner',now())`,
    [
      w,
      fileId,
      recordId,
      name,
      bytes.length,
      `${w}/knowledge/${fileId}/quarantine`,
      key,
      text.length,
    ],
  );
}

async function seedKnowledge(sql: Sql, w: string) {
  const article: RichDoc = normalizeDoc(
    {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Relay brings every customer conversation into one inbox.",
            },
          ],
        },
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Start a conversation" }],
        },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Open the messenger on your site and say hello.",
            },
          ],
        },
        {
          type: "callout",
          attrs: { tone: "info" },
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "Replies usually arrive within an hour during office hours.",
                },
              ],
            },
          ],
        },
      ],
    },
    { article: true },
  );
  const internal: RichDoc = normalizeDoc(
    {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Refunds over 200 need a team lead's approval.",
            },
          ],
        },
      ],
    },
    { article: true },
  );
  // A snippet repeating the article's passage, so the content health report (phase 07, C2b)
  // has a near-duplicate to show. Internal: never in the help center or the AI agent.
  const repeat: RichDoc = normalizeDoc(
    {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Open the messenger on your site and say hello. Replies usually arrive within an hour during office hours.",
            },
          ],
        },
      ],
    },
    { article: true },
  );
  const records = [
    [
      "00000000-0000-4000-8000-00000000a001",
      "article",
      "public",
      true,
      true,
      "Getting started with Relay",
      article,
      true,
    ],
    [
      "00000000-0000-4000-8000-00000000a002",
      "internal_article",
      "internal",
      false,
      false,
      "Refund approvals",
      internal,
      false,
    ],
    [
      "00000000-0000-4000-8000-00000000a003",
      "snippet",
      "internal",
      false,
      false,
      "Start a conversation",
      repeat,
      true,
    ],
  ] as const;
  for (const [
    id,
    source,
    audience,
    ai,
    helpCenter,
    title,
    body,
    published,
  ] of records) {
    const added = await sql.query(
      `INSERT INTO knowledge_records(workspace_id,id,source,owner_id,audience,for_ai,for_help_center) VALUES($1,$2,$3,'owner',$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id`,
      [w, id, source, audience, ai, helpCenter],
    );
    if (!added.rows.length) continue;
    await sql.query(
      `INSERT INTO knowledge_locales(workspace_id,record_id,locale,status,draft_title,draft_body,draft_updated_by,published_title,published_body,published_text,published_revision,published_at,published_by)
      VALUES($1,$2,'en',$3,$4,$5,'owner',$6,$7,$8,$9,CASE WHEN $9::int IS NULL THEN NULL ELSE now() END,$10)`,
      [
        w,
        id,
        published ? "published" : "draft",
        title,
        JSON.stringify(body),
        published ? title : null,
        published ? JSON.stringify(body) : null,
        published ? plainText(body) : null,
        published ? 1 : null,
        published ? "owner" : null,
      ],
    );
    if (published)
      await sql.query(
        "INSERT INTO knowledge_revisions(workspace_id,record_id,locale,revision,title,body,created_by) VALUES($1,$2,'en',1,$3,$4,'owner')",
        [w, id, title, JSON.stringify(body)],
      );
  }
  // Published articles have a public address (phase 07, step A2).
  await sql.query(
    "UPDATE knowledge_locales SET slug='getting-started-with-relay' WHERE workspace_id=$1 AND record_id=$2 AND locale='en' AND slug IS NULL",
    [w, records[0][0]],
  );
  // A help center for the default brand: two collections, one with a section holding the article.
  const center = "00000000-0000-4000-8000-00000000c001";
  const added = await sql.query(
    `INSERT INTO help_centers(workspace_id,id,brand_id,name,slug,default_locale,locales,layout)
    VALUES($1,$2,'default','Relay Help','relay-help','en',ARRAY['en','fr'],$3) ON CONFLICT DO NOTHING RETURNING id`,
    [
      w,
      center,
      JSON.stringify([
        { type: "search" },
        { type: "collections" },
        { type: "contact" },
      ]),
    ],
  );
  if (!added.rows.length) return;
  const nodes = [
    [
      "00000000-0000-4000-8000-00000000c101",
      "collection",
      null,
      0,
      "Getting started",
      "getting-started",
    ],
    [
      "00000000-0000-4000-8000-00000000c102",
      "collection",
      null,
      1,
      "Billing",
      "billing",
    ],
    [
      "00000000-0000-4000-8000-00000000c103",
      "section",
      "00000000-0000-4000-8000-00000000c101",
      0,
      "Your first conversation",
      "your-first-conversation",
    ],
  ] as const;
  for (const [id, kind, parent, position, name, slug] of nodes) {
    await sql.query(
      "INSERT INTO help_nodes(workspace_id,id,center_id,kind,parent_id,position) VALUES($1,$2,$3,$4,$5,$6)",
      [w, id, center, kind, parent, position],
    );
    await sql.query(
      "INSERT INTO help_node_locales(workspace_id,node_id,center_id,kind,locale,name,slug) VALUES($1,$2,$3,$4,'en',$5,$6)",
      [w, id, center, kind, name, slug],
    );
  }
  await sql.query(
    "INSERT INTO help_placements(workspace_id,node_id,record_id,position) VALUES($1,$2,$3,0)",
    [w, nodes[2][0], records[0][0]],
  );
}

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
import { resolve, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import { SignJWT, jwtVerify } from "jose";
import { bridgeAgentRequest } from "../server/agent-bridge";
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
import { tenant, digest } from "../server/db";
import { handleApi, type ApiEnvironment } from "../server/api";
import { RealtimeClient, fanOutSignal } from "../server/realtime";
import { messengerAsset } from "../server/assets";
import { notifyWorkspace } from "../server/realtime-batch";
import { runBulkApply, runBulkUndo } from "../server/bulk";
import { runBroadcast } from "../server/ticket-links";
import { checkDueSlas, reevaluateJob } from "../server/sla";
import { saveTicketType } from "../server/tickets";
import { CoalescedPublisher } from "../server/publication";
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
    longTimeline?: boolean;
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
  let keys = { session: secret(), identity: secret(), bridge: secret() };
  if (options.directory) {
    await mkdir(options.directory, { recursive: true });
    const path = resolve(options.directory, "local-secrets.json");
    try {
      keys = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await writeFile(path, JSON.stringify(keys), { mode: 0o600, flag: "wx" });
    }
  }
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
              await sql.query<{ id: string }>(
                "SELECT id FROM jobs WHERE workspace_id=$1 AND state IN ('queued','running') AND (lease_until IS NULL OR lease_until<now()) ORDER BY created_at,id LIMIT 20",
                [w],
              )
            ).rows,
        );
        for (const job of pending) {
          await runJob(db.connect, w, job.id, handlers);
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
        // Draft retention, at most once a day per workspace (the Worker runs it at 03:00 UTC).
        if (Date.now() - (lastPurge.get(w) ?? 0) > 86_400_000) {
          lastPurge.set(w, Date.now());
          await purgeDrafts(db.connect, w);
          await purgeInlineImages(db.connect, env.attachments, w);
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
  const serve = (origin: string, handler: (r: Request) => Promise<Response>) =>
    createServer(async (req: IncomingMessage, res: ServerResponse) => {
      try {
        // Raw bytes: uploads to local storage are binary and up to 10 MB; everything else 24 KB.
        const limit = req.url?.startsWith(LOCAL_STORAGE_PATH)
          ? LOCAL_UPLOAD_LIMIT
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
    });
  const api = serve(apiOrigin, async (req) => {
    const { value: response, timing } = await db.measure(() =>
      new URL(req.url).pathname.startsWith("/v1/")
        ? handleApi(req, env)
        : messengerAsset(req, db.connect, staticResponse),
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
            "content-security-policy": `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ${apiOrigin.replace("http", "ws")}; img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'`,
          },
        },
      );
    }
    if (url.pathname === "/demo/boot.js")
      return new Response(
        `window.relayViolations=[];document.addEventListener('securitypolicyviolation',e=>window.relayViolations.push(e.violatedDirective));window.Relay=window.Relay||function(){(window.Relay.q=window.Relay.q||[]).push(arguments)};Relay('boot',{api:${JSON.stringify(apiOrigin)},workspaceId:'demo',brandId:'default',locale:new URLSearchParams(location.search).get('locale')||'en'});document.getElementById('open-support').onclick=()=>Relay('open');document.getElementById('notifications').onclick=()=>Relay('enableNotifications');`,
        { headers: { "content-type": "text/javascript" } },
      );
    if (url.pathname === "/demo/hostile.css")
      return new Response(
        `*{font-family:monospace!important;color:#ee3355!important;line-height:2!important;border-radius:0!important}button{background:yellow!important;padding:30px!important;font-size:28px!important}iframe{border:30px solid red!important;width:75px!important;height:75px!important}body{background:#e9f1f4;margin:40px}article{max-width:650px}`,
        { headers: { "content-type": "text/css" } },
      );
    const baseline = url.searchParams.has("baseline");
    const body = `<article><p>Relay / integration test</p><h1>A deliberately unfriendly host page</h1><p>This page applies aggressive styles to every element, button and iframe. Relay's controls stay inside their own document and shadow root.</p><button id="open-support">Open support</button><button id="notifications">Enable reply notifications</button><p><a href="/agent">Open the local agent inbox</a></p><p id="anchor">This paragraph must not move when the messenger boots or opens.</p></article>${baseline ? "" : `<script src="/demo/boot.js" defer></script><script src="${apiOrigin}/messenger/loader.js" async></script>`}`;
    return new Response(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Relay hostile host</title><link rel="stylesheet" href="/demo/hostile.css"></head><body>${body}</body></html>`,
      {
        headers: {
          "content-type": "text/html",
          "content-security-policy": `default-src 'none'; script-src 'self' ${apiOrigin}; style-src 'self' ${apiOrigin}; frame-src ${apiOrigin}; connect-src 'self' ${apiOrigin} ${apiOrigin.replace("http", "ws")}; img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`,
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
    clients,
    disconnect(conversationId: string) {
      for (const [socket, client] of sockets)
        if (client.subscriptions.has(conversationId)) socket.terminate();
    },
    async close() {
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
      while (background.size) await Promise.allSettled([...background]);
      await db.close();
    },
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const app = await startLocalRelay({
    directory: resolve(process.env.RELAY_LOCAL_DIRECTORY ?? "work/local-relay"),
    inboxViews: process.env.RELAY_LOCAL_INBOX_VIEWS === "true",
    longTimeline: true,
    apiPort: Number(process.env.RELAY_LOCAL_API_PORT ?? 8788),
    hostPort: Number(process.env.RELAY_LOCAL_HOST_PORT ?? 8789),
  });
  console.log(
    "Local Relay demo: " +
      app.hostOrigin +
      " (loopback only; persisted in " +
      (process.env.RELAY_LOCAL_DIRECTORY ?? "work/local-relay") +
      ").",
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => void app.close().then(() => process.exit()));
}

import { assert, DomainError, tenant, type Connect, type Sql } from "./db";
import { authorize } from "./policy";
import { access, conversation } from "./conversations";
import { resolveContact } from "./people";
import { developerOn } from "./developer";
import { seal, unseal } from "./connectors";
import { checkAddress, FetchRefused, safeRequest, type FetchPolicy } from "./safe-fetch";
import { signature } from "./webhooks";
import { CanvasInvalid, inputValues, parseAnswer, PLACEMENTS, submittable, type Canvas, type Placement } from "../lib/canvas";

/**
 * Canvas apps (phase 15, step D5; docs/DEVELOPER_PLATFORM_STEP5.md), behind `developer_api_v1`.
 *
 * - **What an app is:** an OAuth app (D4) that also gives a canvas address and the placements it
 *   draws in: the inbox sidebar, the composer, and settings (its configure step, after install).
 * - **Requests:** Relay's server POSTs `<canvas address>/initialize`, `/submit` or `/configure`,
 *   signed like webhooks (`Relay-Signature`, with the app's canvas secret), with a short time limit
 *   (a teammate is waiting) and a 64 KB answer cap. The app sees ids, the teammate, its settings and
 *   what was entered; anything else it reads through the API with its own token, within its scopes.
 * - **Answers** are checked against the schema (`lib/canvas.ts`) before anything reaches a browser;
 *   a failure (time out, unreachable, error status, or a card Relay can't show) becomes a clear
 *   failure card, and every request is logged with its outcome.
 * - **Sessions:** the canvas on screen and its stored data stay on the server for an hour, so a
 *   submit is checked against what was shown and stored data never reaches the browser.
 * - **Error rates:** the installing workspace reads its own log; the app's developer reads daily
 *   counts kept in the app's own workspace (only counts cross workspaces).
 */
export type CanvasEnvironment = { key: string; policy?: FetchPolicy; timeoutMs?: number };
export const CANVAS_TIMEOUT_MS = 5000;
const MAX_BYTES = 64 * 1024;
const SESSION_MS = 3_600_000;
const KEEP_DAYS = 30;
const STATS_DAYS = 7;
const random = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[b % 62]).join("");
const field = (f: string, message: string) => new DomainError("INVALID_FIELD", message, 400, { field: f });
const sealed = (env: CanvasEnvironment, w: string, appId: string, secret: string) => seal(env.key, w, appId, "canvas_secret", secret);
const opened = (env: CanvasEnvironment, w: string, appId: string, s: string) => unseal(env.key, w, appId, "canvas_secret", s);

/* ------------------------------------------------------------------------------------------ */
/* The developer's side: an app's canvas address, placements and signing secret                */
/* ------------------------------------------------------------------------------------------ */
export type CanvasColumns = { canvas_url: string | null; canvas_placements: string[]; canvas_secret_last_four: string | null };
export const CANVAS_COLUMNS = "canvas_url,canvas_placements,canvas_secret_last_four";
export const canvasOut = (a: CanvasColumns) => ({ canvasUrl: a.canvas_url, canvasPlacements: a.canvas_placements, canvasSecretLastFour: a.canvas_secret_last_four });

/**
 * An app's canvas address and placements, set; its signing secret made the first time an address
 * is given (returned this once). Addresses follow the fetch policy: public https when deployed.
 */
export async function setCanvas(db: Sql, w: string, appId: string, env: CanvasEnvironment | undefined, p: { canvasUrl?: unknown; canvasPlacements?: unknown }) {
  if (p.canvasUrl === undefined && p.canvasPlacements === undefined) return undefined;
  const now = (await db.query<CanvasColumns & { canvas_secret_sealed: string | null }>(`SELECT ${CANVAS_COLUMNS},canvas_secret_sealed FROM oauth_apps WHERE workspace_id=$1 AND id=$2`, [w, appId])).rows[0];
  let url = now.canvas_url;
  if (p.canvasUrl !== undefined) {
    const raw = typeof p.canvasUrl === "string" ? p.canvasUrl.trim() : "";
    if (!raw) url = null;
    else
      try {
        const u = checkAddress(raw, env?.policy ?? {});
        if (u.search || u.hash) throw new Error();
        url = u.toString().replace(/\/+$/, "");
      } catch {
        throw field("canvas_url", "The canvas address is a public https address, without a ?query or #fragment.");
      }
  }
  let placements = now.canvas_placements;
  if (p.canvasPlacements !== undefined) {
    const list = Array.isArray(p.canvasPlacements) ? [...new Set(p.canvasPlacements.map(String))] : [];
    const bad = list.find((x) => !(PLACEMENTS as readonly string[]).includes(x));
    if (bad) throw field("canvas_placements", `There's no placement ${bad}.`);
    placements = PLACEMENTS.filter((x) => list.includes(x));
  }
  if (placements.length && !url) throw field("canvas_url", "Give the canvas address the placements are drawn from.");
  let secret: string | undefined;
  if (url && !now.canvas_secret_sealed) {
    assert(env?.key, "UNAVAILABLE", "Canvas apps need the connector key, which isn't configured.", 503);
    secret = "relay_cvs_" + random(40);
    await db.query("UPDATE oauth_apps SET canvas_secret_sealed=$3,canvas_secret_last_four=$4 WHERE workspace_id=$1 AND id=$2", [w, appId, await sealed(env!, w, appId, secret), secret.slice(-4)]);
  }
  await db.query("UPDATE oauth_apps SET canvas_url=$3,canvas_placements=$4,updated_at=now() WHERE workspace_id=$1 AND id=$2", [w, appId, url, placements]);
  return secret;
}

/** A new signing secret; the previous one also signs for 24 hours, so the app can switch without failing. */
export async function rotateCanvasSecret(db: Sql, w: string, appId: string, env: CanvasEnvironment | undefined) {
  assert(env?.key, "UNAVAILABLE", "Canvas apps need the connector key, which isn't configured.", 503);
  const now = (await db.query<{ canvas_secret_sealed: string | null }>("SELECT canvas_secret_sealed FROM oauth_apps WHERE workspace_id=$1 AND id=$2", [w, appId])).rows[0];
  assert(now?.canvas_secret_sealed, "INVALID_APP", "Give the app a canvas address first.");
  const secret = "relay_cvs_" + random(40);
  await db.query(
    "UPDATE oauth_apps SET canvas_previous_secret_sealed=canvas_secret_sealed,canvas_previous_until=now()+interval '24 hours',canvas_secret_sealed=$3,canvas_secret_last_four=$4,updated_at=now() WHERE workspace_id=$1 AND id=$2",
    [w, appId, await sealed(env!, w, appId, secret), secret.slice(-4)],
  );
  return secret;
}

/* ------------------------------------------------------------------------------------------ */
/* Reading an app from where it's installed                                                    */
/* ------------------------------------------------------------------------------------------ */
type AppCanvas = { name: string; url: string | null; placements: Placement[]; archived: boolean; secrets: string[] };
/** An app's canvas, read in its developer's workspace (its own row-level security), with its live secrets when asked. */
async function appCanvas(connect: Connect, appW: string, appId: string, env?: CanvasEnvironment): Promise<AppCanvas | null> {
  return tenant(connect, appW, async (db) => {
    const a = (
      await db.query<{ name: string; canvas_url: string | null; canvas_placements: Placement[]; archived_at: Date | null; canvas_secret_sealed: string | null; canvas_previous_secret_sealed: string | null; canvas_previous_until: Date | null }>(
        "SELECT name,canvas_url,canvas_placements,archived_at,canvas_secret_sealed,canvas_previous_secret_sealed,canvas_previous_until FROM oauth_apps WHERE workspace_id=$1 AND id=$2",
        [appW, appId],
      )
    ).rows[0];
    if (!a) return null;
    const secrets: string[] = [];
    if (env && a.canvas_secret_sealed) {
      secrets.push(await opened(env, appW, appId, a.canvas_secret_sealed));
      if (a.canvas_previous_secret_sealed && a.canvas_previous_until && new Date(a.canvas_previous_until) > new Date()) secrets.push(await opened(env, appW, appId, a.canvas_previous_secret_sealed));
    }
    return { name: a.name, url: a.canvas_url, placements: a.canvas_placements, archived: !!a.archived_at, secrets };
  });
}
type GrantRow = { id: string; app_workspace_id: string; app_id: string; app_name: string; canvas_settings: Record<string, unknown> | null; configured_at: Date | null };
const GRANTS = "SELECT id,app_workspace_id,app_id,app_name,canvas_settings,configured_at FROM oauth_grants WHERE workspace_id=$1 AND revoked_at IS NULL";

/** The apps installed here that draw in a placement, for a teammate who can see it. */
export async function listCanvasApps(connect: Connect, w: string, principal: string, placement: string, conversationId?: string) {
  assert((PLACEMENTS as readonly string[]).includes(placement), "INVALID_FIELD", "Choose a placement.");
  const grants = await tenant(connect, w, async (db) => {
    await allowed(db, w, principal, placement as Placement, conversationId);
    if (!(await developerOn(db, w))) return [];
    return (await db.query<GrantRow>(`${GRANTS} ORDER BY created_at,id`, [w])).rows;
  });
  const out = [];
  for (const g of grants) {
    const app = await appCanvas(connect, g.app_workspace_id, g.app_id);
    if (app && !app.archived && app.url && app.placements.includes(placement as Placement)) out.push({ installationId: g.id, appName: app.name, placement });
  }
  return { apps: out };
}

/** Who may see an app in a placement: settings is for who manages the workspace; the inbox's are for who can read the conversation. */
async function allowed(db: Sql, w: string, principal: string, placement: Placement, conversationId?: string) {
  if (placement === "settings") return void (await authorize(db, w, principal, "workspace.manage"));
  await authorize(db, w, principal, "conversations.read");
  assert(conversationId, "INVALID_FIELD", "Say which conversation.");
  const c = await conversation(db, w, conversationId!);
  await access(db, w, c, { type: "teammate", principal });
  return c;
}

/** Settings › Developers › Apps: each installation's placements and error rate, and your own apps' rates across workspaces. */
export async function canvasOverview(connect: Connect, w: string) {
  const local = await tenant(connect, w, async (db) => ({
    grants: (await db.query<GrantRow>(GRANTS, [w])).rows,
    calls: (
      await db.query<{ grant_id: string; calls: number; failures: number }>(
        `SELECT grant_id,count(*)::int AS calls,(count(*) FILTER (WHERE outcome<>'ok'))::int AS failures FROM canvas_calls
         WHERE workspace_id=$1 AND created_at>now()-($2::int*interval '1 day') GROUP BY grant_id`,
        [w, STATS_DAYS],
      )
    ).rows,
    apps: (
      await db.query<{ app_id: string; calls: number; failures: number; timeouts: number }>(
        `SELECT app_id,sum(calls)::int AS calls,sum(failures)::int AS failures,sum(timeouts)::int AS timeouts FROM canvas_app_daily
         WHERE workspace_id=$1 AND day>(now() AT TIME ZONE 'UTC')::date-$2::int GROUP BY app_id`,
        [w, STATS_DAYS],
      )
    ).rows,
  }));
  const installed: Record<string, { placements: Placement[]; configured: boolean; calls: number; failures: number }> = {};
  for (const g of local.grants) {
    const app = await appCanvas(connect, g.app_workspace_id, g.app_id).catch(() => null);
    const c = local.calls.find((x) => x.grant_id === g.id);
    installed[g.id] = { placements: app && !app.archived && app.url ? app.placements : [], configured: !!g.configured_at, calls: c?.calls ?? 0, failures: c?.failures ?? 0 };
  }
  return { installed, apps: Object.fromEntries(local.apps.map((a) => [a.app_id, { calls: a.calls, failures: a.failures, timeouts: a.timeouts }])), days: STATS_DAYS };
}

/* ------------------------------------------------------------------------------------------ */
/* Requests to the app                                                                          */
/* ------------------------------------------------------------------------------------------ */
type Outcome = "ok" | "timeout" | "unreachable" | "http_error" | "invalid_response";
export type CanvasResult =
  | { status: "ready"; sessionId: string; canvas: Canvas }
  | { status: "insert"; text: string }
  | { status: "configured" }
  | { status: "failed"; outcome: Exclude<Outcome, "ok">; message: string; detail: string };

/**
 * A card's request: `initialize` (first drawn) or `submit` (a teammate pressed something), sent to
 * the app as initialize/submit, or configure in settings. Always answers what to draw: a canvas,
 * text for the reply, "configured", or a failure card.
 */
export async function canvasRequest(connect: Connect, env: CanvasEnvironment | undefined, w: string, principal: string, p: Record<string, unknown>): Promise<CanvasResult> {
  assert(env?.key, "UNAVAILABLE", "Canvas apps need the connector key, which isn't configured.", 503);
  const placement = String(p.placement ?? "") as Placement;
  assert(PLACEMENTS.includes(placement), "INVALID_FIELD", "Choose a placement.");
  assert(p.action === "initialize" || p.action === "submit", "INVALID_FIELD", "Choose initialize or submit.");
  const conversationId = placement === "settings" ? undefined : String(p.conversationId ?? "");
  const ctx = await tenant(connect, w, async (db) => {
    assert(await developerOn(db, w), "NOT_FOUND", "The API isn't enabled for this workspace.", 404);
    const c = await allowed(db, w, principal, placement, conversationId);
    const teammate = (await db.query<{ id: string; name: string }>("SELECT id,name FROM teammates WHERE workspace_id=$1 AND principal_id=$2", [w, principal])).rows[0];
    assert(teammate, "FORBIDDEN", "Sign in as a teammate.", 403);
    const grant = (await db.query<GrantRow>(`${GRANTS} AND id=$2`, [w, String(p.installationId ?? "")])).rows[0];
    assert(grant, "NOT_FOUND", "This app isn't installed here.", 404);
    const mapped = c?.primary_identity_id
      ? (await db.query<{ contact_id: string }>("SELECT contact_id FROM identity_contact_mappings WHERE workspace_id=$1 AND identity_id=$2", [w, c.primary_identity_id])).rows[0]?.contact_id
      : undefined;
    const contactId = mapped ? await resolveContact(db, w, mapped) : null;
    let session: { id: string; canvas: Canvas; stored_data: Record<string, unknown> | null } | null = null;
    let values: Record<string, string | string[]> = {};
    if (p.action === "submit") {
      session =
        (
          await db.query<{ id: string; canvas: Canvas; stored_data: Record<string, unknown> | null }>(
            `SELECT id,canvas,stored_data FROM canvas_sessions WHERE workspace_id=$1 AND id=$2 AND grant_id=$3 AND teammate_id=$4 AND placement=$5
             AND conversation_id IS NOT DISTINCT FROM $6 AND expires_at>now()`,
            [w, String(p.sessionId ?? ""), grant.id, teammate.id, placement, conversationId ?? null],
          )
        ).rows[0] ?? null;
      assert(session, "CANVAS_EXPIRED", "This card has expired. Reload it.", 409);
      assert(submittable(session!.canvas, String(p.componentId ?? "")), "INVALID_FIELD", "That isn't something on this card that can be pressed.");
      values = inputValues(session!.canvas, p.inputValues);
    }
    return { teammate, grant, contactId, session, values };
  });
  const app = await appCanvas(connect, ctx.grant.app_workspace_id, ctx.grant.app_id, env);
  assert(app && !app.archived && app.url && app.placements.includes(placement) && app.secrets.length, "NOT_FOUND", "This app no longer shows here.", 404);
  const kind = placement === "settings" ? "configure" : (p.action as "initialize" | "submit");
  const body = JSON.stringify({
    type: kind,
    placement,
    request_id: crypto.randomUUID(),
    workspace_id: w,
    installation_id: ctx.grant.id,
    teammate: { id: ctx.teammate.id, name: ctx.teammate.name },
    conversation: conversationId ? { id: conversationId, contact_id: ctx.contactId } : null,
    settings: ctx.grant.canvas_settings,
    ...(ctx.session
      ? { component_id: String(p.componentId), input_values: ctx.values, stored_data: ctx.session.stored_data, current_canvas: { content: { components: ctx.session.canvas.components } } }
      : {}),
  });
  const started = Date.now();
  const limit = env!.timeoutMs ?? CANVAS_TIMEOUT_MS;
  let outcome: Outcome = "ok";
  let statusCode: number | null = null;
  let detail = "";
  let answer: ReturnType<typeof parseAnswer> | null = null;
  try {
    const r = await safeRequest(
      `${app!.url}/${kind}`,
      env!.policy ?? {},
      { method: "POST", headers: { "content-type": "application/json", accept: "application/json", "relay-signature": await signature(app!.secrets, body) }, body },
      { maxBytes: MAX_BYTES, timeoutMs: limit },
    );
    statusCode = r.status;
    if (r.status < 200 || r.status >= 300) {
      outcome = "http_error";
      detail = `It answered ${r.status}.`;
    } else {
      let json: unknown;
      try {
        json = JSON.parse(String(r.body ?? ""));
      } catch {
        throw new CanvasInvalid("response", "isn't JSON.");
      }
      answer = parseAnswer(json, placement, kind);
    }
  } catch (e) {
    if (e instanceof CanvasInvalid) {
      outcome = "invalid_response";
      detail = e.message;
    } else if (e instanceof FetchRefused && e.code === "TIMEOUT") {
      outcome = "timeout";
      detail = `No answer within ${limit / 1000} seconds.`;
    } else if (e instanceof FetchRefused && e.code === "TOO_LARGE") {
      outcome = "invalid_response";
      detail = `The answer is larger than ${MAX_BYTES / 1024} KB.`;
    } else {
      outcome = "unreachable";
      detail = e instanceof FetchRefused && e.code === "ADDRESS_NOT_ALLOWED" ? "Its canvas address isn't allowed." : "Its canvas address couldn't be reached.";
    }
  }
  const tookMs = Date.now() - started;
  const result = await tenant(connect, w, async (db): Promise<CanvasResult> => {
    await db.query("INSERT INTO canvas_calls(workspace_id,id,grant_id,kind,placement,outcome,status_code,duration_ms,error) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [
      w,
      crypto.randomUUID(),
      ctx.grant.id,
      kind,
      placement,
      outcome,
      statusCode,
      tookMs,
      detail,
    ]);
    await db.query("DELETE FROM canvas_calls WHERE workspace_id=$1 AND grant_id=$2 AND created_at<now()-($3::int*interval '1 day')", [w, ctx.grant.id, KEEP_DAYS]);
    await db.query("DELETE FROM canvas_sessions WHERE workspace_id=$1 AND grant_id=$2 AND expires_at<=now()", [w, ctx.grant.id]);
    if (!answer) {
      const message =
        outcome === "timeout"
          ? `${app!.name} didn't answer in time.`
          : outcome === "http_error"
            ? `${app!.name} answered with an error.`
            : outcome === "invalid_response"
              ? `${app!.name} sent a card Relay can't show.`
              : `${app!.name} couldn't be reached.`;
      return { status: "failed", outcome: outcome as Exclude<Outcome, "ok">, message, detail };
    }
    if (answer.kind === "insert" || answer.kind === "results") {
      if (ctx.session) await db.query("DELETE FROM canvas_sessions WHERE workspace_id=$1 AND id=$2", [w, ctx.session.id]);
      if (answer.kind === "insert") return { status: "insert", text: answer.text };
      await db.query("UPDATE oauth_grants SET canvas_settings=$3,configured_at=now() WHERE workspace_id=$1 AND id=$2", [w, ctx.grant.id, JSON.stringify(answer.results)]);
      return { status: "configured" };
    }
    const sessionId = ctx.session?.id ?? crypto.randomUUID();
    await db.query(
      `INSERT INTO canvas_sessions(workspace_id,id,grant_id,placement,conversation_id,teammate_id,canvas,stored_data,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+($9::int*interval '1 millisecond'))
       ON CONFLICT(workspace_id,id) DO UPDATE SET canvas=EXCLUDED.canvas,stored_data=EXCLUDED.stored_data,expires_at=EXCLUDED.expires_at`,
      [w, sessionId, ctx.grant.id, placement, conversationId ?? null, ctx.teammate.id, JSON.stringify(answer.canvas), answer.storedData === null ? null : JSON.stringify(answer.storedData), SESSION_MS],
    );
    return { status: "ready", sessionId, canvas: answer.canvas };
  });
  // The developer's counts, in the app's own workspace: only how many, never what.
  await tenant(connect, ctx.grant.app_workspace_id, (db) =>
    db.query(
      `INSERT INTO canvas_app_daily(workspace_id,app_id,day,calls,failures,timeouts) VALUES($1,$2,(now() AT TIME ZONE 'UTC')::date,1,$3,$4)
       ON CONFLICT(workspace_id,app_id,day) DO UPDATE SET calls=canvas_app_daily.calls+1,failures=canvas_app_daily.failures+EXCLUDED.failures,timeouts=canvas_app_daily.timeouts+EXCLUDED.timeouts`,
      [ctx.grant.app_workspace_id, ctx.grant.app_id, outcome === "ok" ? 0 : 1, outcome === "timeout" ? 1 : 0],
    ),
  ).catch(() => undefined);
  return result;
}

import { assert, DomainError, once, tenant, type Connect, type Sql } from "./db";
import { authorize } from "./policy";
import { resolveContact } from "./people";

/**
 * Subscription types (phase 13, step O1; docs/OUTBOUND_STEP1.md), behind `segments_v1`: the kinds
 * of message a contact chooses to get. An opt-in type is sent only once they agree; an opt-out type
 * until they say no; unsubscribing from everything (`contacts.global_unsubscribe`) says no to all.
 * `effectiveSubscriptions` is the one answer, used by segments and by the delivery gate
 * (`mayDeliver`), so nothing outbound reaches a contact who said no. Contacts choose on their
 * preference page (`/v1/preferences/<token>`), reached from every unsubscribe link (O4).
 */
export type SubscriptionState = "opted_in" | "opted_out";
export const SUBSCRIPTION_CHANNELS = ["email", "sms", "whatsapp", "in_app"] as const;
const CHANNEL_NAMES: Record<string, string> = { email: "Email", sms: "SMS", whatsapp: "WhatsApp", in_app: "In-app" };

async function on(db: Sql, w: string) {
  return (await db.query("SELECT 1 FROM workspace_features WHERE workspace_id=$1 AND name='segments_v1' AND enabled", [w])).rows.length > 0;
}

/** Each type's state for a contact: archived types and unsubscribing from everything are "out" (`ownChoices`: apart from the latter). */
export async function effectiveSubscriptions(db: Sql, w: string, contactId: string, typeIds?: string[], ownChoices = false): Promise<Record<string, SubscriptionState>> {
  const rows = (
    await db.query<{ id: string; state: SubscriptionState }>(
      `SELECT t.id,CASE WHEN (c.global_unsubscribe AND NOT $4) OR t.archived_at IS NOT NULL THEN 'opted_out'
              ELSE COALESCE(s.state, CASE t.consent WHEN 'opt_out' THEN 'opted_in' ELSE 'opted_out' END) END AS state
       FROM subscription_types t JOIN contacts c ON c.workspace_id=t.workspace_id AND c.id=$2
       LEFT JOIN contact_subscriptions s ON s.workspace_id=t.workspace_id AND s.contact_id=c.id AND s.subscription_type_id=t.id
       WHERE t.workspace_id=$1 AND ($3::text[] IS NULL OR t.id=ANY($3::text[]))`,
      [w, contactId, typeIds ?? null, ownChoices],
    )
  ).rows;
  const out: Record<string, SubscriptionState> = {};
  for (const id of typeIds ?? []) out[id] = "opted_out";
  for (const r of rows) out[r.id] = r.state;
  return out;
}

/** A contact's choice, recorded with where it came from (never edited: each change is a row). */
export async function setSubscription(
  db: Sql,
  w: string,
  contactId: string,
  typeId: string | null,
  state: SubscriptionState,
  source: "preference_page" | "teammate" | "import",
  actor: string | null,
) {
  if (typeId === null) {
    const changed = await db.query("UPDATE contacts SET global_unsubscribe=$3 WHERE workspace_id=$1 AND id=$2 AND global_unsubscribe<>$3 RETURNING id", [w, contactId, state === "opted_out"]);
    if (!changed.rows.length) return false;
  } else {
    const changed = await db.query(
      `INSERT INTO contact_subscriptions(workspace_id,contact_id,subscription_type_id,state) VALUES($1,$2,$3,$4)
       ON CONFLICT (workspace_id,contact_id,subscription_type_id) DO UPDATE SET state=EXCLUDED.state,changed_at=now() WHERE contact_subscriptions.state<>EXCLUDED.state RETURNING contact_id`,
      [w, contactId, typeId, state],
    );
    if (!changed.rows.length) return false;
  }
  await db.query("INSERT INTO contact_subscription_changes(workspace_id,id,contact_id,subscription_type_id,state,source,actor) VALUES($1,$2,$3,$4,$5,$6,$7)", [
    w,
    crypto.randomUUID(),
    contactId,
    typeId,
    state,
    source,
    actor,
  ]);
  return true;
}

/* ------------------------------------------------------------------------------------------ */
/* Settings › Subscriptions                                                                    */

type TypeRow = { id: string; name: string; description: string; consent: "opt_in" | "opt_out"; channel: string; archived_at: string | null; opted_in: number; opted_out: number };
export async function readSubscriptionTypes(db: Sql, w: string, principal: string) {
  await authorize(db, w, principal, "workspace.manage");
  assert(await on(db, w), "SEGMENTS_DISABLED", "Subscriptions are not enabled for this workspace.", 404);
  const types = (
    await db.query<TypeRow>(
      `SELECT t.id,t.name,t.description,t.consent,t.channel,t.archived_at,
              (SELECT count(*)::int FROM contact_subscriptions s WHERE s.workspace_id=t.workspace_id AND s.subscription_type_id=t.id AND s.state='opted_in') AS opted_in,
              (SELECT count(*)::int FROM contact_subscriptions s WHERE s.workspace_id=t.workspace_id AND s.subscription_type_id=t.id AND s.state='opted_out') AS opted_out
       FROM subscription_types t WHERE t.workspace_id=$1 ORDER BY t.archived_at IS NOT NULL,lower(t.name),t.id`,
      [w],
    )
  ).rows;
  return {
    types: types.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      consent: t.consent,
      channel: t.channel,
      archived: !!t.archived_at,
      optedIn: t.opted_in,
      optedOut: t.opted_out,
    })),
    unsubscribedFromAll: (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM contacts WHERE workspace_id=$1 AND global_unsubscribe AND merged_into_contact_id IS NULL", [w])).rows[0].n,
  };
}

export async function changeSubscriptionTypes(db: Sql, w: string, principal: string, key: string, p: Record<string, unknown>) {
  const t = await authorize(db, w, principal, "workspace.manage");
  assert(await on(db, w), "SEGMENTS_DISABLED", "Subscriptions are not enabled for this workspace.", 404);
  return once(db, w, "subscription-types:" + principal, key, p, async () => {
    const invalid = (m: string): never => {
      throw new DomainError("INVALID_SUBSCRIPTION", m, 400);
    };
    const name = String(p.name ?? "").trim();
    const description = String(p.description ?? "").trim();
    const named = async (except: string | null) => {
      if (!name || name.length > 80) invalid("Name it (80 characters at most).");
      if (description.length > 300) invalid("Keep the description to 300 characters.");
      if ((await db.query("SELECT 1 FROM subscription_types WHERE workspace_id=$1 AND lower(name)=lower($2) AND archived_at IS NULL AND id IS DISTINCT FROM $3", [w, name, except])).rows.length)
        invalid("A subscription with that name already exists.");
    };
    if (p.action === "create") {
      await named(null);
      if (p.consent !== "opt_in" && p.consent !== "opt_out") invalid("Choose opt-in or opt-out.");
      if (!(SUBSCRIPTION_CHANNELS as readonly string[]).includes(String(p.channel))) invalid("Choose its channel: email, SMS, WhatsApp or in-app.");
      await db.query("INSERT INTO subscription_types(workspace_id,id,name,description,consent,channel,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)", [
        w,
        crypto.randomUUID(),
        name,
        description,
        p.consent,
        p.channel,
        t.id,
      ]);
    } else if (p.action === "update") {
      // Its consent and channel stay: contacts chose on those terms.
      const id = String(p.id ?? "");
      if (!(await db.query("SELECT 1 FROM subscription_types WHERE workspace_id=$1 AND id=$2 AND archived_at IS NULL", [w, id])).rows.length) invalid("That subscription isn't available.");
      await named(id);
      await db.query("UPDATE subscription_types SET name=$3,description=$4,updated_at=now() WHERE workspace_id=$1 AND id=$2", [w, id, name, description]);
    } else if (p.action === "archive") {
      // Archived: nothing of this type is sent again (its contacts count as out), and it's kept.
      const r = await db.query("UPDATE subscription_types SET archived_at=now(),updated_at=now() WHERE workspace_id=$1 AND id=$2 AND archived_at IS NULL RETURNING id", [w, String(p.id ?? "")]);
      if (!r.rows.length) invalid("That subscription isn't available.");
    } else invalid("Unknown change.");
    return readSubscriptionTypes(db, w, principal);
  });
}

/* ------------------------------------------------------------------------------------------ */
/* The preference page                                                                         */

const enc = new TextEncoder();
const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
async function mac(secret: string, text: string) {
  const k = await crypto.subtle.importKey("raw", enc.encode("relay-preferences:" + secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", k, enc.encode(text)));
}
const same = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};
/** A contact's preference link: signed, so it reveals and changes only their own choices. */
export async function preferenceToken(secret: string, w: string, contactId: string) {
  const body = b64url(enc.encode(JSON.stringify([w, contactId])));
  return `${body}.${await mac(secret, body)}`;
}
async function readToken(secret: string, token: string) {
  const [body, sig] = token.split(".");
  if (!body || !sig || token.length > 600 || !same(await mac(secret, body), sig)) return null;
  try {
    const [w, contactId] = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(body.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))));
    return typeof w === "string" && typeof contactId === "string" ? { w, contactId } : null;
  } catch {
    return null;
  }
}

const html = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};
const NOT_FOUND = () =>
  new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not found</title><p>This link isn't valid.</p>`, {
    status: 404,
    headers: PAGE_HEADERS,
  });

/**
 * `GET` and `POST /v1/preferences/<token>`: the contact's subscriptions, each switched on or off,
 * and unsubscribing from everything. A plain form with no script; changes are recorded as theirs.
 */
export async function preferencePage(connect: Connect, secret: string, token: string, req: Request) {
  const t = await readToken(secret, token);
  if (!t || !/^[A-Za-z0-9_-]{1,100}$/.test(t.w)) return NOT_FOUND();
  const form = req.method === "POST" ? new URLSearchParams((await req.text()).slice(0, 20_000)) : null;
  try {
    return await tenant(connect, t.w, async (db) => {
      if (!(await on(db, t.w))) return NOT_FOUND();
      const contactId = await resolveContact(db, t.w, t.contactId);
      if (!(await db.query("SELECT 1 FROM contacts WHERE workspace_id=$1 AND id=$2", [t.w, contactId])).rows.length) return NOT_FOUND();
      const types = (
        await db.query<{ id: string; name: string; description: string; channel: string }>(
          "SELECT id,name,description,channel FROM subscription_types WHERE workspace_id=$1 AND archived_at IS NULL ORDER BY channel,lower(name),id",
          [t.w],
        )
      ).rows;
      let saved = false;
      if (form) {
        const all = form.get("all") === "on";
        if (!all) await setSubscription(db, t.w, contactId, null, "opted_in", "preference_page", null);
        for (const type of types) await setSubscription(db, t.w, contactId, type.id, form.get("type:" + type.id) === "on" ? "opted_in" : "opted_out", "preference_page", null);
        if (all) await setSubscription(db, t.w, contactId, null, "opted_out", "preference_page", null);
        saved = true;
      }
      // Each type as they chose it (or its consent's default), apart from unsubscribing from everything.
      const own = await effectiveSubscriptions(db, t.w, contactId, types.map((x) => x.id), true);
      const everything = (await db.query<{ global_unsubscribe: boolean }>("SELECT global_unsubscribe FROM contacts WHERE workspace_id=$1 AND id=$2", [t.w, contactId])).rows[0].global_unsubscribe;
      const brand = (await db.query<{ name: string }>("SELECT name FROM brands WHERE workspace_id=$1 ORDER BY id='default' DESC,name LIMIT 1", [t.w])).rows[0]?.name ?? "us";
      const rows = types
        .map(
          (x) =>
            `<label class="row"><input type="checkbox" name="type:${html(x.id)}"${own[x.id] === "opted_in" ? " checked" : ""}><span><strong>${html(x.name)}</strong> <small>${CHANNEL_NAMES[x.channel]}</small>${x.description ? `<br><small>${html(x.description)}</small>` : ""}</span></label>`,
        )
        .join("");
      const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your subscriptions</title>
<style>:root{color-scheme:light dark;--bg:#fff;--text:#1d1d1f;--muted:#5f5f66;--line:#d9d9de;--ok:#1b6e3b}@media (prefers-color-scheme:dark){:root{--bg:#141416;--text:#f2f2f4;--muted:#a7a7ae;--line:#3a3a40;--ok:#7fd6a0}}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,sans-serif}main{max-width:560px;margin:0 auto;padding:32px 16px}h1{font-size:22px;margin:0 0 4px}p{color:var(--muted);margin:0 0 20px}
.row{display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-top:1px solid var(--line)}.row input{margin-top:5px;width:18px;height:18px}small{color:var(--muted)}.all{border-bottom:1px solid var(--line)}
button{margin-top:20px;font:inherit;padding:8px 16px;border-radius:8px;border:1px solid var(--line);background:var(--text);color:var(--bg);cursor:pointer}.saved{color:var(--ok)}</style></head>
<body><main><h1>Your subscriptions</h1><p>Choose what you hear from ${html(brand)}. Replies to conversations you start aren't affected.</p>
${saved ? `<p class="saved" role="status">Saved.</p>` : ""}<form method="post">${rows}<label class="row all"><input type="checkbox" name="all"${everything ? " checked" : ""}><span><strong>Unsubscribe from everything</strong><br><small>No messages of any of these kinds, whatever is ticked above.</small></span></label>
<button type="submit">Save</button></form></main></body></html>`;
      return new Response(body, { status: 200, headers: PAGE_HEADERS });
    });
  } catch (e) {
    if (e instanceof DomainError) return NOT_FOUND();
    throw e;
  }
}

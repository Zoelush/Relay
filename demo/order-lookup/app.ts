import { Relay, RelayError, verifyWebhook } from "../../sdk/javascript/relay.mjs";
import { SHOPS, type Order, type Shop } from "./orders";

/**
 * The order-lookup example app (phase 15, step D5; docs/DEVELOPER_PLATFORM_STEP5.md), built only
 * on what any developer has: Relay's OAuth, its REST API (through the generated JavaScript SDK)
 * and Canvas. It's the reference's example ("Canvas apps") and the acceptance test's app.
 *
 * - **Installing:** `/install` sends a workspace's manager to Relay's consent screen (PKCE);
 *   `/oauth/callback` exchanges the code and keeps the tokens per workspace (refreshing them).
 * - **Configure** (Settings): which shop, and whether to show refunded orders.
 * - **Inbox sidebar:** the conversation's customer (read through the API, with the app's own
 *   token) and their orders from the order service; pressing one shows its details.
 * - **Composer:** pick an order, add a line, and its status goes into the reply for the teammate
 *   to read and send.
 * - **Every canvas request is verified** (`Relay-Signature`, the same as webhooks) before anything.
 */
export type Credentials = { clientId: string; clientSecret: string; canvasSecret: string };
export type OrderLookupOptions = {
  /** Where people use Relay (its consent screen), e.g. http://127.0.0.1:8789. */
  relayHost: string;
  /** Relay's API origin, e.g. http://127.0.0.1:8788 (the SDK's base is `<this>/rest`). */
  relayApi: string;
  /** This app's own address (its OAuth redirect is `<this>/oauth/callback`). */
  publicUrl: string;
  /** The order service's address. */
  orderService: string;
  credentials?: Credentials;
  fetch?: typeof fetch;
};
type Settings = { shop: Shop; show_refunded: boolean };
type CanvasRequest = {
  type: "initialize" | "submit" | "configure";
  placement: "conversation.sidebar" | "composer" | "settings";
  workspace_id: string;
  conversation: { id: string; contact_id: string | null } | null;
  settings: Partial<Settings> | null;
  component_id?: string;
  input_values?: Record<string, string | string[]>;
  stored_data?: { email?: string } | null;
};
type Component = Record<string, unknown> & { type: string };
const canvas = (components: Component[], stored_data?: Record<string, unknown>) => Response.json({ canvas: { content: { components }, ...(stored_data ? { stored_data } : {}) } });
const text = (t: string, style?: "header" | "muted" | "error"): Component => ({ type: "text", text: t, ...(style ? { style } : {}) });
const date = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
const STATUS = { processing: "Being prepared", shipped: "Shipped", delivered: "Delivered", refunded: "Refunded" } as const;
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const html = (body: string, status = 200) =>
  new Response(`<!doctype html><meta charset="utf-8"><title>Order lookup</title><body style="font:15px/1.5 system-ui,sans-serif;max-width:40em;margin:3em auto">${body}</body>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** What the composer puts in the reply: the order's status, in words for the customer. */
export function statusSentence(o: Order, shop: Shop) {
  const what = `Your order #${o.number} (${o.items.join(", ")})`;
  if (o.status === "shipped") return `${what} is on its way with ${o.carrier}, tracking number ${o.tracking}. It should arrive by ${date(o.estimatedDelivery!)}.`;
  if (o.status === "processing") return `${what} is being prepared at ${SHOPS[shop].name} and should arrive by ${date(o.estimatedDelivery!)}.`;
  if (o.status === "delivered") return `${what} was delivered by ${o.carrier}.`;
  return `${what} was refunded in full.`;
}

export function orderLookupApp(options: OrderLookupOptions) {
  const send = options.fetch ?? fetch;
  let credentials = options.credentials ?? null;
  const pending = new Map<string, string>();
  const installs = new Map<string, { access: string; refresh: string; expiresAt: number }>();

  async function tokens(form: Record<string, string>) {
    const r = await send(options.relayApi + "/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...form, client_id: credentials!.clientId, client_secret: credentials!.clientSecret }),
    });
    const t = (await r.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string };
    if (!r.ok || !t.access_token) throw new Error(t.error_description ?? "Relay refused the tokens.");
    return { access: t.access_token, refresh: t.refresh_token!, expiresAt: Date.now() + (t.expires_in! - 60) * 1000 };
  }
  /** The API client for a workspace that installed the app, its token refreshed when due. */
  async function relayFor(workspace: string) {
    let t = installs.get(workspace);
    if (!t) return null;
    if (Date.now() > t.expiresAt) installs.set(workspace, (t = await tokens({ grant_type: "refresh_token", refresh_token: t.refresh })));
    return new Relay({ token: t.access, baseUrl: options.relayApi + "/rest", fetch: send });
  }
  async function orders(settings: Settings, email: string): Promise<Order[] | null> {
    try {
      const r = await send(`${options.orderService}/orders?${new URLSearchParams({ shop: settings.shop, email })}`);
      if (!r.ok) return null;
      const all = ((await r.json()) as { orders: Order[] }).orders;
      return settings.show_refunded ? all : all.filter((o) => o.status !== "refunded");
    } catch {
      return null;
    }
  }

  /* -------------------------------------------------------------------------------------- */
  /* The cards                                                                               */
  /* -------------------------------------------------------------------------------------- */
  async function customerEmail(req: CanvasRequest) {
    if (req.stored_data?.email) return { email: req.stored_data.email };
    const relay = await relayFor(req.workspace_id);
    if (!relay) return { problem: "Order lookup isn't connected to this workspace. Install it again from the app's page." };
    const contactId = req.conversation?.contact_id;
    if (!contactId) return { problem: "There's no customer on this conversation yet." };
    try {
      const contact = await relay.getContact(contactId);
      return contact.email ? { email: contact.email } : { problem: "This customer has no email address, so their orders can't be found." };
    } catch (e) {
      return { problem: e instanceof RelayError && e.status === 403 ? "Order lookup isn't allowed to see customers' details here." : "Relay's API didn't answer. Try again." };
    }
  }
  const orderList = (list: Order[]): Component => ({
    type: "list",
    items: list.map((o) => ({
      id: "order:" + o.number,
      title: `#${o.number} · ${o.total}`,
      subtitle: `${STATUS[o.status]} · ${date(o.placedAt)}`,
      tertiary: o.items.join(", "),
      action: { type: "submit" },
    })),
  });
  async function ordersCard(req: CanvasRequest, settings: Settings, heading: string) {
    const who = await customerEmail(req);
    if (!who.email) return canvas([text(heading, "header"), text(who.problem!, "muted")]);
    const list = await orders(settings, who.email);
    if (!list)
      return canvas(
        [text(heading, "header"), text("The order service isn't answering. Try again in a moment.", "error"), { type: "button", id: "retry", label: "Try again", style: "secondary", action: { type: "submit" } }],
        { email: who.email },
      );
    if (!list.length) return canvas([text(heading, "header"), text(`No orders for ${who.email} at ${SHOPS[settings.shop].name}.`, "muted")], { email: who.email });
    return canvas([text(heading, "header"), text(`${who.email} · ${SHOPS[settings.shop].name}`, "muted"), orderList(list)], { email: who.email });
  }
  async function find(req: CanvasRequest, settings: Settings, number: string) {
    const list = req.stored_data?.email ? await orders(settings, req.stored_data.email) : null;
    return list?.find((o) => o.number === number) ?? null;
  }
  async function sidebar(req: CanvasRequest, settings: Settings) {
    const id = req.component_id ?? "";
    if (id.startsWith("order:")) {
      const o = await find(req, settings, id.slice(6));
      if (!o) return ordersCard(req, settings, "Orders");
      return canvas(
        [
          text(`Order #${o.number}`, "header"),
          {
            type: "data_table",
            items: [
              { field: "Status", value: STATUS[o.status] },
              { field: "Placed", value: date(o.placedAt) },
              { field: "Total", value: o.total },
              { field: "Items", value: o.items.join(", ") },
              ...(o.carrier ? [{ field: "Carrier", value: o.carrier }] : []),
              ...(o.tracking ? [{ field: "Tracking", value: o.tracking }] : []),
              ...(o.estimatedDelivery ? [{ field: "Arrives by", value: date(o.estimatedDelivery) }] : []),
            ],
          },
          { type: "link", text: `Open in ${SHOPS[settings.shop].name} admin`, url: `https://admin.acme.example/${settings.shop}/orders/${o.number}` },
          { type: "divider" },
          { type: "button", id: "back", label: "Back to orders", style: "secondary", action: { type: "submit" } },
        ],
        { email: req.stored_data!.email },
      );
    }
    return ordersCard(req, settings, "Orders");
  }
  async function composer(req: CanvasRequest, settings: Settings) {
    const id = req.component_id ?? "";
    if (id.startsWith("insert:")) {
      const o = await find(req, settings, id.slice(7));
      const extra = String(req.input_values?.note ?? "").trim();
      if (o) return Response.json({ insert_text: statusSentence(o, settings.shop) + (extra ? "\n\n" + extra : "") });
    }
    if (id.startsWith("order:")) {
      const o = await find(req, settings, id.slice(6));
      if (o)
        return canvas(
          [
            text(`Order #${o.number}`, "header"),
            text(statusSentence(o, settings.shop)),
            { type: "textarea", id: "note", label: "Add a line (optional)", placeholder: "Anything else for the customer" },
            { type: "button", id: "insert:" + o.number, label: "Insert into reply", style: "primary", action: { type: "submit" } },
            { type: "button", id: "back", label: "Back", style: "link", action: { type: "submit" } },
          ],
          { email: req.stored_data!.email },
        );
    }
    return ordersCard(req, settings, "Insert an order's status");
  }
  function configure(req: CanvasRequest, settings: Settings) {
    if (req.component_id === "save") {
      const shop = String(req.input_values?.shop ?? "");
      if (!(shop in SHOPS)) return configureCard(settings, "Choose a shop.");
      const checks = req.input_values?.options;
      return Response.json({ results: { shop, show_refunded: Array.isArray(checks) && checks.includes("show_refunded") } });
    }
    return configureCard(settings);
  }
  const configureCard = (settings: Settings, problem?: string) =>
    canvas([
      text("Set up Order lookup", "header"),
      text("Choose the shop whose orders appear beside your conversations.", "muted"),
      { type: "dropdown", id: "shop", label: "Shop", options: Object.entries(SHOPS).map(([id, s]) => ({ id, text: s.name })), value: settings.shop },
      { type: "checkbox", id: "options", label: "Options", options: [{ id: "show_refunded", text: "Show refunded orders" }], value: settings.show_refunded ? ["show_refunded"] : [] },
      ...(problem ? [text(problem, "error")] : []),
      { type: "button", id: "save", label: "Save", style: "primary", action: { type: "submit" } },
    ]);

  /* -------------------------------------------------------------------------------------- */
  /* HTTP                                                                                    */
  /* -------------------------------------------------------------------------------------- */
  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/canvas/") && req.method === "POST") {
      const raw = await req.text();
      let body: CanvasRequest;
      try {
        if (!credentials) throw new Error("not set up");
        body = (await verifyWebhook(credentials.canvasSecret, raw, req.headers.get("relay-signature") ?? "")) as unknown as CanvasRequest;
      } catch {
        return Response.json({ error: "The signature doesn't match." }, { status: 401 });
      }
      const settings: Settings = { shop: body.settings?.shop && body.settings.shop in SHOPS ? body.settings.shop : "uk", show_refunded: !!body.settings?.show_refunded };
      if (body.placement === "settings") return configure(body, settings);
      if (body.placement === "composer") return composer(body, settings);
      return sidebar(body, settings);
    }
    if (url.pathname === "/install") {
      if (!credentials) return html("<p>Register the app in Relay first (Settings › Developers › Apps), then start it with its credentials.</p>", 503);
      const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
      const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
      pending.set(state, verifier);
      const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
      const q = new URLSearchParams({
        response_type: "code",
        client_id: credentials.clientId,
        redirect_uri: options.publicUrl + "/oauth/callback",
        scope: "conversations.read contacts.personal_data",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      return new Response(null, { status: 302, headers: { location: `${options.relayHost}/oauth/authorize?${q}` } });
    }
    if (url.pathname === "/oauth/callback") {
      const verifier = pending.get(url.searchParams.get("state") ?? "");
      if (!verifier) return html("<p>That sign-in link has expired. Start again from the install page.</p>", 400);
      pending.delete(url.searchParams.get("state")!);
      if (url.searchParams.get("error")) return html("<p>Order lookup wasn't installed.</p>");
      try {
        const t = await tokens({ grant_type: "authorization_code", code: url.searchParams.get("code") ?? "", redirect_uri: options.publicUrl + "/oauth/callback", code_verifier: verifier });
        const me = await new Relay({ token: t.access, baseUrl: options.relayApi + "/rest", fetch: send }).getMe();
        installs.set(me.workspace_id, t);
        return html(`<h1>Order lookup is installed</h1><p>Open a conversation in Relay to see the customer's orders.</p><p><a href="${escape(options.relayHost)}/agent#settings/apps">Back to Relay</a></p>`);
      } catch (e) {
        return html(`<p>Order lookup couldn't finish installing: ${escape(e instanceof Error ? e.message : "unknown error")}</p>`, 502);
      }
    }
    if (url.pathname === "/")
      return html(`<h1>Order lookup</h1><p>Shows a customer's orders beside their conversations in Relay.</p><p><a href="/install">Install in Relay</a></p>`);
    return Response.json({ error: "Not found." }, { status: 404 });
  }
  return {
    handle,
    setCredentials(c: Credentials) {
      credentials = c;
    },
    installedIn: (workspace: string) => installs.has(workspace),
  };
}

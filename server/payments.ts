import { DomainError } from "./db";

/**
 * The payment provider (phase 16, step C10a; docs/SECURITY_STEP20.md), behind a port. Relay issues
 * every invoice (the record); the provider only keeps the card and charges an invoice's total.
 *
 * - **Stripe** (deployed): a small client over Stripe's REST API (no SDK). The card is added on
 *   Stripe Checkout in setup mode, so card numbers never reach Relay; Relay keeps the card's brand,
 *   last 4 digits and expiry. A charge is a PaymentIntent confirmed off-session with the card on
 *   file, idempotent on its key. A live key is refused unless `RELAY_BILLING_LIVE=true`.
 * - **The stand-in** (locally and in tests): the same steps with no network and no money. Its card
 *   ends 4242 and its charges succeed, unless it's made to decline.
 *
 * Webhooks: Stripe's are believed only when signed with the endpoint's secret within 5 minutes
 * (`Stripe-Signature`, HMAC-SHA-256 over `<t>.<body>`).
 */
export type Card = { paymentMethodId: string; brand: string; last4: string; expMonth: number; expYear: number };
export type ChargeResult =
  | { status: "succeeded"; id: string }
  | { status: "failed"; id: string | null; failure: string };
export type PaymentEvent =
  | { id: string; type: "card_added"; workspace: string; sessionId: string }
  | { id: string; type: "charge_succeeded"; workspace: string; invoiceId: string; paymentId: string }
  | { id: string; type: "charge_failed"; workspace: string; invoiceId: string; paymentId: string; failure: string }
  | { id: string; type: "ignored" };
export type PaymentPort = {
  provider: "stripe" | "stand-in";
  /** The provider's customer for this workspace (made the first time). */
  customer(w: string, profile: { email: string; name: string }): Promise<string>;
  /** Where the manager adds a card; the provider sends them back to `returnUrl`, its `{CHECKOUT_SESSION_ID}` filled in. */
  setupSession(r: { w: string; customerId: string; returnUrl: string; cancelUrl: string }): Promise<{ id: string; url: string }>;
  /** The card a finished setup session saved (made the customer's default). */
  cardFrom(r: { w: string; customerId: string; sessionId: string }): Promise<Card>;
  /** Charges a total once per key. */
  charge(r: { w: string; customerId: string; paymentMethodId: string; amountCents: number; currency: string; invoiceId: string; description: string; idempotencyKey: string }): Promise<ChargeResult>;
  /** A webhook, believed only when signed; null when it isn't. */
  event(raw: string, signature: string, now?: number): Promise<PaymentEvent | null>;
};

/** Why a card was declined, in plain words (by the provider's code, never its own text). */
export function declineWords(code: string | undefined) {
  const words: Record<string, string> = {
    insufficient_funds: "The card has insufficient funds.",
    card_declined: "The card was declined.",
    generic_decline: "The card was declined.",
    expired_card: "The card has expired.",
    incorrect_cvc: "The card's security code was wrong.",
    processing_error: "The card couldn't be processed. Try again.",
    authentication_required: "The bank asked the cardholder to confirm this payment.",
    lost_card: "The card was declined.",
    stolen_card: "The card was declined.",
  };
  return words[code ?? ""] ?? "The card was declined.";
}

/* ------------------------------------------------------------------------------------------ */
/* Stripe                                                                                      */

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function hmac(secret: string, text: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(text)));
}
/** Equal strings in time that doesn't depend on where they differ. */
function same(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
/** Stripe's signature header: `t=<seconds>,v1=<hex>[,v1=…]`, within 5 minutes. */
export async function stripeSigned(raw: string, header: string, secret: string, now = Date.now()) {
  const parts = header.split(",").map((p) => p.split("=") as [string, string]);
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const signatures = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!Number.isFinite(t) || !signatures.length || Math.abs(now / 1000 - t) > 300) return false;
  const expected = await hmac(secret, `${t}.${raw}`);
  return signatures.some((s) => same(s, expected));
}
/** Stripe's form encoding, nested keys included (`metadata[workspace_id]`). */
function form(o: Record<string, string | number | boolean | undefined>) {
  return Object.entries(o)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
}

export function stripePayments(o: { secretKey: string; webhookSecret: string; live?: boolean; fetch?: typeof fetch }): PaymentPort {
  if (o.secretKey.startsWith("sk_live_") && !o.live) throw new Error("A live Stripe key is refused until RELAY_BILLING_LIVE=true.");
  const send = o.fetch ?? fetch;
  const call = async <T>(method: "GET" | "POST", path: string, body?: Record<string, string | number | boolean | undefined>, idempotencyKey?: string) => {
    let response: Response;
    try {
      response = await send("https://api.stripe.com/v1" + path, {
        method,
        signal: AbortSignal.timeout(20_000),
        headers: {
          authorization: `Bearer ${o.secretKey}`,
          "content-type": "application/x-www-form-urlencoded",
          "stripe-version": "2024-06-20",
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        },
        body: body ? form(body) : undefined,
      });
    } catch {
      throw new DomainError("PAYMENTS_UNAVAILABLE", "The payment provider couldn't be reached. Try again.", 503);
    }
    const parsed = (await response.json().catch(() => ({}))) as T & { error?: { type?: string; code?: string; decline_code?: string; payment_intent?: { id?: string } } };
    return { status: response.status, body: parsed };
  };
  return {
    provider: "stripe",
    async customer(w, profile) {
      const r = await call<{ id: string }>("POST", "/customers", { email: profile.email || undefined, name: profile.name || undefined, "metadata[workspace_id]": w }, `customer:${w}`);
      if (r.status !== 200 || !r.body.id) throw new DomainError("PAYMENTS_FAILED", `The payment provider refused (${r.status}).`, 502);
      return r.body.id;
    },
    async setupSession({ w, customerId, returnUrl, cancelUrl }) {
      const r = await call<{ id: string; url: string }>("POST", "/checkout/sessions", {
        mode: "setup",
        customer: customerId,
        currency: "usd",
        "payment_method_types[0]": "card",
        success_url: returnUrl,
        cancel_url: cancelUrl,
        "metadata[workspace_id]": w,
        "setup_intent_data[metadata][workspace_id]": w,
      });
      if (r.status !== 200 || !r.body.url) throw new DomainError("PAYMENTS_FAILED", `The payment provider refused (${r.status}).`, 502);
      return { id: r.body.id, url: r.body.url };
    },
    async cardFrom({ w, customerId, sessionId }) {
      if (!/^cs_[A-Za-z0-9_]{1,200}$/.test(sessionId)) throw new DomainError("INVALID_FIELD", "That card setup isn't valid.", 400);
      const s = await call<{ status?: string; customer?: string; metadata?: Record<string, string>; setup_intent?: { payment_method?: { id: string; card?: { brand: string; last4: string; exp_month: number; exp_year: number } } } }>(
        "GET",
        `/checkout/sessions/${sessionId}?expand[]=setup_intent.payment_method`,
      );
      const pm = s.body.setup_intent?.payment_method;
      if (s.status !== 200 || s.body.status !== "complete" || s.body.customer !== customerId || s.body.metadata?.workspace_id !== w || !pm?.card)
        throw new DomainError("CARD_NOT_ADDED", "The card wasn't added. Try again.", 409);
      await call("POST", `/customers/${customerId}`, { "invoice_settings[default_payment_method]": pm.id });
      return { paymentMethodId: pm.id, brand: pm.card.brand, last4: pm.card.last4, expMonth: pm.card.exp_month, expYear: pm.card.exp_year };
    },
    async charge(c) {
      const r = await call<{ id?: string; status?: string }>(
        "POST",
        "/payment_intents",
        {
          amount: c.amountCents,
          currency: c.currency,
          customer: c.customerId,
          payment_method: c.paymentMethodId,
          off_session: true,
          confirm: true,
          description: c.description,
          "metadata[workspace_id]": c.w,
          "metadata[invoice_id]": c.invoiceId,
        },
        c.idempotencyKey,
      );
      if (r.status === 200 && r.body.status === "succeeded" && r.body.id) return { status: "succeeded", id: r.body.id };
      if (r.status === 200) return { status: "failed", id: r.body.id ?? null, failure: declineWords(r.body.status === "requires_action" ? "authentication_required" : undefined) };
      if (r.status === 402) return { status: "failed", id: r.body.error?.payment_intent?.id ?? null, failure: declineWords(r.body.error?.decline_code ?? r.body.error?.code) };
      throw new DomainError("PAYMENTS_UNAVAILABLE", `The payment provider answered ${r.status}. Try again.`, 503);
    },
    async event(raw, signature, now) {
      if (!(await stripeSigned(raw, signature, o.webhookSecret, now))) return null;
      const e = JSON.parse(raw) as { id: string; type: string; data?: { object?: Record<string, unknown> } };
      const obj = e.data?.object ?? {};
      const meta = (obj.metadata ?? {}) as Record<string, string>;
      const w = meta.workspace_id;
      if (!w) return { id: e.id, type: "ignored" };
      if (e.type === "checkout.session.completed" && obj.mode === "setup") return { id: e.id, type: "card_added", workspace: w, sessionId: String(obj.id) };
      if (e.type === "payment_intent.succeeded" && meta.invoice_id) return { id: e.id, type: "charge_succeeded", workspace: w, invoiceId: meta.invoice_id, paymentId: String(obj.id) };
      if (e.type === "payment_intent.payment_failed" && meta.invoice_id) {
        const err = (obj.last_payment_error ?? {}) as { decline_code?: string; code?: string };
        return { id: e.id, type: "charge_failed", workspace: w, invoiceId: meta.invoice_id, paymentId: String(obj.id), failure: declineWords(err.decline_code ?? err.code) };
      }
      return { id: e.id, type: "ignored" };
    },
  };
}

/* ------------------------------------------------------------------------------------------ */
/* The stand-in                                                                                */

/**
 * Locally and in tests: a card ending 4242 (or 0002, which declines, when `decline` is on), added by
 * a "session" that sends the manager straight back; charges recorded in `charges`, never made.
 * Its webhooks are signed with `secret`, like Stripe's, so tests drive the same path.
 */
export function standInPayments(o: { decline?: boolean; secret?: string } = {}) {
  const charges: { key: string; amountCents: number; invoiceId: string }[] = [];
  const sessions = new Map<string, string>();
  const state = { decline: !!o.decline };
  const secret = o.secret ?? "whsec_stand_in";
  const port: PaymentPort = {
    provider: "stand-in",
    async customer(w) {
      return `cus_stand_in_${w}`;
    },
    async setupSession({ w, returnUrl }) {
      const id = `cs_stand_in_${crypto.randomUUID().replace(/-/g, "")}`;
      sessions.set(id, w);
      return { id, url: returnUrl.replace("{CHECKOUT_SESSION_ID}", id) };
    },
    async cardFrom({ w, sessionId }) {
      if (sessions.get(sessionId) !== w) throw new DomainError("CARD_NOT_ADDED", "The card wasn't added. Try again.", 409);
      return { paymentMethodId: `pm_stand_in_${state.decline ? "0002" : "4242"}`, brand: "visa", last4: state.decline ? "0002" : "4242", expMonth: 12, expYear: new Date().getUTCFullYear() + 3 };
    },
    async charge(c) {
      const earlier = charges.find((x) => x.key === c.idempotencyKey);
      if (!earlier) charges.push({ key: c.idempotencyKey, amountCents: c.amountCents, invoiceId: c.invoiceId });
      if (c.paymentMethodId.endsWith("0002")) return { status: "failed", id: `pi_stand_in_${c.idempotencyKey}`, failure: declineWords("insufficient_funds") };
      return { status: "succeeded", id: `pi_stand_in_${c.idempotencyKey}` };
    },
    async event(raw, signature, now) {
      if (!(await stripeSigned(raw, signature, secret, now))) return null;
      const e = JSON.parse(raw) as PaymentEvent;
      return e;
    },
  };
  /** Tests: sign a stand-in webhook as Stripe would. */
  const sign = async (raw: string, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${await hmac(secret, `${t}.${raw}`)}`;
  return { port, charges, state, sign };
}

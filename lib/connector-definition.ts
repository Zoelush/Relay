/**
 * A data connector's definition (phase 09, step D1; docs/ACTIONS_STEP1.md), shared by the server
 * (`server/connectors.ts`, which validates every save and publish) and the Actions page.
 *
 * Everything sent outward is declared: the request is a template whose only placeholders are the
 * connector's declared inputs (`{{order_id}}`), each with a type and where its value comes from.
 * Everything that comes back is mapped: named, typed values picked out of the JSON response by
 * path. Zoe only ever sees those values, never the raw response.
 */
export const INPUT_SOURCES = {
  customer: "Asked of the customer",
  "contact.email": "The customer's email",
  "contact.name": "The customer's name",
  "contact.external_id": "The customer's user ID (signed in)",
  "conversation.id": "The conversation's ID",
} as const;
export type InputSource = keyof typeof INPUT_SOURCES;
export type ValueType = "string" | "number" | "boolean";
export type ConnectorInput = {
  name: string;
  label: string;
  type: ValueType;
  source: InputSource;
  required: boolean;
  /** Redacted in the audit. */
  sensitive: boolean;
  /** A regular expression the value must match (strings only), or "". */
  pattern: string;
  maxLength: number;
};
export type ConnectorOutput = {
  name: string;
  label: string;
  /** Where in the JSON response: `order.status`, `items[0].name`. */
  path: string;
  type: ValueType | "list";
  sensitive: boolean;
};
export type ConnectorAuth =
  | { type: "none" }
  | { type: "api_key"; header: string }
  | { type: "bearer" }
  | { type: "oauth_client_credentials"; tokenUrl: string; clientId: string; scope: string }
  /** D4: OAuth 2 on the workspace's behalf: a manager connects it once; Relay refreshes the token. */
  | { type: "oauth_authorization_code"; authorizeUrl: string; tokenUrl: string; clientId: string; scope: string };
export type Definition = {
  description: string;
  /**
   * Read looks things up; write changes things (D3): any method but GET, used by Zoe only once a
   * manager turns its writes on, refused while the workspace's writes are paused, and only for a
   * signed-in customer.
   */
  access: "read" | "write";
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  baseUrl: string;
  path: string;
  query: { name: string; value: string }[];
  headers: { name: string; value: string }[];
  /** JSON (POST only); placeholders go inside strings: `{"id": "{{order_id}}"}`. */
  body: string;
  inputs: ConnectorInput[];
  outputs: ConnectorOutput[];
  auth: ConnectorAuth;
  timeoutMs: number;
  /**
   * Retries after a timeout, a network failure, a 429 or a 5xx. A write is retried only with an
   * idempotency header: without one, a write that may have gone through is never sent again.
   */
  retries: number;
  /** Writes: whether a teammate approves each one before it runs. */
  approval: "always" | "never";
  /** Writes: the header carrying a key that's the same for every attempt at one write, or "". */
  idempotencyHeader: string;
  /** Calls a minute, across the workspace. */
  rateLimit: number;
};
/** Which secret each kind of authentication needs. */
export const SECRET_FOR: Record<ConnectorAuth["type"], "api_key" | "token" | "client_secret" | null> = {
  none: null,
  api_key: "api_key",
  bearer: "token",
  oauth_client_credentials: "client_secret",
  oauth_authorization_code: "client_secret",
};

export const blankDefinition = (): Definition => ({
  description: "",
  access: "read",
  method: "GET",
  baseUrl: "https://",
  path: "/",
  query: [],
  headers: [],
  body: "",
  inputs: [],
  outputs: [],
  auth: { type: "none" },
  timeoutMs: 5000,
  retries: 1,
  rateLimit: 60,
  approval: "always",
  idempotencyHeader: "",
});
/** Methods each access allows. */
export const METHODS = { read: ["GET", "POST"], write: ["POST", "PUT", "PATCH", "DELETE"] } as const;

const NAME = /^[a-z][a-z0-9_]{0,39}$/;
const HEADER = /^[A-Za-z0-9-]{1,64}$/;
const PATH = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+|\[\d{1,3}\])*$/;
/** Headers Relay sets, or that no connector may set. */
const RESERVED_HEADERS =
  /^(authorization|cookie|host|content-length|transfer-encoding|connection|te|upgrade|user-agent|proxy-.*|x-forwarded-.*|forwarded)$/i;
const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;

export class DefinitionError extends Error {}
const fail = (message: string): never => {
  throw new DefinitionError(message);
};
const text = (v: unknown, max: number, what: string, required = false) => {
  const s = typeof v === "string" ? v.trim() : "";
  if (required && !s) fail(`Give ${what}.`);
  if (s.length > max) fail(`Keep ${what} to ${max} characters.`);
  if (/[\r\n\x00]/.test(s) && what !== "the body" && what !== "the description")
    fail(`${what[0].toUpperCase() + what.slice(1)} can't contain line breaks.`);
  return s;
};
const int = (v: unknown, min: number, max: number, what: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) fail(`Set ${what} between ${min} and ${max}.`);
  return n;
};
const list = <T>(v: unknown, max: number, what: string, each: (x: Record<string, unknown>, i: number) => T) => {
  if (v === undefined) return [];
  if (!Array.isArray(v)) fail(`List ${what}.`);
  if ((v as unknown[]).length > max) fail(`Keep ${what} to ${max}.`);
  return (v as Record<string, unknown>[]).map((x, i) => each(x && typeof x === "object" ? x : {}, i));
};
const https = (v: unknown, what: string) => {
  const s = text(v, 500, what, true);
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return fail(`Give ${what} as a full address, starting https://.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") fail(`Give ${what} as a full address, starting https://.`);
  if (url.username || url.password) fail(`Put credentials in Authentication, not in ${what}.`);
  if (url.search || url.hash) fail(`Put query values in Query, not in ${what}.`);
  return s.replace(/\/+$/, "");
};

/** The placeholders a template uses. */
export function placeholders(template: string) {
  return [...template.matchAll(PLACEHOLDER)].map((m) => m[1]);
}

/** A valid definition from what was submitted, or a `DefinitionError` saying what to fix. */
export function validateDefinition(raw: unknown): Definition {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const access = d.access === "write" ? "write" : d.access === "read" || d.access === undefined ? "read" : fail("Choose read or write.");
  const method =
    (METHODS[access] as readonly string[]).find((m) => m === d.method) as Definition["method"] | undefined ??
    fail(access === "read" ? "A read connector uses GET or POST." : "A write connector uses POST, PUT, PATCH or DELETE.");
  const inputs = list(d.inputs, 20, "inputs", (x, i): ConnectorInput => {
    const name = text(x.name, 40, `input ${i + 1}'s name`, true);
    if (!NAME.test(name)) fail(`Name input ${i + 1} with lowercase letters, digits and underscores, starting with a letter.`);
    const type = (["string", "number", "boolean"] as const).find((t) => t === x.type) ?? fail(`Choose input ${name}'s type.`);
    const source = (Object.keys(INPUT_SOURCES) as InputSource[]).find((s) => s === x.source) ?? fail(`Choose where input ${name} comes from.`);
    const pattern = text(x.pattern, 200, `input ${name}'s pattern`);
    if (pattern)
      try {
        new RegExp(pattern);
      } catch {
        fail(`Input ${name}'s pattern isn't a valid regular expression.`);
      }
    return {
      name,
      label: text(x.label, 60, `input ${name}'s label`) || name,
      type,
      source,
      required: x.required !== false,
      sensitive: x.sensitive === true,
      pattern: type === "string" ? pattern : "",
      maxLength: x.maxLength === undefined ? 200 : int(x.maxLength, 1, 2000, `input ${name}'s maximum length`),
    };
  });
  const names = new Set<string>();
  for (const i of inputs) {
    if (names.has(i.name)) fail(`Two inputs are called ${i.name}.`);
    names.add(i.name);
  }
  const outputs = list(d.outputs, 30, "outputs", (x, i): ConnectorOutput => {
    const name = text(x.name, 40, `output ${i + 1}'s name`, true);
    if (!NAME.test(name)) fail(`Name output ${i + 1} with lowercase letters, digits and underscores, starting with a letter.`);
    const path = text(x.path, 200, `output ${name}'s path`, true);
    if (!PATH.test(path)) fail(`Output ${name}'s path should look like order.status or items[0].name.`);
    return {
      name,
      label: text(x.label, 60, `output ${name}'s label`) || name,
      path,
      type: (["string", "number", "boolean", "list"] as const).find((t) => t === x.type) ?? fail(`Choose output ${name}'s type.`),
      sensitive: x.sensitive === true,
    };
  });
  const outNames = new Set<string>();
  for (const o of outputs) {
    if (outNames.has(o.name)) fail(`Two outputs are called ${o.name}.`);
    outNames.add(o.name);
  }
  const a = (d.auth && typeof d.auth === "object" ? d.auth : { type: "none" }) as Record<string, unknown>;
  const auth: ConnectorAuth =
    a.type === "api_key"
      ? (() => {
          const header = text(a.header, 64, "the API key's header", true);
          if (!HEADER.test(header) || RESERVED_HEADERS.test(header)) fail(`Relay can't send the API key as ${header}.`);
          return { type: "api_key" as const, header };
        })()
      : a.type === "bearer"
        ? { type: "bearer" }
        : a.type === "oauth_client_credentials"
          ? {
              type: "oauth_client_credentials",
              tokenUrl: https(a.tokenUrl, "the token address"),
              clientId: text(a.clientId, 200, "the client ID", true),
              scope: text(a.scope, 500, "the scope"),
            }
          : a.type === "oauth_authorization_code"
            ? {
                type: "oauth_authorization_code",
                authorizeUrl: https(a.authorizeUrl, "the authorization address"),
                tokenUrl: https(a.tokenUrl, "the token address"),
                clientId: text(a.clientId, 200, "the client ID", true),
                scope: text(a.scope, 500, "the scope"),
              }
          : a.type === "none" || a.type === undefined
            ? { type: "none" }
            : fail("Choose how Relay authenticates.");
  const query = list(d.query, 20, "query values", (x, i) => {
    const name = text(x.name, 64, `query value ${i + 1}'s name`, true);
    if (!/^[A-Za-z0-9_.\-[\]]+$/.test(name)) fail(`Query value ${name} has characters a name can't have.`);
    return { name, value: text(x.value, 500, `query value ${name}`) };
  });
  const headers = list(d.headers, 20, "headers", (x, i) => {
    const name = text(x.name, 64, `header ${i + 1}'s name`, true);
    if (!HEADER.test(name)) fail(`Header ${name} has characters a header name can't have.`);
    if (RESERVED_HEADERS.test(name) || (auth.type === "api_key" && auth.header.toLowerCase() === name.toLowerCase()))
      fail(`Relay sets ${name} itself; use Authentication for credentials.`);
    return { name, value: text(x.value, 500, `header ${name}`) };
  });
  const path = text(d.path, 500, "the path") || "/";
  if (!path.startsWith("/")) fail("Start the path with /.");
  if (/[?#]/.test(path)) fail("Put query values in Query, not in the path.");
  const body = method !== "GET" && method !== "DELETE" ? text(d.body, 10_000, "the body") : "";
  if (body)
    try {
      JSON.parse(body);
    } catch {
      fail("Write the body as JSON, with placeholders inside strings.");
    }
  const idempotencyHeader = access === "write" ? text(d.idempotencyHeader, 64, "the idempotency header") : "";
  if (idempotencyHeader && (!HEADER.test(idempotencyHeader) || RESERVED_HEADERS.test(idempotencyHeader)))
    fail(`Relay can't send the idempotency key as ${idempotencyHeader}.`);
  const def: Definition = {
    description: text(d.description, 500, "the description"),
    access,
    method,
    baseUrl: https(d.baseUrl, "the base address"),
    path,
    query,
    headers,
    body,
    inputs,
    outputs,
    auth,
    timeoutMs: d.timeoutMs === undefined ? 5000 : int(d.timeoutMs, 1000, 10_000, "the timeout (milliseconds)"),
    retries: d.retries === undefined ? 1 : int(d.retries, 0, 2, "retries"),
    rateLimit: d.rateLimit === undefined ? 60 : int(d.rateLimit, 1, 600, "the rate limit (calls a minute)"),
    approval: access === "write" && d.approval === "never" ? "never" : "always",
    idempotencyHeader,
  };
  if (access === "write" && def.retries > 0 && !idempotencyHeader)
    fail("A write without an idempotency header is never retried: set retries to 0, or name the header.");
  // Every placeholder is a declared input: nothing undeclared can be sent.
  for (const t of [def.path, def.body, ...def.query.map((q) => q.value), ...def.headers.map((h) => h.value)]) {
    if ((t.match(/\{\{/g) ?? []).length !== placeholders(t).length)
      fail("Write placeholders as {{name}}, with an input's name.");
    for (const p of placeholders(t)) if (!names.has(p)) fail(`{{${p}}} isn't one of the inputs. Add it as an input first.`);
  }
  return def;
}

/* ------------------------------------------------------------------------------------------ */
/* Values in, request out; response in, values out                                             */

export type Values = Record<string, string | number | boolean>;

/** Checks and converts each input's value; a `DefinitionError` names the first problem. */
export function coerceInputs(def: Definition, raw: Record<string, unknown>): Values {
  const out: Values = {};
  for (const i of def.inputs) {
    const v = raw[i.name];
    if (v === undefined || v === null || v === "") {
      if (i.required) fail(`${i.label} is needed.`);
      continue;
    }
    if (i.type === "number") {
      const n = typeof v === "number" ? v : Number(String(v).trim());
      if (!Number.isFinite(n)) fail(`${i.label} should be a number.`);
      out[i.name] = n;
    } else if (i.type === "boolean") {
      if (v === true || v === "true") out[i.name] = true;
      else if (v === false || v === "false") out[i.name] = false;
      else fail(`${i.label} should be true or false.`);
    } else {
      const s = String(v).trim();
      if (s.length > i.maxLength) fail(`${i.label} is longer than ${i.maxLength} characters.`);
      if (/[\r\n\x00]/.test(s)) fail(`${i.label} can't contain line breaks.`);
      if (i.pattern && !new RegExp(`^(?:${i.pattern})$`).test(s)) fail(`${i.label} isn't in the expected format.`);
      out[i.name] = s;
    }
  }
  return out;
}

const fill = (template: string, values: Values, encode: (s: string) => string) =>
  template.replace(PLACEHOLDER, (_, name: string) => (name in values ? encode(String(values[name])) : ""));

/** The request, from the template and the values. */
export function renderRequest(def: Definition, values: Values) {
  const url = new URL(def.baseUrl + fill(def.path, values, encodeURIComponent));
  for (const q of def.query) url.searchParams.append(q.name, fill(q.value, values, (s) => s));
  const headers: Record<string, string> = { accept: "application/json" };
  for (const h of def.headers) headers[h.name] = fill(h.value, values, (s) => s);
  let body: string | undefined;
  if (def.method !== "GET" && def.method !== "DELETE") {
    headers["content-type"] = "application/json";
    // A string that is only a placeholder becomes the typed value; otherwise text is filled in.
    const walk = (v: unknown): unknown => {
      if (typeof v === "string") {
        const whole = /^\{\{\s*([a-z][a-z0-9_]*)\s*\}\}$/.exec(v);
        if (whole) return whole[1] in values ? values[whole[1]] : null;
        return fill(v, values, (s) => s);
      }
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
      return v;
    };
    body = JSON.stringify(def.body ? walk(JSON.parse(def.body)) : {});
  }
  return { method: def.method, url: url.toString(), headers, body };
}

/** The value at a path (`order.items[0].name`), or undefined. */
export function pick(data: unknown, path: string): unknown {
  let at: unknown = data;
  for (const part of path.match(/[^.[\]]+|\[\d+\]/g) ?? []) {
    if (at === null || at === undefined) return undefined;
    if (part.startsWith("[")) at = Array.isArray(at) ? at[Number(part.slice(1, -1))] : undefined;
    else at = typeof at === "object" && !Array.isArray(at) ? (at as Record<string, unknown>)[part] : undefined;
  }
  return at;
}

/** The named values, or a `DefinitionError` for a value of the wrong type. Absent values are null. */
export function mapOutputs(def: Definition, data: unknown) {
  const out: Record<string, string | number | boolean | string[] | null> = {};
  for (const o of def.outputs) {
    const v = pick(data, o.path);
    if (v === undefined || v === null) {
      out[o.name] = null;
      continue;
    }
    if (o.type === "string" && (typeof v === "string" || typeof v === "number"))
      out[o.name] = String(v).slice(0, 1000);
    else if (o.type === "number" && typeof v === "number") out[o.name] = v;
    else if (o.type === "boolean" && typeof v === "boolean") out[o.name] = v;
    else if (o.type === "list" && Array.isArray(v) && v.every((x) => typeof x === "string" || typeof x === "number"))
      out[o.name] = v.slice(0, 20).map((x) => String(x).slice(0, 200));
    else fail(`${o.label} (${o.path}) wasn't a ${o.type === "list" ? "list" : o.type} in the response.`);
  }
  return out;
}

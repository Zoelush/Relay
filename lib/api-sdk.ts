import { LATEST_VERSION, operations, SPEC, type Operation, type Schema, type Spec } from "./api-spec";
import { resolve } from "./api-validate";

/**
 * The SDKs, generated from the API's spec (phase 15, D2): JavaScript (`sdk/javascript/relay.mjs`
 * with `relay.d.ts`) and Python (`sdk/python/relay.py`), both with no dependencies. `npm run api:doc`
 * writes them; a test compares them, and exercises both against the API itself.
 *
 * Each operation is a method: its path parameters in order, then its body (if it takes one), then
 * options (query parameters, and an idempotency key). Every call sends the token and the pinned
 * version; a POST gets an idempotency key (yours, or one made for the call, reused on its retries);
 * a 429 waits `Retry-After` seconds and tries again (up to `maxRetries`). A paged list also has an
 * `…All` method (Python: `iter_…`) that follows the cursor.
 */
type Op = { method: string; path: string; o: Operation; pathParams: string[]; hasBody: boolean; paged: "query" | "body" | null };
function ops(spec: Spec): Op[] {
  return operations(spec).map(({ method, path, operation: o }) => {
    const pathParams = [...path.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]);
    const hasBody = !!o.requestBody;
    const query = (o.parameters ?? []).some((p) => p.name === "starting_after");
    const bodyPaged = hasBody && !!resolve(o.requestBody!.content["application/json"].schema, spec).properties?.starting_after;
    return { method, path, o, pathParams, hasBody, paged: query ? "query" : bodyPaged ? "body" : null };
  });
}
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const snake = (s: string) => s.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
const jsPath = (path: string) => "`" + path.replace(/\{([a-z_]+)\}/g, (_, n) => "${e(" + camel(n) + ")}") + "`";
const pyPath = (path: string) => 'f"' + path.replace(/\{([a-z_]+)\}/g, (_, n) => "{_e(" + n + ")}") + '"';

/** A schema as a TypeScript type. */
function tsType(s: Schema, spec: Spec, depth = 0): string {
  if (s.$ref) return s.$ref.replace("#/components/schemas/", "");
  const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
  const one = (t: string): string => {
    if (t === "string") return s.enum ? s.enum.map((e) => JSON.stringify(e)).join(" | ") : "string";
    if (t === "integer" || t === "number") return "number";
    if (t === "boolean") return "boolean";
    if (t === "null") return "null";
    if (t === "array") return `${s.items ? wrap(tsType(s.items, spec, depth + 1)) : "unknown"}[]`;
    if (t === "object") {
      const props = Object.entries(s.properties ?? {});
      const extra = typeof s.additionalProperties === "object" ? `[key: string]: ${tsType(s.additionalProperties, spec, depth + 1)}` : !props.length ? "[key: string]: unknown" : "";
      const pad = "  ".repeat(depth + 1);
      const lines = props.map(([k, v]) => `${pad}${k}${(s.required ?? []).includes(k) ? "" : "?"}: ${tsType(v, spec, depth + 1)};`);
      if (extra) lines.push(`${pad}${extra};`);
      return `{\n${lines.join("\n")}\n${"  ".repeat(depth)}}`;
    }
    return "unknown";
  };
  const wrap = (t: string) => (t.includes("|") ? `(${t})` : t);
  return types.length ? types.map(one).join(" | ") : "unknown";
}
const successSchema = (o: Operation) => Object.entries(o.responses).find(([s]) => s.startsWith("2"))![1].content?.["application/json"].schema;

const HEADER = (lang: string) =>
  `${lang} Relay API client, generated from lib/api-spec.ts by \`npm run api:doc\` (API version ${LATEST_VERSION}). Don't edit by hand.`;

export function jsSdk(spec: Spec = SPEC) {
  const methods = ops(spec).flatMap(({ method, path, o, pathParams, hasBody, paged }) => {
    const name = o.operationId;
    const args = [...pathParams.map(camel), ...(hasBody ? ["body"] : []), "options = {}"];
    const call = `this.request(${JSON.stringify(method)}, ${pathParams.length ? jsPath(path) : JSON.stringify(path)}, { ...options${hasBody ? ", body" : ""} })`;
    const out = [`  /** ${o.summary}. ${o.description.replace(/\*\//g, "")} */\n  ${name}(${args.join(", ")}) {\n    return ${call};\n  }`];
    if (paged === "query")
      out.push(
        `  /** Every page of ${name}, item by item. */\n  async *${name}All(${[...pathParams.map(camel), "options = {}"].join(", ")}) {\n    let after;\n    do {\n      const page = await this.${name}(${[...pathParams.map(camel), "{ ...options, query: { ...options.query, ...(after ? { starting_after: after } : {}) } }"].join(", ")});\n      yield* page.data;\n      after = page.pages.next;\n    } while (after);\n  }`,
      );
    if (paged === "body")
      out.push(
        `  /** Every page of ${name}, item by item. */\n  async *${name}All(${[...pathParams.map(camel), "body", "options = {}"].join(", ")}) {\n    let after;\n    do {\n      const page = await this.${name}(${[...pathParams.map(camel), "{ ...body, ...(after ? { starting_after: after } : {}) }", "options"].join(", ")});\n      yield* page.data;\n      after = page.pages.next;\n    } while (after);\n  }`,
      );
    return out;
  });
  return `// ${HEADER("JavaScript")}
const e = (v) => encodeURIComponent(String(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** An error from the API: its HTTP status, stable code, message, the field at fault, and request id. */
export class RelayError extends Error {
  constructor(status, body) {
    const first = (body && body.errors && body.errors[0]) || {};
    super(first.message || \`Relay API error \${status}\`);
    this.name = "RelayError";
    this.status = status;
    this.code = first.code || "unknown";
    this.field = first.field;
    this.requestId = body && body.request_id;
    this.errors = (body && body.errors) || [];
  }
}

export class Relay {
  /**
   * @param {{ token: string, baseUrl: string, version?: string, maxRetries?: number, fetch?: typeof fetch }} options
   */
  constructor({ token, baseUrl, version = ${JSON.stringify(LATEST_VERSION)}, maxRetries = 3, fetch: f = globalThis.fetch }) {
    if (!token) throw new Error("Relay: a token is required.");
    if (!baseUrl) throw new Error("Relay: baseUrl is required (https://api.<your domain>/rest).");
    this.token = token;
    this.baseUrl = baseUrl.replace(/\\/+$/, "");
    this.version = version;
    this.maxRetries = maxRetries;
    this.fetch = f;
  }

  /** One call: the token, the version, an idempotency key on POST, and a wait on 429. */
  async request(method, path, { query, body, idempotencyKey } = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const headers = { authorization: "Bearer " + this.token, "relay-version": this.version, accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (method === "POST") headers["idempotency-key"] = idempotencyKey || crypto.randomUUID();
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetch(url.toString(), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      if (res.status === 429 && attempt < this.maxRetries) {
        await sleep(Math.max(0, Number(res.headers.get("retry-after") || 1)) * 1000);
        continue;
      }
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new RelayError(res.status, data);
      return data;
    }
  }

${methods.join("\n\n")}
}
`;
}

export function jsTypes(spec: Spec = SPEC) {
  const schemas = Object.entries(spec.components.schemas).map(([name, s]) => `export type ${name} = ${tsType(s, spec)};`);
  const methods = ops(spec).flatMap(({ o, pathParams, hasBody, paged }) => {
    const query = (o.parameters ?? []).filter((p) => p.in === "query");
    const q = query.length ? `{ ${query.map((p) => `${p.name}?: ${tsType(p.schema, spec)}`).join("; ")} }` : "never";
    const body = hasBody ? tsType(o.requestBody!.content["application/json"].schema, spec, 1) : null;
    const result = successSchema(o);
    const ret = result ? tsType(result, spec, 1) : "void";
    const params = [...pathParams.map((p) => `${camel(p)}: string`), ...(body ? [`body: ${body}`] : []), `options?: RequestOptions<${q}>`];
    const out = [`  /** ${o.summary}. */\n  ${o.operationId}(${params.join(", ")}): Promise<${ret}>;`];
    if (paged) {
      const item = result && resolve(result, spec).properties?.data?.items;
      const itemType = item ? tsType(item, spec, 1) : "unknown";
      out.push(`  ${o.operationId}All(${params.join(", ")}): AsyncGenerator<${itemType}>;`);
    }
    return out;
  });
  return `// ${HEADER("TypeScript types for the")}
${schemas.join("\n")}
export type RequestOptions<Q> = { query?: Q; idempotencyKey?: string };
export declare class RelayError extends Error {
  status: number;
  code: string;
  field?: string;
  requestId?: string;
  errors: { code: string; message: string; field?: string }[];
}
export declare class Relay {
  constructor(options: { token: string; baseUrl: string; version?: string; maxRetries?: number; fetch?: typeof fetch });
  request(method: string, path: string, options?: { query?: Record<string, unknown>; body?: unknown; idempotencyKey?: string }): Promise<unknown>;
${methods.join("\n")}
}
`;
}

export function pythonSdk(spec: Spec = SPEC) {
  const methods = ops(spec).flatMap(({ method, path, o, pathParams, hasBody, paged }) => {
    const name = snake(o.operationId);
    const query = (o.parameters ?? []).filter((p) => p.in === "query").map((p) => p.name);
    const args = ["self", ...pathParams, ...(hasBody ? ["body"] : []), ...(query.length ? ["*", ...query.map((q) => `${q}=None`)] : ["*"]), "idempotency_key=None"];
    const q = query.length ? `{${query.map((x) => `"${x}": ${x}`).join(", ")}}` : "None";
    const call = `self.request("${method}", ${pathParams.length ? pyPath(path) : JSON.stringify(path)}, query=${q}${hasBody ? ", body=body" : ""}, idempotency_key=idempotency_key)`;
    const out = [`    def ${name}(${args.join(", ")}):\n        """${o.summary}. ${o.description.replace(/"""/g, "'")}"""\n        return ${call}`];
    if (paged === "query") {
      const rest = query.filter((x) => x !== "starting_after");
      out.push(
        `    def iter_${name}(${["self", ...pathParams, ...(rest.length ? ["*", ...rest.map((x) => `${x}=None`)] : [])].join(", ")}):\n        """Every page of ${name}, item by item."""\n        after = None\n        while True:\n            page = self.${name}(${[...pathParams, ...rest.map((x) => `${x}=${x}`), "starting_after=after"].join(", ")})\n            yield from page["data"]\n            after = page["pages"]["next"]\n            if not after:\n                return`,
      );
    }
    if (paged === "body")
      out.push(
        `    def iter_${name}(${["self", ...pathParams, "body"].join(", ")}):\n        """Every page of ${name}, item by item."""\n        after = None\n        while True:\n            page = self.${name}(${[...pathParams, "dict(body, **({'starting_after': after} if after else {}))"].join(", ")})\n            yield from page["data"]\n            after = page["pages"]["next"]\n            if not after:\n                return`,
      );
    return out;
  });
  return `# ${HEADER("Python")}
import json
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

VERSION = "${LATEST_VERSION}"


def _e(v):
    return urllib.parse.quote(str(v), safe="")


class RelayError(Exception):
    """An error from the API: its HTTP status, stable code, message, the field at fault, and request id."""

    def __init__(self, status, body):
        first = ((body or {}).get("errors") or [{}])[0]
        super().__init__(first.get("message") or "Relay API error %s" % status)
        self.status = status
        self.code = first.get("code", "unknown")
        self.field = first.get("field")
        self.request_id = (body or {}).get("request_id")
        self.errors = (body or {}).get("errors") or []


class Relay:
    def __init__(self, token, base_url, version=VERSION, max_retries=3, timeout=30):
        if not token:
            raise ValueError("Relay: a token is required.")
        if not base_url:
            raise ValueError("Relay: base_url is required (https://api.<your domain>/rest).")
        self.token = token
        self.base_url = base_url.rstrip("/")
        self.version = version
        self.max_retries = max_retries
        self.timeout = timeout

    def request(self, method, path, query=None, body=None, idempotency_key=None):
        """One call: the token, the version, an idempotency key on POST, and a wait on 429."""
        url = self.base_url + path
        params = {k: v for k, v in (query or {}).items() if v is not None}
        if params:
            url += "?" + urllib.parse.urlencode({k: (str(v).lower() if isinstance(v, bool) else v) for k, v in params.items()})
        headers = {"authorization": "Bearer " + self.token, "relay-version": self.version, "accept": "application/json"}
        data = None
        if body is not None:
            headers["content-type"] = "application/json"
            data = json.dumps(body).encode()
        if method == "POST":
            headers["idempotency-key"] = idempotency_key or str(uuid.uuid4())
        attempt = 0
        while True:
            req = urllib.request.Request(url, data=data, method=method, headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as res:
                    return json.loads(res.read().decode() or "null")
            except urllib.error.HTTPError as e:
                payload = None
                try:
                    payload = json.loads(e.read().decode())
                except Exception:
                    pass
                if e.code == 429 and attempt < self.max_retries:
                    attempt += 1
                    time.sleep(max(0, float(e.headers.get("retry-after") or 1)))
                    continue
                raise RelayError(e.code, payload) from None

${methods.join("\n\n")}
`;
}

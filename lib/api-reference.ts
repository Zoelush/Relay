import { API_VERSIONS, LATEST_VERSION, operations, SPEC, type Schema, type Spec } from "./api-spec";
import { resolve } from "./api-validate";
import { CONTACT_FIELDS, CONVERSATION_FIELDS, OPERATOR_MEANING, OPERATORS, type Field as SearchField } from "./api-search";
import { TOPICS } from "./webhook-topics";

/**
 * The API's reference, generated from its spec (phase 15, D1): `docs/API.md` (`npm run api:doc`; a
 * test compares them) and the `/developers` page. The guide's sections are written here once; each
 * operation and schema comes from `lib/api-spec.ts`.
 */
const GUIDE: { title: string; body: string[] }[] = [
  {
    title: "Authentication",
    body: [
      "Make a personal access token in **Settings › Developers**. Send it on every request as `Authorization: Bearer <token>`.",
      "A token acts as the teammate who made it, within the scopes they chose. A scope is one of their role's capabilities, so a token never has more than its maker, and if their role loses a capability, so does the token.",
      "Tokens are shown once and kept only as hashes. Revoke one in Settings; it stops working at once.",
    ],
  },
  {
    title: "Versions",
    body: [
      `Name a version with the \`Relay-Version\` header (\`${LATEST_VERSION}\`). Without one, the token's own version is used (chosen when it was made). Every response says which version answered.`,
      `Supported: ${API_VERSIONS.map((v) => `\`${v}\``).join(", ")}.`,
      "**Deprecation policy:** a new version is announced in the changelog with what changed. The one before stays supported for at least 12 months after that, so at least two versions are supported once there's a second. A version is retired only after a warning on every token still using it.",
    ],
  },
  {
    title: "Errors",
    body: [
      "An error is `{\"type\":\"error\",\"request_id\":\"…\",\"errors\":[{\"code\":\"…\",\"message\":\"…\",\"field\":\"…\"}]}`. `code` is stable and meant for your code (`invalid_field`, `unauthorized`, `forbidden`, `not_found`, `rate_limited`, `invalid_version`…). `message` is for a person. `field` names what's wrong, when something is.",
      "An unexpected failure is `internal_error`, with no detail: quote its `request_id`.",
    ],
  },
  {
    title: "Pagination",
    body: [
      "Lists are `{\"type\":\"list\",\"data\":[…],\"pages\":{\"next\":\"…\"}}`. Pass `pages.next` as `starting_after` for the next page; it's `null` on the last. `per_page` is 1 to 100 (20 by default). There's no offset paging.",
    ],
  },
  {
    title: "Rate limits",
    body: [
      "Each token may make bursts of up to 100 requests, refilling at 10 a second (600 a minute). Each workspace may make up to 1,500 a minute across all its tokens.",
      "Every response carries `X-RateLimit-Limit` (a minute's allowance), `X-RateLimit-Remaining` and `X-RateLimit-Reset` (seconds until the burst is full again). Over the limit, you get `429` with `Retry-After` (seconds).",
      "Each token's calls and refusals over the last hour are on the Developers page.",
    ],
  },
  {
    title: "Searching",
    body: [
      "`POST /conversations/search` and `POST /contacts/search` take `{\"query\":…, \"sort\":{\"field\",\"order\"}, \"per_page\", \"starting_after\"}`. A query is a condition, `{\"field\":\"status\",\"operator\":\"=\",\"value\":\"open\"}`, or a group, `{\"operator\":\"AND\",\"value\":[…]}` (`AND` or `OR`), nested up to 3 groups deep with up to 20 conditions.",
      "Example: open conversations on email or SMS, waiting since before 9 this morning: `{\"query\":{\"operator\":\"AND\",\"value\":[{\"field\":\"status\",\"operator\":\"=\",\"value\":\"open\"},{\"field\":\"channel\",\"operator\":\"IN\",\"value\":[\"email\",\"sms\"]},{\"field\":\"waiting_since\",\"operator\":\"<\",\"value\":\"2026-10-20T09:00:00Z\"}]}}`.",
      "Each field's type decides its operators. " + (Object.entries(OPERATORS) as [string, readonly string[]][]).map(([t, ops]) => `**${t}:** ${ops.map((o) => `\`${o}\``).join(" ")}`).join("; ") + ".",
      "Operators: " + Object.entries(OPERATOR_MEANING).map(([o, m]) => `\`${o}\` ${m}`).join("; ") + ". Text comparisons ignore case; times need an offset.",
      "A refused query names the part at fault, as `query.value[1].operator`.",
    ],
  },
  {
    title: "Webhooks",
    body: [
      "Subscribe a public https address to topics (Settings › Developers › Webhooks, or `POST /webhooks`). Each event is POSTed as JSON: `{\"type\":\"webhook_event\",\"id\",\"topic\",\"created_at\",\"workspace_id\",\"data\":{\"item\":…}}`, where `item` is the resource as this API shows it (a conversation, ticket, contact, event or article), with `data.part`, `data.tag`, `data.changes` or `data.metric` when the topic has one. Internal notes are never sent.",
      "Headers: `Relay-Signature`, `Relay-Event-Id` (the same across retries and replays: dedupe on it), `Relay-Webhook-Id` (this delivery) and `Relay-Topic`. Events are sent in the order they happened, but a retry can arrive after a later event: order by `created_at` if it matters.",
      "**Delivery** is at least once. Answer with a 2xx within 10 seconds. Anything else is retried with exponential backoff (a minute, doubling, at most two hours apart) for 24 hours. A webhook that has failed for 24 hours without a success is turned off, and its creator is told (by email too, if it names an alert email). Its deliveries are kept 30 days and any one can be replayed.",
      "**Verifying:** `Relay-Signature` is `t=<unix seconds>,v1=<hex>`. The hex is HMAC-SHA256 of `<t>.<the raw body>` under your secret. While a secret is being rotated, a second `v1` signs under the previous one for 24 hours. Accept the delivery if any `v1` matches and `t` is within 5 minutes. The SDKs do this: `verifyWebhook(secret, rawBody, header)` in JavaScript, `verify_webhook(secret, raw_body, header)` in Python.",
      "```js\nimport { createHmac, timingSafeEqual } from \"node:crypto\";\nexport function verify(secret, rawBody, header, now = Date.now() / 1000) {\n  const items = header.split(\",\").map((p) => p.split(\"=\"));\n  const t = Number(items.find(([k]) => k === \"t\")?.[1]);\n  if (!t || Math.abs(now - t) > 300) return false;\n  const want = createHmac(\"sha256\", secret).update(`${t}.${rawBody}`).digest();\n  return items.some(([k, v]) => { if (k !== \"v1\") return false; const got = Buffer.from(v, \"hex\"); return got.length === want.length && timingSafeEqual(got, want); });\n}\n```",
      "```python\nimport hashlib, hmac, time\ndef verify(secret, raw_body, header, tolerance=300):\n    items = [p.split(\"=\", 1) for p in header.split(\",\")]\n    t = next((int(v) for k, v in items if k == \"t\"), 0)\n    if not t or abs(time.time() - t) > tolerance:\n        return False\n    want = hmac.new(secret.encode(), f\"{t}.\".encode() + raw_body, hashlib.sha256).hexdigest()\n    return any(hmac.compare_digest(v, want) for k, v in items if k == \"v1\")\n```",
    ],
  },
  {
    title: "Retries",
    body: [
      "Send `Idempotency-Key` (up to 200 letters, digits and `_.:-`) on a `POST` to make it safe to retry. The same key from the same token does the work once and returns the same result.",
    ],
  },
];

const typeName = (s: Schema): string => {
  if (s.$ref) return s.$ref.replace("#/components/schemas/", "");
  const t = Array.isArray(s.type) ? s.type.join(" or ") : (s.type ?? "any");
  if (s.type === "array" && s.items) return `array of ${typeName(s.items)}`;
  return s.enum ? `${t}: ${s.enum.map((e) => `\`${e}\``).join(", ")}` : s.format ? `${t} (${s.format})` : t;
};
const limits = (s: Schema) =>
  [
    s.minLength !== undefined && s.minLength > 1 ? `at least ${s.minLength} characters` : null,
    s.maxLength !== undefined ? `up to ${s.maxLength} characters` : null,
    s.minimum !== undefined && s.maximum !== undefined ? `${s.minimum} to ${s.maximum}` : null,
    s.default !== undefined ? `default ${String(s.default)}` : null,
  ]
    .filter(Boolean)
    .join("; ");
type Field = { name: string; type: string; required: boolean; about: string };
const fields = (schema: Schema, spec: Spec): Field[] => {
  const s = resolve(schema, spec);
  return Object.entries(s.properties ?? {}).map(([name, p]) => ({
    name,
    type: typeName(p),
    required: (s.required ?? []).includes(name),
    about: [p.description ?? (p.$ref ? resolve(p, spec).description : ""), limits(p)].filter(Boolean).join(" "),
  }));
};

/** The reference as Markdown: the guide, then each group's operations, then the objects. */
export function apiReferenceMarkdown(spec: Spec = SPEC) {
  const out: string[] = [
    "# Relay API reference",
    "",
    "Generated from `lib/api-spec.ts` by `npm run api:doc`; don't edit by hand. The machine-readable spec is at `/rest/openapi.json`, and this page at `/developers`.",
    "",
    spec.info.description,
    "",
    "Base URL: `https://api.<your domain>/rest` (locally, the API server's `/rest`).",
    "",
  ];
  for (const g of GUIDE) out.push(`## ${g.title}`, "", ...g.body.flatMap((b) => [b, ""]));
  const ops = operations(spec);
  for (const tag of [...new Set(ops.flatMap((o) => o.operation.tags))]) {
    out.push(`## ${tag}`, "");
    for (const { method, path, operation: o } of ops.filter((x) => x.operation.tags.includes(tag))) {
      out.push(`### ${o.summary}`, "", `\`${method} ${path}\``, "", o.description, "", `**Scope:** ${o["x-relay-scope"] ? `\`${o["x-relay-scope"]}\`` : "none (any token)"}.`, "");
      const params = (o.parameters ?? []).filter((p) => p.in !== "header");
      if (params.length) {
        out.push("| Parameter | In | Type | Required | About |", "|---|---|---|---|---|");
        for (const p of params) out.push(`| \`${p.name}\` | ${p.in} | ${typeName(p.schema)} | ${p.required ? "yes" : "no"} | ${[p.description, limits(p.schema)].filter(Boolean).join(" ")} |`);
        out.push("");
      }
      if (o.requestBody) {
        const f = fields(o.requestBody.content["application/json"].schema, spec);
        out.push("**Body:**", "", "| Field | Type | Required | About |", "|---|---|---|---|");
        for (const x of f) out.push(`| \`${x.name}\` | ${x.type} | ${x.required ? "yes" : "no"} | ${x.about} |`);
        out.push("");
      }
      const success = Object.entries(o.responses).find(([s]) => s.startsWith("2"))!;
      const schema = success[1].content?.["application/json"].schema;
      out.push(`**Returns:** \`${success[0]}\`${schema ? `, ${typeName(schema)}` : ""}.`, "");
    }
  }
  const searchable = (title: string, fields: Record<string, SearchField>, extra = "") => {
    out.push(`### ${title}`, "", "| Field | Type | Sortable | About |", "|---|---|---|---|");
    for (const [name, f] of Object.entries(fields)) out.push(`| \`${name}\` | ${f.type}${f.values ? `: ${f.values.map((v) => `\`${v}\``).join(", ")}` : ""} | ${f.sortable ? "yes" : "no"} | ${f.about} |`);
    if (extra) out.push("", extra);
    out.push("");
  };
  out.push("## Search fields", "");
  searchable("Conversations", CONVERSATION_FIELDS, "Sorted by `updated_at`, newest first, unless you choose.");
  searchable("Contacts", CONTACT_FIELDS, "Also `custom_attributes.<name>` (text, or a number when the value is one). Sorted by `last_seen_at`, newest first, unless you choose.");
  out.push("## Webhook topics", "", "| Topic | When | `data.item` |", "|---|---|---|");
  for (const t of TOPICS) out.push(`| \`${t.id}\` | ${t.about} | ${t.item} |`);
  out.push("", "Company topics and `contact.tagged` come with companies and tags on people (phase 01).", "");
  out.push("## Objects", "");
  for (const [name, s] of Object.entries(spec.components.schemas)) {
    out.push(`### ${name}`, "");
    if (s.description) out.push(s.description, "");
    const f = fields(s, spec);
    if (f.length) {
      out.push("| Field | Type | Always present | About |", "|---|---|---|---|");
      for (const x of f) out.push(`| \`${x.name}\` | ${x.type} | ${x.required ? "yes" : "no"} | ${x.about} |`);
      out.push("");
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Inline Markdown (code, bold) and tables, enough for the reference's own text. */
function html(md: string) {
  const lines = md.split("\n");
  const out: string[] = [];
  const inline = (s: string) => escape(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("```")) {
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) code.push(lines[i]);
      out.push(`<pre><code>${escape(code.join("\n"))}</code></pre>`);
      continue;
    }
    if (l.startsWith("|") && lines[i + 1]?.startsWith("|---")) {
      const head = l.split("|").slice(1, -1);
      out.push("<table><thead><tr>" + head.map((h) => `<th>${inline(h.trim())}</th>`).join("") + "</tr></thead><tbody>");
      i += 2;
      for (; i < lines.length && lines[i].startsWith("|"); i++) out.push("<tr>" + lines[i].split("|").slice(1, -1).map((c) => `<td>${inline(c.trim())}</td>`).join("") + "</tr>");
      out.push("</tbody></table>");
      i--;
    } else if (/^#{1,3} /.test(l)) {
      const level = l.indexOf(" ");
      const text = l.slice(level + 1);
      out.push(`<h${level} id="${text.toLowerCase().replace(/[^a-z0-9]+/g, "-")}">${inline(text)}</h${level}>`);
    } else if (l.trim()) out.push(`<p>${inline(l)}</p>`);
  }
  return out.join("\n");
}

/** The `/developers` page: the same reference, readable in a browser, light and dark. */
export function apiReferenceHtml(spec: Spec = SPEC) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Relay API reference</title><style>
:root{color-scheme:light dark;--bg:#fcfdfb;--fg:#183a31;--muted:#56695d;--line:#dfe8e2;--code:#eef4f0}
@media (prefers-color-scheme:dark){:root{--bg:#0f0f10;--fg:#ececee;--muted:#a9a9ae;--line:#2a2a2e;--code:#1c1c1f}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:920px;margin:0 auto;padding:32px 16px 80px}h1{font-size:30px;letter-spacing:-.5px}h2{margin-top:44px;padding-top:12px;border-top:1px solid var(--line)}
h3{margin-top:28px}code{padding:1px 5px;border-radius:5px;background:var(--code);font-size:.9em}
table{width:100%;border-collapse:collapse;margin:8px 0;font-size:14px;display:block;overflow-x:auto}th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{color:var(--muted);font-weight:600}p{margin:8px 0}pre{overflow-x:auto;padding:12px 14px;border-radius:8px;background:var(--code);font-size:13px;line-height:1.5}pre code{padding:0;background:none}
</style></head><body><main>${html(apiReferenceMarkdown(spec))}</main></body></html>`;
}

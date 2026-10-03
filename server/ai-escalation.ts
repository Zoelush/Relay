import { DomainError, type Sql } from "./db";
import { normalize } from "./help-search";
import type { Conversation } from "./conversations";

/**
 * What the AI agent must hand over without answering (phase 08, step A2b; docs/AI_STEP3.md).
 *
 * - **Escalation rules:** deterministic conditions on the customer and the conversation. When one
 *   matches a customer message, the agent hands over instead of answering. Checked in code, on
 *   every customer message, so a tag added mid-conversation applies from the next one.
 * - **Never-handle topics:** a name, a description and keywords. The keywords are checked in code
 *   (so they hold when the model is down); the model also judges the topic by meaning.
 * - **Escalation guidance:** natural-language instructions the classifier applies. They only decide
 *   whether to hand over; they can't change what the agent may do.
 *
 * TODO(phase 01): company and custom contact attribute conditions, once the people service stores
 * them. Conditions are a closed list, so adding a field means adding it here and to `facts`.
 */
export const MAX_RULES = 20;
export const MAX_TOPICS = 20;
export const MAX_GUIDANCE = 10;

export type Condition =
  | { field: "signed_in"; op: "is"; value: boolean }
  | { field: "email_domain"; op: "is" | "is_not"; value: string }
  | { field: "brand"; op: "is" | "is_not"; value: string }
  | { field: "language"; op: "is" | "is_not"; value: string }
  | { field: "page"; op: "contains" | "starts_with" | "equals"; value: string }
  | { field: "tag"; op: "has" | "has_not"; value: string }
  | {
      field: "attribute";
      key: string;
      op: "is" | "is_not" | "is_set";
      value: string;
    };
export type Rule = {
  id: string;
  name: string;
  enabled: boolean;
  match: "all" | "any";
  conditions: Condition[];
};
export type Topic = { name: string; description: string; keywords: string[] };

const invalid = (message: string): never => {
  throw new DomainError("INVALID_AI_SETTINGS", message, 400);
};
const text = (v: unknown, max: number, what: string, required = true) => {
  const s = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
  if ((required && !s) || s.length > max)
    invalid(`Give ${what} up to ${max} characters.`);
  return s;
};

/** Checks the rules against this workspace's brands, tags and attributes. */
export async function validRules(
  db: Sql,
  w: string,
  input: unknown,
): Promise<Rule[]> {
  if (!Array.isArray(input) || input.length > MAX_RULES)
    invalid(`Keep to ${MAX_RULES} escalation rules.`);
  const ids = async (sql: string) =>
    new Set((await db.query<{ id: string }>(sql, [w])).rows.map((r) => r.id));
  const brands = await ids("SELECT id FROM brands WHERE workspace_id=$1");
  const tags = await ids(
    "SELECT id FROM tags WHERE workspace_id=$1 AND archived_at IS NULL",
  );
  const attributes = await ids(
    "SELECT id FROM attribute_definitions WHERE workspace_id=$1 AND owner_type='conversation' AND archived_at IS NULL",
  );
  const seen = new Set<string>();
  return (input as Record<string, unknown>[]).map((r, i) => {
    const name = text(r?.name, 120, `rule ${i + 1} a name of`);
    const where = `“${name}”`;
    if (r.match !== "all" && r.match !== "any")
      invalid(`Choose whether ${where} needs all or any of its conditions.`);
    const list = Array.isArray(r.conditions) ? r.conditions : [];
    if (!list.length || list.length > 10)
      invalid(`Give ${where} one to ten conditions.`);
    const conditions = (list as Record<string, unknown>[]).map(
      (c): Condition => {
        const value = typeof c?.value === "string" ? c.value.trim() : c?.value;
        const need = (ok: boolean, why: string) => {
          if (!ok) invalid(`${where}: ${why}`);
        };
        switch (c?.field) {
          case "signed_in":
            need(typeof value === "boolean", "choose signed in or not.");
            return { field: "signed_in", op: "is", value: value as boolean };
          case "email_domain": {
            const domain = String(value ?? "")
              .toLowerCase()
              .replace(/^@/, "");
            need(
              /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) && domain.length <= 200,
              "give an email domain such as example.com.",
            );
            need(c.op === "is" || c.op === "is_not", "choose is or is not.");
            return {
              field: "email_domain",
              op: c.op as "is" | "is_not",
              value: domain,
            };
          }
          case "brand":
            need(brands.has(String(value)), "choose one of your brands.");
            need(c.op === "is" || c.op === "is_not", "choose is or is not.");
            return {
              field: "brand",
              op: c.op as "is" | "is_not",
              value: String(value),
            };
          case "language": {
            let tag = "";
            try {
              tag = Intl.getCanonicalLocales(String(value))[0] ?? "";
            } catch {
              tag = "";
            }
            need(!!tag, "choose a language such as fr or pt-BR.");
            need(c.op === "is" || c.op === "is_not", "choose is or is not.");
            return {
              field: "language",
              op: c.op as "is" | "is_not",
              value: tag,
            };
          }
          case "page":
            need(
              typeof value === "string" && !!value && value.length <= 300,
              "give the page address to match.",
            );
            need(
              ["contains", "starts_with", "equals"].includes(String(c.op)),
              "choose contains, starts with or is exactly.",
            );
            return {
              field: "page",
              op: c.op as "contains" | "starts_with" | "equals",
              value: value as string,
            };
          case "tag":
            need(tags.has(String(value)), "choose one of your tags.");
            need(c.op === "has" || c.op === "has_not", "choose has or hasn't.");
            return {
              field: "tag",
              op: c.op as "has" | "has_not",
              value: String(value),
            };
          case "attribute": {
            need(
              attributes.has(String(c.key)),
              "choose one of your conversation attributes.",
            );
            need(
              ["is", "is_not", "is_set"].includes(String(c.op)),
              "choose is, is not or is set.",
            );
            need(
              c.op === "is_set" ||
                (typeof value === "string" && !!value && value.length <= 200),
              "give the value to compare.",
            );
            return {
              field: "attribute",
              key: String(c.key),
              op: c.op as "is" | "is_not" | "is_set",
              value: c.op === "is_set" ? "" : (value as string),
            };
          }
          default:
            return invalid(
              `${where}: choose what to check (signed in, email domain, brand, language, page, tag or attribute). Company and contact attributes arrive with the people service.`,
            );
        }
      },
    );
    const id =
      typeof r.id === "string" && /^[a-z0-9-]{1,40}$/.test(r.id) && !seen.has(r.id)
        ? r.id
        : crypto.randomUUID();
    seen.add(id);
    return {
      id,
      name,
      enabled: r.enabled !== false,
      match: r.match as "all" | "any",
      conditions,
    };
  });
}

export function validTopics(input: unknown): Topic[] {
  if (!Array.isArray(input) || input.length > MAX_TOPICS)
    invalid(`Keep to ${MAX_TOPICS} never-handle topics.`);
  return (input as Record<string, unknown>[]).map((t, i) => {
    const name = text(t?.name, 80, `topic ${i + 1} a name of`);
    const keywords = (Array.isArray(t.keywords) ? t.keywords : [])
      .map((k) => (typeof k === "string" ? k.trim() : ""))
      .filter(Boolean);
    if (keywords.length > 20 || keywords.some((k) => k.length > 60))
      invalid(`“${name}” takes up to 20 keywords of up to 60 characters.`);
    return {
      name,
      description: text(t.description, 300, `“${name}” a description of`, false),
      keywords: [...new Set(keywords)],
    };
  });
}

export function validGuidance(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > MAX_GUIDANCE)
    invalid(`Keep to ${MAX_GUIDANCE} pieces of escalation guidance.`);
  return (input as unknown[]).map((g, i) =>
    text(g, 500, `guidance ${i + 1}`),
  );
}

/** What rules can test about a conversation, read once per customer message. */
export type Facts = {
  signedIn: boolean;
  emailDomains: string[];
  brand: string;
  language: string;
  page: string;
  tags: string[];
  attributes: Record<string, unknown>;
};
export async function facts(
  db: Sql,
  w: string,
  c: Conversation,
  context: { signedIn: boolean; language: string },
): Promise<Facts> {
  const emails = (
    await db.query<{ email: string }>(
      // Verified addresses only: a visitor typing someone else's email can't match a rule.
      `SELECT e.email FROM identity_contact_mappings m JOIN contact_emails e ON e.workspace_id=m.workspace_id AND e.contact_id=m.contact_id
       WHERE m.workspace_id=$1 AND m.identity_id=$2 AND e.verified`,
      [w, c.primary_identity_id],
    )
  ).rows;
  const page =
    (
      await db.query<{ page_url: string | null }>(
        "SELECT page_url FROM messenger_sessions WHERE workspace_id=$1 AND identity_id=$2 AND brand_id=$3 ORDER BY expires_at DESC LIMIT 1",
        [w, c.primary_identity_id, c.brand_id],
      )
    ).rows[0]?.page_url ?? "";
  const tags = (
    await db.query<{ tag_id: string }>(
      "SELECT tag_id FROM conversation_tags WHERE workspace_id=$1 AND conversation_id=$2",
      [w, c.id],
    )
  ).rows.map((r) => r.tag_id);
  return {
    signedIn: context.signedIn,
    emailDomains: emails.map((e) => e.email.split("@").pop()!.toLowerCase()),
    brand: c.brand_id,
    language: context.language,
    page,
    tags,
    attributes: (c.attributes as Record<string, unknown>) ?? {},
  };
}

const holds = (c: Condition, f: Facts): boolean => {
  switch (c.field) {
    case "signed_in":
      return f.signedIn === c.value;
    case "email_domain": {
      const has = f.emailDomains.includes(c.value);
      return c.op === "is" ? has : !has;
    }
    case "brand":
      return (f.brand === c.value) === (c.op === "is");
    case "language": {
      const lang = f.language.toLowerCase();
      const want = c.value.toLowerCase();
      // "fr" matches fr-CA; "pt-BR" matches only itself.
      const same = lang === want || lang.split("-")[0] === want;
      return c.op === "is" ? same : !same;
    }
    case "page": {
      if (!f.page) return false;
      return c.op === "contains"
        ? f.page.includes(c.value)
        : c.op === "starts_with"
          ? f.page.startsWith(c.value)
          : f.page === c.value;
    }
    case "tag": {
      const has = f.tags.includes(c.value);
      return c.op === "has" ? has : !has;
    }
    case "attribute": {
      const v = f.attributes[c.key];
      const set = v !== undefined && v !== null && v !== "";
      if (c.op === "is_set") return set;
      const same = set && String(v) === c.value;
      return c.op === "is" ? same : !same;
    }
  }
};
/** The first enabled rule that matches, in order. */
export const matchRule = (rules: Rule[], f: Facts) =>
  rules.find(
    (r) =>
      r.enabled &&
      (r.match === "all"
        ? r.conditions.every((c) => holds(c, f))
        : r.conditions.some((c) => holds(c, f))),
  ) ?? null;

/** The first topic one of whose keywords is in the message, as whole words (accents ignored). */
export function matchKeywords(topics: Topic[], message: string) {
  const text = " " + normalize(message).replace(/[^\p{L}\p{N}]+/gu, " ") + " ";
  return (
    topics.find((t) =>
      t.keywords.some((k) => {
        const word = normalize(k).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
        return !!word && text.includes(" " + word + " ");
      }),
    ) ?? null
  );
}

/** The agent's rules, in order. */
export async function rulesOf(db: Sql, w: string, agentId: string) {
  return (
    await db.query<{
      id: string;
      name: string;
      enabled: boolean;
      conditions: { match: "all" | "any"; conditions: Condition[] };
    }>(
      "SELECT id,name,enabled,conditions FROM ai_escalation_rules WHERE workspace_id=$1 AND agent_id=$2 ORDER BY position,id",
      [w, agentId],
    )
  ).rows.map(
    (r): Rule => ({
      id: r.id,
      name: r.name,
      enabled: r.enabled,
      match: r.conditions.match,
      conditions: r.conditions.conditions,
    }),
  );
}
/** Replaces the agent's rules with these (in the transaction that saves the settings). */
export async function saveRules(
  db: Sql,
  w: string,
  agentId: string,
  rules: Rule[],
) {
  await db.query(
    "DELETE FROM ai_escalation_rules WHERE workspace_id=$1 AND agent_id=$2",
    [w, agentId],
  );
  for (const [i, r] of rules.entries())
    await db.query(
      "INSERT INTO ai_escalation_rules(workspace_id,id,agent_id,name,conditions,enabled,position) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        w,
        r.id,
        agentId,
        r.name,
        JSON.stringify({ match: r.match, conditions: r.conditions }),
        r.enabled,
        i,
      ],
    );
}

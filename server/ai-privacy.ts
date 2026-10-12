import type { Connect, Sql } from "./db";
import { tenant } from "./db";
import type { Turn } from "./ai-model";
import { isDate } from "./ai-guard";

/**
 * Zoe's privacy (phase 08, step B2b; docs/AI_STEP9.md).
 *
 * - Redaction (a workspace setting, off by default): before anything is sent to a model provider,
 *   email addresses, card numbers, IBANs, IP addresses, phone numbers and the customer's own name
 *   are replaced by placeholders ("[email 1]"). The same value always gets the same placeholder
 *   within one answer, and her reply puts the customer's own values back.
 * - The record of model calls: exactly what was sent for each customer message (redacted when the
 *   setting is on), kept 90 days for audit.
 * - Memory (a workspace setting, off by default): a signed-in customer's last three other
 *   conversations from the past 90 days, public messages only, given to her as data.
 */
export type RedactionKind = "email" | "card" | "iban" | "ip" | "phone" | "name";
export type Redactor = {
  /** The text with personal data replaced (unchanged when redaction is off). */
  redact(text: string): string;
  /** Placeholders in a reply back to the customer's own values. */
  restore(text: string): string;
  counts(): Partial<Record<RedactionKind, number>>;
  on: boolean;
};

const luhn = (digits: string) => {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
};

/** One answer's redactor; `names` are the customer's own name(s), redacted as "[name]". */
export function redactor(on: boolean, names: string[] = []): Redactor {
  const byValue = new Map<string, string>();
  const byPlaceholder = new Map<string, string>();
  const seen: Partial<Record<RedactionKind, number>> = {};
  const place = (kind: RedactionKind, value: string, key = value) => {
    const k = kind + ":" + key;
    let p = byValue.get(k);
    if (!p) {
      seen[kind] = (seen[kind] ?? 0) + 1;
      p = kind === "name" ? (seen.name === 1 ? "[name]" : `[name ${seen.name}]`) : `[${kind} ${seen[kind]}]`;
      byValue.set(k, p);
      byPlaceholder.set(p, value);
    }
    return p;
  };
  const wanted = names
    .map((n) => n.trim())
    .filter((n) => n.length >= 2)
    .sort((a, b) => b.length - a.length);
  return {
    on,
    redact(text) {
      if (!on || !text) return text;
      let out = text.replace(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu, (m) =>
        place("email", m, m.toLowerCase()),
      );
      out = out.replace(/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g, (m) =>
        place("iban", m, m.replace(/ /g, "")),
      );
      out = out.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (m) => place("ip", m));
      out = out.replace(/(?<![\w[])\+?\d[\d ().-]{6,22}\d(?![\w\]])/g, (m) => {
        if (isDate(m)) return m;
        const digits = m.replace(/\D/g, "");
        if (digits.length >= 13 && digits.length <= 19 && luhn(digits))
          return place("card", m, digits);
        if (digits.length >= 8 && digits.length <= 15) return place("phone", m, digits);
        return m;
      });
      for (const n of wanted) {
        const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        out = out.replace(new RegExp(`(?<![\\p{L}])${escaped}(?![\\p{L}])`, "giu"), (m) =>
          place("name", m, n.toLowerCase()),
        );
      }
      return out;
    },
    restore(text) {
      if (!on || !text) return text;
      return text.replace(/\[(?:email|card|iban|ip|phone|name)(?: \d+)?\]/g, (p) => byPlaceholder.get(p) ?? p);
    },
    counts: () => ({ ...seen }),
  };
}

/** What was sent to a model for one customer message (B2b). */
export type ModelCall = {
  kind: "answer" | "classify";
  model: string;
  sent: string;
  redacted: boolean;
  redactions: Partial<Record<RedactionKind, number>>;
};

/** Records the calls made for one customer message. */
export async function recordModelCalls(
  db: Sql,
  w: string,
  conversationId: string,
  questionPartId: string,
  calls: ModelCall[],
) {
  for (const c of calls)
    await db.query(
      `INSERT INTO ai_model_calls(workspace_id,id,conversation_id,question_part_id,kind,model,sent,redacted,redactions)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [w, crypto.randomUUID(), conversationId, questionPartId, c.kind, c.model, c.sent, c.redacted, JSON.stringify(c.redactions)],
    );
}

/** The record of model calls is kept 90 days (a daily sweep removes up to 1,000 older ones). */
export async function purgeModelCalls(connect: Connect, w: string, now = Date.now()) {
  return tenant(connect, w, async (db) =>
    (
      await db.query(
        `DELETE FROM ai_model_calls WHERE workspace_id=$1 AND id IN (
           SELECT id FROM ai_model_calls WHERE workspace_id=$1 AND created_at < $2 ORDER BY created_at LIMIT 1000)
         RETURNING id`,
        [w, new Date(now - 90 * 86_400_000).toISOString()],
      )
    ).rows.length,
  );
}

/** A remembered conversation: its id, and its public messages, oldest first. */
export type Remembered = { conversationId: string; turns: Turn[] };

/**
 * Memory (B2b): a signed-in customer's last three other conversations from the past 90 days, up
 * to six public messages each (never internal notes or events).
 */
export async function memoryFor(
  db: Sql,
  w: string,
  identityId: string,
  conversationId: string,
): Promise<Remembered[]> {
  const earlier = (
    await db.query<{ id: string }>(
      `SELECT id FROM conversations WHERE workspace_id=$1 AND primary_identity_id=$2 AND id<>$3
         AND merged_into_id IS NULL AND created_at > now() - interval '90 days'
       ORDER BY created_at DESC LIMIT 3`,
      [w, identityId, conversationId],
    )
  ).rows;
  const out: Remembered[] = [];
  for (const c of earlier) {
    const turns = (
      await db.query<{ kind: string; body: string }>(
        `SELECT kind,body FROM (
           SELECT kind,body,seq FROM conversation_parts
           WHERE workspace_id=$1 AND conversation_id=$2 AND audience='public'
             AND kind IN ('customer_message','teammate_reply','ai_reply')
             AND NOT COALESCE((data->>'deleted')::boolean,false)
           ORDER BY seq DESC LIMIT 6) t ORDER BY seq`,
        [w, c.id],
      )
    ).rows
      .filter((p) => p.body.trim())
      .map((p): Turn => ({ from: p.kind === "customer_message" ? "customer" : "agent", text: p.body }));
    if (turns.length) out.push({ conversationId: c.id, turns });
  }
  return out.reverse();
}

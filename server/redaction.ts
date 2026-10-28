import { assert, DomainError, type Sql } from "./db";
import { authorize } from "./policy";
import { securityOn } from "./two-factor";
import { BUILT_INS, checkPattern, redactor, type BuiltIn, type Rule } from "../lib/redaction";

/**
 * Content redaction and model-provider controls (phase 16, step C6b; docs/SECURITY_STEP10.md):
 * Settings › Security › Data protection (`security.manage`, behind `security_v1`).
 *
 * - **Rules:** built-in detectors (off until turned on) and custom patterns (checked by
 *   `checkPattern` when saved). `workspaceRedactor` is what every place that stores conversation
 *   text uses (`append`, email in, drafts, raw inbound payloads once read); everything derived
 *   from those follows. Rules apply from when they're turned on: stored messages are append-only.
 * - **What reaches the model:** Zoe's switches (redact personal data, memory) and how many earlier
 *   messages she sends (0, 5 or 10).
 */
export async function rulesOf(db: Sql, w: string): Promise<Rule[]> {
  return (
    await db.query<{ kind: "builtin" | "custom"; builtin: BuiltIn | null; pattern: string | null }>(
      "SELECT kind,builtin,pattern FROM redaction_rules WHERE workspace_id=$1 AND enabled ORDER BY created_at",
      [w],
    )
  ).rows.map((r) => (r.kind === "builtin" ? { kind: "builtin", builtin: r.builtin! } : { kind: "custom", pattern: r.pattern! }));
}
/** The workspace's redactor (one per transaction is plenty: rules change rarely). */
export const workspaceRedactor = async (db: Sql, w: string) => redactor(await rulesOf(db, w));

type Inbound = "sms_inbound" | "whatsapp_inbound" | "meta_inbound" | "community_inbound" | "voice_inbound";
/** A raw inbound payload, once read: every string in it redacted, so the original isn't kept. */
export async function scrubPayload(db: Sql, w: string, table: Inbound, id: string) {
  const r = await workspaceRedactor(db, w);
  if (!r.on) return;
  const row = (await db.query<{ payload: unknown }>(`SELECT payload FROM ${table} WHERE workspace_id=$1 AND id=$2`, [w, id])).rows[0];
  if (row) await db.query(`UPDATE ${table} SET payload=$3 WHERE workspace_id=$1 AND id=$2`, [w, id, JSON.stringify(r.json(row.payload))]);
}

export async function readDataProtection(db: Sql, w: string, principal: string) {
  await authorize(db, w, principal, "security.manage");
  await securityOn(db, w);
  const rows = (
    await db.query<{ id: string; kind: string; builtin: BuiltIn | null; name: string; pattern: string | null; enabled: boolean; created_at: Date }>(
      "SELECT id,kind,builtin,name,pattern,enabled,created_at FROM redaction_rules WHERE workspace_id=$1 ORDER BY created_at",
      [w],
    )
  ).rows;
  // Loaded when used: Zoe's module imports the conversations module, which imports this one.
  const { agentRow } = await import("./ai-agent");
  const agent = await agentRow(db, w);
  const model = (await db.query<{ history_messages: number }>("SELECT history_messages FROM ai_agents WHERE workspace_id=$1 AND id=$2", [w, agent.id])).rows[0];
  return {
    builtIns: BUILT_INS.map((b) => ({ ...b, enabled: rows.some((r) => r.builtin === b.id && r.enabled) })),
    custom: rows.filter((r) => r.kind === "custom").map((r) => ({ id: r.id, name: r.name, pattern: r.pattern!, enabled: r.enabled })),
    model: { redactPersonalData: agent.redact_personal_data, memory: agent.memory, historyMessages: model?.history_messages ?? 10 },
  };
}

export async function changeDataProtection(db: Sql, w: string, principal: string, p: Record<string, unknown>) {
  const me = await authorize(db, w, principal, "security.manage");
  await securityOn(db, w);
  const done = () => readDataProtection(db, w, principal);
  if (p.action === "try") {
    // A preview: what the pattern (or a built-in) would make of a sample; nothing is saved.
    const sample = typeof p.sample === "string" ? p.sample.slice(0, 2000) : "";
    if (typeof p.builtin === "string") {
      assert(BUILT_INS.some((b) => b.id === p.builtin), "INVALID_FIELD", "Choose a built-in rule.");
      return { result: redactor([{ kind: "builtin", builtin: p.builtin as BuiltIn }]).text(sample) };
    }
    const problem = checkPattern(p.pattern);
    if (problem) throw new DomainError("INVALID_FIELD", problem, 400, { field: "pattern" });
    return { result: redactor([{ kind: "custom", pattern: String(p.pattern) }]).text(sample) };
  }
  if (p.action === "builtin") {
    const b = BUILT_INS.find((x) => x.id === p.builtin);
    assert(b, "INVALID_FIELD", "Choose a built-in rule.");
    await db.query(
      `INSERT INTO redaction_rules(workspace_id,id,kind,builtin,name,enabled,created_by) VALUES($1,$2,'builtin',$3,$4,$5,$6)
       ON CONFLICT(workspace_id,builtin) WHERE builtin IS NOT NULL DO UPDATE SET enabled=EXCLUDED.enabled`,
      [w, crypto.randomUUID(), b!.id, b!.label, p.on === true, me.id],
    );
    return done();
  }
  if (p.action === "custom-add") {
    const name = typeof p.name === "string" ? p.name.trim().slice(0, 80) : "";
    assert(name, "INVALID_FIELD", "Give the pattern a name.");
    const problem = checkPattern(p.pattern);
    if (problem) throw new DomainError("INVALID_FIELD", problem, 400, { field: "pattern" });
    const count = Number((await db.query<{ n: string }>("SELECT count(*) AS n FROM redaction_rules WHERE workspace_id=$1 AND kind='custom'", [w])).rows[0].n);
    assert(count < 25, "INVALID_FIELD", "Up to 25 custom patterns.");
    await db.query("INSERT INTO redaction_rules(workspace_id,id,kind,name,pattern,created_by) VALUES($1,$2,'custom',$3,$4,$5)", [w, crypto.randomUUID(), name, String(p.pattern), me.id]);
    return done();
  }
  if (p.action === "custom-toggle" || p.action === "custom-remove") {
    const r =
      p.action === "custom-remove"
        ? await db.query("DELETE FROM redaction_rules WHERE workspace_id=$1 AND id=$2 AND kind='custom' RETURNING id", [w, String(p.id ?? "")])
        : await db.query("UPDATE redaction_rules SET enabled=$3 WHERE workspace_id=$1 AND id=$2 AND kind='custom' RETURNING id", [w, String(p.id ?? ""), p.on === true]);
    assert(r.rows.length, "NOT_FOUND", "That pattern isn't there.", 404);
    return done();
  }
  if (p.action === "model") {
    const history = Number(p.historyMessages);
    assert([0, 5, 10].includes(history), "INVALID_FIELD", "Send none, 5 or 10 earlier messages.");
    const { agentRow } = await import("./ai-agent");
    const agent = await agentRow(db, w);
    await db.query("UPDATE ai_agents SET redact_personal_data=$3,memory=$4,history_messages=$5,version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2", [
      w,
      agent.id,
      p.redactPersonalData === true,
      p.memory === true,
      history,
    ]);
    return done();
  }
  throw new DomainError("INVALID_DATA_PROTECTION", "Choose try, builtin, custom-add, custom-toggle, custom-remove or model.");
}

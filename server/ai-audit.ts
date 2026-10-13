import { assert, type Sql } from "./db";
import { authorize, can } from "./policy";

/**
 * One conversation's audit of Zoe's actions (phase 09, step D4; docs/ACTIONS_STEP4.md): every
 * procedure that ran, every connector call (from the append-only `ai_connector_calls`) and every
 * approval, in time order, for teammates who can read the conversation. What was sent and returned
 * is shown only to those who may see customers' personal data; sensitive inputs were redacted when
 * they were recorded, so they never appear here.
 */
export type AuditEntry =
  | {
      kind: "procedure";
      at: string;
      procedure: string;
      version: number;
      status: string;
      reason: string;
      endedAt: string | null;
    }
  | {
      kind: "call";
      at: string;
      connector: string;
      version: number | null;
      access: string;
      by: string;
      method: string;
      url: string | null;
      inputs: Record<string, unknown> | null;
      outputs: Record<string, unknown> | null;
      status: number | null;
      attempts: number;
      durationMs: number;
      result: string;
      error: string;
      approvalId: string | null;
      idempotencyKey: string | null;
    }
  | {
      kind: "approval";
      at: string;
      id: string;
      connector: string;
      status: string;
      decidedBy: string | null;
      decidedAt: string | null;
      note: string;
    };

const iso = (v: string | null) => (v ? new Date(v).toISOString() : null);

export async function readAiAudit(db: Sql, w: string, principal: string, conversationId: string) {
  await authorize(db, w, principal, "conversations.read");
  assert(
    (await db.query("SELECT 1 FROM conversations WHERE workspace_id=$1 AND id=$2", [w, conversationId])).rows.length,
    "CONVERSATION_NOT_FOUND",
    "Conversation unavailable.",
    404,
  );
  const details = await can(db, w, principal, "contacts.personal_data");
  const runs = (
    await db.query<{ started_at: string; name: string; procedure_version: number; status: string; reason: string; ended_at: string | null }>(
      `SELECT r.started_at,p.name,r.procedure_version,r.status,r.reason,r.ended_at FROM ai_procedure_runs r
       JOIN ai_procedures p ON p.workspace_id=r.workspace_id AND p.id=r.procedure_id
       WHERE r.workspace_id=$1 AND r.conversation_id=$2`,
      [w, conversationId],
    )
  ).rows.map(
    (r): AuditEntry => ({
      kind: "procedure",
      at: iso(r.started_at)!,
      procedure: r.name,
      version: r.procedure_version,
      status: r.status,
      reason: r.reason,
      endedAt: iso(r.ended_at),
    }),
  );
  const calls = (
    await db.query<{
      created_at: string;
      name: string;
      version: number | null;
      access: string;
      source: string;
      teammate: string | null;
      method: string;
      url: string;
      inputs: Record<string, unknown>;
      outputs: Record<string, unknown>;
      status: number | null;
      attempts: number;
      duration_ms: number;
      result: string;
      error: string;
      approval_id: string | null;
      idempotency_key: string | null;
    }>(
      `SELECT k.created_at,c.name,k.version,c.access,k.source,t.name AS teammate,k.method,k.url,k.inputs,k.outputs,k.status,k.attempts,k.duration_ms,
         k.result,k.error,k.approval_id,k.idempotency_key
       FROM ai_connector_calls k JOIN ai_connectors c ON c.workspace_id=k.workspace_id AND c.id=k.connector_id
       LEFT JOIN teammates t ON t.workspace_id=k.workspace_id AND t.id=k.invoked_by
       WHERE k.workspace_id=$1 AND k.conversation_id=$2`,
      [w, conversationId],
    )
  ).rows.map(
    (k): AuditEntry => ({
      kind: "call",
      at: iso(k.created_at)!,
      connector: k.name,
      version: k.version,
      access: k.access,
      by: k.source === "agent" ? "Zoe" : k.source === "workflow" ? "A workflow" : (k.teammate ?? "A teammate"),
      method: k.method,
      url: details ? k.url : null,
      inputs: details ? k.inputs : null,
      outputs: details ? k.outputs : null,
      status: k.status,
      attempts: k.attempts,
      durationMs: k.duration_ms,
      result: k.result,
      error: k.error,
      approvalId: k.approval_id,
      idempotencyKey: k.idempotency_key,
    }),
  );
  const approvals = (
    await db.query<{ id: string; requested_at: string; name: string | null; status: string; decided: string | null; decided_at: string | null; note: string }>(
      `SELECT a.id,a.requested_at,c.name,a.status,t.name AS decided,a.decided_at,a.note FROM ai_action_approvals a
       LEFT JOIN ai_connectors c ON c.workspace_id=a.workspace_id AND c.id=a.connector_id
       LEFT JOIN teammates t ON t.workspace_id=a.workspace_id AND t.id=a.decided_by
       WHERE a.workspace_id=$1 AND a.conversation_id=$2`,
      [w, conversationId],
    )
  ).rows.map(
    (a): AuditEntry => ({
      kind: "approval",
      at: iso(a.requested_at)!,
      id: a.id,
      connector: a.name ?? "A removed connector",
      status: a.status,
      decidedBy: a.decided,
      decidedAt: iso(a.decided_at),
      note: a.note,
    }),
  );
  const order = { procedure: 0, approval: 1, call: 2 };
  const entries = [...runs, ...calls, ...approvals].sort((a, b) => a.at.localeCompare(b.at) || order[a.kind] - order[b.kind]);
  return { conversationId, details, entries };
}

/** The audit as plain text, to read, copy or keep (the acceptance demonstration). */
export function auditText(audit: Awaited<ReturnType<typeof readAiAudit>>) {
  const time = (s: string) => s.replace("T", " ").slice(0, 19) + " UTC";
  const lines = [`Zoe's actions in conversation ${audit.conversationId}`, ""];
  for (const e of audit.entries) {
    if (e.kind === "procedure")
      lines.push(
        `${time(e.at)}  Procedure “${e.procedure}” (version ${e.version}) started; ${e.status === "waiting" ? "still running" : e.status}${e.endedAt ? ` at ${time(e.endedAt)}` : ""}.`,
        `    ${e.reason}`,
      );
    else if (e.kind === "approval")
      lines.push(
        `${time(e.at)}  Approval asked to run ${e.connector}: ${e.status}${e.decidedBy ? ` by ${e.decidedBy}` : ""}${e.decidedAt ? ` at ${time(e.decidedAt)}` : ""}${e.note ? ` (“${e.note}”)` : ""}.`,
      );
    else {
      lines.push(
        `${time(e.at)}  ${e.by} called ${e.connector}${e.version ? ` (version ${e.version})` : " (draft)"}${e.access === "write" ? ", a write" : ""}: ${e.result}${e.status !== null ? ` (${e.status})` : ""} in ${e.durationMs} ms${e.attempts > 1 ? ` over ${e.attempts} attempts` : ""}.${e.error ? ` ${e.error}` : ""}`,
      );
      if (e.url) lines.push(`    ${e.method} ${e.url}`);
      if (e.inputs) lines.push(`    Sent: ${JSON.stringify(e.inputs)}`);
      if (e.outputs && e.result === "ok") lines.push(`    Got: ${JSON.stringify(e.outputs)}`);
      if (e.approvalId) lines.push(`    Under approval ${e.approvalId}${e.idempotencyKey ? `, idempotency key ${e.idempotencyKey}` : ""}.`);
    }
  }
  if (!audit.entries.length) lines.push("Nothing: Zoe ran no procedures or connectors here.");
  if (!audit.details) lines.push("", "What was sent and returned is hidden: it needs permission to see customers' personal data.");
  return lines.join("\n");
}

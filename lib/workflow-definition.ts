/**
 * A workflow's definition (phase 11, step W1; docs/WORKFLOWS_STEP1.md), shared by the engine
 * (`server/workflow-engine.ts`), its API (`server/workflows.ts`) and the builder (W2,
 * `agent/workflow-builder.tsx`), which checks drafts with the same `validate` and `problems`.
 *
 * A workflow is one trigger and a directed graph of lettered *paths*, stored as data. Each path is
 * a list of steps, then a way on: end, go to another path, branch on conditions (first match
 * wins, else a fallback), or wait until a condition holds (or time out). The first path is where
 * a run starts. `validate` checks the shape on every save; `problems` lists what blocks publishing
 * (unreachable paths, missing branches, paths that don't end, conditions that can't be evaluated).
 */

/* ------------------------------------------------------------------------------------------ */
/* Triggers                                                                                    */

export type Source = "customer" | "teammate" | "zoe" | "workflow" | "system" | "manual";
export const TRIGGERS = {
  conversation_started: {
    label: "A customer starts a conversation",
    customer: true,
    firedBy: "The customer, when a new conversation opens in the messenger.",
  },
  first_message: {
    label: "A customer sends their first message",
    customer: true,
    firedBy: "The customer's first message in a conversation.",
  },
  customer_message: {
    label: "A customer sends any message",
    customer: true,
    firedBy: "Every customer message, the first included.",
  },
  teammate_reply: {
    label: "A teammate replies",
    customer: false,
    firedBy: "A teammate's reply to the customer. Zoe's replies don't fire it.",
  },
  note_added: {
    label: "A teammate adds a note",
    customer: false,
    firedBy: "A teammate's internal note. A workflow's notes and Zoe's handover summaries fire it too.",
  },
  assigned: {
    label: "A conversation is assigned",
    customer: false,
    firedBy: "Any change of teammate or team: by a teammate, bulk action, routing, Zoe's handover or a workflow.",
  },
  tagged: {
    label: "A conversation is tagged",
    customer: false,
    firedBy: "A tag added by a teammate, bulk action or workflow. Choose a tag to fire only for it.",
  },
  closed: {
    label: "A conversation is closed",
    customer: false,
    firedBy: "Closing by a teammate, bulk action or workflow.",
  },
  reopened: {
    label: "A conversation is reopened",
    customer: false,
    firedBy: "Reopening by a teammate or workflow, or the customer replying to a closed conversation.",
  },
  snoozed: {
    label: "A conversation is snoozed",
    customer: false,
    firedBy: "Snoozing by a teammate, bulk action or workflow.",
  },
  attribute_changed: {
    label: "A conversation attribute changes",
    customer: false,
    firedBy: "A change by a teammate or workflow. Choose an attribute to fire only for it.",
  },
  contact_attribute_changed: {
    label: "A customer attribute changes",
    customer: false,
    firedBy: "A workflow setting it. Changes through the people API arrive with phase 01's people service.",
  },
  ticket_created: {
    label: "A ticket is created",
    customer: false,
    firedBy: "A conversation converted to a ticket, by a teammate or workflow.",
  },
  ticket_state_changed: {
    label: "A ticket changes state",
    customer: false,
    firedBy: "A ticket's state set by a teammate or workflow.",
  },
  sla_breached: {
    label: "An SLA is breached",
    customer: false,
    firedBy: "Relay, when a target passes unmet.",
  },
  manual: {
    label: "Run by a teammate from the inbox",
    customer: false,
    firedBy: "A teammate choosing it on a conversation.",
  },
} as const;
export type Trigger = keyof typeof TRIGGERS;
/**
 * Triggers phase 11 asks for that need later phases; a workflow can't use them yet.
 * TODO(phase 11 W4): schedule, webhook, page visit, unresponsive customer, before an SLA breach.
 * TODO(phase 12): inbound email. TODO(phase 13): segment entry or exit. TODO(phase 14): event received.
 */
export const LATER_TRIGGERS: Record<string, string> = {
  schedule: "W4",
  webhook: "W4",
  page_visit: "W4",
  unresponsive: "W4",
  sla_before_breach: "W4",
  email_received: "phase 12",
  segment_changed: "phase 13",
  event_received: "phase 14",
};

/* ------------------------------------------------------------------------------------------ */
/* Conditions                                                                                  */

export type Op = "is" | "is_not" | "is_set" | "is_not_set" | "contains" | "not_contains" | "has" | "has_not";
export type Condition = { field: Field; op: Op; value?: string | boolean; key?: string };
export type Group = { match: "all" | "any"; items: (Condition | Group)[] };
/** What a condition can test, and how. `key` names the attribute, team, and so on. */
export const FIELDS = {
  "conversation.status": { label: "Conversation state", ops: ["is", "is_not"], values: ["open", "snoozed", "closed"] },
  "conversation.priority": { label: "Priority", ops: ["is"], values: [true, false] },
  "conversation.assignee": { label: "Assigned teammate", ops: ["is", "is_not", "is_set", "is_not_set"] },
  "conversation.team": { label: "Team", ops: ["is", "is_not", "is_set", "is_not_set"] },
  "conversation.tag": { label: "Tag", ops: ["has", "has_not"] },
  "conversation.brand": { label: "Brand", ops: ["is", "is_not"] },
  "conversation.channel": { label: "Channel", ops: ["is", "is_not"] },
  "conversation.language": { label: "Language", ops: ["is", "is_not"] },
  "conversation.attribute": { label: "Conversation attribute", ops: ["is", "is_not", "is_set", "is_not_set", "contains"], key: true },
  "conversation.ai_state": { label: "Zoe's state", ops: ["is", "is_not", "is_set", "is_not_set"], values: ["pending", "escalated", "needs_input", "resolved"] },
  "conversation.sla": { label: "SLA", ops: ["is", "is_not"], values: ["breached", "overdue"] },
  "message.text": { label: "The message", ops: ["contains", "not_contains"] },
  "contact.signed_in": { label: "Customer is signed in", ops: ["is"], values: [true, false] },
  "contact.role": { label: "Customer type", ops: ["is", "is_not"], values: ["visitor", "lead", "user"] },
  "contact.email_domain": { label: "Customer's email domain", ops: ["is", "is_not"] },
  "contact.attribute": { label: "Customer attribute", ops: ["is", "is_not", "is_set", "is_not_set", "contains"], key: true },
  office_hours: { label: "Office hours", ops: ["is"], values: ["open", "closed"] },
  "team.available": { label: "Team has someone available", ops: ["is"], values: [true, false], key: true },
  "change.by": { label: "The change was made by", ops: ["is", "is_not"], values: ["customer", "teammate", "zoe", "workflow", "system", "manual"] },
  "wait.timed_out": { label: "The last wait timed out", ops: ["is"], values: [true, false] },
} as const;
export type Field = keyof typeof FIELDS;
/** What conditions can't test yet, and the phase that brings it: refused at publish, never "no match". */
export const LATER_FIELDS: Record<string, string> = {
  "company.attribute": "phase 01 (companies)",
  "object.attribute": "phase 01 (custom objects)",
  topic: "phase 14 (topics)",
  "event.history": "phase 14 (events)",
  segment: "phase 13 (segments)",
};
export const MAX_DEPTH = 3;
export const MAX_CONDITIONS = 25;

/* ------------------------------------------------------------------------------------------ */
/* Steps and paths                                                                             */

export const ACTIONS = {
  tag_add: { label: "Add a tag", needs: ["tagId"] },
  tag_remove: { label: "Remove a tag", needs: ["tagId"] },
  assign: { label: "Assign", needs: [] },
  priority: { label: "Set priority", needs: ["value"] },
  snooze: { label: "Snooze", needs: ["seconds"] },
  close: { label: "Close", needs: [] },
  reopen: { label: "Reopen", needs: [] },
  sla_apply: { label: "Apply an SLA", needs: ["policyId"] },
  sla_clear: { label: "Clear the applied SLA", needs: [] },
  attribute_set: { label: "Set a conversation attribute", needs: ["attributeId"] },
  contact_attribute_set: { label: "Set a customer attribute", needs: ["key"] },
  note: { label: "Add an internal note", needs: ["text"] },
  ticket_create: { label: "Create a ticket", needs: ["typeId"] },
  ai_handover: { label: "Hand to Zoe", needs: [] },
  human_handover: { label: "Hand to the team", needs: [] },
  wait: { label: "Wait", needs: ["seconds"] },
  wait_office_hours: { label: "Wait until office hours", needs: [] },
  // W3: customer-facing steps. They reach the customer in the conversation's own channel
  // (the messenger) as Automation, never as a teammate's reply.
  message: { label: "Send a message", needs: ["text"] },
  reply_time: { label: "Show the expected reply time", needs: [] },
  collect: { label: "Collect a reply", needs: ["text", "into"] },
} as const;
/**
 * TODO(phase 13): start an outbound series. TODO(phase 15): notify a Slack channel, send a
 * webhook. TODO(phase 12): send an email. TODO(phase 01): reply buttons from custom objects.
 */
export type ActionType = keyof typeof ACTIONS;
/** Steps that talk to the customer: handing to Zoe counts, since she then answers them. */
export const CUSTOMER_STEPS: ReadonlySet<ActionType> = new Set(["message", "reply_time", "collect", "ai_handover"]);
/** Where a collected reply is kept. */
export const COLLECT_INTO = {
  email: "The customer's email address",
  contact: "A customer attribute",
  conversation: "A conversation attribute",
} as const;
export const COLLECT_FORMATS = { text: "Any text", email: "An email address", number: "A number" } as const;
/** A connector input's value: fixed, or read from the customer or the conversation. */
export type ValueSource = { from: "value"; value: string } | { from: "contact"; key: string } | { from: "conversation"; attributeId: string };
export type Step = { id: string; type: ActionType; options: Record<string, unknown> };
export type Next =
  | { type: "end" }
  | { type: "goto"; path: string }
  | { type: "branch"; branches: { label: string; when: Group; path: string }[]; else: string }
  | { type: "wait_until"; when: Group; timeoutSeconds: number; met: string; timedOut: string }
  /** W3: a question with reply buttons, each its own path; typing instead, or no answer, too. */
  | { type: "buttons"; text: string; buttons: { label: string; path: string }[]; other: string; timeoutSeconds: number; timedOut: string }
  /** W3: Zoe answers; on to a path by her outcome. */
  | { type: "zoe"; resolved: string; handedOver: string; timeoutSeconds: number; timedOut: string }
  /** W3: a published read connector, its outputs kept in conversation attributes; on by result. */
  | { type: "connector"; connectorId: string; inputs: Record<string, ValueSource>; save: Record<string, string>; ok: string; failed: string };
export const MAX_BUTTONS = 8;
export type Path = { id: string; label: string; steps: Step[]; next: Next };
export type Definition = {
  trigger: { type: Trigger; options: { tagId?: string; attributeId?: string; key?: string } };
  /** Who it runs for: checked when it triggers (empty: everyone). */
  when: Group;
  paths: Path[];
};
export const MAX_PATHS = 40;
export const MAX_STEPS = 20;
/** At most this many steps run in one run (loop protection inside a workflow). */
export const MAX_NODES = 100;

export const blankDefinition = (trigger: Trigger = "first_message"): Definition => ({
  trigger: { type: trigger, options: {} },
  when: { match: "all", items: [] },
  paths: [{ id: "A", label: "Start", steps: [], next: { type: "end" } }],
});

/**
 * Whether it talks to the customer: then only the top-priority match runs for a trigger, none
 * starts while another is waiting for the customer's answer, and Zoe waits for it.
 */
export function customerFacing(def: Definition) {
  return def.paths.some((p) => p.next.type === "buttons" || p.next.type === "zoe" || p.steps.some((s) => CUSTOMER_STEPS.has(s.type)));
}

/* ------------------------------------------------------------------------------------------ */
/* Checking                                                                                    */

export class DefinitionError extends Error {}
const fail = (m: string): never => {
  throw new DefinitionError(m);
};
const isGroup = (x: unknown): x is Group => !!x && typeof x === "object" && "items" in (x as object);
const LETTERS = /^[A-Z]{1,2}$/;

function checkGroup(g: unknown, depth: number, count: { n: number }, where: string): Group {
  if (!isGroup(g) || (g.match !== "all" && g.match !== "any") || !Array.isArray(g.items))
    return fail(`${where}: choose whether all or any of its conditions must hold.`);
  if (depth > MAX_DEPTH) fail(`${where}: nest groups at most ${MAX_DEPTH} deep.`);
  return {
    match: g.match,
    items: g.items.map((x) => {
      if (isGroup(x)) return checkGroup(x, depth + 1, count, where);
      if (++count.n > MAX_CONDITIONS) fail(`${where}: use at most ${MAX_CONDITIONS} conditions.`);
      const c = (x ?? {}) as Record<string, unknown>;
      const field = String(c.field ?? "");
      if (field in LATER_FIELDS) fail(`${where}: ${field} conditions arrive with ${LATER_FIELDS[field]}; it can't be evaluated yet.`);
      const spec = (FIELDS as Record<string, { label: string; ops: readonly string[]; values?: readonly unknown[]; key?: boolean }>)[field];
      if (!spec) fail(`${where}: “${field}” isn't something a condition can test.`);
      if (!spec.ops.includes(String(c.op))) fail(`${where}: ${spec.label} can't be compared with “${String(c.op)}”.`);
      const op = c.op as Op;
      const needsValue = op !== "is_set" && op !== "is_not_set";
      let value: string | boolean | undefined;
      if (needsValue) {
        if (spec.values) {
          if (!spec.values.includes(c.value as never)) fail(`${where}: choose a value for ${spec.label}.`);
          value = c.value as string | boolean;
        } else {
          if (typeof c.value !== "string" || !c.value.trim() || c.value.length > 500) fail(`${where}: give a value for ${spec.label}.`);
          value = (c.value as string).trim();
        }
      }
      let key: string | undefined;
      if (spec.key) {
        if (typeof c.key !== "string" || !c.key || c.key.length > 100) fail(`${where}: choose which for ${spec.label}.`);
        key = c.key as string;
      }
      return { field: field as Field, op, ...(value !== undefined ? { value } : {}), ...(key ? { key } : {}) };
    }),
  };
}

function checkStep(s: unknown, where: string): Step {
  const x = (s ?? {}) as Record<string, unknown>;
  const type = String(x.type ?? "");
  if (!(type in ACTIONS)) fail(`${where}: “${type}” isn't a step a workflow can take yet.`);
  const options = (x.options && typeof x.options === "object" ? x.options : {}) as Record<string, unknown>;
  const spec = ACTIONS[type as ActionType];
  for (const need of spec.needs)
    if (options[need] === undefined || options[need] === "" || options[need] === null) fail(`${where}: ${spec.label} needs its ${need}.`);
  if ((type === "wait" || type === "snooze") && !(Number.isInteger(options.seconds) && (options.seconds as number) >= 60 && (options.seconds as number) <= 30 * 86_400))
    fail(`${where}: ${spec.label} for between a minute and 30 days.`);
  if (type === "note" && (typeof options.text !== "string" || options.text.length > 5000)) fail(`${where}: keep the note to 5,000 characters.`);
  if ((type === "message" || type === "collect") && (typeof options.text !== "string" || !options.text.trim() || options.text.length > 2000))
    fail(`${where}: write the message, in up to 2,000 characters.`);
  if (type === "collect") {
    if (!(String(options.into) in COLLECT_INTO)) fail(`${where}: choose where to keep the reply.`);
    if (options.into === "contact" && !/^[A-Za-z0-9_.-]{1,60}$/.test(String(options.key ?? ""))) fail(`${where}: name the customer attribute (letters, digits, . _ -).`);
    if (options.into === "conversation" && (typeof options.attributeId !== "string" || !options.attributeId)) fail(`${where}: choose the conversation attribute.`);
    if (options.format !== undefined && !(String(options.format) in COLLECT_FORMATS)) fail(`${where}: choose what kind of reply it is.`);
    const t = options.timeoutSeconds ?? 86_400;
    if (!(Number.isInteger(t) && (t as number) >= 60 && (t as number) <= 30 * 86_400)) fail(`${where}: wait for the reply between a minute and 30 days.`);
  }
  if (type === "priority" && typeof options.value !== "boolean") fail(`${where}: set priority on or off.`);
  return { id: typeof x.id === "string" && x.id ? x.id.slice(0, 40) : crypto.randomUUID(), type: type as ActionType, options };
}

const timeout = (v: unknown, where: string) => {
  const t = Number(v);
  if (!Number.isInteger(t) || t < 60 || t > 30 * 86_400) fail(`${where}: wait at most between a minute and 30 days.`);
  return t;
};

/** The definition, in shape (any draft may be saved this way, even an unfinished one). */
export function validate(raw: unknown): Definition {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const t = (d.trigger ?? {}) as Record<string, unknown>;
  const type = String(t.type ?? "");
  if (type in LATER_TRIGGERS) fail(`That trigger arrives with ${LATER_TRIGGERS[type]}.`);
  if (!(type in TRIGGERS)) fail("Choose what starts the workflow.");
  const o = (t.options ?? {}) as Record<string, unknown>;
  const options: Definition["trigger"]["options"] = {};
  for (const k of ["tagId", "attributeId", "key"] as const) if (typeof o[k] === "string" && o[k]) options[k] = String(o[k]).slice(0, 100);
  const count = { n: 0 };
  const when = d.when === undefined ? { match: "all" as const, items: [] } : checkGroup(d.when, 1, count, "Who it runs for");
  if (!Array.isArray(d.paths) || !d.paths.length) fail("Give the workflow at least one path.");
  if ((d.paths as unknown[]).length > MAX_PATHS) fail(`Keep to ${MAX_PATHS} paths.`);
  const paths = (d.paths as Record<string, unknown>[]).map((p, i): Path => {
    const id = String(p?.id ?? "");
    if (!LETTERS.test(id)) fail(`Path ${i + 1}: letter it A, B, … AA.`);
    const where = `Path ${id}`;
    const steps = Array.isArray(p.steps) ? p.steps : [];
    if (steps.length > MAX_STEPS) fail(`${where}: keep to ${MAX_STEPS} steps.`);
    const n = (p.next ?? { type: "end" }) as Record<string, unknown>;
    let next: Next;
    if (n.type === "end") next = { type: "end" };
    else if (n.type === "goto") next = { type: "goto", path: String(n.path ?? "") };
    else if (n.type === "branch") {
      const branches = Array.isArray(n.branches) ? (n.branches as Record<string, unknown>[]) : [];
      if (branches.length > 10) fail(`${where}: keep to 10 branches.`);
      next = {
        type: "branch",
        branches: branches.map((b, j) => ({
          label: typeof b.label === "string" && b.label.trim() ? b.label.trim().slice(0, 60) : `Branch ${j + 1}`,
          when: checkGroup(b.when, 1, count, `${where}, branch ${j + 1}`),
          path: String(b.path ?? ""),
        })),
        else: String(n.else ?? ""),
      };
    } else if (n.type === "wait_until") {
      const timeout = Number(n.timeoutSeconds);
      if (!Number.isInteger(timeout) || timeout < 60 || timeout > 30 * 86_400) fail(`${where}: wait at most between a minute and 30 days.`);
      next = { type: "wait_until", when: checkGroup(n.when, 1, count, `${where}, wait`), timeoutSeconds: timeout, met: String(n.met ?? ""), timedOut: String(n.timedOut ?? "") };
    } else if (n.type === "buttons") {
      const text = typeof n.text === "string" ? n.text.trim() : "";
      if (!text || text.length > 1000) fail(`${where}: write the question, in up to 1,000 characters.`);
      const buttons = Array.isArray(n.buttons) ? (n.buttons as Record<string, unknown>[]) : [];
      if (!buttons.length || buttons.length > MAX_BUTTONS) fail(`${where}: give between 1 and ${MAX_BUTTONS} reply buttons.`);
      const labels = buttons.map((b, j) => {
        const label = typeof b.label === "string" ? b.label.trim() : "";
        if (!label || label.length > 40) fail(`${where}, button ${j + 1}: label it, in up to 40 characters.`);
        return label;
      });
      if (new Set(labels.map((l) => l.toLowerCase())).size !== labels.length) fail(`${where}: two buttons have the same label.`);
      next = {
        type: "buttons",
        text,
        buttons: buttons.map((b, j) => ({ label: labels[j], path: String(b.path ?? "") })),
        other: String(n.other ?? ""),
        timeoutSeconds: timeout(n.timeoutSeconds, where),
        timedOut: String(n.timedOut ?? ""),
      };
    } else if (n.type === "zoe") {
      next = {
        type: "zoe",
        resolved: String(n.resolved ?? ""),
        handedOver: String(n.handedOver ?? ""),
        timeoutSeconds: timeout(n.timeoutSeconds, where),
        timedOut: String(n.timedOut ?? ""),
      };
    } else if (n.type === "connector") {
      const connectorId = typeof n.connectorId === "string" ? n.connectorId.slice(0, 100) : "";
      if (!connectorId) fail(`${where}: choose the connector.`);
      const inputs: Record<string, ValueSource> = {};
      for (const [k, v] of Object.entries((n.inputs ?? {}) as Record<string, Record<string, unknown>>)) {
        if (!/^[A-Za-z0-9_]{1,60}$/.test(k)) fail(`${where}: “${k}” isn't an input name.`);
        if (v?.from === "value" && typeof v.value === "string" && v.value.length <= 500) inputs[k] = { from: "value", value: v.value };
        else if (v?.from === "contact" && /^[A-Za-z0-9_.-]{1,60}$/.test(String(v.key ?? ""))) inputs[k] = { from: "contact", key: String(v.key) };
        else if (v?.from === "conversation" && typeof v.attributeId === "string" && v.attributeId) inputs[k] = { from: "conversation", attributeId: v.attributeId.slice(0, 100) };
        else fail(`${where}: choose where the connector's ${k} comes from.`);
      }
      const save: Record<string, string> = {};
      for (const [k, v] of Object.entries((n.save ?? {}) as Record<string, unknown>))
        if (typeof v === "string" && v && /^[A-Za-z0-9_]{1,60}$/.test(k)) save[k] = v.slice(0, 100);
      next = { type: "connector", connectorId, inputs, save, ok: String(n.ok ?? ""), failed: String(n.failed ?? "") };
    } else return fail(`${where}: choose what happens after its steps.`);
    return {
      id,
      label: typeof p.label === "string" ? p.label.trim().slice(0, 60) : "",
      steps: steps.map((s, j) => checkStep(s, `${where}, step ${j + 1}`)),
      next,
    };
  });
  if (new Set(paths.map((p) => p.id)).size !== paths.length) fail("Two paths have the same letter.");
  return { trigger: { type: type as Trigger, options }, when, paths };
}

/**
 * A path's ways on, each a handle on the builder's canvas: `next` (go to), `b0`… (branches),
 * `else`, `met` and `timedOut`. An empty target is a way on not yet connected.
 */
export function outlets(p: Path): { id: string; label: string; target: string }[] {
  const n = p.next;
  if (n.type === "goto") return [{ id: "next", label: "Then", target: n.path }];
  if (n.type === "branch")
    return [...n.branches.map((b, i) => ({ id: "b" + i, label: b.label, target: b.path })), { id: "else", label: "Else", target: n.else }];
  if (n.type === "wait_until")
    return [
      { id: "met", label: "When it holds", target: n.met },
      { id: "timedOut", label: "If it times out", target: n.timedOut },
    ];
  if (n.type === "buttons")
    return [
      ...n.buttons.map((b, i) => ({ id: "b" + i, label: b.label, target: b.path })),
      { id: "other", label: "If they type instead", target: n.other },
      { id: "timedOut", label: "If they don't answer", target: n.timedOut },
    ];
  if (n.type === "zoe")
    return [
      { id: "resolved", label: "Resolved", target: n.resolved },
      { id: "handedOver", label: "Handed over", target: n.handedOver },
      { id: "timedOut", label: "If no outcome", target: n.timedOut },
    ];
  if (n.type === "connector")
    return [
      { id: "ok", label: "It worked", target: n.ok },
      { id: "failed", label: "It failed", target: n.failed },
    ];
  return [];
}

/** The path with one way on pointed at `target` ("" disconnects it); "next" on an end goes on. */
export function setOutlet(p: Path, id: string, target: string): Path {
  const n = p.next;
  const button = /^b(\d+)$/.exec(id);
  if (id === "next") return { ...p, next: target ? { type: "goto", path: target } : { type: "end" } };
  if (n.type === "branch" && id === "else") return { ...p, next: { ...n, else: target } };
  if (n.type === "branch" && button) return { ...p, next: { ...n, branches: n.branches.map((b, j) => (j === Number(button[1]) ? { ...b, path: target } : b)) } };
  if (n.type === "buttons" && button) return { ...p, next: { ...n, buttons: n.buttons.map((b, j) => (j === Number(button[1]) ? { ...b, path: target } : b)) } };
  if (n.type === "buttons" && (id === "other" || id === "timedOut")) return { ...p, next: { ...n, [id]: target } };
  if (n.type === "wait_until" && (id === "met" || id === "timedOut")) return { ...p, next: { ...n, [id]: target } };
  if (n.type === "zoe" && (id === "resolved" || id === "handedOver" || id === "timedOut")) return { ...p, next: { ...n, [id]: target } };
  if (n.type === "connector" && (id === "ok" || id === "failed")) return { ...p, next: { ...n, [id]: target } };
  return p;
}
const targets = (p: Path) => outlets(p).map((o) => o.target);

/** What blocks publishing: each in words. Empty: it can be published. */
export function problems(def: Definition): string[] {
  const out: string[] = [];
  const ids = new Set(def.paths.map((p) => p.id));
  for (const p of def.paths) {
    for (const t of targets(p)) if (!t) out.push(`Path ${p.id}: a way on doesn't lead anywhere. Choose its path.`);
      else if (!ids.has(t)) out.push(`Path ${p.id}: it leads to path ${t}, which doesn't exist.`);
      else if (t === p.id) out.push(`Path ${p.id}: it leads back to itself.`);
    if (p.next.type === "branch" && !p.next.branches.length) out.push(`Path ${p.id}: a branch needs at least one condition.`);
    if (p.next.type === "branch") p.next.branches.forEach((b, j) => !b.when.items.length && out.push(`Path ${p.id}, branch ${j + 1}: give it a condition.`));
    if (p.next.type === "wait_until" && !p.next.when.items.length) out.push(`Path ${p.id}: give the wait a condition.`);
  }
  // Reachable from the first path.
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (seen.has(id) || !ids.has(id)) return;
    seen.add(id);
    for (const t of targets(def.paths.find((p) => p.id === id)!)) walk(t);
  };
  walk(def.paths[0].id);
  for (const p of def.paths) if (!seen.has(p.id)) out.push(`Path ${p.id} can't be reached from path ${def.paths[0].id}.`);
  // Every path reachable from the start can come to an end (no path that only loops).
  const ends = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of def.paths)
      if (!ends.has(p.id) && (p.next.type === "end" || targets(p).some((t) => ends.has(t)))) {
        ends.add(p.id);
        grew = true;
      }
  }
  for (const p of def.paths) if (seen.has(p.id) && !ends.has(p.id)) out.push(`Path ${p.id} never reaches an end.`);
  if (def.trigger.type === "contact_attribute_changed" && !def.trigger.options.key) out.push("Choose which customer attribute fires it.");
  return out;
}

/* ------------------------------------------------------------------------------------------ */
/* The builder's layout (W2)                                                                   */

/**
 * Where each card sits on the canvas: `trigger` and each path's letter. Kept beside the draft,
 * not in versions, so moving cards never counts as an unpublished change.
 */
export type Layout = Record<string, { x: number; y: number }>;
export const LAYOUT_COLUMN = 380;
export const LAYOUT_ROW = 260;

/** A layout in shape: known cards only, finite positions within the canvas. */
export function checkLayout(raw: unknown, def: Definition): Layout {
  const keys = new Set(["trigger", ...def.paths.map((p) => p.id)]);
  const out: Layout = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const p = (v ?? {}) as { x?: unknown; y?: unknown };
    if (keys.has(k) && Number.isFinite(p.x) && Number.isFinite(p.y))
      out[k] = { x: Math.max(-1e5, Math.min(1e5, Math.round(p.x as number))), y: Math.max(-1e5, Math.min(1e5, Math.round(p.y as number))) };
  }
  return out;
}

/**
 * Cards in columns by their distance from the trigger (the first path next to it), in path order
 * within a column; paths that can't be reached go in a last column. Used for "Tidy up" and for
 * cards without a saved position.
 */
export function autoLayout(def: Definition): Layout {
  const depth = new Map<string, number>();
  const byId = new Map(def.paths.map((p) => [p.id, p]));
  const queue = def.paths.length ? [def.paths[0].id] : [];
  if (queue.length) depth.set(queue[0], 1);
  while (queue.length) {
    const id = queue.shift()!;
    for (const t of targets(byId.get(id)!))
      if (byId.has(t) && !depth.has(t)) {
        depth.set(t, depth.get(id)! + 1);
        queue.push(t);
      }
  }
  const last = Math.max(1, ...depth.values()) + 1;
  const rows = new Map<number, number>();
  const out: Layout = { trigger: { x: 0, y: 0 } };
  for (const p of def.paths) {
    const col = depth.get(p.id) ?? last;
    const row = rows.get(col) ?? 0;
    rows.set(col, row + 1);
    out[p.id] = { x: col * LAYOUT_COLUMN, y: row * LAYOUT_ROW };
  }
  return out;
}

/** The next free letter: A…Z, then AA, AB… */
export function nextLetter(def: Definition): string {
  const taken = new Set(def.paths.map((p) => p.id));
  const letters = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];
  for (const id of [...letters, ...letters.flatMap((a) => letters.map((b) => a + b))]) if (!taken.has(id)) return id;
  return "ZZ";
}

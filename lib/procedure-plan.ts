/**
 * Procedures (phase 09, step D2; docs/ACTIONS_STEP2.md): what a workspace writes, and the fixed
 * plan it compiles to. The plan decides the control flow; Zoe only asks, says and looks up what it
 * says, so no message can change what she does next. Shared by the server (which compiles every
 * save and publish) and the Procedures page.
 *
 * Steps are numbered lines, one action each:
 *
 *   1. Ask for order_id.
 *   2. Look up Order lookup.
 *   3. If status is "shipped", go to step 6.
 *   4. Say "Your order is {{status}}."
 *   5. Go to step 7.
 *   6. Say "It's on its way and should arrive on {{eta}}."
 *   7. Resolve.
 *
 * Actions: Ask for <input>. Look up <connector>. If <value> is / is not / contains "<text>", or
 * is empty / is not empty, go to step <n>. Say "<text>" (with {{value}} placeholders). Go to
 * step <n>. Resolve. Hand over. Stop.
 */
export type ProcedureInput = {
  name: string;
  label: string;
  /** What Zoe asks when she needs it. */
  question: string;
  /** A regular expression; with one, the value can be found inside a longer message. */
  pattern: string;
};
export type Source = {
  description: string;
  /** Words or phrases that start it, checked in code. */
  keywords: string[];
  inputs: ProcedureInput[];
  steps: string;
  /** Said when a look-up fails, before she hands over. */
  onFailure: string;
};
export type Step =
  | { line: number; kind: "ask"; input: string }
  | { line: number; kind: "call"; connectorId: string; connector: string }
  | {
      line: number;
      kind: "branch";
      value: string;
      op: "is" | "is_not" | "contains" | "empty" | "not_empty";
      text: string;
      to: number;
    }
  | { line: number; kind: "say"; text: string }
  | { line: number; kind: "goto"; to: number }
  | { line: number; kind: "end"; outcome: "resolved" | "escalated" | "abandoned" };
export type Plan = {
  keywords: string[];
  inputs: ProcedureInput[];
  /** Steps in order; `to` is a step's index. */
  steps: Step[];
  onFailure: string;
  connectors: { id: string; name: string }[];
};
/** What the compiler knows of a connector: its customer inputs and its outputs. */
export type ConnectorRef = { id: string; name: string; asks: string[]; outputs: string[] };

export const blankSource = (): Source => ({
  description: "",
  keywords: [],
  inputs: [],
  steps: "1. Resolve.",
  onFailure: "",
});

export class CompileError extends Error {
  constructor(
    message: string,
    public line: number | null = null,
  ) {
    super(line === null ? message : `Step ${line}: ${message}`);
  }
}
const NAME = /^[a-z][a-z0-9_]{0,39}$/;
const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;
const clean = (v: unknown, max: number) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "");

/** The source, tidied and checked; a `CompileError` says what to fix. */
export function validSource(raw: unknown): Source {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const keywords = (Array.isArray(s.keywords) ? s.keywords : [])
    .map((k) => clean(k, 60).toLowerCase())
    .filter(Boolean);
  if (keywords.length > 20) throw new CompileError("Keep to 20 keywords.");
  const inputs = (Array.isArray(s.inputs) ? s.inputs : []).map((x: Record<string, unknown>, i: number) => {
    const name = clean(x?.name, 40);
    if (!NAME.test(name))
      throw new CompileError(`Name what to collect ${i + 1} with lowercase letters, digits and underscores.`);
    const pattern = clean(x?.pattern, 200);
    if (pattern)
      try {
        new RegExp(pattern);
      } catch {
        throw new CompileError(`${name}'s pattern isn't a valid regular expression.`);
      }
    const question = clean(x?.question, 300);
    if (!question) throw new CompileError(`Write the question Zoe asks for ${name}.`);
    return { name, label: clean(x?.label, 60) || name, question, pattern };
  });
  if (inputs.length > 10) throw new CompileError("Collect at most 10 values.");
  if (new Set(inputs.map((i) => i.name)).size !== inputs.length)
    throw new CompileError("Two things to collect have the same name.");
  const steps = typeof s.steps === "string" ? s.steps.trim() : "";
  if (!steps || steps.length > 5000) throw new CompileError("Write the steps, in up to 5,000 characters.");
  return {
    description: clean(s.description, 500),
    keywords: [...new Set(keywords)],
    inputs,
    steps,
    onFailure: clean(s.onFailure, 500),
  };
}

/** Compiles the steps into a plan, against the connectors that exist. */
export function compile(source: Source, connectors: ConnectorRef[]): Plan {
  const lines = source.steps
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length > 30) throw new CompileError("Keep to 30 steps.");
  const raw = lines.map((l, i) => {
    const m = /^(\d+)[.)]\s+(.+)$/.exec(l);
    if (!m) throw new CompileError(`Number each step: “${i + 1}. …”.`, i + 1);
    if (Number(m[1]) !== i + 1) throw new CompileError(`Number the steps 1, 2, 3 in order.`, i + 1);
    return m[2].trim();
  });
  const n = raw.length;
  const inputNames = new Set(source.inputs.map((i) => i.name));
  const used: { id: string; name: string }[] = [];
  const known = new Set(inputNames);
  // Outputs of every connector the plan looks up can be named anywhere (absent until looked up).
  for (const text of raw) {
    const m = /^(?:look up|call)\s+(.+?)\.?$/i.exec(text);
    const c = m && connectors.find((x) => x.name.toLowerCase() === m[1].trim().toLowerCase());
    if (c) for (const o of c.outputs) known.add(o);
  }
  const target = (v: string, line: number) => {
    const to = Number(v);
    if (!Number.isInteger(to) || to < 1 || to > n) throw new CompileError(`There's no step ${v}.`, line);
    if (to === line) throw new CompileError("A step can't go to itself.", line);
    return to - 1;
  };
  const value = (v: string, line: number) => {
    if (!known.has(v))
      throw new CompileError(`“${v}” isn't something collected or looked up.`, line);
    return v;
  };
  const say = (t: string, line: number) => {
    if (!t || t.length > 1000) throw new CompileError("Write what she says, in up to 1,000 characters.", line);
    for (const m of t.matchAll(PLACEHOLDER)) value(m[1], line);
    return t;
  };
  const steps: Step[] = raw.map((text, i): Step => {
    const line = i + 1;
    let m: RegExpExecArray | null;
    if ((m = /^ask for\s+([a-z][a-z0-9_]*)\.?$/i.exec(text))) {
      if (!inputNames.has(m[1])) throw new CompileError(`Add ${m[1]} to what to collect first.`, line);
      return { line, kind: "ask", input: m[1] };
    }
    if ((m = /^(?:look up|call)\s+(.+?)\.?$/i.exec(text))) {
      const c = connectors.find((x) => x.name.toLowerCase() === m![1].trim().toLowerCase());
      if (!c) throw new CompileError(`There's no published connector called “${m[1].trim()}”.`, line);
      for (const a of c.asks)
        if (!inputNames.has(a))
          throw new CompileError(`${c.name} needs ${a} from the customer: add it to what to collect.`, line);
      if (!used.some((u) => u.id === c.id)) used.push({ id: c.id, name: c.name });
      return { line, kind: "call", connectorId: c.id, connector: c.name };
    }
    if ((m = /^if\s+([a-z][a-z0-9_]*)\s+(is not|is|contains)\s+"([^"]*)",?\s+go to step\s+(\d+)\.?$/i.exec(text)))
      return {
        line,
        kind: "branch",
        value: value(m[1], line),
        op: m[2].toLowerCase() === "is not" ? "is_not" : (m[2].toLowerCase() as "is" | "contains"),
        text: m[3],
        to: target(m[4], line),
      };
    if ((m = /^if\s+([a-z][a-z0-9_]*)\s+(is not empty|is empty),?\s+go to step\s+(\d+)\.?$/i.exec(text)))
      return {
        line,
        kind: "branch",
        value: value(m[1], line),
        op: m[2].toLowerCase() === "is empty" ? "empty" : "not_empty",
        text: "",
        to: target(m[3], line),
      };
    if ((m = /^say:?\s+"([\s\S]+)"\.?$/i.exec(text)) || (m = /^say:\s+([\s\S]+)$/i.exec(text)))
      return { line, kind: "say", text: say(m[1].trim(), line) };
    if ((m = /^go to step\s+(\d+)\.?$/i.exec(text))) return { line, kind: "goto", to: target(m[1], line) };
    if (/^(resolve|finish)\.?$/i.test(text)) return { line, kind: "end", outcome: "resolved" };
    if (/^hand over\.?$/i.test(text)) return { line, kind: "end", outcome: "escalated" };
    if (/^stop\.?$/i.test(text)) return { line, kind: "end", outcome: "abandoned" };
    throw new CompileError(
      "Start the step with Ask for, Look up, If, Say, Go to step, Resolve, Hand over or Stop.",
      line,
    );
  });
  const last = steps[n - 1];
  if (last.kind !== "end" && last.kind !== "goto")
    throw new CompileError("Finish the last step with Resolve, Hand over, Stop or Go to step.", n);
  if (!source.keywords.length) throw new CompileError("Give at least one keyword that starts it.");
  return { keywords: source.keywords, inputs: source.inputs, steps, onFailure: source.onFailure, connectors: used };
}

/** A placeholder-filled message. Values not known yet are left out. */
export const fill = (text: string, values: Record<string, unknown>) =>
  text.replace(PLACEHOLDER, (_, name: string) => {
    const v = values[name];
    return v === undefined || v === null ? "" : Array.isArray(v) ? v.join(", ") : String(v);
  });

/** Whether a branch holds for these values. */
export function holds(step: Extract<Step, { kind: "branch" }>, values: Record<string, unknown>) {
  const v = values[step.value];
  const s = v === undefined || v === null ? "" : Array.isArray(v) ? v.join(", ") : String(v);
  const a = s.toLowerCase();
  const b = step.text.toLowerCase();
  switch (step.op) {
    case "is":
      return a === b;
    case "is_not":
      return a !== b;
    case "contains":
      return a.includes(b);
    case "empty":
      return s === "";
    case "not_empty":
      return s !== "";
  }
}

/** The plan in words, for teammates to check before publishing. */
export function describe(plan: Plan): string[] {
  return plan.steps.map((s, i) => {
    const n = `${i + 1}.`;
    switch (s.kind) {
      case "ask":
        return `${n} Ask for ${plan.inputs.find((x) => x.name === s.input)?.label ?? s.input}, unless it's already known.`;
      case "call":
        return `${n} Look up ${s.connector} (a verified customer only, by your verification rules).`;
      case "branch": {
        const how =
          s.op === "empty" ? "is empty" : s.op === "not_empty" ? "isn't empty" : `${s.op === "is_not" ? "isn't" : s.op === "contains" ? "contains" : "is"} “${s.text}”`;
        return `${n} If ${s.value} ${how}, go to step ${s.to + 1}; otherwise continue.`;
      }
      case "say":
        return `${n} Say “${s.text}”`;
      case "goto":
        return `${n} Go to step ${s.to + 1}.`;
      case "end":
        return `${n} ${s.outcome === "resolved" ? "End: resolved." : s.outcome === "escalated" ? "End: hand over to the team." : "End: stop, and answer normally from then on."}`;
    }
  });
}

import { useId } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import {
  ACTIONS,
  COLLECT_FORMATS,
  COLLECT_INTO,
  FIELDS,
  MAX_DEPTH,
  type ActionType,
  type Condition,
  type Field,
  type Group,
  type Op,
  type Step,
} from "../lib/workflow-definition";

/**
 * The workflow builder's editors (phase 11, step W2; docs/WORKFLOWS_STEP2.md): condition groups,
 * steps, and the words cards show for them. Every choice comes from the definition's own lists
 * (`FIELDS`, `ACTIONS`), so the builder can't offer what the engine refuses.
 */
export type Named = { id: string; name: string };
export type Options = {
  tags: Named[];
  teams: Named[];
  teammates: Named[];
  brands: Named[];
  attributes: (Named & { type: string; options: unknown })[];
  slaPolicies: Named[];
  ticketTypes: Named[];
  /** W3: published read connectors, with the inputs to give and the outputs to keep. */
  connectors: (Named & { inputs: { name: string; label: string; required: boolean }[]; outputs: { name: string; label: string }[] })[];
};

const OPS: Record<Op, string> = {
  is: "is",
  is_not: "is not",
  is_set: "is set",
  is_not_set: "is not set",
  contains: "contains",
  not_contains: "doesn't contain",
  has: "has",
  has_not: "doesn't have",
};
const VALUES: Record<string, string> = {
  open: "Open",
  snoozed: "Snoozed",
  closed: "Closed",
  pending: "Answering",
  escalated: "Handed over",
  needs_input: "Waiting for the customer",
  resolved: "Resolved",
  breached: "Breached",
  overdue: "Overdue",
  visitor: "Visitor",
  lead: "Lead",
  user: "User",
  customer: "The customer",
  teammate: "A teammate",
  zoe: "Zoe",
  workflow: "A workflow",
  system: "Relay",
  manual: "A teammate running it",
};
/** The condition picker's sections. */
const SECTIONS: [string, Field[]][] = [
  [
    "Conversation",
    [
      "conversation.status",
      "conversation.priority",
      "conversation.assignee",
      "conversation.team",
      "conversation.tag",
      "conversation.brand",
      "conversation.channel",
      "conversation.language",
      "conversation.attribute",
      "conversation.ai_state",
      "conversation.sla",
    ],
  ],
  ["Message", ["message.text"]],
  ["Customer", ["contact.signed_in", "contact.role", "contact.email_domain", "contact.attribute"]],
  ["Availability", ["office_hours", "team.available"]],
  ["The change", ["change.by", "wait.timed_out"]],
];
const LANGUAGES = ["en", "fr", "de", "es", "it", "pt", "nl", "pl", "sv", "da", "nb", "fi", "ja", "zh", "ko", "ar", "tr", "ru"];

type Spec = { label: string; ops: readonly Op[]; values?: readonly (string | boolean)[]; key?: boolean };
const spec = (f: Field) => FIELDS[f] as unknown as Spec;
const nameIn = (list: Named[], id: unknown, what: string) =>
  list.find((x) => x.id === id)?.name ?? (id ? `a missing ${what}` : `no ${what}`);
const isGroup = (x: Condition | Group): x is Group => "items" in x;

/* ------------------------------------------------------------------------------------------ */
/* Words                                                                                       */

export function seconds(n: number) {
  const unit = n % 86_400 === 0 ? ["day", 86_400] : n % 3600 === 0 ? ["hour", 3600] : ["minute", 60];
  const v = Math.round(n / (unit[1] as number));
  return `${v} ${unit[0]}${v === 1 ? "" : "s"}`;
}

/** One condition, as a card says it: "Language is fr", "Tag has “Billing”". */
export function describeCondition(c: Condition, o: Options): string {
  const s = spec(c.field);
  const yes = (v: unknown) => (v === true ? "yes" : "no");
  const value = (): string => {
    switch (c.field) {
      case "conversation.assignee":
        return nameIn(o.teammates, c.value, "teammate");
      case "conversation.team":
        return nameIn(o.teams, c.value, "team");
      case "conversation.tag":
        return `“${nameIn(o.tags, c.value, "tag")}”`;
      case "conversation.brand":
        return nameIn(o.brands, c.value, "brand");
      case "conversation.priority":
      case "contact.signed_in":
      case "wait.timed_out":
        return yes(c.value);
      default:
        return typeof c.value === "string" ? (VALUES[c.value] ?? c.value) : String(c.value ?? "");
    }
  };
  const subject =
    c.field === "conversation.attribute"
      ? `“${nameIn(o.attributes, c.key, "attribute")}”`
      : c.field === "contact.attribute"
        ? `The customer's ${c.key || "attribute"}`
        : c.field === "team.available"
          ? `“${nameIn(o.teams, c.key, "team")}” has someone available`
          : s.label;
  if (c.op === "is_set" || c.op === "is_not_set") return `${subject} ${OPS[c.op]}`;
  return `${subject} ${OPS[c.op]} ${value()}`;
}

/** A group, in a line or two: "Language is fr and Tag has “Billing”". */
export function describeGroup(g: Group, o: Options): string {
  if (!g.items.length) return "Everyone";
  const join = g.match === "all" ? " and " : " or ";
  return g.items.map((x) => (isGroup(x) ? `(${describeGroup(x, o)})` : describeCondition(x, o))).join(join);
}

/** One step, as a card says it: "Add the tag “Triaged”", "Assign to the team French". */
export function describeStep(s: Step, o: Options): string {
  const v = s.options;
  switch (s.type) {
    case "tag_add":
      return `Add the tag “${nameIn(o.tags, v.tagId, "tag")}”`;
    case "tag_remove":
      return `Remove the tag “${nameIn(o.tags, v.tagId, "tag")}”`;
    case "assign": {
      const who = v.teammateId ? nameIn(o.teammates, v.teammateId, "teammate") : "";
      const team = v.teamId ? `the team ${nameIn(o.teams, v.teamId, "team")}` : "";
      return who && team ? `Assign to ${who} in ${team}` : who || team ? `Assign to ${who || team}` : "Unassign";
    }
    case "priority":
      return v.value ? "Mark as priority" : "Remove priority";
    case "snooze":
      return `Snooze for ${seconds(Number(v.seconds) || 0)}`;
    case "sla_apply":
      return v.policyId === "none" ? "Apply no SLA" : `Apply the SLA “${nameIn(o.slaPolicies, v.policyId, "policy")}”`;
    case "attribute_set":
      return `Set “${nameIn(o.attributes, v.attributeId, "attribute")}” to ${v.value === undefined || v.value === "" ? "nothing" : String(v.value)}`;
    case "contact_attribute_set":
      return `Set the customer's ${String(v.key || "attribute")} to ${v.value === undefined || v.value === "" ? "nothing" : String(v.value)}`;
    case "note":
      return `Note: ${String(v.text ?? "").slice(0, 60) || "(empty)"}`;
    case "ticket_create":
      return `Create a “${nameIn(o.ticketTypes, v.typeId, "ticket type")}” ticket`;
    case "human_handover":
      return v.teamId ? `Hand to the team ${nameIn(o.teams, v.teamId, "team")}` : "Hand to the team";
    case "wait":
      return `Wait ${seconds(Number(v.seconds) || 0)}`;
    case "message":
      return `Send: “${clip(v.text)}”`;
    case "collect":
      return `Ask “${clip(v.text)}”, keep the reply in ${
        v.into === "email" ? "their email" : v.into === "contact" ? `the customer's ${String(v.key || "attribute")}` : `“${nameIn(o.attributes, v.attributeId, "attribute")}”`
      }`;
    default:
      return ACTIONS[s.type].label;
  }
}

const clip = (v: unknown) => {
  const t = String(v ?? "").trim();
  return t ? (t.length > 50 ? t.slice(0, 49) + "…" : t) : "…";
};

/** A step's starting options: what it needs, set to the first choice there is. */
export function newStep(type: ActionType, o: Options): Step {
  const first = (l: Named[]) => l[0]?.id ?? "";
  const options: Record<string, unknown> =
    type === "tag_add" || type === "tag_remove"
      ? { tagId: first(o.tags) }
      : type === "priority"
        ? { value: true }
        : type === "snooze" || type === "wait"
          ? { seconds: 3600 }
          : type === "sla_apply"
            ? { policyId: first(o.slaPolicies) || "none" }
            : type === "attribute_set"
              ? { attributeId: first(o.attributes), value: "" }
              : type === "contact_attribute_set"
                ? { key: "", value: "" }
                : type === "note" || type === "message"
                  ? { text: "" }
                  : type === "collect"
                    ? { text: "", into: "email", timeoutSeconds: 86_400 }
                  : type === "ticket_create"
                    ? { typeId: first(o.ticketTypes) }
                    : {};
  return { id: crypto.randomUUID(), type, options };
}

/* ------------------------------------------------------------------------------------------ */
/* Pickers                                                                                     */

function Pick({
  label,
  value,
  onChange,
  list,
  none,
}: {
  label: string;
  value: unknown;
  onChange: (v: string) => void;
  list: Named[];
  /** An empty choice, with this wording. */
  none?: string;
}) {
  const v = typeof value === "string" ? value : "";
  const missing = v && !list.some((x) => x.id === v);
  return (
    <select aria-label={label} value={v} onChange={(e) => onChange(e.target.value)}>
      {none !== undefined && <option value="">{none}</option>}
      {!v && none === undefined && <option value="">Choose…</option>}
      {missing && <option value={v}>(missing)</option>}
      {list.map((x) => (
        <option key={x.id} value={x.id}>
          {x.name}
        </option>
      ))}
    </select>
  );
}

/** A duration in minutes, hours or days, kept as seconds. */
export function Duration({ label, value, onChange }: { label: string; value: number; onChange: (seconds: number) => void }) {
  const unit = value % 86_400 === 0 ? 86_400 : value % 3600 === 0 ? 3600 : 60;
  return (
    <span className="pg-wf-inline">
      <input
        type="number"
        min={1}
        aria-label={`${label}, amount`}
        value={Math.round(value / unit) || ""}
        onChange={(e) => onChange(Math.max(0, Math.round(Number(e.target.value))) * unit)}
      />
      <select aria-label={`${label}, unit`} value={unit} onChange={(e) => onChange(Math.round(value / unit) * Number(e.target.value))}>
        <option value={60}>minutes</option>
        <option value={3600}>hours</option>
        <option value={86_400}>days</option>
      </select>
    </span>
  );
}

/** A conversation attribute's value, by its type. */
function AttributeValue({ label, attribute, value, onChange }: { label: string; attribute?: Options["attributes"][number]; value: unknown; onChange: (v: string) => void }) {
  const v = value === undefined || value === null ? "" : String(value);
  const choices = Array.isArray(attribute?.options) ? (attribute!.options as unknown[]).map((x) => String((x as { label?: string })?.label ?? x)) : null;
  if (attribute?.type === "boolean")
    return (
      <select aria-label={label} value={v} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose…</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    );
  if (attribute?.type === "options" && choices)
    return (
      <select aria-label={label} value={v} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose…</option>
        {choices.map((c) => (
          <option key={c}>{c}</option>
        ))}
      </select>
    );
  return <input aria-label={label} value={v} onChange={(e) => onChange(e.target.value)} />;
}

/* ------------------------------------------------------------------------------------------ */
/* Conditions                                                                                  */

function ConditionRow({ c, o, onChange, onRemove, n }: { c: Condition; o: Options; onChange: (c: Condition) => void; onRemove: () => void; n: number }) {
  const s = spec(c.field);
  const label = `Condition ${n}`;
  const pickField = (field: Field) => {
    const next = spec(field);
    const op = next.ops[0];
    onChange({
      field,
      op,
      ...(op === "is_set" || op === "is_not_set" ? {} : { value: next.values ? next.values[0] : field === "conversation.tag" ? (o.tags[0]?.id ?? "") : "" }),
      ...(next.key ? { key: field === "team.available" ? (o.teams[0]?.id ?? "") : field === "conversation.attribute" ? (o.attributes[0]?.id ?? "") : "" } : {}),
    });
  };
  const needsValue = c.op !== "is_set" && c.op !== "is_not_set";
  const setValue = (value: string | boolean) => onChange({ ...c, value });
  const valueInput = () => {
    const ids: Partial<Record<Field, [Named[], string]>> = {
      "conversation.assignee": [o.teammates, "teammate"],
      "conversation.team": [o.teams, "team"],
      "conversation.tag": [o.tags, "tag"],
      "conversation.brand": [o.brands, "brand"],
    };
    const list = ids[c.field];
    if (list) return <Pick label={`${label}, ${list[1]}`} value={c.value} onChange={setValue} list={list[0]} />;
    if (s.values)
      return (
        <select
          aria-label={`${label}, value`}
          value={String(c.value)}
          onChange={(e) => setValue(typeof s.values![0] === "boolean" ? e.target.value === "true" : e.target.value)}
        >
          {s.values.map((v) => (
            <option key={String(v)} value={String(v)}>
              {typeof v === "boolean" ? (v ? "Yes" : "No") : (VALUES[v] ?? v)}
            </option>
          ))}
        </select>
      );
    if (c.field === "conversation.attribute")
      return <AttributeValue label={`${label}, value`} attribute={o.attributes.find((a) => a.id === c.key)} value={c.value} onChange={setValue} />;
    return (
      <input
        aria-label={`${label}, value`}
        list={c.field === "conversation.language" ? "pg-wf-languages" : undefined}
        placeholder={c.field === "conversation.language" ? "fr" : c.field === "contact.email_domain" ? "example.com" : ""}
        value={typeof c.value === "string" ? c.value : ""}
        onChange={(e) => setValue(e.target.value)}
      />
    );
  };
  return (
    <li className="pg-wf-condition">
      <select aria-label={`${label}, what it tests`} value={c.field} onChange={(e) => pickField(e.target.value as Field)}>
        {SECTIONS.map(([section, fields]) => (
          <optgroup key={section} label={section}>
            {fields.map((f) => (
              <option key={f} value={f}>
                {FIELDS[f].label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {s.key &&
        (c.field === "team.available" ? (
          <Pick label={`${label}, team`} value={c.key} onChange={(key) => onChange({ ...c, key })} list={o.teams} />
        ) : c.field === "conversation.attribute" ? (
          <Pick label={`${label}, attribute`} value={c.key} onChange={(key) => onChange({ ...c, key, value: "" })} list={o.attributes} />
        ) : (
          <input aria-label={`${label}, attribute name`} placeholder="plan" value={c.key ?? ""} onChange={(e) => onChange({ ...c, key: e.target.value })} />
        ))}
      {s.ops.length > 1 ? (
        <select
          aria-label={`${label}, comparison`}
          value={c.op}
          onChange={(e) => {
            const op = e.target.value as Op;
            const { value, ...rest } = c;
            onChange(op === "is_set" || op === "is_not_set" ? { ...rest, op } : { ...rest, op, value: value ?? (s.values ? s.values[0] : "") });
          }}
        >
          {s.ops.map((op) => (
            <option key={op} value={op}>
              {OPS[op]}
            </option>
          ))}
        </select>
      ) : (
        <span className="pg-muted">{OPS[c.op]}</span>
      )}
      {needsValue && valueInput()}
      <button type="button" className="pg-wf-icon" aria-label={`Remove condition ${n}`} title="Remove" onClick={onRemove}>
        <Trash2 size={14} aria-hidden="true" />
      </button>
    </li>
  );
}

/** "Match all/any of these", its conditions, and groups inside it (at most three deep). */
export function GroupEditor({
  group,
  onChange,
  o,
  label,
  depth = 1,
  onRemove,
}: {
  group: Group;
  onChange: (g: Group) => void;
  o: Options;
  label: string;
  depth?: number;
  onRemove?: () => void;
}) {
  const id = useId();
  const set = (i: number, x: Condition | Group) => onChange({ ...group, items: group.items.map((y, j) => (j === i ? x : y)) });
  const remove = (i: number) => onChange({ ...group, items: group.items.filter((_, j) => j !== i) });
  const fresh = (): Condition => ({ field: "conversation.language", op: "is", value: "" });
  let n = 0;
  return (
    <fieldset className="pg-wf-group" data-depth={depth} aria-labelledby={id}>
      <legend id={id} className="pg-wf-group-head">
        <span className="pg-visually-hidden">{label}: </span>
        {group.items.length > 1 || depth > 1 ? (
          <>
            Match{" "}
            <select aria-label={`${label}: match`} value={group.match} onChange={(e) => onChange({ ...group, match: e.target.value as "all" | "any" })}>
              <option value="all">all</option>
              <option value="any">any</option>
            </select>{" "}
            of these
          </>
        ) : group.items.length ? (
          "When"
        ) : (
          "Everyone, until you add a condition"
        )}
        {onRemove && (
          <button type="button" className="pg-wf-icon" aria-label={`Remove this group from ${label}`} title="Remove group" onClick={onRemove}>
            <Trash2 size={14} aria-hidden="true" />
          </button>
        )}
      </legend>
      <ul className="pg-wf-conditions">
        {group.items.map((x, i) =>
          isGroup(x) ? (
            <li key={i}>
              <GroupEditor group={x} onChange={(g) => set(i, g)} o={o} label={`${label}, group ${i + 1}`} depth={depth + 1} onRemove={() => remove(i)} />
            </li>
          ) : (
            <ConditionRow key={i} c={x} o={o} n={++n} onChange={(c) => set(i, c)} onRemove={() => remove(i)} />
          ),
        )}
      </ul>
      <div className="pg-wf-group-add">
        <button type="button" className="pg-zoe-secondary" onClick={() => onChange({ ...group, items: [...group.items, fresh()] })}>
          <Plus size={14} aria-hidden="true" /> Condition
        </button>
        {depth < MAX_DEPTH && (
          <button type="button" className="pg-zoe-secondary" onClick={() => onChange({ ...group, items: [...group.items, { match: "any", items: [fresh()] }] })}>
            <Plus size={14} aria-hidden="true" /> Group
          </button>
        )}
      </div>
      <datalist id="pg-wf-languages">
        {LANGUAGES.map((l) => (
          <option key={l} value={l} />
        ))}
      </datalist>
    </fieldset>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Steps                                                                                       */

function StepFields({ step, o, onChange, label }: { step: Step; o: Options; onChange: (s: Step) => void; label: string }) {
  const v = step.options;
  const set = (k: string, value: unknown) => onChange({ ...step, options: { ...v, [k]: value } });
  switch (step.type) {
    case "tag_add":
    case "tag_remove":
      return <Pick label={`${label}, tag`} value={v.tagId} onChange={(x) => set("tagId", x)} list={o.tags} />;
    case "assign":
      return (
        <>
          <Pick label={`${label}, teammate`} value={v.teammateId} onChange={(x) => set("teammateId", x)} list={o.teammates} none="No teammate" />
          <Pick label={`${label}, team`} value={v.teamId} onChange={(x) => set("teamId", x)} list={o.teams} none="No team" />
        </>
      );
    case "priority":
      return (
        <select aria-label={`${label}, priority`} value={v.value ? "on" : "off"} onChange={(e) => set("value", e.target.value === "on")}>
          <option value="on">Priority</option>
          <option value="off">Not priority</option>
        </select>
      );
    case "snooze":
    case "wait":
      return <Duration label={`${label}, how long`} value={Number(v.seconds) || 0} onChange={(x) => set("seconds", x)} />;
    case "sla_apply":
      return (
        <select aria-label={`${label}, SLA policy`} value={String(v.policyId ?? "")} onChange={(e) => set("policyId", e.target.value)}>
          <option value="none">No SLA</option>
          {typeof v.policyId === "string" && v.policyId && v.policyId !== "none" && !o.slaPolicies.some((p) => p.id === v.policyId) && (
            <option value={v.policyId}>(missing)</option>
          )}
          {o.slaPolicies.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      );
    case "attribute_set":
      return (
        <>
          <Pick label={`${label}, attribute`} value={v.attributeId} onChange={(x) => onChange({ ...step, options: { attributeId: x, value: "" } })} list={o.attributes} />
          <AttributeValue label={`${label}, value`} attribute={o.attributes.find((a) => a.id === v.attributeId)} value={v.value} onChange={(x) => set("value", x)} />
        </>
      );
    case "contact_attribute_set":
      return (
        <>
          <input aria-label={`${label}, attribute name`} placeholder="plan" value={String(v.key ?? "")} onChange={(e) => set("key", e.target.value)} />
          <input aria-label={`${label}, value`} value={String(v.value ?? "")} onChange={(e) => set("value", e.target.value)} />
        </>
      );
    case "note":
      return <textarea aria-label={`${label}, note`} rows={3} maxLength={5000} value={String(v.text ?? "")} onChange={(e) => set("text", e.target.value)} />;
    case "ticket_create":
      return (
        <>
          <Pick label={`${label}, ticket type`} value={v.typeId} onChange={(x) => set("typeId", x)} list={o.ticketTypes} />
          <input aria-label={`${label}, title`} placeholder="Title (optional)" value={String(v.title ?? "")} onChange={(e) => set("title", e.target.value)} />
        </>
      );
    case "human_handover":
      return <Pick label={`${label}, team`} value={v.teamId} onChange={(x) => set("teamId", x)} list={o.teams} none="Its current team" />;
    case "message":
      return <textarea aria-label={`${label}, message`} rows={3} maxLength={2000} placeholder="What the customer reads" value={String(v.text ?? "")} onChange={(e) => set("text", e.target.value)} />;
    case "reply_time":
      return <p className="pg-muted pg-wf-hint">Tells the customer when to expect a reply, or when the team is back, in their language.</p>;
    case "collect":
      return (
        <>
          <textarea aria-label={`${label}, question`} rows={2} maxLength={2000} placeholder="What's your email?" value={String(v.text ?? "")} onChange={(e) => set("text", e.target.value)} />
          <select aria-label={`${label}, keep the reply in`} value={String(v.into ?? "email")} onChange={(e) => onChange({ ...step, options: { text: v.text, into: e.target.value, timeoutSeconds: v.timeoutSeconds } })}>
            {Object.entries(COLLECT_INTO).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
          {v.into === "contact" && <input aria-label={`${label}, attribute name`} placeholder="plan" value={String(v.key ?? "")} onChange={(e) => set("key", e.target.value)} />}
          {v.into === "conversation" && <Pick label={`${label}, attribute`} value={v.attributeId} onChange={(x) => set("attributeId", x)} list={o.attributes} />}
          {v.into !== "email" && (
            <select aria-label={`${label}, kind of reply`} value={String(v.format ?? "text")} onChange={(e) => set("format", e.target.value)}>
              {Object.entries(COLLECT_FORMATS).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          )}
          <span className="pg-wf-inline">
            <span className="pg-muted">Wait for it up to</span>
            <Duration label={`${label}, wait for the reply`} value={Number(v.timeoutSeconds ?? 86_400)} onChange={(x) => set("timeoutSeconds", x)} />
          </span>
        </>
      );
    default:
      return null;
  }
}

/** A path's steps: each editable, movable and removable, and a picker to add one. */
export function StepsEditor({ steps, onChange, o, max }: { steps: Step[]; onChange: (s: Step[]) => void; o: Options; max: number }) {
  const move = (i: number, by: number) => {
    const next = [...steps];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    onChange(next);
  };
  return (
    <>
      <ol className="pg-wf-steps">
        {steps.map((s, i) => {
          const label = `Step ${i + 1}`;
          return (
            <li key={s.id} className="pg-wf-step">
              <div className="pg-wf-step-head">
                <strong>
                  {i + 1}. {ACTIONS[s.type].label}
                </strong>
                <span className="pg-wf-step-tools">
                  <button type="button" className="pg-wf-icon" aria-label={`Move step ${i + 1} up`} title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                    <ArrowUp size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="pg-wf-icon"
                    aria-label={`Move step ${i + 1} down`}
                    title="Move down"
                    disabled={i === steps.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    <ArrowDown size={14} aria-hidden="true" />
                  </button>
                  <button type="button" className="pg-wf-icon" aria-label={`Remove step ${i + 1}`} title="Remove" onClick={() => onChange(steps.filter((_, j) => j !== i))}>
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </span>
              </div>
              <div className="pg-wf-step-fields">
                <StepFields step={s} o={o} label={label} onChange={(x) => onChange(steps.map((y, j) => (j === i ? x : y)))} />
              </div>
            </li>
          );
        })}
      </ol>
      {steps.length < max ? (
        <select
          aria-label="Add a step"
          className="pg-wf-add-step"
          value=""
          onChange={(e) => e.target.value && onChange([...steps, newStep(e.target.value as ActionType, o)])}
        >
          <option value="">Add a step…</option>
          {(Object.keys(ACTIONS) as ActionType[]).map((t) => (
            <option key={t} value={t}>
              {ACTIONS[t].label}
            </option>
          ))}
        </select>
      ) : (
        <p className="pg-muted">A path holds at most {max} steps.</p>
      )}
    </>
  );
}

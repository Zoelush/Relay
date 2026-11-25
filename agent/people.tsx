import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Building2, Filter, FolderPlus, Plus, Trash2, Users, X } from "lucide-react";
import { api } from "./api";
import { ShowMenuButton, SideMenu, useSideMenu } from "./shell";
import { message } from "./settings-ui";
import { fieldsFor, isGroup, MAX_DEPTH, SEGMENT_FIELDS, type Op, type Rule, type SegmentDefinition, type SegmentGroup, type SegmentItem, type SegmentTarget } from "../lib/segments";

/**
 * People (phase 13, step O1; docs/OUTBOUND_STEP1.md), behind `segments_v1`, at `#people` and
 * `#people/<segment>`: contacts by segment, after Intercom's Contacts. The side menu lists the
 * predefined segments and saved ones with their counts; the rules above the list are the
 * segment's, and changing them shows a live count before saving (as a new segment, or over a
 * saved one). A person opens beside the list: their details, latest events and subscriptions.
 *
 * Phase 01 P2a (docs/PEOPLE_STEP4.md): rules nest in groups (all or any, 3 deep), filter on tags
 * and on a person's companies, and a People / Companies switch shows segments of companies too.
 */
type Segment = { id: string; name: string; predefined: boolean; target: SegmentTarget; definition: SegmentDefinition; count: number };
export type Directory = {
  segments: Segment[];
  attributes: string[];
  events: string[];
  subscriptions: { id: string; name: string; channel: string }[];
  /** P2a: what tag and company rules can name. */
  tags?: { id: string; name: string }[];
  companyAttributes?: string[];
};
type CompanyRow = { id: string; name: string; companyId: string; plan: string | null; seats: number | null; monthlySpend: number | null; people: number };
type Person = { id: string; name: string; role: string; email: string | null; firstSeenAt: string | null; lastSeenAt: string | null; signedUpAt: string | null };
type Details = {
  contact: {
    id: string;
    name: string;
    role: string;
    externalId: string | null;
    emails: string[];
    phones: string[];
    attributes: Record<string, unknown>;
    firstSeenAt: string | null;
    lastSeenAt: string | null;
    signedUpAt: string | null;
    unsubscribedFromAll: boolean;
  };
  events: { name: string; metadata: Record<string, unknown>; at: string; source: string }[];
  subscriptions: { id: string; name: string; channel: string; state: "opted_in" | "opted_out" }[];
};
const ROLE: Record<string, string> = { user: "User", lead: "Lead", visitor: "Visitor" };
const CHANNELS: Record<string, string> = { email: "Email", sms: "SMS", whatsapp: "WhatsApp", in_app: "In-app" };
const OPS: Record<Op, string> = {
  is: "is",
  is_not: "is not",
  contains: "contains",
  ends_with: "ends with",
  is_set: "is known",
  is_not_set: "is unknown",
  greater_than: "is greater than",
  less_than: "is less than",
  more_than_days_ago: "more than … days ago",
  less_than_days_ago: "less than … days ago",
  performed: "was done",
  not_performed: "wasn't done",
  opted_in: "is subscribed",
  opted_out: "is unsubscribed",
  has: "has",
  has_not: "doesn't have",
};
/** Words for an operator on a particular field, where the general ones read wrongly. */
const opLabel = (field: string, op: Op) => (field === "companies" ? (op === "is_set" ? "in a company" : "in no company") : OPS[op]);
const ago = (iso: string | null) => {
  if (!iso) return "—";
  const d = (Date.now() - Date.parse(iso)) / 86_400_000;
  return d < 1 ? "Today" : d < 2 ? "Yesterday" : d < 60 ? `${Math.floor(d)} days ago` : new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};
const needsValue = (op: Op) => !["is_set", "is_not_set", "performed", "not_performed", "opted_in", "opted_out", "has", "has_not"].includes(op);
/** Whether a rule names a company's attribute (a company segment's, or a person's company's). */
const companyAttribute = (field: string, target: SegmentTarget) => field === "company.attribute" || (target === "companies" && field === "attribute");
/** A new rule on a field, with a first value that makes sense for it. */
export function fresh(field: string, dir: Directory, target: SegmentTarget = "contacts"): Rule {
  const f = fieldsFor(target)[field];
  const op = f.ops[0];
  const r: Rule = { field, op };
  if (f.key === "event") r.key = dir.events[0] ?? "";
  if (f.key === "subscription") r.key = dir.subscriptions[0]?.id ?? "";
  if (f.key === "attribute") r.key = (companyAttribute(field, target) ? dir.companyAttributes?.[0] : dir.attributes[0]) ?? "";
  if (f.tag) r.value = dir.tags?.[0]?.id ?? "";
  if (f.values) r.value = f.values[0];
  else if (op === "more_than_days_ago" || op === "less_than_days_ago") r.value = 30;
  else if (op === "greater_than" || op === "less_than") r.value = 0;
  return r;
}

export function People({ segment, onSegment }: { segment: string; onSegment: (id: string) => void }) {
  const menu = useSideMenu("people");
  const [dir, setDir] = useState<Directory | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(
    () =>
      api<Directory>("people")
        .then(setDir)
        .catch((e) => setError(message(e, "People couldn't be loaded."))),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const current = dir?.segments.find((s) => s.id === segment) ?? dir?.segments[0];
  const target = current?.target ?? "contacts";
  return (
    <section className="pg-workspace pg-people" aria-label="People">
      <div className="pg-area">
        <SideMenu state={menu} title="People" label="People menu">
          {dir && (
            <>
              {/* P2a: segments of people, or of companies. */}
              <div className="pg-people-switch" role="group" aria-label="Show segments of">
                {(["contacts", "companies"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    aria-pressed={target === t}
                    onClick={() => target !== t && onSegment(dir.segments.find((s) => s.target === t)?.id ?? "")}
                  >
                    {t === "contacts" ? <Users size={14} aria-hidden="true" /> : <Building2 size={14} aria-hidden="true" />}
                    {t === "contacts" ? "People" : "Companies"}
                  </button>
                ))}
              </div>
              <ul className="pg-menu-entries" aria-label="Predefined segments">
                {dir.segments
                  .filter((s) => s.predefined && s.target === target)
                  .map((s) => (
                    <SegmentEntry key={s.id} s={s} current={current?.id === s.id} onClick={() => onSegment(s.id)} />
                  ))}
              </ul>
              <ul className="pg-menu-entries" aria-label="Your segments">
                {dir.segments
                  .filter((s) => !s.predefined && s.target === target)
                  .map((s) => (
                    <SegmentEntry key={s.id} s={s} current={current?.id === s.id} onClick={() => onSegment(s.id)} />
                  ))}
              </ul>
            </>
          )}
        </SideMenu>
        <div className="pg-area-main">
          {error && (
            <p role="alert" className="pg-attr-error">
              {error}
            </p>
          )}
          {dir && current && (
            <SegmentView
              key={current.id + JSON.stringify(current.definition)}
              dir={dir}
              segment={current}
              menu={<ShowMenuButton state={menu} />}
              notice={notice}
              onSaved={(id, done) => {
                setNotice(done);
                void load().then(() => onSegment(id));
              }}
              onArchived={() => {
                setNotice(`Archived ${current.name}.`);
                void load().then(() => onSegment("all-users"));
              }}
            />
          )}
        </div>
      </div>
    </section>
  );
}

function SegmentEntry({ s, current, onClick }: { s: Segment; current: boolean; onClick: () => void }) {
  return (
    <li data-hue={s.predefined ? "teal" : "slate"}>
      <button aria-current={current ? "page" : undefined} onClick={onClick}>
        <span className="pg-menu-entry-icon" aria-hidden="true">
          {s.predefined ? s.target === "companies" ? <Building2 size={16} /> : <Users size={16} /> : <Filter size={16} />}
        </span>
        <span className="pg-menu-entry-name">{s.name}</span>
        <span className="pg-menu-entry-count">{s.count}</span>
      </button>
    </li>
  );
}

function SegmentView({
  dir,
  segment,
  menu,
  notice,
  onSaved,
  onArchived,
}: {
  dir: Directory;
  segment: Segment;
  menu: ReactNode;
  notice: string;
  onSaved: (id: string, done: string) => void;
  onArchived: () => void;
}) {
  const [def, setDef] = useState<SegmentDefinition>(segment.definition);
  const target = segment.target;
  const [people, setPeople] = useState<{ count: number; contacts?: Person[]; companies?: CompanyRow[] } | null>(null);
  const [page, setPage] = useState(0);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const changed = useMemo(() => JSON.stringify(def) !== JSON.stringify(segment.definition), [def, segment.definition]);
  const asked = useRef(0);
  // The live count: the rules as they are now, a moment after the last change.
  useEffect(() => {
    const n = ++asked.current;
    const t = setTimeout(() => {
      api<{ count: number; contacts?: Person[]; companies?: CompanyRow[] }>("people", changed ? { action: "list", target, definition: def, page: 0 } : { action: "list", segmentId: segment.id, page: 0 })
        .then((r) => {
          if (n !== asked.current) return;
          setPeople(r);
          setPage(0);
          setError("");
        })
        .catch((e) => n === asked.current && setError(message(e, "Those rules can't be used.")));
    }, 250);
    return () => clearTimeout(t);
  }, [def, changed, segment.id, target]);
  const more = async () => {
    const r = await api<{ count: number; contacts?: Person[]; companies?: CompanyRow[] }>("people", changed ? { action: "list", target, definition: def, page: page + 1 } : { action: "list", segmentId: segment.id, page: page + 1 });
    setPeople((p) =>
      p ? { count: r.count, ...(r.companies ? { companies: [...(p.companies ?? []), ...r.companies] } : { contacts: [...(p.contacts ?? []), ...(r.contacts ?? [])] }) } : r,
    );
    setPage(page + 1);
  };
  const shown = (people?.contacts ?? people?.companies ?? []).length;
  const noun = (n: number) => (target === "companies" ? (n === 1 ? "company matches" : "companies match") : n === 1 ? "person matches" : "people match");
  const save = async (asNew: boolean) => {
    try {
      const r = await api<{ id: string }>("people", { action: "save", ...(asNew ? { target } : { id: segment.id }), name: asNew ? name : segment.name, definition: def });
      onSaved(r.id, asNew ? `Saved ${name}.` : `Saved ${segment.name}.`);
    } catch (e) {
      setError(message(e, "The segment couldn't be saved."));
    }
  };
  return (
    <>
      <header className="pg-top pg-settings-head">
        {menu}
        <div>
          <h2>{segment.name}</h2>
          <p className="pg-muted" aria-live="polite" aria-label={target === "companies" ? "Companies matching" : "People matching"}>
            {people ? `${people.count} ${noun(people.count)}${changed ? " these rules" : ""}` : "Counting…"}
          </p>
        </div>
        <div className="pg-settings-save">
          {changed && !segment.predefined && (
            <button type="button" className="pg-primary" onClick={() => void save(false)}>
              Save segment
            </button>
          )}
          {changed && (
            <button type="button" className={segment.predefined ? "pg-primary" : "pg-zoe-secondary"} onClick={() => setNaming(true)}>
              Save as new segment
            </button>
          )}
          {!segment.predefined && !changed && (
            <button
              type="button"
              className="pg-zoe-secondary"
              onClick={async () => {
                try {
                  await api("people", { action: "archive", id: segment.id });
                  onArchived();
                } catch (e) {
                  setError(message(e, "The segment couldn't be archived."));
                }
              }}
            >
              Archive
            </button>
          )}
        </div>
      </header>
      <div className="pg-settings-body wide pg-people-body">
        {notice && (
          <p role="status" className="pg-muted">
            {notice}
          </p>
        )}
        {error && (
          <p role="alert" className="pg-attr-error">
            {error}
          </p>
        )}
        {naming && (
          <form
            className="pg-settings-row"
            aria-label="Name the segment"
            onSubmit={(e) => {
              e.preventDefault();
              void save(true);
            }}
          >
            <label className="pg-settings-field">
              <span className="pg-settings-label">Segment name</span>
              <input autoFocus maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <button type="submit" className="pg-primary">
              Save
            </button>
            <button type="button" className="pg-wf-link" onClick={() => setNaming(false)}>
              Cancel
            </button>
          </form>
        )}
        <section className="pg-people-rules" aria-label="Rules">
          <RulesEditor def={def} dir={dir} target={target} lead={target === "companies" ? "Companies that match" : "People who match"} onChange={setDef} />
        </section>
        <div className="pg-people-split">
          {target === "companies" ? (
            <table className="pg-email-records pg-people-table" aria-label="Companies">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Plan</th>
                  <th scope="col">Seats</th>
                  <th scope="col">Monthly spend</th>
                  <th scope="col">People</th>
                </tr>
              </thead>
              <tbody>
                {people?.companies?.map((c) => (
                  <tr key={c.id}>
                    <th scope="row">{c.name}</th>
                    <td>{c.plan ?? "—"}</td>
                    <td>{c.seats ?? "—"}</td>
                    <td>{c.monthlySpend === null ? "—" : c.monthlySpend.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                    <td>{c.people}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
          <table className="pg-email-records pg-people-table" aria-label="People">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Type</th>
                <th scope="col">Email</th>
                <th scope="col">Last seen</th>
                <th scope="col">First seen</th>
                <th scope="col">Signed up</th>
              </tr>
            </thead>
            <tbody>
              {people?.contacts?.map((c) => (
                <tr key={c.id} aria-selected={open === c.id}>
                  <th scope="row">
                    <button type="button" className="pg-wf-link" onClick={() => setOpen(c.id)}>
                      {c.name || c.email || "Unnamed"}
                    </button>
                  </th>
                  <td>{ROLE[c.role] ?? c.role}</td>
                  <td>{c.email ?? "—"}</td>
                  <td>{ago(c.lastSeenAt)}</td>
                  <td>{ago(c.firstSeenAt)}</td>
                  <td>{ago(c.signedUpAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          )}
          {open && <PersonPanel key={open} id={open} onClose={() => setOpen(null)} />}
        </div>
        {people && shown < people.count && (
          <button type="button" className="pg-zoe-secondary" onClick={() => void more()}>
            Show more
          </button>
        )}
        {people && !people.count && <p className="pg-muted">{target === "companies" ? "No company matches yet." : "Nobody matches yet."}</p>}
      </div>
    </>
  );
}

export function RuleEditor({ rule, index, dir, onChange, target = "contacts" }: { rule: Rule; index: number; dir: Directory; onChange: (r: Rule) => void; target?: SegmentTarget }) {
  const fields = fieldsFor(target);
  const f = fields[rule.field] ?? SEGMENT_FIELDS.attribute;
  const n = index + 1;
  const dated = rule.op === "more_than_days_ago" || rule.op === "less_than_days_ago";
  const ofCompany = companyAttribute(rule.field, target);
  return (
    <div className="pg-people-rule" role="group" aria-label={`Rule ${n}`}>
      <select aria-label={`Rule ${n}: filter on`} value={rule.field} onChange={(e) => onChange(fresh(e.target.value, dir, target))}>
        {Object.entries(fields).map(([id, x]) => (
          <option key={id} value={id}>
            {x.label}
          </option>
        ))}
      </select>
      {f.key === "attribute" && (
        <>
          <input aria-label={`Rule ${n}: attribute`} list={ofCompany ? "pg-people-company-attributes" : "pg-people-attributes"} value={rule.key ?? ""} onChange={(e) => onChange({ ...rule, key: e.target.value })} />
          <datalist id={ofCompany ? "pg-people-company-attributes" : "pg-people-attributes"}>
            {(ofCompany ? (dir.companyAttributes ?? []) : dir.attributes).map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
        </>
      )}
      {f.key === "event" && (
        <select aria-label={`Rule ${n}: event`} value={rule.key ?? ""} onChange={(e) => onChange({ ...rule, key: e.target.value })}>
          {!dir.events.length && <option value="">No events yet</option>}
          {dir.events.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
      )}
      {f.key === "subscription" && (
        <select aria-label={`Rule ${n}: subscription`} value={rule.key ?? ""} onChange={(e) => onChange({ ...rule, key: e.target.value })}>
          {!dir.subscriptions.length && <option value="">No subscriptions yet</option>}
          {dir.subscriptions.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      )}
      <select
        aria-label={`Rule ${n}: how`}
        value={rule.op}
        onChange={(e) => {
          const op = e.target.value as Op;
          const r: Rule = { field: rule.field, op, key: rule.key };
          if (f.tag) r.value = rule.value;
          else if (f.values) r.value = f.values[0];
          else if (op === "more_than_days_ago" || op === "less_than_days_ago") r.value = 30;
          else if (op === "greater_than" || op === "less_than") r.value = 0;
          else if (needsValue(op)) r.value = typeof rule.value === "string" ? rule.value : "";
          onChange(r);
        }}
      >
        {f.ops.map((o) => (
          <option key={o} value={o}>
            {opLabel(rule.field, o)}
          </option>
        ))}
      </select>
      {f.tag && (
        <select aria-label={`Rule ${n}: tag`} value={String(rule.value ?? "")} onChange={(e) => onChange({ ...rule, value: e.target.value })}>
          {!dir.tags?.length && <option value="">No tags yet</option>}
          {dir.tags?.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      )}
      {needsValue(rule.op) &&
        (f.values ? (
          <select aria-label={`Rule ${n}: value`} value={String(rule.value)} onChange={(e) => onChange({ ...rule, value: e.target.value })}>
            {f.values.map((v) => (
              <option key={v} value={v}>
                {rule.field === "unsubscribed" ? (v === "true" ? "yes" : "no") : (ROLE[v] ?? v)}
              </option>
            ))}
          </select>
        ) : dated || rule.op === "greater_than" || rule.op === "less_than" ? (
          <input
            aria-label={`Rule ${n}: ${dated ? "days" : "number"}`}
            type="number"
            min={dated ? 0 : undefined}
            value={String(rule.value ?? "")}
            onChange={(e) => onChange({ ...rule, value: e.target.value === "" ? undefined : Number(e.target.value) })}
          />
        ) : (
          <input aria-label={`Rule ${n}: value`} value={String(rule.value ?? "")} onChange={(e) => onChange({ ...rule, value: e.target.value })} />
        ))}
      {(rule.op === "performed" || rule.op === "not_performed") && (
        <>
          {rule.op === "performed" && (
            <label className="pg-settings-inline">
              at least
              <input aria-label={`Rule ${n}: times`} type="number" min={1} value={rule.count ?? 1} onChange={(e) => onChange({ ...rule, count: Number(e.target.value) || 1 })} />
              times
            </label>
          )}
          <label className="pg-settings-inline">
            in the last
            <input
              aria-label={`Rule ${n}: within days`}
              type="number"
              min={1}
              placeholder="any"
              value={rule.days ?? ""}
              onChange={(e) => onChange({ ...rule, days: e.target.value === "" ? undefined : Number(e.target.value) })}
            />
            days
          </label>
        </>
      )}
    </div>
  );
}

/**
 * A definition's rules, grouped (P2a): the top group's "all" or "any", its rules, and groups within
 * it (3 deep at most), each with its own "all" or "any". Rules are numbered in reading order, so
 * "Rule 3" is the third on the page, however it's grouped.
 */
export function RulesEditor({ def, dir, target, lead, onChange }: { def: SegmentDefinition; dir: Directory; target: SegmentTarget; lead: string; onChange: (d: SegmentDefinition) => void }) {
  return <GroupEditor group={def} dir={dir} target={target} lead={lead} depth={1} firstRule={0} number={0} firstChild={1} onChange={onChange} />;
}

/** How many rules and groups a group holds, however deep. */
const tally = (g: SegmentGroup): { rules: number; groups: number } =>
  g.rules.reduce(
    (t, r) => {
      if (!isGroup(r)) return { rules: t.rules + 1, groups: t.groups };
      const x = tally(r);
      return { rules: t.rules + x.rules, groups: t.groups + 1 + x.groups };
    },
    { rules: 0, groups: 0 },
  );

function GroupEditor({
  group,
  dir,
  target,
  lead,
  depth,
  firstRule,
  number,
  firstChild,
  onChange,
  onRemove,
}: {
  group: SegmentGroup;
  dir: Directory;
  target: SegmentTarget;
  lead: string;
  depth: number;
  /** How many rules come before this group's first, on the page. */
  firstRule: number;
  /** This group's number (the top group has none), and its first inner group's. */
  number: number;
  firstChild: number;
  onChange: (g: SegmentGroup) => void;
  onRemove?: () => void;
}) {
  const top = depth === 1;
  const label = top ? "" : `Group ${number}`;
  // Each item's place in the reading order: a rule's number, or a group's and its first rule's.
  const places: { rule: number; group: number; child: number }[] = [];
  let nextRule = firstRule;
  let nextGroup = firstChild;
  for (const item of group.rules) {
    if (isGroup(item)) {
      places.push({ rule: nextRule, group: nextGroup, child: nextGroup + 1 });
      const t = tally(item);
      nextRule += t.rules;
      nextGroup += 1 + t.groups;
    } else places.push({ rule: nextRule++, group: 0, child: 0 });
  }
  const set = (i: number, item: SegmentItem) => onChange({ ...group, rules: group.rules.map((x, j) => (j === i ? item : x)) });
  const remove = (i: number) => onChange({ ...group, rules: group.rules.filter((_, j) => j !== i) });
  return (
    <div className={top ? "pg-people-group-top" : "pg-people-group"} role={top ? undefined : "group"} aria-label={top ? undefined : label}>
      <div className="pg-settings-row pg-people-group-head">
        <label className="pg-settings-inline">
          {top ? lead : "Match"}
          <select aria-label={top ? "Match" : `${label}: match`} value={group.match} onChange={(e) => onChange({ ...group, match: e.target.value as "all" | "any" })}>
            <option value="all">all</option>
            <option value="any">any</option>
          </select>
          of these rules
        </label>
        {onRemove && (
          <button type="button" className="pg-wf-link" aria-label={`Remove ${label.toLowerCase()}`} onClick={onRemove}>
            <Trash2 size={14} aria-hidden="true" />
          </button>
        )}
      </div>
      <ol className="pg-people-rule-list">
        {group.rules.map((item, i) => {
          if (isGroup(item))
            return (
              <li key={i} className="pg-people-group-item">
                <GroupEditor
                  group={item}
                  dir={dir}
                  target={target}
                  lead={lead}
                  depth={depth + 1}
                  firstRule={places[i].rule}
                  number={places[i].group}
                  firstChild={places[i].child}
                  onChange={(g) => set(i, g)}
                  onRemove={() => remove(i)}
                />
              </li>
            );
          const n = places[i].rule;
          return (
            <li key={i}>
              <RuleEditor rule={item} index={n} dir={dir} target={target} onChange={(x) => set(i, x)} />
              <button type="button" className="pg-wf-link" aria-label={`Remove rule ${n + 1}`} onClick={() => remove(i)}>
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ol>
      <div className="pg-people-group-actions">
        <button type="button" className="pg-zoe-secondary" aria-label={top ? "Add rule" : `${label}: add rule`} onClick={() => onChange({ ...group, rules: [...group.rules, fresh("attribute", dir, target)] })}>
          <Plus size={14} aria-hidden="true" /> Add rule
        </button>
        {depth < MAX_DEPTH && (
          <button
            type="button"
            className="pg-zoe-secondary"
            aria-label={top ? "Add group" : `${label}: add group`}
            onClick={() => onChange({ ...group, rules: [...group.rules, { match: "any", rules: [fresh("attribute", dir, target)] }] })}
          >
            <FolderPlus size={14} aria-hidden="true" /> Add group
          </button>
        )}
      </div>
    </div>
  );
}

function PersonPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const [d, setD] = useState<Details | null>(null);
  const [error, setError] = useState("");
  // Each person is its own panel (keyed by id), so nothing of the last one shows while loading.
  useEffect(() => {
    api<Details>("people", { action: "contact", contactId: id })
      .then(setD)
      .catch((e) => setError(message(e, "This person couldn't be loaded.")));
  }, [id]);
  const c = d?.contact;
  return (
    <aside className="pg-people-person" aria-label={c ? `About ${c.name || c.emails[0] || "this person"}` : "About this person"}>
      <header>
        <h3>{c ? c.name || c.emails[0] || "Unnamed" : "…"}</h3>
        <button type="button" className="pg-wf-link" aria-label="Close" onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      {error && <p className="pg-attr-error">{error}</p>}
      {c && d && (
        <>
          <dl className="pg-people-facts">
            <dt>Type</dt>
            <dd>{ROLE[c.role] ?? c.role}</dd>
            {c.externalId && (
              <>
                <dt>User ID</dt>
                <dd>{c.externalId}</dd>
              </>
            )}
            <dt>Email</dt>
            <dd>{c.emails.join(", ") || "—"}</dd>
            {c.phones.length > 0 && (
              <>
                <dt>Phone</dt>
                <dd>{c.phones.join(", ")}</dd>
              </>
            )}
            <dt>Last seen</dt>
            <dd>{ago(c.lastSeenAt)}</dd>
            <dt>Signed up</dt>
            <dd>{ago(c.signedUpAt)}</dd>
            {Object.entries(c.attributes)
              .filter(([, v]) => v === null || typeof v !== "object")
              .slice(0, 30)
              .map(([k, v]) => (
                <div key={k} className="pg-people-fact">
                  <dt>{k}</dt>
                  <dd>{String(v)}</dd>
                </div>
              ))}
          </dl>
          <h4>Subscriptions</h4>
          {c.unsubscribedFromAll && <p className="pg-muted">Unsubscribed from everything.</p>}
          <ul className="pg-suppressions" aria-label="Subscriptions">
            {d.subscriptions.map((s) => (
              <li key={s.id}>
                <div>
                  <strong>{s.name}</strong>
                  <span className="pg-muted">{CHANNELS[s.channel] ?? s.channel}</span>
                </div>
                <span className="pg-email-status" data-status={s.state === "opted_in" ? "verified" : "failed"}>
                  {s.state === "opted_in" ? "Subscribed" : "Unsubscribed"}
                </span>
              </li>
            ))}
            {!d.subscriptions.length && <li className="pg-muted">No subscription types yet.</li>}
          </ul>
          <h4>Latest events</h4>
          <ul className="pg-suppressions" aria-label="Latest events">
            {d.events.map((e, i) => (
              <li key={i}>
                <div>
                  <strong>{e.name}</strong>
                  <span className="pg-muted">
                    {new Date(e.at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · {e.source === "api" ? "from your server" : "in the messenger"}
                    {Object.keys(e.metadata).length ? ` · ${Object.entries(e.metadata).map(([k, v]) => `${k}: ${String(v)}`).join(", ")}` : ""}
                  </span>
                </div>
              </li>
            ))}
            {!d.events.length && <li className="pg-muted">No events yet.</li>}
          </ul>
        </>
      )}
    </aside>
  );
}

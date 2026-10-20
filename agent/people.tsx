import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Filter, Plus, Trash2, Users, X } from "lucide-react";
import { api } from "./api";
import { ShowMenuButton, SideMenu, useSideMenu } from "./shell";
import { message } from "./settings-ui";
import { SEGMENT_FIELDS, type Op, type Rule, type SegmentDefinition } from "../lib/segments";

/**
 * People (phase 13, step O1; docs/OUTBOUND_STEP1.md), behind `segments_v1`, at `#people` and
 * `#people/<segment>`: contacts by segment, after Intercom's Contacts. The side menu lists the
 * predefined segments and saved ones with their counts; the rules above the list are the
 * segment's, and changing them shows a live count before saving (as a new segment, or over a
 * saved one). A person opens beside the list: their details, latest events and subscriptions.
 */
type Segment = { id: string; name: string; predefined: boolean; definition: SegmentDefinition; count: number };
export type Directory = { segments: Segment[]; attributes: string[]; events: string[]; subscriptions: { id: string; name: string; channel: string }[] };
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
};
const ago = (iso: string | null) => {
  if (!iso) return "—";
  const d = (Date.now() - Date.parse(iso)) / 86_400_000;
  return d < 1 ? "Today" : d < 2 ? "Yesterday" : d < 60 ? `${Math.floor(d)} days ago` : new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};
const needsValue = (op: Op) => !["is_set", "is_not_set", "performed", "not_performed", "opted_in", "opted_out"].includes(op);
/** A new rule on a field, with a first value that makes sense for it. */
export function fresh(field: string, dir: Directory): Rule {
  const f = SEGMENT_FIELDS[field];
  const op = f.ops[0];
  const r: Rule = { field, op };
  if (f.key === "event") r.key = dir.events[0] ?? "";
  if (f.key === "subscription") r.key = dir.subscriptions[0]?.id ?? "";
  if (f.key === "attribute") r.key = dir.attributes[0] ?? "";
  if (f.values) r.value = f.values[0];
  else if (op === "more_than_days_ago" || op === "less_than_days_ago") r.value = 30;
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
  return (
    <section className="pg-workspace pg-people" aria-label="People">
      <div className="pg-area">
        <SideMenu state={menu} title="People" label="People menu">
          {dir && (
            <>
              <ul className="pg-menu-entries" aria-label="Predefined segments">
                {dir.segments
                  .filter((s) => s.predefined)
                  .map((s) => (
                    <SegmentEntry key={s.id} s={s} current={current?.id === s.id} onClick={() => onSegment(s.id)} />
                  ))}
              </ul>
              <ul className="pg-menu-entries" aria-label="Your segments">
                {dir.segments
                  .filter((s) => !s.predefined)
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
          {s.predefined ? <Users size={16} /> : <Filter size={16} />}
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
  const [people, setPeople] = useState<{ count: number; contacts: Person[] } | null>(null);
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
      api<{ count: number; contacts: Person[] }>("people", changed ? { action: "list", definition: def, page: 0 } : { action: "list", segmentId: segment.id, page: 0 })
        .then((r) => {
          if (n !== asked.current) return;
          setPeople(r);
          setPage(0);
          setError("");
        })
        .catch((e) => n === asked.current && setError(message(e, "Those rules can't be used.")));
    }, 250);
    return () => clearTimeout(t);
  }, [def, changed, segment.id]);
  const more = async () => {
    const r = await api<{ count: number; contacts: Person[] }>("people", changed ? { action: "list", definition: def, page: page + 1 } : { action: "list", segmentId: segment.id, page: page + 1 });
    setPeople((p) => (p ? { count: r.count, contacts: [...p.contacts, ...r.contacts] } : r));
    setPage(page + 1);
  };
  const save = async (asNew: boolean) => {
    try {
      const r = await api<{ id: string }>("people", { action: "save", ...(asNew ? {} : { id: segment.id }), name: asNew ? name : segment.name, definition: def });
      onSaved(r.id, asNew ? `Saved ${name}.` : `Saved ${segment.name}.`);
    } catch (e) {
      setError(message(e, "The segment couldn't be saved."));
    }
  };
  const setRule = (i: number, r: Rule) => setDef({ ...def, rules: def.rules.map((x, j) => (j === i ? r : x)) });
  return (
    <>
      <header className="pg-top pg-settings-head">
        {menu}
        <div>
          <h2>{segment.name}</h2>
          <p className="pg-muted" aria-live="polite" aria-label="People matching">
            {people ? `${people.count} ${people.count === 1 ? "person matches" : "people match"}${changed ? " these rules" : ""}` : "Counting…"}
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
          <div className="pg-settings-row">
            <label className="pg-settings-inline">
              People who match
              <select aria-label="Match" value={def.match} onChange={(e) => setDef({ ...def, match: e.target.value as "all" | "any" })}>
                <option value="all">all</option>
                <option value="any">any</option>
              </select>
              of these rules
            </label>
          </div>
          <ol className="pg-people-rule-list">
            {def.rules.map((r, i) => (
              <li key={i}>
                <RuleEditor rule={r} index={i} dir={dir} onChange={(x) => setRule(i, x)} />
                <button type="button" className="pg-wf-link" aria-label={`Remove rule ${i + 1}`} onClick={() => setDef({ ...def, rules: def.rules.filter((_, j) => j !== i) })}>
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ol>
          <button type="button" className="pg-zoe-secondary" onClick={() => setDef({ ...def, rules: [...def.rules, fresh("attribute", dir)] })}>
            <Plus size={14} aria-hidden="true" /> Add rule
          </button>
        </section>
        <div className="pg-people-split">
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
              {people?.contacts.map((c) => (
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
          {open && <PersonPanel key={open} id={open} onClose={() => setOpen(null)} />}
        </div>
        {people && people.contacts.length < people.count && (
          <button type="button" className="pg-zoe-secondary" onClick={() => void more()}>
            Show more
          </button>
        )}
        {people && !people.count && <p className="pg-muted">Nobody matches yet.</p>}
      </div>
    </>
  );
}

export function RuleEditor({ rule, index, dir, onChange }: { rule: Rule; index: number; dir: Directory; onChange: (r: Rule) => void }) {
  const f = SEGMENT_FIELDS[rule.field];
  const n = index + 1;
  const dated = rule.op === "more_than_days_ago" || rule.op === "less_than_days_ago";
  return (
    <div className="pg-people-rule" role="group" aria-label={`Rule ${n}`}>
      <select aria-label={`Rule ${n}: filter on`} value={rule.field} onChange={(e) => onChange(fresh(e.target.value, dir))}>
        {Object.entries(SEGMENT_FIELDS).map(([id, x]) => (
          <option key={id} value={id}>
            {x.label}
          </option>
        ))}
      </select>
      {f.key === "attribute" && (
        <>
          <input aria-label={`Rule ${n}: attribute`} list="pg-people-attributes" value={rule.key ?? ""} onChange={(e) => onChange({ ...rule, key: e.target.value })} />
          <datalist id="pg-people-attributes">
            {dir.attributes.map((a) => (
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
          if (f.values) r.value = f.values[0];
          else if (op === "more_than_days_ago" || op === "less_than_days_ago") r.value = 30;
          else if (op === "greater_than" || op === "less_than") r.value = 0;
          else if (needsValue(op)) r.value = typeof rule.value === "string" ? rule.value : "";
          onChange(r);
        }}
      >
        {f.ops.map((o) => (
          <option key={o} value={o}>
            {OPS[o]}
          </option>
        ))}
      </select>
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

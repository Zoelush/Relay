import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Megaphone, MessageSquare, Pause, Play, Plus, Send, Trash2 } from "lucide-react";
import { api } from "./api";
import { ShowMenuButton, SideMenu, useSideMenu } from "./shell";
import { message } from "./settings-ui";
import { fresh, RuleEditor, type Directory } from "./people";
import type { OutboundDefinition, SendTimeRule } from "../lib/outbound";

/**
 * Outbound (phase 13, step O3; docs/OUTBOUND_STEP3.md), behind `outbound_v1`, for managers, at
 * `#outbound` (a view) and `#outbound/m/<id>` (one message): after Intercom's Outbound. The list
 * shows each message's state, type and numbers; the editor holds its content, audience (with the
 * live size), delivery, subscription, goal and holdout, and publishes it now or at a time. A
 * message's page also shows its versions, its numbers against the control group, and who it
 * reached. Everything is checked by the engine (`server/outbound.ts`); the editor only shows why.
 */
type Stats = {
  sent: number;
  seen: number;
  replied: number;
  clicked: number;
  dismissed: number;
  heldOut: number;
  suppressed: number;
  pending: number;
  goal: null | { event: string; days: number; sent: { n: number; converted: number }; control: { n: number; converted: number }; verdict: string };
};
type Row = { id: string; title: string; type: "chat" | "banner"; state: string; liveVersion: number | null; updatedAt: string; stats: Stats };
type Choices = { teammates: { id: string; name: string }[]; subscriptions: { id: string; name: string }[]; segments: { id: string; name: string }[]; events: string[]; attributes: string[] };
type List = { messages: Row[]; choices: Choices };
type Detail = {
  message: { id: string; title: string; type: "chat" | "banner"; state: string; liveVersion: number | null };
  draft: OutboundDefinition;
  problems: string[];
  versions: { version: number; effectiveAt: string; publishedBy: string }[];
  stats: Stats;
  entries: { id: string; name: string; email: string | null; version: number; variant: string; status: string; reason: string; enteredAt: string | null; seenAt: string | null; repliedAt: string | null; clickedAt: string | null; dismissedAt: string | null }[];
};
const VIEWS = [
  { id: "all", label: "All messages" },
  { id: "live", label: "Live" },
  { id: "draft", label: "Drafts" },
  { id: "paused", label: "Paused" },
] as const;
const STATE: Record<string, string> = { live: "Live", draft: "Draft", paused: "Paused", archived: "Archived" };
const TYPES = { chat: "Chat", banner: "Banner" } as const;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "—");

export function Outbound({ open, onOpen }: { open: string | null; onOpen: (page: string | null) => void }) {
  const menu = useSideMenu("outbound");
  const [list, setList] = useState<List | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(
    () =>
      api<List>("outbound")
        .then(setList)
        .catch((e) => setError(message(e, "Outbound couldn't be loaded."))),
    [],
  );
  useEffect(() => {
    void load();
  }, [load, open]);
  const view = open && !open.startsWith("m/") ? open : "all";
  const messageId = open?.startsWith("m/") ? open.slice(2) : null;
  return (
    <section className="pg-workspace pg-wf" aria-label="Outbound">
      <div className="pg-area">
        <SideMenu state={menu} title="Outbound" label="Outbound menu">
          <ul className="pg-menu-entries">
            {VIEWS.map((v) => (
              <li key={v.id} data-hue="green">
                <button aria-current={!messageId && view === v.id ? "page" : undefined} onClick={() => onOpen(v.id === "all" ? null : v.id)}>
                  <span className="pg-menu-entry-icon" aria-hidden="true">
                    <Send size={16} />
                  </span>
                  <span className="pg-menu-entry-name">{v.label}</span>
                  <span className="pg-menu-entry-count">{list ? list.messages.filter((m) => v.id === "all" || m.state === v.id).length : ""}</span>
                </button>
              </li>
            ))}
          </ul>
        </SideMenu>
        <div className="pg-area-main">
          {error && (
            <p role="alert" className="pg-attr-error">
              {error}
            </p>
          )}
          {messageId && list ? (
            <Editor key={messageId} id={messageId} choices={list.choices} menu={<ShowMenuButton state={menu} />} onBack={() => onOpen(null)} onChanged={() => void load()} />
          ) : (
            list && <MessageList list={list} view={view} menu={<ShowMenuButton state={menu} />} onOpen={(id) => onOpen("m/" + id)} />
          )}
        </div>
      </div>
    </section>
  );
}

function MessageList({ list, view, menu, onOpen }: { list: List; view: string; menu: React.ReactNode; onOpen: (id: string) => void }) {
  const [type, setType] = useState("");
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [newType, setNewType] = useState<"chat" | "banner">("chat");
  const [error, setError] = useState("");
  const rows = list.messages.filter((m) => (view === "all" || m.state === view) && (!type || m.type === type));
  return (
    <>
      <header className="pg-top pg-settings-head">
        {menu}
        <div>
          <h2>{VIEWS.find((v) => v.id === view)?.label ?? "Messages"}</h2>
          <p className="pg-muted">Reach people before they contact you: chats and banners in your product, to the people you choose, within the limits in Settings › Outbound.</p>
        </div>
        <div className="pg-settings-save">
          <select aria-label="Content type" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All content types</option>
            <option value="chat">Chats</option>
            <option value="banner">Banners</option>
          </select>
          <button type="button" className="pg-primary" onClick={() => setCreating(true)}>
            <Plus size={14} aria-hidden="true" /> New message
          </button>
        </div>
      </header>
      <div className="pg-settings-body wide">
        {creating && (
          <form
            className="pg-settings-row pg-people-rules"
            aria-label="New message"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                const d = await api<Detail>("outbound-message", { action: "create", type: newType, title: title || "Untitled" });
                onOpen(d.message.id);
              } catch (x) {
                setError(message(x, "The message couldn't be made."));
              }
            }}
          >
            <label className="pg-settings-field">
              <span className="pg-settings-label">Title</span>
              <input autoFocus maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label className="pg-settings-field">
              <span className="pg-settings-label">Type</span>
              <select value={newType} onChange={(e) => setNewType(e.target.value as "chat" | "banner")}>
                <option value="chat">Chat</option>
                <option value="banner">Banner</option>
              </select>
            </label>
            <button type="submit" className="pg-primary">
              Create
            </button>
            <button type="button" className="pg-wf-link" onClick={() => setCreating(false)}>
              Cancel
            </button>
            {error && <p className="pg-attr-error">{error}</p>}
          </form>
        )}
        {rows.length ? (
          <table className="pg-email-records pg-people-table" aria-label="Messages">
            <thead>
              <tr>
                <th scope="col">Title</th>
                <th scope="col">Type</th>
                <th scope="col">State</th>
                <th scope="col">Sent</th>
                <th scope="col">Engaged</th>
                <th scope="col">Goal</th>
                <th scope="col">Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id}>
                  <th scope="row">
                    <button type="button" className="pg-wf-link" onClick={() => onOpen(m.id)}>
                      {m.title}
                    </button>
                  </th>
                  <td>
                    {m.type === "chat" ? <MessageSquare size={13} aria-hidden="true" /> : <Megaphone size={13} aria-hidden="true" />} {TYPES[m.type]}
                  </td>
                  <td>
                    <span className="pg-email-status" data-status={m.state === "live" ? "verified" : m.state === "paused" ? "failed" : "pending"}>
                      {STATE[m.state]}
                    </span>
                  </td>
                  <td>{m.stats.sent}</td>
                  <td>{m.type === "chat" ? `${pct(m.stats.replied, m.stats.sent)} replied` : `${pct(m.stats.clicked, m.stats.sent)} clicked`}</td>
                  <td>{m.stats.goal ? pct(m.stats.goal.sent.converted, m.stats.goal.sent.n) : "—"}</td>
                  <td>{when(m.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="pg-muted">No messages here yet.</p>
        )}
      </div>
    </>
  );
}

function Editor({ id, choices, menu, onBack, onChanged }: { id: string; choices: Choices; menu: React.ReactNode; onBack: () => void; onChanged: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [def, setDef] = useState<OutboundDefinition | null>(null);
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [size, setSize] = useState<string>("");
  const [at, setAt] = useState("");
  const load = useCallback(
    () =>
      api<Detail>(`outbound-message?id=${encodeURIComponent(id)}`)
        .then((x) => {
          setD(x);
          setDef(x.draft);
          setTitle(x.message.title);
        })
        .catch((e) => setError(message(e, "This message couldn't be loaded."))),
    [id],
  );
  useEffect(() => {
    void load();
  }, [load]);
  // The live size: the audience as it stands, a moment after the last change.
  const asked = useRef(0);
  const audience = def ? JSON.stringify(def.audience) : "";
  useEffect(() => {
    if (!def) return;
    const n = ++asked.current;
    const t = setTimeout(() => {
      api<{ count: number; sendTimeRules: number }>("outbound-message", { action: "audience", definition: def })
        .then((r) => n === asked.current && setSize(`${r.count} ${r.count === 1 ? "person matches" : "people match"} now${r.sendTimeRules ? ", then the page rules when they visit" : ""}.`))
        .catch((e) => n === asked.current && setSize(message(e, "The audience can't be counted.")));
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audience]);
  const act = async (body: Record<string, unknown>, done: string) => {
    setError("");
    setNotice("");
    try {
      const r = await api<Detail | { archived: true }>("outbound-message", { id, ...body });
      if ("archived" in r) {
        onChanged();
        onBack();
        return;
      }
      setD(r);
      setDef(r.draft);
      setTitle(r.message.title);
      setNotice(done);
      onChanged();
    } catch (e) {
      setError(message(e, "That didn't work."));
    }
  };
  if (!d || !def) return error ? <p className="pg-attr-error">{error}</p> : null;
  const set = (x: Partial<OutboundDefinition>) => setDef({ ...def, ...x });
  const dir: Directory = { segments: [], attributes: choices.attributes, events: choices.events, subscriptions: choices.subscriptions.map((s) => ({ ...s, channel: "in_app" })) };
  const save = () => act({ action: "save", title, definition: def }, "Saved.");
  const m = d.message;
  return (
    <>
      <header className="pg-top pg-settings-head">
        {menu}
        <button type="button" className="pg-wf-link" aria-label="Back to messages" onClick={onBack}>
          <ArrowLeft size={16} aria-hidden="true" />
        </button>
        <div>
          <input className="pg-outbound-title" aria-label="Message title" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
          <p className="pg-muted">
            {TYPES[m.type]} · <span aria-label="Message state">{STATE[m.state]}</span>
            {m.liveVersion ? ` · version ${m.liveVersion} live` : ""}
          </p>
        </div>
        <div className="pg-settings-save">
          <button type="button" className="pg-zoe-secondary" onClick={() => void save()}>
            Save draft
          </button>
          {m.state === "live" && (
            <button type="button" className="pg-zoe-secondary" onClick={() => void act({ action: "pause" }, "Paused: nothing more is sent.")}>
              <Pause size={14} aria-hidden="true" /> Pause
            </button>
          )}
          {m.state === "paused" && (
            <button type="button" className="pg-zoe-secondary" onClick={() => void act({ action: "resume" }, "Live again.")}>
              <Play size={14} aria-hidden="true" /> Resume
            </button>
          )}
          <button
            type="button"
            className="pg-primary"
            onClick={async () => {
              await act({ action: "save", title, definition: def }, "");
              await act({ action: "publish", ...(at ? { at: new Date(at).toISOString() } : {}) }, at ? `Version scheduled for ${when(new Date(at).toISOString())}.` : "Published: it's live.");
            }}
          >
            {m.state === "draft" ? "Set live" : "Publish changes"}
          </button>
        </div>
      </header>
      <div className="pg-settings-body wide pg-outbound-body">
        {error && (
          <p role="alert" className="pg-attr-error">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="pg-muted">
            {notice}
          </p>
        )}
        {d.problems.length > 0 && (
          <ul className="pg-outbound-problems" aria-label="What stops it going live">
            {d.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <div className="pg-outbound-columns">
          <div className="pg-settings-stack">
            <Section title="Content">
              {def.type === "chat" ? (
                <>
                  <label className="pg-settings-field">
                    <span className="pg-settings-label">From</span>
                    <select value={def.content.senderId ?? ""} onChange={(e) => set({ content: { ...def.content, senderId: e.target.value } })}>
                      {choices.teammates.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="pg-settings-field">
                    <span className="pg-settings-label">Message</span>
                    <textarea rows={4} maxLength={5000} value={def.content.text} onChange={(e) => set({ content: { ...def.content, text: e.target.value } })} />
                  </label>
                </>
              ) : (
                <>
                  <label className="pg-settings-field">
                    <span className="pg-settings-label">Banner text</span>
                    <textarea rows={2} maxLength={300} value={def.content.text} onChange={(e) => set({ content: { ...def.content, text: e.target.value } })} />
                  </label>
                  <div className="pg-settings-row">
                    <label className="pg-settings-field">
                      <span className="pg-settings-label">Position</span>
                      <select value={def.content.position ?? "top"} onChange={(e) => set({ content: { ...def.content, position: e.target.value as "top" | "bottom" } })}>
                        <option value="top">Top of the page</option>
                        <option value="bottom">Bottom of the page</option>
                      </select>
                    </label>
                    <label className="pg-settings-toggle">
                      <input type="checkbox" checked={def.content.dismissible !== false} onChange={(e) => set({ content: { ...def.content, dismissible: e.target.checked } })} /> People can close it
                    </label>
                  </div>
                  <div className="pg-settings-row">
                    <label className="pg-settings-field">
                      <span className="pg-settings-label">Button label (optional)</span>
                      <input
                        maxLength={40}
                        value={def.content.action?.label ?? ""}
                        onChange={(e) => set({ content: { ...def.content, action: e.target.value || def.content.action?.url ? { label: e.target.value, url: def.content.action?.url ?? "" } : null } })}
                      />
                    </label>
                    <label className="pg-settings-field">
                      <span className="pg-settings-label">Button link (https)</span>
                      <input
                        value={def.content.action?.url ?? ""}
                        onChange={(e) => set({ content: { ...def.content, action: e.target.value || def.content.action?.label ? { label: def.content.action?.label ?? "", url: e.target.value } : null } })}
                      />
                    </label>
                  </div>
                </>
              )}
            </Section>
            <Section title="Audience" description={size}>
              <label className="pg-settings-field">
                <span className="pg-settings-label">Segment</span>
                <select value={def.audience.segmentId ?? ""} onChange={(e) => set({ audience: { ...def.audience, segmentId: e.target.value || null } })}>
                  <option value="">Everyone</option>
                  {choices.segments.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="pg-settings-inline">
                and who match
                <select aria-label="Match" value={def.audience.rules.match} onChange={(e) => set({ audience: { ...def.audience, rules: { ...def.audience.rules, match: e.target.value as "all" | "any" } } })}>
                  <option value="all">all</option>
                  <option value="any">any</option>
                </select>
                of these rules
              </label>
              <ol className="pg-people-rule-list">
                {def.audience.rules.rules.map((r, i) => (
                  <li key={i}>
                    <RuleEditor
                      rule={r}
                      index={i}
                      dir={dir}
                      onChange={(x) => set({ audience: { ...def.audience, rules: { ...def.audience.rules, rules: def.audience.rules.rules.map((y, j) => (j === i ? x : y)) } } })}
                    />
                    <button
                      type="button"
                      className="pg-wf-link"
                      aria-label={`Remove rule ${i + 1}`}
                      onClick={() => set({ audience: { ...def.audience, rules: { ...def.audience.rules, rules: def.audience.rules.rules.filter((_, j) => j !== i) } } })}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ol>
              <button type="button" className="pg-zoe-secondary" onClick={() => set({ audience: { ...def.audience, rules: { ...def.audience.rules, rules: [...def.audience.rules.rules, fresh("attribute", dir)] } } })}>
                <Plus size={14} aria-hidden="true" /> Add rule
              </button>
              <SendTimeRules rules={def.audience.sendTime} onChange={(sendTime) => set({ audience: { ...def.audience, sendTime } })} />
            </Section>
            <Section title="Delivery">
              <Delivery def={def} events={choices.events} set={set} />
            </Section>
            <Section title="Subscription, goal and control group">
              <label className="pg-settings-field">
                <span className="pg-settings-label">Subscription type</span>
                <select value={def.subscriptionTypeId} onChange={(e) => set({ subscriptionTypeId: e.target.value })}>
                  <option value="">Choose…</option>
                  {choices.subscriptions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="pg-settings-row">
                <label className="pg-settings-field">
                  <span className="pg-settings-label">Goal event</span>
                  <select value={def.goal?.event ?? ""} onChange={(e) => set({ goal: e.target.value ? { event: e.target.value, days: def.goal?.days ?? 14 } : null })}>
                    <option value="">No goal</option>
                    {choices.events.map((x) => (
                      <option key={x} value={x}>
                        {x}
                      </option>
                    ))}
                  </select>
                </label>
                {def.goal && (
                  <label className="pg-settings-field">
                    <span className="pg-settings-label">Within (days)</span>
                    <input type="number" min={1} max={90} value={def.goal.days} onChange={(e) => set({ goal: { ...def.goal!, days: Number(e.target.value) } })} />
                  </label>
                )}
                <label className="pg-settings-field">
                  <span className="pg-settings-label">Control group (%)</span>
                  <input type="number" min={0} max={50} value={def.holdoutPercent} onChange={(e) => set({ holdoutPercent: Number(e.target.value) })} />
                </label>
              </div>
            </Section>
          </div>
          <div className="pg-settings-stack">
            <Section title="Numbers">
              <StatsView type={def.type} stats={d.stats} />
            </Section>
            <Section title="Publish" description="A new version takes over now, or at a time you choose. People already in it keep theirs.">
              <label className="pg-settings-field">
                <span className="pg-settings-label">Schedule the change (optional)</span>
                <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
              </label>
              <ul className="pg-suppressions" aria-label="Versions">
                {d.versions.map((v) => (
                  <li key={v.version}>
                    <div>
                      <strong>Version {v.version}</strong>
                      <span className="pg-muted">from {when(v.effectiveAt)}</span>
                    </div>
                  </li>
                ))}
                {!d.versions.length && <li className="pg-muted">Not live yet.</li>}
              </ul>
              <button type="button" className="pg-wf-link" onClick={() => void act({ action: "archive" }, "")}>
                Archive this message
              </button>
            </Section>
          </div>
        </div>
        <Section title="Who it reached" description="The latest 50: each person's group, what happened, and why.">
          <table className="pg-email-records pg-people-table" aria-label="Who it reached">
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Group</th>
                <th scope="col">Status</th>
                <th scope="col">Entered</th>
                <th scope="col">{def.type === "chat" ? "Replied" : "Clicked"}</th>
              </tr>
            </thead>
            <tbody>
              {d.entries.map((e) => (
                <tr key={e.id}>
                  <th scope="row">{e.name || e.email || "Unnamed"}</th>
                  <td>{e.variant === "control" ? "Control" : `Version ${e.version}`}</td>
                  <td>
                    {e.status}
                    {e.reason ? ` · ${e.reason}` : ""}
                  </td>
                  <td>{when(e.enteredAt)}</td>
                  <td>{when(def.type === "chat" ? e.repliedAt : e.clickedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!d.entries.length && <p className="pg-muted">Nobody yet.</p>}
        </Section>
      </div>
    </>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="pg-settings-card" aria-label={title}>
      <h3 className="pg-settings-subhead">{title}</h3>
      {description && <p className="pg-muted">{description}</p>}
      {children}
    </section>
  );
}

function SendTimeRules({ rules, onChange }: { rules: SendTimeRule[]; onChange: (r: SendTimeRule[]) => void }) {
  const upd = (i: number, r: SendTimeRule) => onChange(rules.map((x, j) => (j === i ? r : x)));
  return (
    <div className="pg-settings-stack">
      <span className="pg-settings-label">On the page</span>
      {rules.map((r, i) => (
        <div key={i} className="pg-people-rule" role="group" aria-label={`Page rule ${i + 1}`}>
          <select
            aria-label={`Page rule ${i + 1}: on`}
            value={r.field}
            onChange={(e) => {
              const f = e.target.value;
              upd(
                i,
                f === "page_url"
                  ? { field: "page_url", op: "contains", value: "" }
                  : f === "device"
                    ? { field: "device", op: "is", value: "desktop" }
                    : f === "locale"
                      ? { field: "locale", op: "starts_with", value: "en" }
                      : { field: "open_conversation", op: "is", value: false },
              );
            }}
          >
            <option value="page_url">Page address</option>
            <option value="device">Device</option>
            <option value="locale">Language</option>
            <option value="open_conversation">Has an open conversation</option>
          </select>
          {r.field === "page_url" && (
            <>
              <select aria-label={`Page rule ${i + 1}: how`} value={r.op} onChange={(e) => upd(i, { ...r, op: e.target.value as typeof r.op })}>
                <option value="contains">contains</option>
                <option value="not_contains">doesn&apos;t contain</option>
                <option value="starts_with">starts with</option>
                <option value="is">is</option>
              </select>
              <input aria-label={`Page rule ${i + 1}: address`} value={r.value} onChange={(e) => upd(i, { ...r, value: e.target.value })} />
            </>
          )}
          {r.field === "device" && (
            <select aria-label={`Page rule ${i + 1}: device`} value={r.value} onChange={(e) => upd(i, { ...r, value: e.target.value as "desktop" | "mobile" })}>
              <option value="desktop">Desktop</option>
              <option value="mobile">Mobile</option>
            </select>
          )}
          {r.field === "locale" && <input aria-label={`Page rule ${i + 1}: language`} value={r.value} onChange={(e) => upd(i, { ...r, value: e.target.value })} />}
          {r.field === "open_conversation" && (
            <select aria-label={`Page rule ${i + 1}: open`} value={String(r.value)} onChange={(e) => upd(i, { ...r, value: e.target.value === "true" })}>
              <option value="false">no</option>
              <option value="true">yes</option>
            </select>
          )}
          <button type="button" className="pg-wf-link" aria-label={`Remove page rule ${i + 1}`} onClick={() => onChange(rules.filter((_, j) => j !== i))}>
            <Trash2 size={14} aria-hidden="true" />
          </button>
        </div>
      ))}
      <button type="button" className="pg-zoe-secondary" onClick={() => onChange([...rules, { field: "page_url", op: "contains", value: "" }])}>
        <Plus size={14} aria-hidden="true" /> Add page rule
      </button>
    </div>
  );
}

function Delivery({ def, events, set }: { def: OutboundDefinition; events: string[]; set: (x: Partial<OutboundDefinition>) => void }) {
  const local = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date(iso).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : "");
  return (
    <>
      <div className="pg-settings-row">
        <label className="pg-settings-field">
          <span className="pg-settings-label">Send</span>
          <select
            value={def.delivery.mode}
            onChange={(e) => {
              const mode = e.target.value as OutboundDefinition["delivery"]["mode"];
              set({
                delivery:
                  mode === "event"
                    ? { mode, event: { name: events[0] ?? "", delayMinutes: 0 } }
                    : mode === "recurring"
                      ? { mode, every: { unit: "day", at: "09:00" } }
                      : { mode },
              });
            }}
          >
            <option value="once">Once, to who matches when it goes live</option>
            <option value="ongoing">To whoever matches, when they do</option>
            <option value="event">After an event</option>
            <option value="recurring">Daily or weekly</option>
          </select>
        </label>
        {def.delivery.mode === "event" && def.delivery.event && (
          <>
            <label className="pg-settings-field">
              <span className="pg-settings-label">Event</span>
              <select value={def.delivery.event.name} onChange={(e) => set({ delivery: { ...def.delivery, event: { ...def.delivery.event!, name: e.target.value } } })}>
                {events.map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
            </label>
            <label className="pg-settings-field">
              <span className="pg-settings-label">After (minutes)</span>
              <input type="number" min={0} value={def.delivery.event.delayMinutes} onChange={(e) => set({ delivery: { ...def.delivery, event: { ...def.delivery.event!, delayMinutes: Number(e.target.value) } } })} />
            </label>
          </>
        )}
        {def.delivery.mode === "recurring" && def.delivery.every && (
          <>
            <label className="pg-settings-field">
              <span className="pg-settings-label">Every</span>
              <select
                value={def.delivery.every.unit}
                onChange={(e) => set({ delivery: { ...def.delivery, every: { ...def.delivery.every!, unit: e.target.value as "day" | "week", weekday: e.target.value === "week" ? 1 : undefined } } })}
              >
                <option value="day">Day</option>
                <option value="week">Week</option>
              </select>
            </label>
            {def.delivery.every.unit === "week" && (
              <label className="pg-settings-field">
                <span className="pg-settings-label">On</span>
                <select value={def.delivery.every.weekday ?? 1} onChange={(e) => set({ delivery: { ...def.delivery, every: { ...def.delivery.every!, weekday: Number(e.target.value) } } })}>
                  {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((n, i) => (
                    <option key={n} value={i}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="pg-settings-field">
              <span className="pg-settings-label">At</span>
              <input type="time" value={def.delivery.every.at} onChange={(e) => set({ delivery: { ...def.delivery, every: { ...def.delivery.every!, at: e.target.value } } })} />
            </label>
          </>
        )}
      </div>
      <div className="pg-settings-row">
        <label className="pg-settings-field">
          <span className="pg-settings-label">Each person gets it</span>
          <select value={def.reentry.mode} onChange={(e) => set({ reentry: e.target.value === "period" ? { mode: "period", days: 30 } : { mode: e.target.value as "once" | "every" } })}>
            <option value="once">Once</option>
            <option value="period">Once a period</option>
            <option value="every">Every time they match</option>
          </select>
        </label>
        {def.reentry.mode === "period" && (
          <label className="pg-settings-field">
            <span className="pg-settings-label">Every (days)</span>
            <input type="number" min={1} max={365} value={def.reentry.days ?? 30} onChange={(e) => set({ reentry: { mode: "period", days: Number(e.target.value) } })} />
          </label>
        )}
        <label className="pg-settings-toggle">
          <input type="checkbox" checked={!!def.cap} onChange={(e) => set({ cap: e.target.checked ? { count: 1, days: 7 } : null })} /> Its own cap
        </label>
        {def.cap && (
          <>
            <label className="pg-settings-field">
              <span className="pg-settings-label">At most</span>
              <input type="number" min={1} max={100} value={def.cap.count} onChange={(e) => set({ cap: { ...def.cap!, count: Number(e.target.value) } })} />
            </label>
            <label className="pg-settings-field">
              <span className="pg-settings-label">In (days)</span>
              <input type="number" min={1} max={365} value={def.cap.days} onChange={(e) => set({ cap: { ...def.cap!, days: Number(e.target.value) } })} />
            </label>
          </>
        )}
      </div>
      <div className="pg-settings-row">
        <label className="pg-settings-toggle">
          <input type="checkbox" checked={def.quietHours} onChange={(e) => set({ quietHours: e.target.checked })} /> Wait during quiet hours
        </label>
        <label className="pg-settings-field">
          <span className="pg-settings-label">Start (optional)</span>
          <input type="datetime-local" value={local(def.startAt)} onChange={(e) => set({ startAt: e.target.value ? new Date(e.target.value).toISOString() : null })} />
        </label>
        <label className="pg-settings-field">
          <span className="pg-settings-label">Stop (optional)</span>
          <input type="datetime-local" value={local(def.stopAt)} onChange={(e) => set({ stopAt: e.target.value ? new Date(e.target.value).toISOString() : null })} />
        </label>
      </div>
    </>
  );
}

function StatsView({ type, stats }: { type: "chat" | "banner"; stats: Stats }) {
  const rows: [string, number | string][] = [
    ["Sent", stats.sent],
    ["Seen", `${stats.seen} (${pct(stats.seen, stats.sent)})`],
    ...(type === "chat" ? ([["Replied", `${stats.replied} (${pct(stats.replied, stats.sent)})`]] as [string, string][]) : []),
    ...(type === "banner"
      ? ([
          ["Clicked", `${stats.clicked} (${pct(stats.clicked, stats.sent)})`],
          ["Closed", `${stats.dismissed} (${pct(stats.dismissed, stats.sent)})`],
        ] as [string, string][])
      : []),
    ["Control group", stats.heldOut],
    ["Not subscribed", stats.suppressed],
    ["Waiting", stats.pending],
  ];
  return (
    <>
      <table className="pg-email-records" aria-label="Message numbers">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <th scope="row">{k}</th>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {stats.goal && (
        <p aria-label="Goal" className="pg-muted">
          Goal “{stats.goal.event}” within {stats.goal.days} days: {pct(stats.goal.sent.converted, stats.goal.sent.n)} of those sent it, {pct(stats.goal.control.converted, stats.goal.control.n)} of the control group.{" "}
          {stats.goal.verdict}
        </p>
      )}
    </>
  );
}

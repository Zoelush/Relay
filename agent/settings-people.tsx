import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { PERMISSION_INFO, permissionGroups, RESTRICTED_ALLOWED } from "../lib/permissions";
import {
  Card,
  Field,
  Frame,
  message,
  type MenuState,
  type Page,
} from "./settings-ui";

/**
 * Settings › Teammates and Roles (S3a; docs/SETTINGS_STEP4.md), for those who manage teammates.
 * A teammate's role is changed here; a role is a set of permissions. The server enforces the
 * rules (nothing above your own permissions, not your own role, always an owner) and the pages
 * say why when it refuses. Inviting and removing teammates arrive in phase 16.
 */
type Role = {
  id: string;
  name: string;
  capabilities: string[];
  teammates: number;
  builtIn: boolean;
  editable: boolean;
  /** Phase 16 C2: every conversation, or only those assigned to its teammates or their teams. */
  scope: "all" | "assigned";
};
type Teammate = {
  id: string;
  name: string;
  roleId: string;
  role: string;
  seat: string;
  presence: string;
  teams: string[];
};

/** Every permission, grouped and explained in plain words (phase 16 C2: from `lib/permissions.ts`). */
export const PERMISSIONS: [string, [string, string, string?][]][] = permissionGroups(Object.keys(PERMISSION_INFO)).map((g) => [
  g.group,
  g.items.map((i): [string, string, string] => [i.id, i.label, i.description]),
]);
const PRESENCE: Record<string, string> = {
  active: "Active",
  away: "Away",
  away_reassigning: "Away, reassigning",
};

export function TeammatesPage({ menu, page }: { menu: MenuState; page: Page }) {
  const [data, setData] = useState<{
    you: string;
    teammates: Teammate[];
    roles: (Role & { editable: boolean })[];
  } | null>(null);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [find, setFind] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const load = useCallback(
    () =>
      api<NonNullable<typeof data>>("teammates")
        .then((r) => {
          setData(r);
          setChosen({});
        })
        .catch((e) => setError(message(e, "Teammates could not be loaded."))),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  async function save(t: Teammate) {
    const roleId = chosen[t.id];
    const role = data?.roles.find((r) => r.id === roleId);
    setBusy(t.id);
    setError("");
    setNotice("");
    try {
      await api("teammates", { teammateId: t.id, roleId });
      setNotice(`${t.name} is now ${role ? article(role.name) : "moved"}.`);
      void load();
    } catch (e) {
      setError(message(e, "The role could not be changed."));
    } finally {
      setBusy("");
    }
  }
  const shown = (data?.teammates ?? []).filter((t) =>
    t.name.toLowerCase().includes(find.trim().toLowerCase()),
  );
  return (
    <Frame menu={menu} page={page}>
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="pg-settings-notice">
          {notice}
        </p>
      )}
      <Card
        title="Teammates"
        description="Everyone in this workspace and their role. A role decides what a teammate can do; you can hand out only roles within your own permissions, and not change your own."
      >
        {(data?.teammates.length ?? 0) > 10 && (
          <input
            aria-label="Find a teammate"
            placeholder="Find a teammate"
            value={find}
            onChange={(e) => setFind(e.target.value)}
          />
        )}
        <ul className="pg-settings-list" aria-label="Teammates">
          {shown.map((t) => {
            const you = t.id === data?.you;
            const value = chosen[t.id] ?? t.roleId;
            return (
              <li key={t.id}>
                <span>
                  <strong>
                    {t.name}
                    {you && <span className="pg-settings-badge">You</span>}
                  </strong>
                  <small className="pg-muted">
                    {PRESENCE[t.presence] ?? t.presence} ·{" "}
                    {t.seat === "limited" ? "Limited seat" : "Full seat"}
                    {t.teams.length > 0 && ` · ${t.teams.join(", ")}`}
                  </small>
                </span>
                <span className="pg-settings-buttons">
                  <select
                    aria-label={`${t.name}: role`}
                    value={value}
                    disabled={you || busy === t.id}
                    title={you ? "You can't change your own role." : undefined}
                    onChange={(e) =>
                      setChosen({ ...chosen, [t.id]: e.target.value })
                    }
                  >
                    {data?.roles.map((r) => (
                      <option key={r.id} value={r.id}>
                        {roleName(r.name)}
                      </option>
                    ))}
                  </select>
                  {value !== t.roleId && (
                    <button
                      type="button"
                      className="pg-primary"
                      disabled={busy === t.id}
                      aria-label={`Save ${t.name}'s role`}
                      onClick={() => void save(t)}
                    >
                      Save
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
        <p className="pg-muted pg-settings-small">
          Inviting and removing teammates, and seats, arrive with administration
          and billing.
        </p>
      </Card>
    </Frame>
  );
}
/** Built-in roles are stored as owner, admin and agent; shown capitalised. */
const roleName = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);
const article = (name: string) =>
  (/^[aeiou]/i.test(name) ? "an " : "a ") + name.toLowerCase();

export function RolesPage({ menu, page }: { menu: MenuState; page: Page }) {
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [yours, setYours] = useState<string[]>([]);
  const [editing, setEditing] = useState<Role | "new" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    () =>
      api<{ roles: Role[]; yours: string[] }>("roles")
        .then((r) => {
          setRoles(r.roles);
          setYours(r.yours);
        })
        .catch((e) => setError(message(e, "Roles could not be loaded."))),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  async function remove(r: Role) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api("roles", { id: r.id, action: "delete" });
      setNotice(`Deleted ${roleName(r.name)}.`);
    } catch (e) {
      setError(message(e, "The role could not be deleted."));
    } finally {
      setBusy(false);
      void load();
    }
  }
  return (
    <Frame menu={menu} page={page}>
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="pg-settings-notice">
          {notice}
        </p>
      )}
      <Card
        title="Roles"
        description="Each role is a set of permissions. The owner role always has every permission, and there's always at least one owner."
      >
        <ul className="pg-settings-list" aria-label="Roles">
          {roles?.map((r) => (
            <li key={r.id}>
              <span>
                <strong>
                  {roleName(r.name)}
                  {r.builtIn && (
                    <span className="pg-settings-badge">Built in</span>
                  )}
                </strong>
                <small className="pg-muted">
                  {r.id === "owner"
                    ? "Every permission"
                    : `${r.capabilities.length} permissions`}
                  {r.scope === "assigned" && " · restricted to assigned conversations"}{" "}
                  · {r.teammates} {r.teammates === 1 ? "teammate" : "teammates"}
                  {!r.editable &&
                    r.id !== "owner" &&
                    " · you can't edit this role"}
                </small>
              </span>
              <span className="pg-settings-buttons">
                {r.editable && (
                  <button
                    type="button"
                    aria-label={`Edit ${roleName(r.name)}`}
                    onClick={() => setEditing(r)}
                  >
                    Edit
                  </button>
                )}
                {r.editable && !r.builtIn && (
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Delete ${roleName(r.name)}`}
                    onClick={() => void remove(r)}
                  >
                    Delete
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
        {!editing && (
          <div>
            <button type="button" onClick={() => setEditing("new")}>
              New role
            </button>
          </div>
        )}
      </Card>
      {editing && (
        <RoleEditor
          key={editing === "new" ? "new" : editing.id}
          role={editing === "new" ? null : editing}
          yours={yours}
          onSaved={(name) => {
            setEditing(null);
            setNotice(
              `Saved ${name}. Teammates with it have the new permissions now.`,
            );
            void load();
          }}
          onCancel={() => setEditing(null)}
        />
      )}
    </Frame>
  );
}

function RoleEditor({
  role,
  yours,
  onSaved,
  onCancel,
}: {
  role: Role | null;
  yours: string[];
  onSaved: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(
    role?.builtIn ? roleName(role.name) : (role?.name ?? ""),
  );
  const [caps, setCaps] = useState<Set<string>>(
    () =>
      new Set(
        role?.capabilities ?? [
          "conversations.read",
          "conversations.reply",
          "conversations.note",
          "conversations.manage",
          "macros.use",
        ],
      ),
  );
  const [scope, setScope] = useState<"all" | "assigned">(role?.scope ?? "all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const restricted = scope === "assigned";
  // What the role won't be able to do, in words: the editor's summary.
  const cannot = Object.entries(PERMISSION_INFO)
    .filter(([c, p]) => !p.legacy && !caps.has(c))
    .map(([, p]) => p.label);
  async function save() {
    setBusy(true);
    setError("");
    try {
      await api("roles", {
        ...(role ? { id: role.id } : {}),
        name,
        scope,
        capabilities: [...caps].filter((c) => !restricted || RESTRICTED_ALLOWED.includes(c)),
      });
      onSaved(name.trim());
    } catch (e) {
      setError(message(e, "The role could not be saved."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="pg-settings-card"
      aria-label={role ? `Edit ${roleName(role.name)}` : "New role"}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h3>{role ? `Edit ${roleName(role.name)}` : "New role"}</h3>
      <Field
        label="Role name"
        hint={role?.builtIn ? "Built-in roles keep their names." : undefined}
      >
        {(id, hint) => (
          <input
            id={id}
            aria-describedby={hint}
            value={name}
            maxLength={40}
            required
            disabled={role?.builtIn}
            placeholder="Team lead"
            onChange={(e) => setName(e.target.value)}
          />
        )}
      </Field>
      <fieldset className="pg-settings-fieldset">
        <legend>Which conversations</legend>
        <label className="pg-settings-toggle">
          <input type="radio" name="role-scope" checked={!restricted} disabled={role?.id === "owner"} onChange={() => setScope("all")} />
          <span>
            <strong>Every conversation</strong>
            <small className="pg-muted">Teammates with this role can open any conversation in the workspace.</small>
          </span>
        </label>
        <label className="pg-settings-toggle">
          <input
            type="radio"
            name="role-scope"
            checked={restricted}
            disabled={role?.id === "owner"}
            onChange={() => {
              setScope("assigned");
              setCaps(new Set([...caps].filter((c) => RESTRICTED_ALLOWED.includes(c))));
            }}
          />
          <span>
            <strong>Only conversations assigned to them or their teams</strong>
            <small className="pg-muted">
              For outsourced teams. They see no customers&apos; personal details, no reports and no other conversations, in the inbox, search, notifications or the API.
            </small>
          </span>
        </label>
      </fieldset>
      {PERMISSIONS.map(([group, items]) => (
        <fieldset key={group} className="pg-settings-fieldset">
          <legend>{group}</legend>
          {items.map(([cap, label, help]) => {
            const fixed = cap === "conversations.read";
            const beyond = !yours.includes(cap);
            const notRestricted = restricted && !RESTRICTED_ALLOWED.includes(cap);
            return (
              <label key={cap} className="pg-settings-toggle">
                <input
                  type="checkbox"
                  checked={caps.has(cap) && !notRestricted}
                  disabled={fixed || beyond || notRestricted}
                  onChange={(e) => {
                    const next = new Set(caps);
                    if (e.target.checked) next.add(cap);
                    else next.delete(cap);
                    setCaps(next);
                  }}
                />
                <span>
                  <strong>{label}</strong>
                  <small className="pg-muted">
                    {notRestricted ? "Not for restricted roles. " : beyond ? "You don't have this permission yourself. " : ""}
                    {help}
                  </small>
                </span>
              </label>
            );
          })}
        </fieldset>
      ))}
      <section className="pg-role-summary" aria-label="What this role can't do">
        <h4>Teammates with this role can&apos;t</h4>
        {restricted && <p>Open conversations that aren&apos;t assigned to them or their teams.</p>}
        {cannot.length ? (
          <ul>
            {cannot.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        ) : (
          !restricted && <p className="pg-muted">Nothing: this role has every permission.</p>
        )}
      </section>
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      <footer className="pg-settings-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="pg-primary" disabled={busy}>
          {role ? "Save role" : "Create role"}
        </button>
      </footer>
    </form>
  );
}

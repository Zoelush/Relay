import { useState } from "react";
import { api } from "./api";

export type PersonTag = { id: string; name: string; archived?: boolean };

/**
 * Tags on a customer or one of their companies, in the details sidebar (phase 01 P1c): each tag
 * with a button to take it off, and a picker of the workspace's tags (archived ones left out, as on
 * conversations) to put one on.
 */
export function PersonTags({
  target,
  name,
  tags: initial,
}: {
  target: { contactId: string } | { companyId: string };
  /** Who or what is tagged, for the buttons' names ("Jill Valentine", "Umbrella Corp"). */
  name: string;
  tags: PersonTag[];
}) {
  const [tags, setTags] = useState(initial);
  const [options, setOptions] = useState<PersonTag[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const change = async (action: "add" | "remove", tagId: string) => {
    setBusy(true);
    setError("");
    try {
      setTags((await api<{ tags: PersonTag[] }>("people-tags", { action, tagId, ...target })).tags);
      if (action === "add") setOptions(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That couldn't be saved.");
    } finally {
      setBusy(false);
    }
  };
  const open = async () => {
    try {
      setOptions((await api<{ tags: PersonTag[] }>("people-tags")).tags);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The tags couldn't be loaded.");
    }
  };
  const have = new Set(tags.map((t) => t.id));
  const choices = (options ?? []).filter((t) => !have.has(t.id));
  return (
    <div className="pg-person-tags" role="group" aria-label={`Tags on ${name}`}>
      {tags.map((t) => (
        <span key={t.id} className="pg-tag-chip" data-archived={t.archived ? "true" : undefined}>
          {t.name}
          {t.archived && <span className="pg-visually-hidden"> (archived)</span>}
          <button type="button" aria-label={`Remove tag ${t.name} from ${name}`} disabled={busy} onClick={() => void change("remove", t.id)}>
            ×
          </button>
        </span>
      ))}
      {options === null ? (
        <button type="button" className="pg-tag-add" onClick={() => void open()}>
          + Tag
        </button>
      ) : (
        <select
          className="pg-tag-select"
          aria-label={`Add a tag to ${name}`}
          value=""
          disabled={busy}
          onChange={(e) => {
            if (e.target.value) void change("add", e.target.value);
          }}
          onBlur={() => setOptions(null)}
        >
          <option value="">{choices.length ? "Choose a tag" : "No other tags"}</option>
          {choices.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      )}
      {error && (
        <p className="pg-attr-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

import { createElement, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Plus, Trash2 } from "lucide-react";
import { ThemeImage } from "./knowledge-files";
import { DEFAULT_ICON, HELP_ICON_NAMES, helpIcon } from "../lib/help-icons";
import {
  FONTS,
  FONT_IDS,
  LIMITS,
  SOCIALS,
  type Background,
  type FontId,
  type Localized,
  type SocialPlatform,
} from "../lib/help-theme";

/**
 * The fields "Configure and style" is made of (the November 2026 help center rebuild;
 * docs/HELP_CENTER_DESIGN.md). Each one edits a piece of the draft theme and nothing else, so the
 * editor stays a list of sections and the live preview redraws from the same draft.
 */

/** A section of the editor that folds, with the first one open. */
export function Fold({
  title,
  hint,
  open,
  onToggle,
  children,
}: {
  title: string;
  hint?: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="pg-hc-fold">
      <h3>
        <button type="button" aria-expanded={open} onClick={onToggle}>
          <ChevronDown size={15} aria-hidden="true" />
          {title}
        </button>
      </h3>
      {open && (
        <div className="pg-hc-fold-body">
          {hint && <p className="pg-muted">{hint}</p>}
          {children}
        </div>
      )}
    </section>
  );
}

/** One labelled field; `hint` explains it under the control. */
export function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="pg-hc-row">
      <span className="pg-hc-row-label">{label}</span>
      <div className="pg-hc-row-field">{children}</div>
      {hint && <p className="pg-muted pg-hc-hint">{hint}</p>}
    </div>
  );
}

export function Colour({
  label,
  value,
  onChange,
  clearable,
  hint,
}: {
  label: string;
  value: string | null;
  onChange: (v: string | null) => void;
  /** "None" is allowed (the header's and the footer's colours follow the page otherwise). */
  clearable?: boolean;
  hint?: string;
}) {
  return (
    <Row label={label} hint={hint}>
      <span className="pg-hc-colour">
        <input
          type="color"
          aria-label={label}
          value={value ?? "#ffffff"}
          onChange={(e) => onChange(e.target.value)}
        />
        <input
          className="pg-hc-hex"
          aria-label={`${label} (hex)`}
          value={value ?? ""}
          placeholder={clearable ? "None" : "#000000"}
          maxLength={7}
          onChange={(e) => {
            const v = e.target.value.trim();
            if (/^#[0-9a-fA-F]{6}$/.test(v)) onChange(v.toLowerCase());
            else if (!v && clearable) onChange(null);
          }}
        />
        {clearable && value && (
          <button type="button" className="pg-secondary" onClick={() => onChange(null)}>
            Clear
          </button>
        )}
      </span>
    </Row>
  );
}

/** A small set of choices, as buttons (Intercom's segmented pickers). */
export function Choice<T extends string | number>({
  label,
  value,
  options,
  onChange,
  hint,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  hint?: string;
}) {
  return (
    <Row label={label} hint={hint}>
      <span className="pg-hc-choice" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </span>
    </Row>
  );
}

export function Slider({
  label,
  value,
  range,
  onChange,
  suffix = "px",
  hint,
}: {
  label: string;
  value: number;
  range: readonly [number, number] | readonly number[];
  onChange: (v: number) => void;
  suffix?: string;
  hint?: string;
}) {
  const [min, max] = range as [number, number];
  return (
    <Row label={label} hint={hint}>
      <span className="pg-hc-slider">
        <input
          type="range"
          aria-label={label}
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <output>
          {value}
          {suffix}
        </output>
      </span>
    </Row>
  );
}

export function Switch({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <div className="pg-hc-row">
      <label className="pg-hc-switch">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span>{label}</span>
      </label>
      {hint && <p className="pg-muted pg-hc-hint">{hint}</p>}
    </div>
  );
}

/** A line a visitor reads, kept per language: this one edits the language being previewed. */
export function Line({
  label,
  locale,
  value,
  onChange,
  max = LIMITS.line,
  placeholder,
  rows,
  hint,
}: {
  label: string;
  locale: string;
  value: Localized;
  onChange: (v: Localized) => void;
  max?: number;
  placeholder?: string;
  rows?: number;
  hint?: string;
}) {
  const set = (text: string) => {
    const next = { ...value };
    if (text.trim()) next[locale] = text;
    else delete next[locale];
    onChange(next);
  };
  const name = `${label} (${locale})`;
  return (
    <Row label={name} hint={hint}>
      {rows ? (
        <textarea
          aria-label={name}
          rows={rows}
          maxLength={max}
          placeholder={placeholder}
          value={value[locale] ?? ""}
          onChange={(e) => set(e.target.value)}
        />
      ) : (
        <input
          aria-label={name}
          maxLength={max}
          placeholder={placeholder}
          value={value[locale] ?? ""}
          onChange={(e) => set(e.target.value)}
        />
      )}
    </Row>
  );
}

export function Font({
  label,
  value,
  onChange,
}: {
  label: string;
  value: FontId;
  onChange: (v: FontId) => void;
}) {
  return (
    <Row label={label}>
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value as FontId)}>
        {FONT_IDS.map((id) => (
          <option key={id} value={id}>
            {FONTS[id].name}
          </option>
        ))}
      </select>
    </Row>
  );
}

/** A colour, a gradient of up to three colours, or an uploaded image. */
export function BackgroundField({
  label,
  centerId,
  value,
  onChange,
  clearable,
  hint,
}: {
  label: string;
  centerId: string;
  value: Background | null;
  onChange: (v: Background | null) => void;
  clearable?: boolean;
  hint?: string;
}) {
  const kind = value?.type ?? "none";
  const colors = value?.type === "gradient" ? value.colors : ["#087a57", "#054f39"];
  return (
    <div className="pg-hc-background" role="group" aria-label={label}>
      <Choice
        label={label}
        hint={hint}
        value={kind}
        options={[
          ...(clearable ? [{ value: "none", label: "None" }] : []),
          { value: "color", label: "Colour" },
          { value: "gradient", label: "Gradient" },
          { value: "image", label: "Image" },
        ]}
        onChange={(next) => {
          if (next === "none") onChange(null);
          else if (next === "color")
            onChange({ type: "color", color: value?.type === "gradient" ? value.colors[0] : "#087a57" });
          else if (next === "gradient") onChange({ type: "gradient", colors });
          else onChange({ type: "image", fileId: "" });
        }}
      />
      {value?.type === "color" && (
        <Colour label={`${label} colour`} value={value.color} onChange={(c) => c && onChange({ type: "color", color: c })} />
      )}
      {value?.type === "gradient" && (
        <>
          {value.colors.map((c, i) => (
            <Colour
              key={i}
              label={`${label} colour ${i + 1}`}
              value={c}
              onChange={(next) =>
                next && onChange({ type: "gradient", colors: value.colors.map((x, j) => (j === i ? next : x)) })
              }
            />
          ))}
          <div className="pg-hc-inline">
            {value.colors.length < 3 && (
              <button
                type="button"
                className="pg-secondary"
                onClick={() => onChange({ type: "gradient", colors: [...value.colors, value.colors[value.colors.length - 1]] })}
              >
                <Plus size={13} aria-hidden="true" /> Add a colour
              </button>
            )}
            {value.colors.length > 2 && (
              <button
                type="button"
                className="pg-secondary"
                onClick={() => onChange({ type: "gradient", colors: value.colors.slice(0, -1) })}
              >
                Remove the last
              </button>
            )}
          </div>
        </>
      )}
      {value?.type === "image" && (
        <ThemeImage
          label={`${label} image`}
          purpose="theme_image"
          centerId={centerId}
          value={value.fileId || null}
          onChange={(id) => onChange(id ? { type: "image", fileId: id } : { type: "color", color: "#087a57" })}
        />
      )}
    </div>
  );
}

/** One icon from the set, by name (the default for none). */
export const Glyph = ({ name, size }: { name: string | null; size: number }) =>
  createElement(helpIcon(name), { size, "aria-hidden": true });

/** A collection's icon: the set in `lib/help-icons.ts`. */
export function IconPicker({
  name,
  value,
  onPick,
}: {
  name: string;
  value: string | null;
  onPick: (icon: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const current = value ?? DEFAULT_ICON;
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);
  return (
    <div className="pg-hc-iconpicker" ref={box}>
      <button
        type="button"
        className="pg-hc-iconbutton"
        aria-label={`Icon for ${name}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Glyph name={value} size={16} />
      </button>
      {open && (
        <div className="pg-hc-icons" role="radiogroup" aria-label={`Icons for ${name}`}>
          {HELP_ICON_NAMES.map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={n === current}
              aria-label={n.replace(/-/g, " ")}
              title={n.replace(/-/g, " ")}
              onClick={() => {
                onPick(n === DEFAULT_ICON ? null : n);
                setOpen(false);
              }}
            >
              <Glyph name={n} size={18} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Links shown in the header or the footer, kept per language. */
export function LinkList({
  label,
  locale,
  max,
  groups,
  value,
  onChange,
}: {
  label: string;
  locale: string;
  max: number;
  /** Footer links carry a group name (the multi-level footer's columns). */
  groups?: boolean;
  value: Record<string, { title: string; url: string; group?: string }[]>;
  onChange: (v: Record<string, { title: string; url: string; group?: string }[]>) => void;
}) {
  const list = value[locale] ?? [];
  const set = (next: typeof list) => onChange({ ...value, [locale]: next });
  return (
    <div className="pg-hc-links" role="group" aria-label={`${label} (${locale})`}>
      <span className="pg-hc-row-label">
        {label} ({locale})
      </span>
      {list.map((l, i) => (
        <div className="pg-hc-link" key={i}>
          <input
            aria-label={`Link ${i + 1} title`}
            placeholder="Title"
            value={l.title}
            onChange={(e) => set(list.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))}
          />
          <input
            aria-label={`Link ${i + 1} address`}
            placeholder="https://example.com"
            value={l.url}
            onChange={(e) => set(list.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))}
          />
          {groups && (
            <input
              aria-label={`Link ${i + 1} group`}
              placeholder="Group"
              value={l.group ?? ""}
              onChange={(e) => set(list.map((x, j) => (j === i ? { ...x, group: e.target.value } : x)))}
            />
          )}
          <button type="button" className="pg-secondary" aria-label={`Remove link ${i + 1}`} onClick={() => set(list.filter((_, j) => j !== i))}>
            <Trash2 size={14} aria-hidden="true" />
          </button>
        </div>
      ))}
      {list.length < max && (
        <button type="button" className="pg-secondary" onClick={() => set([...list, { title: "", url: "", ...(groups ? { group: "" } : {}) }])}>
          <Plus size={13} aria-hidden="true" /> Add a link
        </button>
      )}
    </div>
  );
}

/** The footer's social links: a network and an address. */
export function SocialList({
  value,
  onChange,
}: {
  value: { platform: SocialPlatform; url: string }[];
  onChange: (v: { platform: SocialPlatform; url: string }[]) => void;
}) {
  return (
    <div className="pg-hc-links" role="group" aria-label="Social links">
      <span className="pg-hc-row-label">Social links</span>
      {value.map((s, i) => (
        <div className="pg-hc-link" key={i}>
          <select
            aria-label={`Social link ${i + 1} network`}
            value={s.platform}
            onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, platform: e.target.value as SocialPlatform } : x)))}
          >
            {(Object.keys(SOCIALS) as SocialPlatform[]).map((p) => (
              <option key={p} value={p}>
                {SOCIALS[p]}
              </option>
            ))}
          </select>
          <input
            aria-label={`Social link ${i + 1} address`}
            placeholder="https://example.com/acme"
            value={s.url}
            onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))}
          />
          <button type="button" className="pg-secondary" aria-label={`Remove social link ${i + 1}`} onClick={() => onChange(value.filter((_, j) => j !== i))}>
            <Trash2 size={14} aria-hidden="true" />
          </button>
        </div>
      ))}
      {value.length < LIMITS.socials && (
        <button type="button" className="pg-secondary" onClick={() => onChange([...value, { platform: "website", url: "" }])}>
          <Plus size={13} aria-hidden="true" /> Add a social link
        </button>
      )}
    </div>
  );
}

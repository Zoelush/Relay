/**
 * Canvas (phase 15, step D5; docs/DEVELOPER_PLATFORM_STEP5.md): the declarative cards apps draw in
 * Relay. An app never runs code in Relay's UI: it answers a signed request with a tree of these
 * components, which Relay checks here (on the server, before anything reaches a browser) and draws
 * with its own components. Anything not described here is refused, with the path to the problem,
 * so a developer sees exactly what to fix.
 *
 * Text is plain text (no HTML or markdown). Addresses (images, links, url actions) are https.
 */
export const PLACEMENTS = ["conversation.sidebar", "composer", "settings"] as const;
export type Placement = (typeof PLACEMENTS)[number];
export const PLACEMENT_LABEL: Record<Placement, string> = {
  "conversation.sidebar": "Inbox sidebar",
  composer: "Composer",
  settings: "Settings (configure at install)",
};

export type Action = { type: "submit" } | { type: "url"; url: string };
export type Option = { id: string; text: string };
export type Component =
  | { type: "text"; id?: string; text: string; style?: "header" | "paragraph" | "muted" | "error"; align?: "left" | "center" | "right" }
  | { type: "image"; id?: string; url: string; alt: string; width?: number; height?: number; rounded?: boolean }
  | { type: "button"; id: string; label: string; style?: "primary" | "secondary" | "link"; action: Action; disabled?: boolean }
  | { type: "link"; id?: string; text: string; url: string }
  | { type: "input"; id: string; label: string; placeholder?: string; value?: string; error?: string; disabled?: boolean; action?: { type: "submit" } }
  | { type: "textarea"; id: string; label: string; placeholder?: string; value?: string; error?: string; disabled?: boolean }
  | { type: "dropdown"; id: string; label: string; options: Option[]; value?: string; disabled?: boolean }
  | { type: "checkbox"; id: string; label: string; options: Option[]; value?: string[]; disabled?: boolean }
  | { type: "list"; id?: string; items: ListItem[] }
  | { type: "data_table"; id?: string; items: { field: string; value: string }[] }
  | { type: "divider"; id?: string }
  | { type: "spacer"; id?: string; size?: "xs" | "s" | "m" | "l" | "xl" };
export type ListItem = { id: string; title: string; subtitle?: string; tertiary?: string; action?: Action; disabled?: boolean };
export type Canvas = { components: Component[] };
/** What a request answers: a canvas, text for the reply (composer), or settings (configure). */
export type CanvasAnswer =
  | { kind: "canvas"; canvas: Canvas; storedData: Record<string, unknown> | null }
  | { kind: "insert"; text: string }
  | { kind: "results"; results: Record<string, unknown> };

export const LIMITS = { components: 50, listItems: 20, tableRows: 30, options: 50, checkboxOptions: 20, storedData: 4096, results: 4096, insertText: 5000 } as const;
export const COMPONENT_TYPES = ["text", "image", "button", "link", "input", "textarea", "dropdown", "checkbox", "list", "data_table", "divider", "spacer"] as const;
const ID = /^[A-Za-z0-9_.:-]{1,64}$/;
/** The reference's table of components (`npm run api:doc`): their properties, as checked below. */
export const COMPONENT_REFERENCE: Record<(typeof COMPONENT_TYPES)[number], string> = {
  text: "`text` (plain, up to 2,000), `style`: `header`, `paragraph`, `muted` or `error`; `align`: `left`, `center` or `right`.",
  image: "`url` (https), `alt` (required), `width` and `height` (up to 1,000), `rounded`.",
  button: "`id`, `label` (up to 60), `style`: `primary`, `secondary` or `link`; `action`: `{type: submit}` or `{type: url, url}`; `disabled`.",
  link: "`text`, `url` (https). Opens in a new tab.",
  input: "`id`, `label`, `placeholder`, `value`, `error` (shown under it), `disabled`, `action` (`{type: submit}`: Enter submits).",
  textarea: "`id`, `label`, `placeholder`, `value` (up to 5,000), `error`, `disabled`.",
  dropdown: "`id`, `label`, `options` (1 to 50 of `{id, text}`), `value` (an option's id), `disabled`.",
  checkbox: "`id`, `label`, `options` (1 to 20), `value` (a list of option ids), `disabled`.",
  list: "`items` (1 to 20): `id`, `title`, `subtitle`, `tertiary`, `action`, `disabled`. An item with a submit action is pressed by its id.",
  data_table: "`items` (1 to 30) of `{field, value}`.",
  divider: "A line.",
  spacer: "`size`: `xs`, `s`, `m`, `l` or `xl`.",
};

export class CanvasInvalid extends Error {
  constructor(
    public path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** One component's checker: reads the allowed keys, refusing any other. */
function reader(o: Obj, path: string, allowed: string[]) {
  const extra = Object.keys(o).find((k) => !allowed.includes(k));
  if (extra) throw new CanvasInvalid(`${path}.${extra}`, "isn't a property of this component.");
  const str = (k: string, max: number, required: boolean, min = 1) => {
    const v = o[k];
    if (v === undefined && !required) return undefined;
    if (typeof v !== "string") throw new CanvasInvalid(`${path}.${k}`, "must be text.");
    if (v.length < min || v.length > max) throw new CanvasInvalid(`${path}.${k}`, min ? `must be 1 to ${max} characters.` : `must be at most ${max} characters.`);
    return v;
  };
  const oneOf = <T extends string>(k: string, values: readonly T[]) => {
    const v = o[k];
    if (v === undefined) return undefined;
    if (!values.includes(v as T)) throw new CanvasInvalid(`${path}.${k}`, `must be one of ${values.join(", ")}.`);
    return v as T;
  };
  const bool = (k: string) => {
    const v = o[k];
    if (v === undefined) return undefined;
    if (typeof v !== "boolean") throw new CanvasInvalid(`${path}.${k}`, "must be true or false.");
    return v;
  };
  const int = (k: string, max: number) => {
    const v = o[k];
    if (v === undefined) return undefined;
    if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > max) throw new CanvasInvalid(`${path}.${k}`, `must be a whole number from 1 to ${max}.`);
    return v as number;
  };
  const id = (required: boolean) => {
    const v = o.id;
    if (v === undefined && !required) return undefined;
    if (typeof v !== "string" || !ID.test(v)) throw new CanvasInvalid(`${path}.id`, "must be 1 to 64 letters, digits, or _ . : -");
    return v;
  };
  const list = (k: string, min: number, max: number) => {
    const v = o[k];
    if (!Array.isArray(v) || v.length < min || v.length > max) throw new CanvasInvalid(`${path}.${k}`, `must be a list of ${min} to ${max}.`);
    return v as unknown[];
  };
  return { str, oneOf, bool, int, id, list };
}

/** An address shown or opened in a teammate's browser: https only, no credentials. */
export function checkHttps(raw: unknown, path: string) {
  let u: URL;
  try {
    u = new URL(String(raw));
  } catch {
    throw new CanvasInvalid(path, "must be a full https address.");
  }
  if (u.protocol !== "https:" || u.username || u.password || typeof raw !== "string" || raw.length > 2000) throw new CanvasInvalid(path, "must be a full https address.");
  return u.toString();
}

function action(raw: unknown, path: string, urlAllowed = true): Action {
  if (!isObj(raw)) throw new CanvasInvalid(path, 'must be {"type":"submit"} or {"type":"url","url":…}.');
  if (raw.type === "submit" && Object.keys(raw).length === 1) return { type: "submit" };
  if (urlAllowed && raw.type === "url" && Object.keys(raw).every((k) => k === "type" || k === "url")) return { type: "url", url: checkHttps(raw.url, path + ".url") };
  throw new CanvasInvalid(path, urlAllowed ? 'must be {"type":"submit"} or {"type":"url","url":…}.' : 'must be {"type":"submit"}.');
}

function options(raw: unknown[], path: string): Option[] {
  const seen = new Set<string>();
  return raw.map((x, i) => {
    const p = `${path}[${i}]`;
    if (!isObj(x)) throw new CanvasInvalid(p, "must be an option.");
    const r = reader(x, p, ["id", "text"]);
    const id = r.id(true)!;
    if (seen.has(id)) throw new CanvasInvalid(p + ".id", `${id} is used twice.`);
    seen.add(id);
    return { id, text: r.str("text", 120, true)! };
  });
}

function component(raw: unknown, path: string): Component {
  if (!isObj(raw)) throw new CanvasInvalid(path, "must be a component.");
  const type = raw.type;
  if (!COMPONENT_TYPES.includes(type as (typeof COMPONENT_TYPES)[number])) throw new CanvasInvalid(path + ".type", `must be one of ${COMPONENT_TYPES.join(", ")}.`);
  const clean = <T extends Obj>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
  switch (type) {
    case "text": {
      const r = reader(raw, path, ["type", "id", "text", "style", "align"]);
      return clean({ type, id: r.id(false), text: r.str("text", 2000, true)!, style: r.oneOf("style", ["header", "paragraph", "muted", "error"] as const), align: r.oneOf("align", ["left", "center", "right"] as const) });
    }
    case "image": {
      const r = reader(raw, path, ["type", "id", "url", "alt", "width", "height", "rounded"]);
      return clean({ type, id: r.id(false), url: checkHttps(raw.url, path + ".url"), alt: r.str("alt", 200, true)!, width: r.int("width", 1000), height: r.int("height", 1000), rounded: r.bool("rounded") });
    }
    case "button": {
      const r = reader(raw, path, ["type", "id", "label", "style", "action", "disabled"]);
      return clean({ type, id: r.id(true)!, label: r.str("label", 60, true)!, style: r.oneOf("style", ["primary", "secondary", "link"] as const), action: action(raw.action, path + ".action"), disabled: r.bool("disabled") });
    }
    case "link": {
      const r = reader(raw, path, ["type", "id", "text", "url"]);
      return clean({ type, id: r.id(false), text: r.str("text", 200, true)!, url: checkHttps(raw.url, path + ".url") });
    }
    case "input": {
      const r = reader(raw, path, ["type", "id", "label", "placeholder", "value", "error", "disabled", "action"]);
      return clean({
        type,
        id: r.id(true)!,
        label: r.str("label", 60, true)!,
        placeholder: r.str("placeholder", 100, false),
        value: r.str("value", 1000, false, 0),
        error: r.str("error", 200, false),
        disabled: r.bool("disabled"),
        action: raw.action === undefined ? undefined : (action(raw.action, path + ".action", false) as { type: "submit" }),
      });
    }
    case "textarea": {
      const r = reader(raw, path, ["type", "id", "label", "placeholder", "value", "error", "disabled"]);
      return clean({ type, id: r.id(true)!, label: r.str("label", 60, true)!, placeholder: r.str("placeholder", 100, false), value: r.str("value", 5000, false, 0), error: r.str("error", 200, false), disabled: r.bool("disabled") });
    }
    case "dropdown": {
      const r = reader(raw, path, ["type", "id", "label", "options", "value", "disabled"]);
      const opts = options(r.list("options", 1, LIMITS.options), path + ".options");
      const value = r.str("value", 64, false);
      if (value !== undefined && !opts.some((o) => o.id === value)) throw new CanvasInvalid(path + ".value", "must be one of its options' ids.");
      return clean({ type, id: r.id(true)!, label: r.str("label", 60, true)!, options: opts, value, disabled: r.bool("disabled") });
    }
    case "checkbox": {
      const r = reader(raw, path, ["type", "id", "label", "options", "value", "disabled"]);
      const opts = options(r.list("options", 1, LIMITS.checkboxOptions), path + ".options");
      let value: string[] | undefined;
      if (raw.value !== undefined) {
        if (!Array.isArray(raw.value) || !raw.value.every((v) => opts.some((o) => o.id === v))) throw new CanvasInvalid(path + ".value", "must be a list of its options' ids.");
        value = [...new Set(raw.value as string[])];
      }
      return clean({ type, id: r.id(true)!, label: r.str("label", 60, true)!, options: opts, value, disabled: r.bool("disabled") });
    }
    case "list": {
      const r = reader(raw, path, ["type", "id", "items"]);
      const items = r.list("items", 1, LIMITS.listItems).map((x, i) => {
        const p = `${path}.items[${i}]`;
        if (!isObj(x)) throw new CanvasInvalid(p, "must be a list item.");
        const ri = reader(x, p, ["id", "title", "subtitle", "tertiary", "action", "disabled"]);
        return clean({
          id: ri.id(true)!,
          title: ri.str("title", 120, true)!,
          subtitle: ri.str("subtitle", 200, false),
          tertiary: ri.str("tertiary", 120, false),
          action: x.action === undefined ? undefined : action(x.action, p + ".action"),
          disabled: ri.bool("disabled"),
        });
      });
      return clean({ type, id: r.id(false), items });
    }
    case "data_table": {
      const r = reader(raw, path, ["type", "id", "items"]);
      const items = r.list("items", 1, LIMITS.tableRows).map((x, i) => {
        const p = `${path}.items[${i}]`;
        if (!isObj(x)) throw new CanvasInvalid(p, "must be a row.");
        const ri = reader(x, p, ["field", "value"]);
        return { field: ri.str("field", 60, true)!, value: ri.str("value", 500, false, 0) ?? "" };
      });
      return clean({ type, id: r.id(false), items });
    }
    case "divider": {
      const r = reader(raw, path, ["type", "id"]);
      return clean({ type, id: r.id(false) });
    }
    default: {
      const r = reader(raw, path, ["type", "id", "size"]);
      return clean({ type: "spacer" as const, id: r.id(false), size: r.oneOf("size", ["xs", "s", "m", "l", "xl"] as const) });
    }
  }
}

function jsonObject(raw: unknown, path: string, max: number) {
  if (!isObj(raw)) throw new CanvasInvalid(path, "must be an object.");
  if (JSON.stringify(raw).length > max) throw new CanvasInvalid(path, `must be at most ${max} characters as JSON.`);
  return raw;
}

/** A canvas: its components checked, and every id that can be submitted or hold a value unique. */
export function validateCanvas(raw: unknown, path = "canvas"): { canvas: Canvas; storedData: Record<string, unknown> | null } {
  if (!isObj(raw)) throw new CanvasInvalid(path, "must be an object with content.components.");
  const extra = Object.keys(raw).find((k) => k !== "content" && k !== "stored_data");
  if (extra) throw new CanvasInvalid(`${path}.${extra}`, "isn't a property of a canvas.");
  const content = raw.content;
  if (!isObj(content) || Object.keys(content).some((k) => k !== "components")) throw new CanvasInvalid(path + ".content", "must be { components: [...] }.");
  const list = content.components;
  if (!Array.isArray(list) || list.length < 1 || list.length > LIMITS.components) throw new CanvasInvalid(path + ".content.components", `must be a list of 1 to ${LIMITS.components} components.`);
  const components = list.map((c, i) => component(c, `${path}.content.components[${i}]`));
  const seen = new Set<string>();
  const use = (id: string | undefined, p: string) => {
    if (id === undefined) return;
    if (seen.has(id)) throw new CanvasInvalid(p, `${id} is used twice.`);
    seen.add(id);
  };
  components.forEach((c, i) => {
    const p = `${path}.content.components[${i}]`;
    use(c.id, p + ".id");
    if (c.type === "list") c.items.forEach((item, j) => use(item.id, `${p}.items[${j}].id`));
  });
  return { canvas: { components }, storedData: raw.stored_data === undefined ? null : jsonObject(raw.stored_data, path + ".stored_data", LIMITS.storedData) };
}

/** An app's answer to a request, for where it's drawn: what each lifecycle request may return. */
export function parseAnswer(raw: unknown, placement: Placement, kind: "initialize" | "submit" | "configure"): CanvasAnswer {
  if (!isObj(raw)) throw new CanvasInvalid("response", "must be a JSON object.");
  const keys = Object.keys(raw);
  if (keys.length === 1 && keys[0] === "canvas") return { kind: "canvas", ...validateCanvas(raw.canvas) };
  if (keys.length === 1 && keys[0] === "insert_text") {
    if (placement !== "composer" || kind !== "submit") throw new CanvasInvalid("response.insert_text", "is only answered to a submit in the composer.");
    if (typeof raw.insert_text !== "string" || !raw.insert_text.trim() || raw.insert_text.length > LIMITS.insertText) throw new CanvasInvalid("response.insert_text", `must be 1 to ${LIMITS.insertText} characters.`);
    return { kind: "insert", text: raw.insert_text };
  }
  if (keys.length === 1 && keys[0] === "results") {
    if (placement !== "settings" || kind !== "configure") throw new CanvasInvalid("response.results", "is only answered to configure.");
    return { kind: "results", results: jsonObject(raw.results, "response.results", LIMITS.results) };
  }
  const allowed = ["canvas", ...(placement === "composer" && kind === "submit" ? ["insert_text"] : []), ...(placement === "settings" && kind === "configure" ? ["results"] : [])];
  throw new CanvasInvalid("response", `must have exactly one of ${allowed.join(", ")}.`);
}

/** What a teammate can submit on a canvas: buttons and list items that submit, and inputs with a submit action. */
export function submittable(canvas: Canvas, id: string) {
  for (const c of canvas.components) {
    if (c.type === "button" && c.id === id) return c.action.type === "submit" && !c.disabled;
    if (c.type === "input" && c.id === id) return c.action?.type === "submit" && !c.disabled;
    if (c.type === "list") for (const item of c.items) if (item.id === id) return item.action?.type === "submit" && !item.disabled;
  }
  return false;
}

/** The values a teammate entered, kept only for this canvas's own fields and checked against them. */
export function inputValues(canvas: Canvas, raw: unknown) {
  const given = isObj(raw) ? raw : {};
  const out: Record<string, string | string[]> = {};
  for (const c of canvas.components) {
    if (!(c.type === "input" || c.type === "textarea" || c.type === "dropdown" || c.type === "checkbox") || c.disabled || !(c.id in given)) continue;
    const v = given[c.id];
    if (c.type === "input" || c.type === "textarea") {
      if (typeof v === "string") out[c.id] = v.slice(0, c.type === "input" ? 1000 : 5000);
    } else if (c.type === "dropdown") {
      if (typeof v === "string" && c.options.some((o) => o.id === v)) out[c.id] = v;
    } else if (c.type === "checkbox") {
      if (Array.isArray(v)) out[c.id] = [...new Set(v.filter((x): x is string => typeof x === "string" && c.options.some((o) => o.id === x)))];
    }
  }
  return out;
}

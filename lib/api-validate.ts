import type { Parameter, Schema, Spec } from "./api-spec";
import { SPEC } from "./api-spec";

/**
 * Request validation, derived from the API's spec (phase 15, D1): the schemas in `lib/api-spec.ts`
 * are read as they are, so what the reference says is what's enforced. It supports the subset of
 * JSON Schema the spec uses, and a test fails if the spec uses a keyword this doesn't check.
 */
export type Problem = { field: string; message: string };
export const CHECKED = new Set([
  "type",
  "description",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "format",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "maxItems",
  "maxProperties",
  "default",
  "$ref",
  "example",
]);

export function resolve(s: Schema, spec: Spec = SPEC): Schema {
  if (!s.$ref) return s;
  const name = s.$ref.replace("#/components/schemas/", "");
  return spec.components.schemas[name];
}
const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
const fits = (t: string, v: unknown) => {
  const actual = typeOf(v);
  return t === actual || (t === "number" && actual === "integer");
};
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

/** The first problem with a value against a schema, or null. Field names are dotted paths. */
export function check(schema: Schema, value: unknown, field = "", spec: Spec = SPEC): Problem | null {
  const s = resolve(schema, spec);
  const at = (message: string): Problem => ({ field: field || "body", message });
  const types = s.type === undefined ? null : Array.isArray(s.type) ? s.type : [s.type];
  if (types && !types.some((t) => fits(t, value))) return at(`Expected ${types.join(" or ")}.`);
  if (value === null) return null;
  if (s.enum && !s.enum.includes(value as string)) return at(`Expected one of: ${s.enum.join(", ")}.`);
  if (typeof value === "string") {
    if (s.minLength !== undefined && value.length < s.minLength) return at(s.minLength === 1 ? "Can't be empty." : `At least ${s.minLength} characters.`);
    if (s.maxLength !== undefined && value.length > s.maxLength) return at(`At most ${s.maxLength} characters.`);
    if (s.format === "date-time" && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value) || Number.isNaN(Date.parse(value))))
      return at("Expected a date and time with an offset (2026-10-21T09:00:00Z).");
    if (s.format === "email" && !EMAIL.test(value)) return at("Expected an email address.");
  }
  if (typeof value === "number") {
    if (s.minimum !== undefined && value < s.minimum) return at(`At least ${s.minimum}.`);
    if (s.maximum !== undefined && value > s.maximum) return at(`At most ${s.maximum}.`);
  }
  if (Array.isArray(value)) {
    if (s.maxItems !== undefined && value.length > s.maxItems) return at(`At most ${s.maxItems} items.`);
    if (s.items) for (const [i, v] of value.entries()) {
      const p = check(s.items, v, `${field}[${i}]`, spec);
      if (p) return p;
    }
  }
  if (typeOf(value) === "object") {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o);
    if (s.maxProperties !== undefined && keys.length > s.maxProperties) return at(`At most ${s.maxProperties} entries.`);
    for (const r of s.required ?? []) if (o[r] === undefined) return { field: field ? `${field}.${r}` : r, message: "Required." };
    for (const k of keys) {
      const name = field ? `${field}.${k}` : k;
      const p = s.properties?.[k] ?? (typeof s.additionalProperties === "object" ? s.additionalProperties : undefined);
      if (!p) {
        if (s.additionalProperties === false) return { field: name, message: "Not a field here." };
        continue;
      }
      const problem = check(p, o[k], name, spec);
      if (problem) return problem;
    }
  }
  return null;
}

/** Query and path parameters, read as their schema's type, checked, with defaults. */
export function readParameters(params: Parameter[], from: { path: Record<string, string>; query: URLSearchParams }, spec: Spec = SPEC) {
  const out: Record<string, unknown> = {};
  for (const p of params) {
    if (p.in === "header") continue;
    const raw = p.in === "path" ? from.path[p.name] : from.query.get(p.name);
    if (raw === undefined || raw === null || raw === "") {
      if (p.required) return { problem: { field: p.name, message: "Required." } as Problem };
      if (p.schema.default !== undefined) out[p.name] = p.schema.default;
      continue;
    }
    const s = resolve(p.schema, spec);
    const value = s.type === "integer" ? (/^-?\d+$/.test(raw) ? Number(raw) : raw) : s.type === "boolean" ? (raw === "true" ? true : raw === "false" ? false : raw) : raw;
    const problem = check(s, value, p.name, spec);
    if (problem) return { problem };
    out[p.name] = value;
  }
  return { values: out };
}

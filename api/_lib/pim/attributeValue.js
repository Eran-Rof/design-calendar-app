// api/_lib/pim/attributeValue.js
//
// Value-type validation shared between product_attribute_definitions
// (the def is what declares the type) and the per-style upsert handler
// (which validates the incoming `value` against the def).
//
// Spec: value_type ∈ {'enum','number','text','boolean','date'}; for 'enum'
// the def's options jsonb must shape as {"options": [string, ...]} and
// the value must match one of those options exactly.
//
// Tangerine P8-6 (M42 PIM).

export const VALUE_TYPES = ["enum", "number", "text", "boolean", "date"];

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Validate the `options` jsonb on an attribute definition based on its value_type.
// For non-enum types options is allowed to be null/undefined.
export function validateOptionsForType(value_type, options) {
  if (value_type === "enum") {
    if (options == null || typeof options !== "object" || Array.isArray(options)) {
      return { error: "options must be an object {\"options\": [...]} for enum value_type" };
    }
    const list = options.options;
    if (!Array.isArray(list) || list.length === 0) {
      return { error: "options.options must be a non-empty array of strings for enum value_type" };
    }
    for (const o of list) {
      if (typeof o !== "string" || o.trim() === "") {
        return { error: "Every options.options entry must be a non-empty string" };
      }
    }
    return { data: { options: list.map((s) => s) } };
  }
  // For non-enum types, allow options=null (most common) OR a plain object
  // (the def may carry hints like {"min":0, "max":100} for number — we
  // don't enforce those here; just shape-check).
  if (options == null) return { data: { options: null } };
  if (typeof options !== "object" || Array.isArray(options)) {
    return { error: "options must be an object or null" };
  }
  return { data: { options } };
}

// Validate an attribute VALUE (the per-style `value` jsonb) against a
// definition row. We accept either:
//   * a raw scalar (string / number / boolean) which we wrap as {value: x}
//   * a {value: ...} envelope (what the schema stores)
//
// Returns { data: {value: <wrapped>} } or { error: ... }.
export function validateValueAgainstDef(def, raw) {
  if (!def || !VALUE_TYPES.includes(def.value_type)) {
    return { error: "Attribute definition is missing or has invalid value_type" };
  }
  const inner = unwrap(raw);
  if (inner === undefined) {
    return { error: "value is required" };
  }

  switch (def.value_type) {
    case "enum": {
      const list = def.options?.options;
      if (!Array.isArray(list) || list.length === 0) {
        return { error: "Attribute definition is missing options for enum value_type" };
      }
      if (typeof inner !== "string") {
        return { error: "value must be a string for enum value_type" };
      }
      if (!list.includes(inner)) {
        return { error: `value must be one of ${list.join(", ")}` };
      }
      return { data: { value: inner } };
    }
    case "number": {
      // Accept either Number or a numeric string; coerce to Number.
      if (typeof inner === "boolean") return { error: "value must be a number" };
      const n = Number(inner);
      if (!Number.isFinite(n)) return { error: "value must be a finite number" };
      return { data: { value: n } };
    }
    case "boolean": {
      // Strict: only real booleans accepted (avoids '"false"' → true surprises).
      if (typeof inner !== "boolean") {
        return { error: "value must be a boolean (true or false)" };
      }
      return { data: { value: inner } };
    }
    case "date": {
      if (typeof inner !== "string" || !ISO_DATE_RE.test(inner)) {
        return { error: "value must be an ISO date string (YYYY-MM-DD)" };
      }
      // Verify it's a real calendar date by round-tripping through Date.
      const d = new Date(inner + "T00:00:00Z");
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== inner) {
        return { error: "value must be a valid calendar date (YYYY-MM-DD)" };
      }
      return { data: { value: inner } };
    }
    case "text":
    default: {
      if (typeof inner !== "string") return { error: "value must be a string for text value_type" };
      if (inner.length > 10_000) return { error: "value must be <= 10000 chars" };
      return { data: { value: inner } };
    }
  }
}

// Internal: pull the scalar out of either a {value: x} envelope or a raw scalar.
function unwrap(raw) {
  if (raw === null) return null;
  if (raw === undefined) return undefined;
  if (typeof raw === "object" && !Array.isArray(raw) && Object.prototype.hasOwnProperty.call(raw, "value")) {
    return raw.value;
  }
  return raw;
}

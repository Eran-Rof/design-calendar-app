// api/_lib/approvals/schema.js
//
// JSONB shape validation for approval_rules.match and approval_rules.steps.
// Rejects malformed specs at rule-create time so the matcher (api/_lib/
// approvals/matcher.js) can trust its inputs.
//
// Supported .match operators (all optional; empty {} = match all):
//   min_amount_cents:  number      → amount_cents >= n
//   max_amount_cents:  number      → amount_cents <= n
//   source_kind:       string      → payload.source_kind === s
//   vendor_new:        boolean     → payload.vendor_new === b
//   entity_id:         uuid string → top-level entity_id === s
//   or:                array       → ANY child clause matches
//   and:               array       → EVERY child clause matches
//
// Supported .steps shape (required; non-empty array):
//   [{ step_order: int>=1, mode: "any"|"all", role_required: string }, ...]
//   step_order values must be unique.

const VALID_MATCH_KEYS = new Set([
  "min_amount_cents",
  "max_amount_cents",
  "source_kind",
  "vendor_new",
  "entity_id",
  "or",
  "and",
]);

// Keep in sync with entity_users role CHECK constraint
// (admin|accountant|staff|readonly). Extending that constraint requires
// rerunning this check too.
const VALID_ROLES = new Set(["admin", "accountant", "staff", "readonly"]);

const VALID_MODES = new Set(["any", "all"]);

export function validateMatch(match) {
  if (match === null || match === undefined) {
    return { ok: false, error: "match must be an object" };
  }
  if (typeof match !== "object" || Array.isArray(match)) {
    return { ok: false, error: "match must be an object" };
  }
  for (const key of Object.keys(match)) {
    if (!VALID_MATCH_KEYS.has(key)) {
      return { ok: false, error: `unknown match operator: ${key}` };
    }
  }

  if ("min_amount_cents" in match && !isPositiveNumber(match.min_amount_cents)) {
    return { ok: false, error: "min_amount_cents must be a number >= 0" };
  }
  if ("max_amount_cents" in match && !isPositiveNumber(match.max_amount_cents)) {
    return { ok: false, error: "max_amount_cents must be a number >= 0" };
  }
  if ("source_kind" in match && typeof match.source_kind !== "string") {
    return { ok: false, error: "source_kind must be a string" };
  }
  if ("vendor_new" in match && typeof match.vendor_new !== "boolean") {
    return { ok: false, error: "vendor_new must be a boolean" };
  }
  if ("entity_id" in match && typeof match.entity_id !== "string") {
    return { ok: false, error: "entity_id must be a string" };
  }
  if ("or" in match) {
    if (!Array.isArray(match.or)) return { ok: false, error: "or must be an array" };
    for (const clause of match.or) {
      const r = validateMatch(clause);
      if (!r.ok) return { ok: false, error: `or: ${r.error}` };
    }
  }
  if ("and" in match) {
    if (!Array.isArray(match.and)) return { ok: false, error: "and must be an array" };
    for (const clause of match.and) {
      const r = validateMatch(clause);
      if (!r.ok) return { ok: false, error: `and: ${r.error}` };
    }
  }
  return { ok: true };
}

export function validateSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { ok: false, error: "steps must be a non-empty array" };
  }
  const seenOrder = new Set();
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!s || typeof s !== "object" || Array.isArray(s)) {
      return { ok: false, error: `steps[${i}] must be an object` };
    }
    if (!Number.isInteger(s.step_order) || s.step_order < 1) {
      return { ok: false, error: `steps[${i}].step_order must be an integer >= 1` };
    }
    if (seenOrder.has(s.step_order)) {
      return { ok: false, error: `duplicate step_order ${s.step_order}` };
    }
    seenOrder.add(s.step_order);
    if (!VALID_MODES.has(s.mode)) {
      return { ok: false, error: `steps[${i}].mode must be 'any' or 'all'` };
    }
    if (typeof s.role_required !== "string" || !VALID_ROLES.has(s.role_required)) {
      return { ok: false, error: `steps[${i}].role_required must be one of: ${[...VALID_ROLES].join(", ")}` };
    }
  }
  return { ok: true };
}

export function validateRule({ match, steps }) {
  const m = validateMatch(match);
  if (!m.ok) return m;
  return validateSteps(steps);
}

function isPositiveNumber(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

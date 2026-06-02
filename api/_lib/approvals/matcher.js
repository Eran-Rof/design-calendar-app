// api/_lib/approvals/matcher.js
//
// matchesRule(rule, ctx)  →  boolean
//
// rule.match is an arbitrary JSONB object built from the operator vocabulary
// in schema.js. ctx is the call payload from approvalsAPI.requestIfRequired
// — { entity_id, amount_cents, source_kind, vendor_new, ... }.
//
// Truthiness of every clause is required (implicit AND between keys at the
// same level). or/and operators compose explicit boolean trees.
//
// Empty .match (or missing keys) → matches everything.

export function matchesRule(matchSpec, ctx) {
  if (matchSpec === null || matchSpec === undefined) return true;
  if (typeof matchSpec !== "object" || Array.isArray(matchSpec)) return false;

  // OR — any branch matching closes the gate
  if (Array.isArray(matchSpec.or)) {
    const orResult = matchSpec.or.some((sub) => matchesRule(sub, ctx));
    if (!orResult) return false;
  }
  // AND — every branch must match
  if (Array.isArray(matchSpec.and)) {
    const andResult = matchSpec.and.every((sub) => matchesRule(sub, ctx));
    if (!andResult) return false;
  }

  if ("min_amount_cents" in matchSpec) {
    if (typeof ctx.amount_cents !== "number") return false;
    if (ctx.amount_cents < matchSpec.min_amount_cents) return false;
  }
  if ("max_amount_cents" in matchSpec) {
    if (typeof ctx.amount_cents !== "number") return false;
    if (ctx.amount_cents > matchSpec.max_amount_cents) return false;
  }
  if ("source_kind" in matchSpec) {
    if (ctx.source_kind !== matchSpec.source_kind) return false;
  }
  if ("vendor_new" in matchSpec) {
    if (ctx.vendor_new !== matchSpec.vendor_new) return false;
  }
  if ("entity_id" in matchSpec) {
    if (ctx.entity_id !== matchSpec.entity_id) return false;
  }
  return true;
}

/**
 * Given a set of candidate rules and a request context, return:
 *   - the list of matching rules
 *   - the deduped, ordered step list (union by (step_order, role_required, mode))
 *
 * If no rules match, returns { matched: [], steps: [] }.
 */
export function resolveSteps(rules, ctx) {
  const matched = rules.filter((r) => matchesRule(r.match, ctx));
  if (matched.length === 0) return { matched: [], steps: [] };

  const stepKey = (s) => `${s.step_order}|${s.role_required}|${s.mode}`;
  const seen = new Set();
  const allSteps = [];

  for (const rule of matched) {
    for (const step of rule.steps) {
      const k = stepKey(step);
      if (seen.has(k)) continue;
      seen.add(k);
      allSteps.push({
        step_order: step.step_order,
        role_required: step.role_required,
        mode: step.mode,
      });
    }
  }

  allSteps.sort((a, b) => a.step_order - b.step_order);
  return { matched, steps: allSteps };
}

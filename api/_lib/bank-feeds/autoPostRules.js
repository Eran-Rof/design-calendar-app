// api/_lib/bank-feeds/autoPostRules.js
//
// Tangerine P6-7 — Auto-post fee rules engine (pure, no I/O).
//
// Rule shape (one entry in bank_accounts.auto_post_fee_rules JSONB array):
//   {
//     match:             "<regex source>",        // required, JS regex tested against description+merchant_name
//     target_account_id: "<gl_account uuid>",     // required
//     max_amount_cents:  <int>                    // optional; cap |amount| (no cap if omitted/null)
//     direction:         "deposit" | "withdrawal" | "both",  // optional; default "both"
//     label:             "<short tag for audit>"  // optional, human-readable
//   }
//
// The matcher is intentionally simple: first-match-wins (rules array is
// scanned top-to-bottom), so operators can order specific rules before
// catch-alls. Returns the matched rule + index, or null.
//
// Used by:
//   - /api/internal/bank-accounts/:id PATCH (validating user-supplied rules)
//   - /api/cron/bank-auto-post-fees (matching unmatched bank_transactions)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DIRECTION_VALUES = ["deposit", "withdrawal", "both"];

/**
 * Validate a single rule object. Returns {error} or {data: normalizedRule}.
 * The "match" regex is compiled to verify it's a valid pattern; we store
 * the source string (case-insensitive flag is applied at match time).
 */
export function validateRule(rule) {
  if (rule == null || typeof rule !== "object" || Array.isArray(rule)) {
    return { error: "rule must be an object" };
  }
  if (typeof rule.match !== "string" || rule.match.length === 0) {
    return { error: "rule.match (regex string) is required" };
  }
  if (rule.match.length > 500) {
    return { error: "rule.match must be <= 500 chars" };
  }
  try { new RegExp(rule.match, "i"); }
  catch (e) { return { error: `rule.match is not a valid regex: ${e instanceof Error ? e.message : String(e)}` }; }

  if (typeof rule.target_account_id !== "string" || !UUID_RE.test(rule.target_account_id)) {
    return { error: "rule.target_account_id must be a UUID" };
  }

  const out = {
    match: rule.match,
    target_account_id: rule.target_account_id,
    max_amount_cents: null,
    direction: "both",
    label: null,
  };

  if (rule.max_amount_cents != null) {
    const n = Number(rule.max_amount_cents);
    if (!Number.isInteger(n) || n <= 0) {
      return { error: "rule.max_amount_cents must be a positive integer (cents)" };
    }
    out.max_amount_cents = n;
  }
  if (rule.direction != null) {
    if (!DIRECTION_VALUES.includes(rule.direction)) {
      return { error: `rule.direction must be one of ${DIRECTION_VALUES.join(", ")}` };
    }
    out.direction = rule.direction;
  }
  if (rule.label != null) {
    const s = String(rule.label).trim();
    if (s.length > 80) return { error: "rule.label must be <= 80 chars" };
    if (s.length > 0) out.label = s;
  }
  return { data: out };
}

/**
 * Validate an array of rules. Returns {error} on first invalid entry,
 * else {data: normalizedRules}.
 */
export function validateRulesArray(rules) {
  if (!Array.isArray(rules)) return { error: "rules must be an array" };
  if (rules.length > 50) return { error: "rules array capped at 50 entries" };
  const out = [];
  for (let i = 0; i < rules.length; i += 1) {
    const v = validateRule(rules[i]);
    if (v.error) return { error: `rule[${i}]: ${v.error}` };
    out.push(v.data);
  }
  return { data: out };
}

/**
 * Find the first matching rule for a bank transaction.
 * @param {Array} rules            normalized rules array
 * @param {Object} txn             { description, merchant_name, amount_cents }
 * @returns {{rule: object, index: number} | null}
 */
export function findMatchingRule(rules, txn) {
  if (!Array.isArray(rules) || rules.length === 0) return null;
  if (txn == null || typeof txn !== "object") return null;
  const amount = Number(txn.amount_cents);
  if (!Number.isFinite(amount) || amount === 0) return null;

  const haystack = [
    typeof txn.description === "string" ? txn.description : "",
    typeof txn.merchant_name === "string" ? txn.merchant_name : "",
  ].filter(Boolean).join(" | ");
  if (!haystack) return null;

  const direction = amount > 0 ? "deposit" : "withdrawal";
  const absAmount = Math.abs(amount);

  for (let i = 0; i < rules.length; i += 1) {
    const r = rules[i];
    if (!r || typeof r !== "object") continue;
    if (r.direction && r.direction !== "both" && r.direction !== direction) continue;
    if (r.max_amount_cents != null && absAmount > Number(r.max_amount_cents)) continue;
    let re;
    try { re = new RegExp(String(r.match), "i"); }
    catch { continue; }
    if (re.test(haystack)) return { rule: r, index: i };
  }
  return null;
}

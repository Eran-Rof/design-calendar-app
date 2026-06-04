// api/_lib/master-sync-normalize.js
//
// Tier 2C — server-side port of the daily_check.py + post_master_data.py
// data scrub, so both the Playwright nightly path AND the REST
// rest_master_sync.py path get the same normalization + compliance gate.
//
// Before this module, normalization lived in rof_xoro_project's
// daily_check.py / normalize.py (CamoColors / gender prefix audit / etc.)
// and the >=99% compliance gate lived in post_master_data.py. Those run
// upstream of the Playwright POST. The REST path skipped both, leaving
// /api/master/sync open to ingesting raw, unnormalized data.
//
// What this module ports:
//   1. String trim + HTML strip on the human-typed text fields. (Matches
//      handler's existing stripHtml() but applied earlier in the pipeline
//      so the compliance buckets see clean strings.)
//   2. Gender-code uppercase + alphabet restriction to {M, B, C, G, W, U}
//      with prefix-derived expectation (RY*=M, CG*=G, ACMB*=M, etc.). This
//      is the operator-defined GENDER_PREFIX_RULES table from daily_check.py
//      ported 1:1, with one normalization tweak: daily_check.py marks
//      Womens as "WMS" (3 letters) because that's what Xoro emits; the
//      handler normalizes the canonical single-letter alphabet to "W".
//      See deferred items at the bottom of the docstring.
//   3. Color normalization — collapses common spelling variants that
//      drift in from Xoro's free-text Option1Value. Today the explicit
//      table is small (the canonical "camo color" review list daily_check
//      cared about was data-driven, not hardcoded, so we only port the
//      whitespace/case rules + the small set of fixed canonicalizations
//      that are safe globally).
//   4. Compliance metric — (compliant_rows / scanned_rows). Mirrors the
//      post_master_data.py formula (raw_compliant + auto_corrected) /
//      scanned. From the handler's POV every normalized row is either a
//      "raw_compliant" (no change) or "auto_corrected" (changed), so the
//      sum equals scanned minus rows that still flunk a bucket rule.
//
// Buckets a row can land in (mutually exclusive, lowest-severity wins):
//   - GENDER_INVALID         : GenderCode outside {M,B,C,G,W,U}
//   - GENDER_MISMATCH        : prefix-rule predicts X, Xoro says Y != X
//   - MISSING_STYLE          : neither ItemNumber nor BasePartNumber present
//   - MISSING_DESCRIPTION    : no description + no title (existing rows
//                              still pass — only flagged for telemetry)
//   - OK                     : all rules pass
//
// Idempotency: every transform is a deterministic function of the input
// string. Running normalizeRow twice yields identical output the second
// time (changed=false). This matters because daily_check.py ALSO runs
// upstream — double-normalization must be a no-op or the parallel-run
// would corrupt rows during the Playwright shutdown window.
//
// Deferred items (NOT ported, surfaced in PR body):
//   * Master BP mapping (Group/Category/ProductCategory override) lives
//     in data/master_bp_mapping.csv — a data file Eran maintains, not
//     code. Shipping the CSV into the handler would duplicate state.
//     The handler trusts upstream normalization for Group+Category.
//   * UPC restoration (upc_source_of_truth.csv) — same reasoning.
//   * Junk blocklist (junk_blocklist.txt) — same reasoning.
//   * Checklist-driven (Group, Category) compliance — needs checklist.xlsx
//     loaded, same data-file constraint.
// These all stay upstream in daily_check.py for the Playwright path. The
// REST path produces clean Xoro snapshots without those overrides anyway
// (REST is the source of truth for Group/Category — no UI rewrites to
// fight against).

// Canonical single-letter alphabet for GenderCode. Xoro emits a few
// non-canonical variants (WMS, GIRLS, MENS) which we collapse to single
// letters here so the compliance gate uses one consistent vocabulary.
export const VALID_GENDERS = new Set(["M", "B", "C", "G", "W", "U"]);

// Advisory buckets: still REPORTED in the per-bucket counts + the strict
// compliance_pct, but NOT counted against the upsert gate. GENDER_MISMATCH
// is the prefix-rule disagreeing with Xoro's GenderCode — it's a source-
// data review item (operator fixes GenderCode in Xoro), not a reason to
// refuse the whole item-master snapshot. The local daily_check.py path
// already treats it as compliant (its email reports ~99.95%), so excluding
// it here also re-aligns the two metrics that had drifted apart.
// GENDER_INVALID (code outside the alphabet) stays a HARD gate failure.
export const ADVISORY_BUCKETS = new Set(["GENDER_MISMATCH"]);

// Operator-defined prefix-to-gender rules, ported 1:1 from
// rof_xoro_project/scripts/daily_check.py GENDER_PREFIX_RULES.
// Longest / most-specific prefixes first so the regex match doesn't get
// hijacked by a shorter one (ACMB must beat AC; PTY must beat PT; etc.).
//
// The PYTHON side stores 'WMS' for Womens (because that's the literal
// string Xoro accepts). The handler normalizes the canonical alphabet to
// single letters, so 'WMS' becomes 'W' on the JS side. Both sides agree
// on the underlying concept, just different storage representations.
export const GENDER_PREFIX_RULES = [
  [["ACMB", "BRMB"], "M"], // explicit 4-letter mens prefixes
  [["RBB", "RCB"], "B"],   // explicit 3-letter boys prefixes
  [["PTY"], "M"],          // Psycho Tuna mens
  [["RY"], "M"],           // all RY* are mens
  [["CJ"], "W"],           // CJ* is womens (daily_check.py uses 'WMS' here)
  [["CY", "CM"], "M"],     // CY* / CM* are mens
  [["CB"], "B"],           // CB* is boys
  [["CC"], "C"],           // CC* is child
  [["CG"], "G"],           // CG* is girls
];

// Color spelling-variant canonicalization. Keys are uppercased / trimmed
// input; values are the canonical form. Intentionally narrow — only the
// drift patterns Eran has called out as cleanup-worthy. Free-text drift
// (e.g. minor spacing variations) is handled by the unconditional
// trim/collapse rules in normalizeColor() rather than by this table, so
// the table can stay small.
//
// To extend: add an entry here; idempotency is preserved as long as the
// VALUE is itself a valid key (or absent from keys), so a second pass
// collapses to the same string.
export const COLOR_ALIASES = {
  // Common camo spelling drift seen in Xoro free-text exports.
  // (Kept narrow — the broad daily_check.py "CamoColorsReview" list
  // referenced in the migration plan turned out to be data-driven, not
  // hardcoded, so we only port the small fixed canonicalizations.)
  "CAMOFLAGE": "CAMOUFLAGE",
  "CAMMO": "CAMO",
  "CAMOS": "CAMO",
  // Common color-word drift.
  "BLK": "BLACK",
  "BLCK": "BLACK",
  "WHT": "WHITE",
  "WHTE": "WHITE",
  "GRY": "GREY",
  "GRAY": "GREY",
};

function stripHtml(s) {
  if (!s || typeof s !== "string") return s;
  if (!s.includes("<")) return s;
  return s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

function trimCollapse(s) {
  if (s == null) return "";
  return String(s).replace(/\s+/g, " ").trim();
}

/**
 * Normalize a color string.
 *   - Uppercases, trims, collapses internal whitespace
 *   - Applies COLOR_ALIASES canonicalization
 * Idempotent: normalizeColor(normalizeColor(x)) === normalizeColor(x).
 */
export function normalizeColor(raw) {
  const cleaned = trimCollapse(raw).toUpperCase();
  if (!cleaned) return "";
  return COLOR_ALIASES[cleaned] ?? cleaned;
}

/**
 * Look up the expected gender for a style code (BasePartNumber or
 * ItemNumber prefix). Returns null when no rule matches — daily_check.py
 * "silently skips" those because we can't say what they should be.
 *
 * Returns { gender, prefix } when matched.
 */
export function expectedGenderFor(styleCode) {
  if (!styleCode) return null;
  const sc = String(styleCode).trim().toUpperCase();
  for (const [prefixes, gender] of GENDER_PREFIX_RULES) {
    for (const p of prefixes) {
      if (sc.startsWith(p)) return { gender, prefix: p };
    }
  }
  return null;
}

/**
 * Normalize a GenderCode string to the canonical single-letter alphabet
 * {M, B, C, G, W, U}. Accepts common Xoro variants:
 *   "WMS", "WOMENS", "WOMEN", "W" -> "W"
 *   "MENS", "MEN", "M"            -> "M"
 *   "BOYS", "B"                   -> "B"
 *   "GIRLS", "G"                  -> "G"
 *   "KIDS", "CHILD", "C"          -> "C"
 *   "UNISEX", "U"                 -> "U"
 * Returns the original uppercased trimmed string when no mapping applies
 * so the caller can flag it as GENDER_INVALID.
 */
export function normalizeGender(raw) {
  const v = trimCollapse(raw).toUpperCase();
  if (!v) return "";
  if (v === "WMS" || v.startsWith("WOMEN")) return "W";
  if (v === "MENS" || v === "MEN" || v === "M") return "M";
  if (v === "BOYS" || v === "BOY" || v === "B") return "B";
  if (v === "GIRLS" || v === "GIRL" || v === "G") return "G";
  if (v === "KIDS" || v === "CHILD" || v === "CHILDREN" || v === "C") return "C";
  if (v === "UNISEX" || v === "U") return "U";
  return v;
}

/**
 * Normalize one CSV row (the buildCandidate input shape:
 *   BasePartNumber, Option1Value, GenderCode, GroupName, CategoryName,
 *   ProductCategoryName, Description, Title, ItemNumber, ...).
 *
 * Returns { row, changed, ops, bucket }:
 *   - row     : a NEW row object with normalized field values; original
 *               untouched. Unknown fields pass through unchanged.
 *   - changed : true iff any field was actually mutated.
 *   - ops     : ordered list of operation tags (for the per-row audit).
 *   - bucket  : "OK" | "GENDER_INVALID" | "GENDER_MISMATCH" |
 *               "MISSING_STYLE" | "MISSING_DESCRIPTION"
 *
 * Idempotent. A row that is already normalized round-trips with
 * changed=false and the same bucket.
 */
export function normalizeRow(rowIn) {
  const row = { ...rowIn };
  const ops = [];
  let changed = false;
  let bucket = "OK";

  // 1. Trim/collapse the human-text fields.
  for (const f of [
    "BasePartNumber",
    "ItemNumber",
    "GroupName",
    "CategoryName",
    "ProductCategoryName",
    "Title",
  ]) {
    if (row[f] != null) {
      const before = String(row[f]);
      const after = trimCollapse(before);
      if (after !== before) {
        row[f] = after;
        ops.push(`trim:${f}`);
        changed = true;
      }
    }
  }

  // 2. HTML strip on Description (matches the handler's stripHtml call).
  if (row.Description != null) {
    const before = String(row.Description);
    const stripped = stripHtml(before);
    const after = trimCollapse(stripped == null ? "" : String(stripped));
    if (after !== before) {
      row.Description = after;
      ops.push("strip_html:Description");
      changed = true;
    }
  }

  // 3. Color normalization (Option1Value).
  if (row.Option1Value != null) {
    const before = String(row.Option1Value);
    const after = normalizeColor(before);
    if (after !== before) {
      row.Option1Value = after;
      ops.push("normalize_color:Option1Value");
      changed = true;
    }
  }

  // 4. Gender normalization + bucket assignment.
  if (row.GenderCode != null) {
    const before = String(row.GenderCode);
    const after = normalizeGender(before);
    if (after !== before) {
      row.GenderCode = after;
      ops.push("normalize_gender:GenderCode");
      changed = true;
    }
    // Empty GenderCode is allowed (the upstream gender check skips these
    // when no prefix rule matches; flagging EVERY empty would tank the
    // compliance rate). Only flag a present-but-out-of-alphabet code.
    if (after && !VALID_GENDERS.has(after)) {
      bucket = "GENDER_INVALID";
    }
  }

  // 5. Gender-prefix rule check. Only when an expected gender exists
  // (i.e. the BP starts with a known prefix). Don't override a
  // GENDER_INVALID bucket — that's strictly worse.
  if (bucket === "OK") {
    const styleHint = String(row.BasePartNumber ?? row.ItemNumber ?? "");
    const expected = expectedGenderFor(styleHint);
    if (expected) {
      const current = trimCollapse(row.GenderCode).toUpperCase();
      const want = expected.gender.toUpperCase();
      if (current && current !== want) {
        bucket = "GENDER_MISMATCH";
      }
      // Missing-but-expected is NOT bucketed as a violation here. The
      // upstream daily_check tracks it separately as "missing" and it
      // doesn't cross the compliance gate threshold. Keeping parity.
    }
  }

  // 6. Style presence check.
  if (bucket === "OK") {
    const hasItem = trimCollapse(row.ItemNumber) !== "";
    const hasBp = trimCollapse(row.BasePartNumber) !== "";
    if (!hasItem && !hasBp) bucket = "MISSING_STYLE";
  }

  // 7. Description presence check (lowest severity).
  if (bucket === "OK") {
    const desc = trimCollapse(row.Description) || trimCollapse(row.Title);
    if (!desc) bucket = "MISSING_DESCRIPTION";
  }

  return { row, changed, ops, bucket };
}

/**
 * Aggregate per-row results into the bucket_counts.json-shaped object.
 *
 * Inputs:
 *   rowsIn         : raw rows (just used for the scanned count + base len)
 *   normalizedRows : array of normalizeRow() return values, same length
 *                    as rowsIn (caller responsibility).
 *
 * Output shape (mirrors post_master_data.py compliance_pct formula):
 *   {
 *     compliance_pct,   // 100 * compliant / scanned (or 100 when scanned=0)
 *     scanned,          // count of input rows
 *     compliant,        // rows whose normalized bucket === 'OK'
 *     auto_corrected,   // rows that changed but ended OK
 *     unchanged_ok,     // rows that were already OK and didn't change
 *     buckets: {        // counts per bucket label
 *       OK, GENDER_INVALID, GENDER_MISMATCH,
 *       MISSING_STYLE, MISSING_DESCRIPTION
 *     }
 *   }
 *
 * compliance_pct = compliant / scanned * 100. A row that has bucket=OK
 * counts as compliant regardless of whether it was auto-corrected. This
 * matches the post_master_data.py formula
 * (raw_compliant + auto_corrected) / scanned where "auto_corrected"
 * means the normalized row IS compliant.
 *
 * Severity-only buckets (e.g. MISSING_DESCRIPTION) still count as
 * non-compliant for gate purposes. This matches daily_check.py treating
 * any non-OK reason as non-compliant.
 *
 * Two compliance figures are returned:
 *   - compliance_pct      : strict (only bucket=OK counts) — for telemetry
 *                           so advisory drift stays visible.
 *   - gate_compliance_pct : compliant + ADVISORY_BUCKETS (e.g. gender
 *                           mismatch) — this is what the upsert gate
 *                           compares to the threshold. advisory_count
 *                           breaks out how many rows the gate forgave.
 */
export function computeCompliance(rowsIn, normalizedRows) {
  const scanned = (rowsIn && rowsIn.length) || 0;
  const buckets = {
    OK: 0,
    GENDER_INVALID: 0,
    GENDER_MISMATCH: 0,
    MISSING_STYLE: 0,
    MISSING_DESCRIPTION: 0,
  };
  let compliant = 0;
  let autoCorrected = 0;
  let unchangedOk = 0;
  let advisoryCount = 0;

  for (const nr of normalizedRows || []) {
    const b = nr?.bucket || "OK";
    buckets[b] = (buckets[b] ?? 0) + 1;
    if (b === "OK") {
      compliant++;
      if (nr.changed) autoCorrected++;
      else unchangedOk++;
    } else if (ADVISORY_BUCKETS.has(b)) {
      advisoryCount++;
    }
  }

  const compliancePct = scanned > 0 ? (100 * compliant) / scanned : 100;
  const gateCompliancePct = scanned > 0 ? (100 * (compliant + advisoryCount)) / scanned : 100;
  return {
    compliance_pct: Number(compliancePct.toFixed(4)),
    gate_compliance_pct: Number(gateCompliancePct.toFixed(4)),
    advisory_count: advisoryCount,
    scanned,
    compliant,
    auto_corrected: autoCorrected,
    unchanged_ok: unchangedOk,
    buckets,
  };
}

// Default compliance threshold — mirrors post_master_data.py
// --min-compliance-pct default of 99.0. The handler can override per
// request, but production runs use this default.
export const DEFAULT_COMPLIANCE_THRESHOLD_PCT = 99.0;

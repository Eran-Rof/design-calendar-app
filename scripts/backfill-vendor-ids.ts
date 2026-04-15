#!/usr/bin/env node
/**
 * scripts/backfill-vendor-ids.ts
 *
 * Populates tanda_pos.vendor_id by fuzzy-matching the existing tanda_pos.vendor
 * string column (populated from XoroPO.VendorName at sync time) against the
 * vendors table (materialized from app_data['vendors'] by migration 0002).
 *
 * Usage:
 *   npx tsx scripts/backfill-vendor-ids.ts           # dry-run, prints CSV
 *   npx tsx scripts/backfill-vendor-ids.ts --apply   # actually UPDATEs rows
 *
 * Reads credentials from .env.local (VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY).
 * RLS allows the anon role FOR ALL on tanda_pos + vendors, so the anon key is
 * enough for both SELECT and UPDATE.
 *
 * Match rules:
 *   - Normalize = lowercase, trim, collapse whitespace, strip trailing punctuation.
 *   - Exact normalized match → action=auto-match (confidence 1.00).
 *   - Levenshtein similarity ≥ 0.85 → auto-match (confidence = similarity).
 *   - 0.70 ≤ similarity < 0.85 → needs-review (printed, not applied).
 *   - similarity < 0.70 or empty vendor string → no-match.
 *
 * With --apply, only auto-match rows are written. needs-review and no-match
 * rows are left with NULL vendor_id and printed to stderr so an operator
 * can decide (add an alias to the vendors table, create a new vendor, etc.).
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ── env loading ──────────────────────────────────────────────────────────────
function loadDotEnv(filePath: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(filePath)) return out;
  const raw = fs.readFileSync(filePath, "utf8");
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const env = {
  ...loadDotEnv(path.resolve(process.cwd(), ".env.local")),
  ...process.env,
};

const SB_URL = env.VITE_SUPABASE_URL;
const SB_KEY = env.VITE_SUPABASE_ANON_KEY;

if (!SB_URL || !SB_KEY) {
  console.error("Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY (checked .env.local and process.env).");
  process.exit(1);
}

const SB_HEADERS: Record<string, string> = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  "Content-Type": "application/json",
};

// ── fuzzy-match primitives ───────────────────────────────────────────────────
function normalize(s: string): string {
  return (s || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.,;:]+$/g, "");
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array(b.length + 1);
  const cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

function similarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na && !nb) return 1;
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const d = levenshtein(na, nb);
  const longest = Math.max(na.length, nb.length);
  return 1 - d / longest;
}

type VendorRow = { id: string; name: string; aliases: string[] | null };
type POStringRow = { id: number; po_number: string; vendor: string | null };

function bestMatch(
  vendorString: string,
  vendors: VendorRow[],
): { vendor: VendorRow | null; confidence: number } {
  let best: VendorRow | null = null;
  let bestScore = 0;
  const normalizedTarget = normalize(vendorString);
  if (!normalizedTarget) return { vendor: null, confidence: 0 };

  for (const v of vendors) {
    const candidates = [v.name, ...(v.aliases ?? [])];
    for (const c of candidates) {
      const score = similarity(normalizedTarget, c);
      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    }
  }
  return { vendor: best, confidence: bestScore };
}

// ── data fetching ────────────────────────────────────────────────────────────
async function sbFetch<T>(pathAndQuery: string, init?: RequestInit): Promise<T> {
  const url = `${SB_URL}/rest/v1/${pathAndQuery}`;
  const res = await fetch(url, { ...init, headers: { ...SB_HEADERS, ...(init?.headers || {}) } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${res.status} on ${pathAndQuery}: ${text.slice(0, 300)}`);
  }
  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

async function loadVendors(): Promise<VendorRow[]> {
  return sbFetch<VendorRow[]>(
    "vendors?select=id,name,aliases&deleted_at=is.null",
  );
}

async function loadPOStrings(): Promise<POStringRow[]> {
  // Fetch all rows in pages of 1000 (PostgREST default cap).
  const out: POStringRow[] = [];
  const pageSize = 1000;
  let offset = 0;
  while (true) {
    const page = await sbFetch<POStringRow[]>(
      `tanda_pos?select=id,po_number,vendor&order=id.asc&limit=${pageSize}&offset=${offset}`,
    );
    out.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return out;
}

async function applyUpdates(updates: Array<{ id: number; vendor_id: string }>) {
  // Group by vendor_id so each PATCH sets the same value on many rows —
  // avoids the upsert-requires-all-NOT-NULL-columns trap.
  const byVendor = new Map<string, number[]>();
  for (const u of updates) {
    const arr = byVendor.get(u.vendor_id) ?? [];
    arr.push(u.id);
    byVendor.set(u.vendor_id, arr);
  }

  for (const [vendorId, ids] of byVendor) {
    // PATCH with id=in.(comma,list) filter. Batch the id list to stay under
    // PostgREST's URL length limit (~8k); ~200 numeric ids is well under.
    const BATCH = 200;
    for (let i = 0; i < ids.length; i += BATCH) {
      const slice = ids.slice(i, i + BATCH);
      const url = `${SB_URL}/rest/v1/tanda_pos?id=in.(${slice.join(",")})`;
      const res = await fetch(url, {
        method: "PATCH",
        headers: { ...SB_HEADERS, Prefer: "return=minimal" },
        body: JSON.stringify({ vendor_id: vendorId }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Apply failed ${res.status}: ${text.slice(0, 400)}`);
      }
    }
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
type Decision = {
  po_id: number;
  po_number: string;
  extracted_string: string;
  matched_vendor: string;
  matched_vendor_id: string;
  confidence: string;
  action: "auto-match" | "needs-review" | "no-match";
};

const AUTO_THRESHOLD = 0.85;
const REVIEW_THRESHOLD = 0.70;

async function main() {
  const apply = process.argv.includes("--apply");

  console.error("Loading vendors…");
  const vendors = await loadVendors();
  console.error(`  ${vendors.length} vendors`);

  console.error("Loading tanda_pos rows…");
  const pos = await loadPOStrings();
  console.error(`  ${pos.length} rows`);

  const decisions: Decision[] = [];
  for (const po of pos) {
    const str = (po.vendor ?? "").trim();
    if (!str) {
      decisions.push({
        po_id: po.id,
        po_number: po.po_number,
        extracted_string: "",
        matched_vendor: "",
        matched_vendor_id: "",
        confidence: "0.00",
        action: "no-match",
      });
      continue;
    }
    const { vendor, confidence } = bestMatch(str, vendors);
    const action: Decision["action"] =
      vendor && confidence >= AUTO_THRESHOLD
        ? "auto-match"
        : vendor && confidence >= REVIEW_THRESHOLD
          ? "needs-review"
          : "no-match";
    decisions.push({
      po_id: po.id,
      po_number: po.po_number,
      extracted_string: str,
      matched_vendor: vendor?.name ?? "",
      matched_vendor_id: vendor?.id ?? "",
      confidence: confidence.toFixed(2),
      action,
    });
  }

  // Print CSV to stdout.
  const headers = [
    "po_id",
    "po_number",
    "extracted_string",
    "matched_vendor",
    "matched_vendor_id",
    "confidence",
    "action",
  ];
  const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;
  console.log(headers.join(","));
  for (const d of decisions) {
    console.log([
      d.po_id,
      quote(d.po_number),
      quote(d.extracted_string),
      quote(d.matched_vendor),
      quote(d.matched_vendor_id),
      d.confidence,
      d.action,
    ].join(","));
  }

  // Summary to stderr.
  const counts = { "auto-match": 0, "needs-review": 0, "no-match": 0 };
  for (const d of decisions) counts[d.action]++;
  console.error("\nSummary:");
  console.error(`  auto-match:   ${counts["auto-match"]}`);
  console.error(`  needs-review: ${counts["needs-review"]}`);
  console.error(`  no-match:     ${counts["no-match"]}`);

  if (!apply) {
    console.error("\nDry-run only. Re-run with --apply to write auto-match decisions.");
    return;
  }

  const updates = decisions
    .filter(d => d.action === "auto-match")
    .map(d => ({ id: d.po_id, vendor_id: d.matched_vendor_id }));

  if (updates.length === 0) {
    console.error("Nothing to apply.");
    return;
  }

  console.error(`\nApplying ${updates.length} auto-match updates…`);
  // Batch to stay well under URL / payload limits.
  const BATCH = 200;
  for (let i = 0; i < updates.length; i += BATCH) {
    await applyUpdates(updates.slice(i, i + BATCH));
    console.error(`  applied ${Math.min(i + BATCH, updates.length)} / ${updates.length}`);
  }
  console.error("Done.");
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});

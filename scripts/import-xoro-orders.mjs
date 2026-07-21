#!/usr/bin/env node
/**
 * scripts/import-xoro-orders.mjs
 *
 * Idempotent importer: brings ALL Xoro Purchase Orders (and, best-effort,
 * Sales Orders) from the already-synced REST mirror data into the native
 * Tangerine tables (purchase_orders/_lines, sales_orders/_lines), filling
 * every mappable field + the correct status.
 *
 * DATA SOURCES (verified against prod 2026-06-18):
 *   - POs: table `tanda_pos` (243 rows; data jsonb = full Xoro PO payload:
 *     PoNumber, VendorName, BrandName, StatusName, DateOrder,
 *     DateExpectedDelivery, CurrencyCode, ShipMethodName, CarrierName,
 *     PaymentTermsName, Memo, Tags, BuyerPo, TotalAmount, Items[]{ItemNumber,
 *     Description, QtyOrder, QtyReceived, QtyRemaining, UnitPrice, StatusName,
 *     DateExpectedDelivery}). RICH source.
 *   - SOs (rich): table `tanda_sos` (migration 20260897000000), the SO
 *     counterpart of tanda_pos, populated by POST /api/tanda/sync-sos-from-xoro
 *     from salesorder/getsalesorder (ATS-App / "items" creds). Carries the full
 *     flattened Xoro SO payload (real statuses, order/ship/cancel dates,
 *     CustomerPO, per-size lines). Imported natively behind --sos-native.
 *   - SOs (legacy/lossy): the gzip ATS snapshot in app_data['ats_base_data'].sos
 *     is CSV-derived and LOSSY (no per-size grain, no rich header, only
 *     Released/Partially Shipped). Preview-only behind --include-sos (no write).
 *
 * IDEMPOTENCY: dedup key = (entity_id, po_number), which carries the UNIQUE
 * index uq_purchase_orders_number. Re-running UPDATEs the existing native row +
 * REPLACES its lines (delete+reinsert) rather than duplicating. The importer
 * only ever touches POs it owns: rows whose notes start with "[xoro-import]".
 * Any app-authored native PO with the same number is left untouched.
 *
 * DRY-RUN BY DEFAULT. Pass --apply to write.
 *
 *   node scripts/import-xoro-orders.mjs                            # dry-run POs
 *   node scripts/import-xoro-orders.mjs --apply                    # write POs
 *   node scripts/import-xoro-orders.mjs --include-archived         # also terminal/archived POs
 *   node scripts/import-xoro-orders.mjs --sos-native               # dry-run native SOs from tanda_sos
 *   node scripts/import-xoro-orders.mjs --so-only --sos-native --apply  # write SOs only
 *   node scripts/import-xoro-orders.mjs --include-sos              # preview the lossy SO blob (no write)
 *   node scripts/import-xoro-orders.mjs --po=ROF-P001265 --apply   # targeted single-PO re-import (comma-separable)
 *
 * Reads VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env / .env.local.
 * Dependency-free: talks to PostgREST directly via fetch (no @supabase/supabase-js).
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
// Shared canonical colour derivation (single source of truth — same helper the
// AR/planning sync paths use). Preserves the readable colour segment of a raw
// Xoro ItemNumber ("Island Breeze Lt Wash") instead of squishing it.
import { prettyColorFromItemNumber } from "../api/_lib/sku-canon.js";
// Pure matching helpers (unit-tested in api/_lib/__tests__/xoroLineMatch.test.js).
// Includes the inseam-aware style-token resolver (RYB147730 = RYB1477 + inseam
// 30), the exactly-one colour+size matcher (spelling-tolerant Gray↔Grey /
// Lt↔Light / Blk↔Black), and mergePreservedLinks (the re-import link churn guard).
import {
  parseItemNumber, sizeVariantsOf, looseKey, expandedKey, colorMatchKey,
  resolveStyleToken, pickColorSizeMatch, mergePreservedLinks,
} from "../api/_lib/xoroLineMatch.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── args ───────────────────────────────────────────────────────────────────
const args = new Set(process.argv.slice(2));
const APPLY = args.has("--apply");
const INCLUDE_SOS = args.has("--include-sos");        // lossy ATS-blob preview (no write)
const SOS_NATIVE = args.has("--sos-native");          // import from the rich tanda_sos mirror → sales_orders/_lines
const INCLUDE_ARCHIVED = args.has("--include-archived");
const SO_ONLY = args.has("--so-only");                // skip the PO step (SO-only run)
const AFFECTED_ONLY = args.has("--affected-only");    // re-import ONLY orders that currently have ≥1 unresolved (null-linked) line — the targeted backfill
// --po=<number>[,<number>...]: re-import ONLY the named PO(s) — the single-PO targeted repair.
const PO_ONLY = new Set(
  [...args].filter((a) => a.startsWith("--po=")).flatMap((a) => a.slice(5).split(",")).map((s) => s.trim()).filter(Boolean)
);

// ── env ──────────────────────────────────────────────────────────────────--
function loadEnv(file) {
  try {
    const text = readFileSync(resolve(ROOT, file), "utf8");
    return Object.fromEntries(
      text.split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
      })
    );
  } catch { return {}; }
}
const env = { ...loadEnv(".env"), ...loadEnv(".env.local") };
const SB_URL = (env.VITE_SUPABASE_URL || process.env.VITE_SUPABASE_URL || "").replace(/\/+$/, "");
// Runtime env wins over the .env.local file value: the file holds the new
// sb_secret_* key (rejected by PostgREST), so an explicitly-exported JWT
// service-role key (e.g. revealed via the Management API for --apply) overrides it.
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = env.VITE_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
if (!SB_URL || SB_URL.includes("your_existing")) { console.error("✗ VITE_SUPABASE_URL missing"); process.exit(1); }

// Pick the key. --apply writes to anon-read-RLS tables (purchase_orders), so it
// REQUIRES a valid service-role key. Dry-run only reads (RLS allows anon read),
// so it falls back to the anon key when the service key is missing/stale.
let API_KEY = SERVICE_KEY;
if (!API_KEY || API_KEY.startsWith("sb_secret_")) {
  // The sb_secret_* key in .env.local is rejected by PostgREST ("Unregistered
  // API key") — treat it as absent. For dry-run, use anon.
  if (APPLY) {
    console.error("✗ --apply needs a valid JWT service-role key. The SUPABASE_SERVICE_ROLE_KEY in .env.local");
    console.error("  is the new sb_secret_* format which this project's PostgREST rejects ('Unregistered API key').");
    console.error("  Put a working service-role key (JWT, role=service_role) in SUPABASE_SERVICE_ROLE_KEY and re-run.");
    process.exit(2);
  }
  API_KEY = ANON_KEY;
  if (!API_KEY) { console.error("✗ no usable key (need VITE_SUPABASE_ANON_KEY for dry-run)"); process.exit(1); }
  console.log("ℹ using ANON key (read-only dry-run; --apply will require a valid service-role key)");
}
const REST = `${SB_URL}/rest/v1`;
const HDR = { apikey: API_KEY, Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };
const enc = encodeURIComponent;

// fetch with retry on transient network errors (UND_ERR_SOCKET "other side
// closed", ECONNRESET, etc.) + 5xx. A bare fetch throw used to crash the whole
// 12k-row run mid-import; this keeps long --apply runs resilient. 4 attempts,
// expo backoff.
async function rfetch(url, opts = {}) {
  const delays = [0, 500, 1500, 4000];
  let lastErr;
  for (const d of delays) {
    if (d) await new Promise((r) => setTimeout(r, d));
    try {
      const r = await fetch(url, opts);
      if (r.status >= 500 && r.status < 600) { lastErr = new Error(`HTTP ${r.status}`); continue; }
      return r;
    } catch (e) { lastErr = e; /* network blip — retry */ }
  }
  throw lastErr;
}

// Minimal PostgREST client (dependency-free).
async function pgGet(table, query = "") {
  const r = await rfetch(`${REST}/${table}?${query}`, { headers: HDR });
  if (!r.ok) throw new Error(`GET ${table}: ${r.status} ${await r.text()}`);
  return r.json();
}
async function pgGetPaged(table, selectQuery, page = 1000) {
  const out = []; let from = 0;
  for (;;) {
    const r = await rfetch(`${REST}/${table}?${selectQuery}`, { headers: { ...HDR, Range: `${from}-${from + page - 1}` } });
    if (!r.ok) throw new Error(`GET ${table}: ${r.status} ${await r.text()}`);
    const data = await r.json();
    if (!data || !data.length) break;
    out.push(...data); if (data.length < page) break; from += page;
  }
  return out;
}
async function pgInsert(table, rows, returning = "minimal") {
  const r = await rfetch(`${REST}/${table}`, { method: "POST", headers: { ...HDR, Prefer: `return=${returning}` }, body: JSON.stringify(rows) });
  if (!r.ok) { const t = await r.text(); return { error: { message: `${r.status} ${t}`, code: /23505/.test(t) ? "23505" : String(r.status) } }; }
  return { data: returning === "minimal" ? null : await r.json() };
}
async function pgPatch(table, query, patch) {
  const r = await rfetch(`${REST}/${table}?${query}`, { method: "PATCH", headers: { ...HDR, Prefer: "return=minimal" }, body: JSON.stringify(patch) });
  if (!r.ok) return { error: { message: `${r.status} ${await r.text()}` } };
  return {};
}
async function pgDelete(table, query) {
  const r = await rfetch(`${REST}/${table}?${query}`, { method: "DELETE", headers: { ...HDR, Prefer: "return=minimal" } });
  if (!r.ok) return { error: { message: `${r.status} ${await r.text()}` } };
  return {};
}

const NOTE_TAG = "[xoro-import]";

// ── helpers ──────────────────────────────────────────────────────────────--
const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ").replace(/[.,]+$/, "");

// Map a Xoro SaleStoreName to the canonical Warehouses-master name (mirrors
// migration 20260925). Unknown values pass through unchanged.
const XORO_STORE_TO_WAREHOUSE = {
  "rof main": "Main Warehouse",
  "rof - ecom": "ROF Ecom",
  "psycho tuna": "Psycho Tuna",
  "prebook - psycho tuna": "Psycho Tuna",
};
function warehouseFromXoroStore(raw) {
  const v = (raw == null ? "" : String(raw)).trim();
  if (!v) return null;
  return XORO_STORE_TO_WAREHOUSE[v.toLowerCase()] || v;
}
function toIsoDate(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s || s.startsWith("01/01/0001")) return null;
  s = s.split(" ")[0];
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const p = s.split("/");
  if (p.length === 3) {
    const m = +p[0], d = +p[1], y = +p[2];
    if (y < 1900 || !m || !d) return null;
    return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  return null;
}
const cents = (n) => { const v = Number(n); return Number.isFinite(v) ? Math.round(v * 100) : 0; };

// Size-canon, colour-abbreviation expansion, ItemNumber parse, inseam-aware
// style-token resolution, the exactly-one colour+size matcher, and the churn
// guard all live in ../api/_lib/xoroLineMatch.js (pure + unit-tested). Imported
// at the top of this file — single source of truth, do NOT re-copy them here.

// ── PO status map (Xoro StatusName -> purchase_orders.status) ──────────────--
// enum: draft | issued | partially_received | in_transit | received | cancelled
// (in_transit is a shipment overlay, not an order-lifecycle status; Xoro
//  "Partially Received" maps to partially_received, never in_transit).
function mapPoStatus(xoroStatus) {
  const s = norm(xoroStatus);
  if (s === "open") return "draft";
  if (s === "released") return "issued";
  if (s.includes("partial")) return "partially_received";
  if (s === "received" || s === "closed") return "received";
  if (s === "cancelled" || s === "canceled" || s === "void" || s === "voided") return "cancelled";
  return "issued";
}
// PO LINE status enum: open | received | cancelled
function mapPoLineStatus(line) {
  const s = norm(line.StatusName);
  if (s === "cancelled" || s === "canceled") return "cancelled";
  const ord = Number(line.QtyOrder) || 0;
  const rec = Number(line.QtyReceived) || 0;
  if (s === "received" || s === "closed" || (ord > 0 && rec >= ord)) return "received";
  return "open";
}

// ── SO status map (Xoro Order Line Status -> sales_orders.status) ──────────--
function mapSoStatus(xoroStatus) {
  const s = norm(xoroStatus);
  if (s.includes("partially shipped")) return "fulfilling";
  if (s === "shipped") return "shipped";
  if (s === "invoiced") return "invoiced";
  if (s === "closed" || s === "complete" || s === "completed") return "closed";
  if (s === "cancelled" || s === "canceled" || s === "void") return "cancelled";
  return "confirmed"; // released/open/confirmed
}
// SO LINE status enum: open | allocated | shipped | invoiced | cancelled
function mapSoLineStatus(line) {
  const s = norm(line.StatusName);
  if (s === "cancelled" || s === "canceled" || s === "void") return "cancelled";
  if (s === "invoiced") return "invoiced";
  const ord = Number(line.QtyOrder) || 0;
  const shp = Number(line.QtyShipped) || 0;
  if (s === "shipped" || (ord > 0 && shp >= ord)) return "shipped";
  const alloc = Number(line.QtyAllocated) || 0;
  if (s.includes("allocat") || alloc > 0) return "allocated";
  return "open";
}
// Derive a Xoro-style ItemNumber for SKU resolution: prefer the line's own
// ItemNumber, else rebuild "BASEPART-COLOR-SIZE" from the option fields the SO
// feed carries separately.
function soItemNumber(it) {
  const direct = String(it.ItemNumber ?? "").trim();
  if (direct) return direct;
  const parts = [it.BasePartNumber, it.Color, it.Size].map((x) => String(x ?? "").trim()).filter(Boolean);
  return parts.join("-");
}

// ── reference-data caches ────────────────────────────────────────────────--
async function loadEntity() {
  const data = await pgGet("entities", `code=eq.ROF&select=id,default_revenue_account_id&limit=1`);
  if (!data?.length) throw new Error("ROF entity not found");
  return data[0];
}
async function loadVendors() {
  const data = await pgGet("vendors", `select=id,name,code,aliases`);
  const byName = new Map(), byCode = new Map();
  for (const v of data || []) {
    if (v.name) byName.set(norm(v.name), v.id);
    if (v.code) byCode.set(norm(v.code), v.id);
    for (const a of v.aliases || []) byName.set(norm(a), v.id);
  }
  return { byName, byCode };
}
async function loadCustomers() {
  const data = await pgGet("customers", `select=id,name,customer_code,code,aliases,default_revenue_account_id`);
  const byName = new Map(), byCode = new Map(), revByCust = new Map();
  for (const c of data || []) {
    if (c.name) byName.set(norm(c.name), c.id);
    if (c.customer_code) byCode.set(norm(c.customer_code), c.id);
    if (c.code) byCode.set(norm(c.code), c.id);
    for (const a of c.aliases || []) byName.set(norm(a), c.id); // alias names resolve to this customer
    if (c.default_revenue_account_id) revByCust.set(c.id, c.default_revenue_account_id);
  }
  return { byName, byCode, revByCust };
}
async function loadBrands() {
  const data = await pgGet("brand_master", `select=id,name,code`);
  const byName = new Map();
  for (const b of data || []) { if (b.name) byName.set(norm(b.name), b.id); if (b.code) byName.set(norm(b.code), b.id); }
  return byName;
}
async function loadPaymentTerms() {
  const data = await pgGet("payment_terms", `select=id,name,code`);
  const byName = new Map();
  for (const t of data || []) { if (t.name) byName.set(norm(t.name), t.id); if (t.code) byName.set(norm(t.code), t.id); }
  return byName;
}
async function loadStyles() {
  const m = new Map();
  const data = await pgGetPaged("style_master", `select=id,style_code,aliases&deleted_at=is.null`);
  for (const s of data) {
    if (s.style_code) m.set(s.style_code.toUpperCase(), s.id);
    // Renamed/renumbered styles keep their OLD codes in `aliases` so a Xoro order
    // that still carries the legacy style code resolves to the renamed style
    // (mirrors loadVendors/loadCustomers alias indexing). Don't shadow a live code.
    for (const a of s.aliases || []) { const k = String(a).toUpperCase(); if (!m.has(k)) m.set(k, s.id); }
  }
  return m;
}

// Best-effort self-heal: when the import LINKS to an existing ip_item_master row
// whose colour is NULL/empty (the stale colourless rows that collapse the PO body
// matrix — root cause of the #1858 follow-up), backfill the colour parsed from
// the Xoro ItemNumber. GUARDED: only writes on --apply; NEVER overwrites a
// non-empty colour; try-wrapped so a heal failure can never abort the import.
async function healColorIfMissing(id, existingColor, itemNumber, apply) {
  if (!apply || !id) return;
  if (existingColor != null && String(existingColor).trim() !== "") return;
  try {
    const pretty = prettyColorFromItemNumber(itemNumber);
    if (!pretty) return;
    await pgPatch("ip_item_master", `id=eq.${id}`, { color: pretty });
  } catch { /* best-effort — import must not fail on a heal */ }
}

// SKU resolver: parse ItemNumber -> match existing ip_item_master row by exact
// sku_code, then (style,color,size-variant), then loose sku_code; else (apply)
// create a non-apparel partial SKU. Returns {id, created, reason}.
const skuCache = new Map();
async function resolveSku(entityId, itemNumber, styleByCode, opts) {
  if (skuCache.has(itemNumber)) return skuCache.get(itemNumber);
  let out = { id: null, created: false, reason: "" };
  const p = parseItemNumber(itemNumber);
  if (!p || !p.style_code) { out.reason = "unparseable"; skuCache.set(itemNumber, out); return out; }

  // 1) exact sku_code
  {
    const data = await pgGet("ip_item_master", `entity_id=eq.${entityId}&sku_code=eq.${enc(itemNumber)}&select=id,color&limit=1`);
    if (data?.length) { await healColorIfMissing(data[0].id, data[0].color, itemNumber, opts.apply); out = { id: data[0].id, created: false, reason: "exact-sku" }; skuCache.set(itemNumber, out); return out; }
  }
  // Resolve the style token to a style id, unwrapping the INSEAM COMPOSITE
  // ("RYB147730" = base style "RYB1477" + inseam "30"). Xoro's sized garment
  // ItemNumbers carry the inseam FUSED into the style token, which never matches
  // style_master's base style_code — so before this the tuple tier was skipped
  // and every such line ("Gray Wolf - Lt Gray" waist sizes) imported null-linked
  // even though the catalog row exists. resolveStyleToken also returns the peeled
  // inseam so the tuple can't cross-bind a different inseam's colour.
  const { styleId, inseam: tokenInseam } = resolveStyleToken(styleByCode, p.style_code);
  // 2/b) inseam-aware colour + size tuple. pickColorSizeMatch tolerates the
  //      spelling variance between the Xoro colour ("Gray Wolf - Lt Gray") and
  //      the catalog colour field ("Grey Wolf - Light Grey") — Gray↔Grey,
  //      Lt↔Light, Blk↔Black, wTint↔With Tint — and requires EXACTLY ONE match
  //      (zero-or-multi → fall through to the looser tiers / unresolved; never
  //      guesses). The optional inseam constraint disambiguates a style that has
  //      several inseam composites sharing one base style_code.
  if (styleId && p.size) {
    const variants = sizeVariantsOf(p.size).map((s) => `"${s.replace(/"/g, '""')}"`).join(",");
    const data = await pgGet("ip_item_master", `entity_id=eq.${entityId}&style_id=eq.${styleId}&size=in.(${enc(variants)})&select=id,color,size,inseam`);
    const hit = pickColorSizeMatch(data, { color: p.color, size: p.size, inseam: tokenInseam });
    if (hit) { await healColorIfMissing(hit.id, hit.color, itemNumber, opts.apply); out = { id: hit.id, created: false, reason: tokenInseam ? "inseam-tuple" : "tuple" }; skuCache.set(itemNumber, out); return out; }
  }
  // 3) loose sku_code match within the style family (capture the family so a
  //    missing SIZE can be auto-created from a sibling below).
  let family = [];
  {
    family = (await pgGet("ip_item_master", `entity_id=eq.${entityId}&sku_code=ilike.${enc(p.style_code + "-*")}&select=id,sku_code,style_id,style_code,color,size,inseam,length,fit,is_apparel&limit=500`)) || [];
    const target = looseKey(itemNumber);
    const hit = family.find((r) => looseKey(r.sku_code) === target);
    if (hit) { await healColorIfMissing(hit.id, hit.color, itemNumber, opts.apply); out = { id: hit.id, created: false, reason: "loose-sku" }; skuCache.set(itemNumber, out); return out; }
    // 3b) abbreviation-expanded loose match: tolerate Xoro's abbreviated colour
    //     words (Blck↔Black, MD↔Medium, Lt↔Light) while KEEPING the wash name
    //     (Ibiza, Carbon…). Expands both sides' tokens then strips separators.
    const exTarget = expandedKey(itemNumber);
    const exHit = family.find((r) => expandedKey(r.sku_code) === exTarget);
    if (exHit) { await healColorIfMissing(exHit.id, exHit.color, itemNumber, opts.apply); out = { id: exHit.id, created: false, reason: "loose-expanded" }; skuCache.set(itemNumber, out); return out; }
    // 3b') family colour + size tuple. The code-family (sku_code ILIKE STYLE-*)
    //      is already inseam-scoped by the composite prefix, but the sku_code's
    //      colour TOKEN is squished ("GRAYWOLF") while the Xoro colour carries the
    //      full readable form ("Gray Wolf - Lt Gray"), so 3/3b miss. Match on the
    //      catalog COLOUR FIELD (spelling-tolerant) + canonical size, exactly-one.
    //      Catches lines whose base style_code isn't registered in style_master
    //      (styleId above was null) but whose sized catalog row nonetheless exists.
    const famHit = pickColorSizeMatch(family, { color: p.color, size: p.size, inseam: null });
    if (famHit) { await healColorIfMissing(famHit.id, famHit.color, itemNumber, opts.apply); out = { id: famHit.id, created: false, reason: "family-tuple" }; skuCache.set(itemNumber, out); return out; }
    // 3c) PREPACK (PPK) lines. Xoro's ItemNumber ends in the pack SIZE segment
    //     ("…-PPK24"), but the catalog pack SKU keeps the pack size in the `size`
    //     COLUMN and OMITS it from sku_code (sku RYB153330PPK-SEAWEED-DARKWASH,
    //     size PPK24). That trailing "-PPK24" makes 3/3b miss by exactly the size
    //     token, so real prepacks import null-linked (then #matrix/cost break —
    //     they're the "Other lines" the PO grid can't fold in or cost per-each).
    //     Retry the loose/expanded match with the pack-size segment stripped,
    //     restricted to a family row whose OWN size is a PPK token so a pack line
    //     never binds to a loose per-size SKU. (Backfilled existing lines 2026-07-06.)
    if (/PPK/i.test(p.size || "")) {
      const noSize = p.color ? `${p.style_code}-${p.color}` : p.style_code;
      const lt = looseKey(noSize), et = expandedKey(noSize);
      const packHit = family.find((r) => /PPK/i.test(r.size || "") && (looseKey(r.sku_code) === lt || expandedKey(r.sku_code) === et));
      if (packHit) { out = { id: packHit.id, created: false, reason: "loose-ppk" }; skuCache.set(itemNumber, out); return out; }
      // GRAIN GUARDRAIL (Phase 4): no SIZED pack row, but a COLOR-ONLY row (size
      // null) for this colour exists — the "color-only rows stale" gap. Bind to it
      // AND stamp the pack size from the ItemNumber so the line CARRIES GRAIN
      // (per-each) instead of importing grain-less (the class Phase 1 backfilled:
      // the grid otherwise reads such a line at PACK grain, e.g. $127/each). Guard:
      // never overwrite an existing sibling already at that (style, colour, size).
      const colorOnly = family.find((r) => !r.size && (looseKey(r.sku_code) === lt || expandedKey(r.sku_code) === et));
      if (colorOnly) {
        const packSize = String(p.size).trim().toUpperCase();
        if (opts.apply) {
          const dup = family.find((r) => r.id !== colorOnly.id && r.style_id === colorOnly.style_id
            && colorMatchKey(r.color) === colorMatchKey(colorOnly.color) && String(r.size || "").toUpperCase() === packSize);
          if (!dup) await pgPatch("ip_item_master", `id=eq.${colorOnly.id}`, { size: packSize });
        }
        out = { id: colorOnly.id, created: false, reason: "ppk-promote-size" };
        skuCache.set(itemNumber, out); return out;
      }
    }
  }
  // 3.5) AUTO-CREATE a missing SIZED SKU under an ON-MASTER family (sibling
  //      inherit). The prior code minted is_apparel=false rows unconditionally,
  //      which mis-flagged denim apparel; we instead INHERIT is_apparel + the
  //      apparel dims (inseam/length/fit) and the colour spelling from an existing
  //      sibling SKU of the same style — so a real ordered size that simply has no
  //      SKU yet (e.g. DMB0013 waist 30 when 31–36 exist) joins the matrix
  //      correctly instead of importing as a blank null-linked line. Guards:
  //        • family must already have sibling SKUs (never invent a bare style)
  //        • a real garment size (skip PPK pack tokens — those need a prepack setup)
  //      Off-master items (no family) still fall through to the unresolved bucket
  //      for an operator-gated style + SKU backfill (unchanged).
  // Only create when a sibling with the SAME colour (abbreviation-expanded) exists,
  // so the new SKU inherits the catalog's colour spelling. NEVER fall back to an
  // arbitrary sibling's colour (that would mint a WRONG-colour SKU — e.g. creating
  // an "Ibiza" size under "Algae"). No colour match ⇒ leave unresolved + reported.
  // Prefer a SIZED sibling (r.size present) of the same colour, so the sku_code
  // size-swap is valid — never a color-grain/no-size row.
  // When the parsed style code resolves to a style, the sibling MUST belong to that
  // style. The code-family (sku_code ilike STYLE-*) also sweeps in VARIANT styles
  // (RBB0185-03SF, RBB0185-03SFPPK…), and a cross-style sibling makes the 23505
  // logical-tuple fallback bind the line to the VARIANT (P001265 Navy/Charcoal bound
  // to -03SF rows), splitting the base style's size run across phantom styles.
  const sibPool = styleId ? family.filter((r) => r.style_id === styleId) : family;
  const sib = (sibPool.length && p.size && !/PPK/i.test(itemNumber) && !/PPK/i.test(p.size))
    ? (sibPool.find((r) => r.style_id && r.size && colorMatchKey(r.color) === colorMatchKey(p.color))
        || sibPool.find((r) => r.style_id && colorMatchKey(r.color) === colorMatchKey(p.color)) || null)
    : null;
  if (sib) {
    if (!opts.apply) { out = { id: null, created: false, reason: "would-create-sibling" }; skuCache.set(itemNumber, out); return out; }
    const sizeSafe = String(p.size).trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    // Build the new code as STYLE-COLOUR-SIZE using the sibling's COLOUR FIELD
    // (authoritative) — never by swapping the sibling's trailing sku segment. Two
    // traps that swap hits: a COLOUR-ONLY sibling (sku ends in the colour, e.g.
    // RYB1157-ESPRESSO) loses the colour; and a sibling that is ITSELF a corrupted
    // COLOURLESS row (sku RYB1157-XL, colour "Dark Slate") yields the SIZE token
    // "XL" as the "colour". Both recreate colourless codes that collide across
    // colours and scramble the size/colour matrix — the Defect-C mis-resolution
    // (money still ties, but the grid shows phantom single-size "colours").
    // sib.color is the catalog's real colour, so normalising it (upper, alnum-only:
    // "Dark Slate" -> "DARKSLATE") ALWAYS yields a coloured code. Fall back to the
    // parsed source colour, then to a colourless code only when the SOURCE itself
    // carries no colour (a genuinely colourless ItemNumber).
    const colorSeg = String(sib.color || p.color || "").toUpperCase().replace(/[^A-Z0-9]+/g, "");
    const newSku = colorSeg ? `${sib.style_code}-${colorSeg}-${sizeSafe}` : `${sib.style_code}-${sizeSafe}`;
    // is_apparel only when the sibling is apparel AND all five dims are present
    // (mirrors resolveOrCreateSku — avoids the apparel_dims_required CHECK).
    const apparelFinal = !!(sib.is_apparel && sib.color && p.size && sib.inseam && sib.length && sib.fit);
    // Never mint another COLOURLESS row: when the sibling itself carries no
    // colour, fall back to the colour parsed from the Xoro ItemNumber (pretty
    // form) then the parsed source colour, so the new SKU always gets a colour.
    const newColor = (sib.color && String(sib.color).trim()) ? sib.color
      : (prettyColorFromItemNumber(itemNumber) || p.color || null);
    const row = {
      entity_id: entityId, sku_code: newSku, style_code: sib.style_code, style_id: sib.style_id,
      color: newColor, size: p.size, inseam: sib.inseam, length: sib.length, fit: sib.fit, is_apparel: apparelFinal,
    };
    const { data, error } = await pgInsert("ip_item_master", row, "representation");
    if (!error && data?.[0]?.id) {
      out = { id: data[0].id, created: true, reason: "created-sibling" };
      skuCache.set(itemNumber, { ...out, created: false }); // count the create once
      return out;
    }
    if (error && error.code === "23505") {
      // The sku_code OR the LOGICAL tuple (style_id+color+canonical-size+inseam)
      // already exists under a different sku_code spelling — reuse it rather than
      // dropping the line to unresolved. Try exact sku_code, then the tuple.
      let again = await pgGet("ip_item_master", `entity_id=eq.${entityId}&sku_code=eq.${enc(newSku)}&select=id&limit=1`);
      if (!again?.length) {
        const variants = sizeVariantsOf(p.size).map((s) => `"${s.replace(/"/g, '""')}"`).join(",");
        const colorF = sib.color ? `&color=eq.${enc(sib.color)}` : `&color=is.null`;
        const inseamF = sib.inseam ? `&inseam=eq.${enc(sib.inseam)}` : "";
        again = await pgGet("ip_item_master", `entity_id=eq.${entityId}&style_id=eq.${sib.style_id}${colorF}${inseamF}&size=in.(${enc(variants)})&select=id&limit=1`);
      }
      if (again?.[0]?.id) { out = { id: again[0].id, created: false, reason: "created-sibling-existing" }; skuCache.set(itemNumber, out); return out; }
    } else if (error) {
      // Unexpected insert failure — surface it (was silently dropped to unresolved).
      console.error(`  ! sku create failed [${itemNumber} -> ${newSku}]: ${error.message || error.code || error}`);
    }
  }
  // 4) Could not resolve or create → import null-linked (reported). off-master
  //    denim / PPK packs need an operator-gated style + sized-SKU backfill.
  out.reason = (styleId || family.length) ? "needs-sku-backfill" : "no-style";
  skuCache.set(itemNumber, out);
  return out;
}

// ── PO import ────────────────────────────────────────────────────────────--
async function importPOs(refs) {
  console.log("\n========== PURCHASE ORDERS ==========");
  const all = await pgGetPaged("tanda_pos", `select=po_number,status,data`, 500);
  const pos = all.filter((r) => INCLUDE_ARCHIVED || r.data?._archived !== true);
  console.log(`tanda_pos rows: ${all.length}  (importing ${pos.length}; archived-excluded ${all.length - pos.length})`);

  const existing = await pgGetPaged("purchase_orders", `entity_id=eq.${refs.entity.id}&select=id,po_number,notes`);
  const existingByNum = new Map((existing || []).map((r) => [r.po_number, r]));

  // --affected-only: limit the re-import to POs that currently have ≥1 unresolved
  // (null-linked) line — the targeted backfill (rebuilds those orders' lines from
  // the authoritative tanda source, auto-creating missing sized SKUs).
  let affected = null;
  if (AFFECTED_ONLY) {
    const numById = new Map((existing || []).map((r) => [r.id, r.po_number]));
    const nullLines = await pgGetPaged("purchase_order_lines", `inventory_item_id=is.null&select=purchase_order_id`);
    affected = new Set((nullLines || []).map((r) => numById.get(r.purchase_order_id)).filter(Boolean));
    console.log(`  --affected-only: ${affected.size} POs have unresolved lines`);
  }

  const stats = { insert: 0, update: 0, skip_app_owned: 0, blocked_no_vendor: 0, lines: 0, sku_created: 0, would_create: 0, preserved: 0, status: {}, lineStatus: {} };
  const vendorUnresolved = new Set(), skuUnresolved = new Set();
  const samples = [];

  for (const po of pos) {
    const d = po.data || {};
    const poNum = po.po_number;
    if (affected && !affected.has(poNum)) continue;
    if (PO_ONLY.size && !PO_ONLY.has(poNum)) continue;
    const vendorId = refs.vendors.byName.get(norm(d.VendorName)) || refs.vendors.byCode.get(norm(d.VendorName)) || null;
    if (!vendorId) vendorUnresolved.add(d.VendorName || "(blank)");
    const status = mapPoStatus(d.StatusName);
    stats.status[status] = (stats.status[status] || 0) + 1;

    const existRow = existingByNum.get(poNum);
    if (existRow && !(existRow.notes || "").startsWith(NOTE_TAG)) { stats.skip_app_owned++; continue; }

    // CHURN GUARD: this re-import REPLACES an existing PO's lines (delete+reinsert
    // below). Capture the current line→SKU links FIRST so a manual re-link (or a
    // prior successful auto-link) survives instead of reverting to whatever the
    // resolver produces this run — the bug where a 53/53-linked PO reverted to 5
    // unlinked after the next nightly. Keyed by line_number (deterministic from
    // the stable Xoro Items order). Best-effort read; a failure never aborts.
    let priorLinkByLineNo = new Map();
    if (existRow) {
      try {
        const prior = await pgGet("purchase_order_lines", `purchase_order_id=eq.${existRow.id}&select=line_number,inventory_item_id`);
        for (const pl of prior || []) if (pl.inventory_item_id != null) priorLinkByLineNo.set(Number(pl.line_number), pl.inventory_item_id);
      } catch { /* best-effort */ }
    }

    const lineRows = [];
    let ln = 1;
    for (const it of d.Items || []) {
      const qty = Number(it.QtyOrder) || 0;
      if (qty <= 0) continue;
      const sku = await resolveSku(refs.entity.id, it.ItemNumber, refs.styles, { apply: APPLY });
      if (sku.created) stats.sku_created++;
      if (!sku.id) { if (sku.reason === "would-create-sibling") stats.would_create++; else skuUnresolved.add(it.ItemNumber); }
      const uc = cents(it.UnitPrice);
      const lst = mapPoLineStatus(it);
      stats.lineStatus[lst] = (stats.lineStatus[lst] || 0) + 1;
      lineRows.push({
        line_number: ln++,
        inventory_item_id: sku.id,
        description: it.Description ? String(it.Description).trim() : null,
        qty_ordered: qty,
        qty_received: Number(it.QtyReceived) || 0,
        unit_cost_cents: uc,
        line_total_cents: Math.round(qty * uc),
        status: lst,
      });
    }
    if (!lineRows.length) continue;
    // Restore preserved links over the freshly-resolved ones (prior non-null wins;
    // prior null lets the upgraded resolver re-heal previously-unlinked lines).
    const merged = mergePreservedLinks(lineRows, priorLinkByLineNo);
    lineRows.length = 0; lineRows.push(...merged.rows);
    stats.preserved += merged.preserved;
    const subtotal = lineRows.reduce((s, l) => s + l.line_total_cents, 0);

    const header = {
      entity_id: refs.entity.id,
      vendor_id: vendorId,
      po_number: poNum,
      order_date: toIsoDate(d.DateOrder) || undefined,
      expected_date: toIsoDate(d.DateExpectedDelivery),
      status,
      currency: d.CurrencyCode || "USD",
      payment_terms_id: refs.terms.get(norm(d.PaymentTermsName)) || null,
      vendor_ref: d.BuyerPo || null,
      ship_method: null, // Xoro ShipMethodName ("Delivery (Own Truck)") has no sea/air/ground mapping
      freight_forwarder: d.CarrierName || null,
      notes: `${NOTE_TAG}${d.Memo ? " " + d.Memo : ""}`.trim(),
      subtotal_cents: subtotal,
      total_cents: subtotal,
    };
    const brandId = refs.brands.get(norm(d.BrandName));
    if (brandId) header.brand_id = brandId;

    if (samples.length < 4) samples.push({ poNum, vendor: d.VendorName, vendorResolved: !!vendorId, status, lines: lineRows.length, subtotal_$: (subtotal / 100).toFixed(2), firstLine: { ...lineRows[0], _skuReason: skuCache.get(d.Items?.[0]?.ItemNumber)?.reason } });

    if (!vendorId) { stats.blocked_no_vendor++; continue; } // vendor_id is NOT NULL

    if (APPLY) {
      let poId;
      if (existRow) {
        const { error } = await pgPatch("purchase_orders", `id=eq.${existRow.id}`, header);
        if (error) { console.error(`  ! update ${poNum}: ${error.message}`); continue; }
        poId = existRow.id; stats.update++;
        await pgDelete("purchase_order_lines", `purchase_order_id=eq.${poId}`);
      } else {
        const { data: h, error } = await pgInsert("purchase_orders", header, "representation");
        if (error) { console.error(`  ! insert ${poNum}: ${error.message}`); continue; }
        poId = h[0].id; stats.insert++;
      }
      const rows = lineRows.map((l) => ({ ...l, purchase_order_id: poId }));
      const { error: le } = await pgInsert("purchase_order_lines", rows);
      if (le) { console.error(`  ! lines ${poNum}: ${le.message}`); continue; }
      stats.lines += rows.length;
    } else {
      if (existRow) stats.update++; else stats.insert++;
      stats.lines += lineRows.length;
    }
  }

  console.log(`\n${APPLY ? "APPLIED" : "DRY-RUN"} PO result:`);
  console.log(`  inserts:        ${stats.insert}`);
  console.log(`  updates:        ${stats.update}`);
  console.log(`  lines:          ${stats.lines}`);
  console.log(`  skus created:   ${stats.sku_created}${stats.would_create ? `  (would create on --apply: ${stats.would_create})` : ""}`);
  console.log(`  links preserved (manual/prior link kept across re-import): ${stats.preserved}`);
  console.log(`  POs blocked (unresolved vendor, vendor_id NOT NULL): ${stats.blocked_no_vendor}`);
  console.log(`  skipped (app-owned native PO left untouched): ${stats.skip_app_owned}`);
  console.log(`  PO header status breakdown: ${JSON.stringify(stats.status)}`);
  console.log(`  PO line status breakdown:   ${JSON.stringify(stats.lineStatus)}`);
  console.log(`  UNRESOLVED vendors (${vendorUnresolved.size}): ${[...vendorUnresolved].join(" | ") || "none"}`);
  console.log(`  UNRESOLVED SKUs (distinct ${skuUnresolved.size}). first 15: ${[...skuUnresolved].slice(0, 15).join(", ") || "none"}`);
  console.log(`  sample mapped POs:`);
  for (const s of samples) console.log("   ", JSON.stringify(s));
  if (APPLY) {
    console.log(`\n  ➜ INGEST GUARDRAIL: run \`npm run audit:pos\` now to confirm no PO grid invariant regressed (unlinked / grain / size / case).`);
    console.log(`  ➜ DATA QUALITY: run \`npm run data-quality\` to surface any catalog/link defects this import introduced (orphan codes / unlinked / PPK / size coverage) — also visible in the PO grid's "⚠ Data quality" report.`);
  }
}

// ── SO source preview (lossy, opt-in) ────────────────────────────────────--
async function importSOs() {
  console.log("\n========== SALES ORDERS (LOSSY source — preview only) ==========");
  const row = await pgGet("app_data", `key=eq.ats_base_data&select=value&limit=1`);
  if (!row?.[0]?.value) { console.log("  no ats_base_data blob; skipping"); return; }
  let parsed;
  try {
    let obj = JSON.parse(row[0].value);
    if (obj && obj._gz) obj = JSON.parse(gunzipSync(Buffer.from(obj._gz, "base64")).toString("utf8"));
    parsed = obj;
  } catch (e) { console.log(`  could not parse ats_base_data: ${e.message}`); return; }
  const sos = Array.isArray(parsed?.sos) ? parsed.sos : [];
  console.log(`  ats_base_data.sos rows (line-grain): ${sos.length}  (syncedAt ${parsed?.syncedAt})`);
  if (sos.length) console.log(`  sample raw SO row keys: ${Object.keys(sos[0]).join(", ")}`);
  console.log("  NOTE: CSV-derived & lossy - no per-size SKU grain, no rich Xoro SO header, only");
  console.log("        Released/Partially Shipped statuses in the nightly. SO import is NOT executed.");
  console.log("        Recommend a dedicated tanda_sos mirror (like tanda_pos) before importing SOs.");
  const byOrder = new Map();
  for (const s of sos) {
    const on = s.orderNumber || s.order || s["Order Number"] || "";
    if (!on) continue;
    if (!byOrder.has(on)) byOrder.set(on, { customer: s.customer || s["Customer Name"], po: s.customerPo || s["Customer PO"], status: s.status || s["Order Line Status"], lines: 0 });
    byOrder.get(on).lines++;
  }
  console.log(`  distinct SO order numbers: ${byOrder.size}`);
  let i = 0;
  for (const [on, h] of byOrder) { if (i++ >= 3) break; console.log("   sample SO:", JSON.stringify({ on, ...h, mappedStatus: mapSoStatus(h.status) })); }
}

// ── SO import from the rich tanda_sos mirror → sales_orders/_lines ──────────--
// The faithful path. Reads the tanda_sos mirror (populated by
// POST /api/tanda/sync-sos-from-xoro) and writes native sales_orders/_lines
// with real statuses, dates, customer PO, and per-size lines. Idempotent on
// (entity_id, so_number); only touches SOs it owns (notes start with the
// import tag); app-authored native SOs with the same number are left untouched.
// customer_id is NOT NULL → an SO whose customer can't be resolved is blocked.
async function importSOsNative(refs) {
  console.log("\n========== SALES ORDERS (native, from tanda_sos mirror) ==========");
  let mirror;
  try {
    mirror = await pgGetPaged("tanda_sos", `select=so_number,status,data`, 500);
  } catch (e) {
    console.log(`  tanda_sos not available (${e.message}).`);
    console.log("  Populate it first: POST /api/tanda/sync-sos-from-xoro (bearer DESIGN_CALENDAR_API_TOKEN).");
    return;
  }
  console.log(`  tanda_sos rows: ${mirror.length}`);
  if (mirror.length === 0) {
    console.log("  Mirror is empty — run POST /api/tanda/sync-sos-from-xoro to populate, then re-run.");
    return;
  }

  const existing = await pgGetPaged("sales_orders", `entity_id=eq.${refs.entity.id}&select=id,so_number,notes`);
  const existingByNum = new Map((existing || []).map((r) => [r.so_number, r]));

  // --affected-only: limit the re-import to SOs that currently have ≥1 unresolved
  // (null-linked) line — the targeted backfill (rebuilds those orders' lines from
  // the authoritative tanda source, auto-creating missing sized SKUs).
  let affected = null;
  if (AFFECTED_ONLY) {
    const numById = new Map((existing || []).map((r) => [r.id, r.so_number]));
    const nullLines = await pgGetPaged("sales_order_lines", `inventory_item_id=is.null&select=sales_order_id`);
    affected = new Set((nullLines || []).map((r) => numById.get(r.sales_order_id)).filter(Boolean));
    console.log(`  --affected-only: ${affected.size} SOs have unresolved lines`);
  }

  const stats = { insert: 0, update: 0, skip_app_owned: 0, blocked_no_customer: 0, lines: 0, sku_created: 0, would_create: 0, preserved: 0, status: {}, lineStatus: {} };
  const custUnresolved = new Set(), skuUnresolved = new Set();
  const samples = [];

  for (const so of mirror) {
    const d = so.data || {};
    const soNum = so.so_number;
    if (affected && !affected.has(soNum)) continue;
    const custId = refs.customers.byName.get(norm(d.CustomerName)) || refs.customers.byCode.get(norm(d.CustomerName)) || null;
    if (!custId) custUnresolved.add(d.CustomerName || "(blank)");
    const status = mapSoStatus(d.StatusName);
    stats.status[status] = (stats.status[status] || 0) + 1;

    const existRow = existingByNum.get(soNum);
    if (existRow && !(existRow.notes || "").startsWith(NOTE_TAG)) { stats.skip_app_owned++; continue; }

    // CHURN GUARD (see importPOs): preserve prior line→SKU links across the
    // delete+reinsert so a manual re-link survives; a prior null re-resolves.
    let priorLinkByLineNo = new Map();
    if (existRow) {
      try {
        const prior = await pgGet("sales_order_lines", `sales_order_id=eq.${existRow.id}&select=line_number,inventory_item_id`);
        for (const pl of prior || []) if (pl.inventory_item_id != null) priorLinkByLineNo.set(Number(pl.line_number), pl.inventory_item_id);
      } catch { /* best-effort */ }
    }

    const lineRows = [];
    let ln = 1;
    for (const it of d.Items || []) {
      const qty = Number(it.QtyOrder) || 0;
      if (qty <= 0) continue;
      const itemNo = soItemNumber(it);
      const sku = await resolveSku(refs.entity.id, itemNo, refs.styles, { apply: APPLY });
      if (sku.created) stats.sku_created++;
      if (!sku.id) { if (sku.reason === "would-create-sibling") stats.would_create++; else skuUnresolved.add(itemNo); }
      const up = cents(it.UnitPrice);
      const lst = mapSoLineStatus(it);
      stats.lineStatus[lst] = (stats.lineStatus[lst] || 0) + 1;
      lineRows.push({
        line_number: ln++,
        inventory_item_id: sku.id,
        description: it.Description ? String(it.Description).trim() : null,
        qty_ordered: qty,
        qty_allocated: Number(it.QtyAllocated) || 0,
        qty_shipped: Number(it.QtyShipped) || 0,
        unit_price_cents: up,
        line_total_cents: Math.round(qty * up),
        status: lst,
      });
    }
    if (!lineRows.length) continue;
    const merged = mergePreservedLinks(lineRows, priorLinkByLineNo);
    lineRows.length = 0; lineRows.push(...merged.rows);
    stats.preserved += merged.preserved;
    const subtotal = lineRows.reduce((s, l) => s + l.line_total_cents, 0);

    const header = {
      entity_id: refs.entity.id,
      customer_id: custId,
      so_number: soNum,
      order_date: toIsoDate(d.DateOrder) || undefined,
      requested_ship_date: toIsoDate(d.DateToBeShipped),
      cancel_date: toIsoDate(d.DateToBeCancelled),
      status,
      currency: d.CurrencyCode || "USD",
      payment_terms_id: refs.terms.get(norm(d.PaymentTermsName)) || null,
      customer_po: d.CustomerPO || null,
      sale_store: warehouseFromXoroStore(d.SaleStoreName), // canonical Warehouses-master name (drives the SO Warehouse filter)
      origin: "internal", // sales_orders_origin_check allows: internal|b2b_portal|edi|marketplace
      notes: `${NOTE_TAG}${d.Memo ? " " + d.Memo : ""}`.trim(),
      subtotal_cents: subtotal,
      total_cents: subtotal,
    };
    const brandId = refs.brands.get(norm(d.BrandName));
    if (brandId) header.brand_id = brandId;
    const revId = custId ? refs.customers.revByCust.get(custId) : null;
    if (revId) header.revenue_account_id = revId;

    if (samples.length < 4) samples.push({ soNum, customer: d.CustomerName, customerResolved: !!custId, status, lines: lineRows.length, subtotal_$: (subtotal / 100).toFixed(2), firstLine: { ...lineRows[0], _skuReason: skuCache.get(soItemNumber(d.Items?.[0] || {}))?.reason } });

    if (!custId) { stats.blocked_no_customer++; continue; } // customer_id is NOT NULL

    if (APPLY) {
      let soId;
      if (existRow) {
        const { error } = await pgPatch("sales_orders", `id=eq.${existRow.id}`, header);
        if (error) { console.error(`  ! update ${soNum}: ${error.message}`); continue; }
        soId = existRow.id; stats.update++;
        await pgDelete("sales_order_lines", `sales_order_id=eq.${soId}`);
      } else {
        const { data: h, error } = await pgInsert("sales_orders", header, "representation");
        if (error) { console.error(`  ! insert ${soNum}: ${error.message}`); continue; }
        soId = h[0].id; stats.insert++;
      }
      const rows = lineRows.map((l) => ({ ...l, sales_order_id: soId }));
      const { error: le } = await pgInsert("sales_order_lines", rows);
      if (le) { console.error(`  ! lines ${soNum}: ${le.message}`); continue; }
      stats.lines += rows.length;
    } else {
      if (existRow) stats.update++; else stats.insert++;
      stats.lines += lineRows.length;
    }
  }

  console.log(`\n${APPLY ? "APPLIED" : "DRY-RUN"} SO result:`);
  console.log(`  inserts:        ${stats.insert}`);
  console.log(`  updates:        ${stats.update}`);
  console.log(`  lines:          ${stats.lines}`);
  console.log(`  skus created:   ${stats.sku_created}${stats.would_create ? `  (would create on --apply: ${stats.would_create})` : ""}`);
  console.log(`  links preserved (manual/prior link kept across re-import): ${stats.preserved}`);
  console.log(`  SOs blocked (unresolved customer, customer_id NOT NULL): ${stats.blocked_no_customer}`);
  console.log(`  skipped (app-owned native SO left untouched): ${stats.skip_app_owned}`);
  console.log(`  SO header status breakdown: ${JSON.stringify(stats.status)}`);
  console.log(`  SO line status breakdown:   ${JSON.stringify(stats.lineStatus)}`);
  console.log(`  UNRESOLVED customers (${custUnresolved.size}): ${[...custUnresolved].slice(0, 20).join(" | ") || "none"}`);
  console.log(`  UNRESOLVED SKUs (distinct ${skuUnresolved.size}). first 15: ${[...skuUnresolved].slice(0, 15).join(", ") || "none"}`);
  console.log(`  sample mapped SOs:`);
  for (const s of samples) console.log("   ", JSON.stringify(s));
}

// ── main ─────────────────────────────────────────────────────────────────--
(async () => {
  const tags = [INCLUDE_SOS ? "+SOs(lossy preview)" : "", SOS_NATIVE ? "+SOs(native)" : "", INCLUDE_ARCHIVED ? "+archived" : "", SO_ONLY ? "SO-only" : ""].filter(Boolean).join(" ");
  console.log(`Xoro->Tangerine order importer  [${APPLY ? "APPLY (WRITES)" : "DRY-RUN"}] ${tags}`);
  const entity = await loadEntity();
  const [vendors, customers, brands, terms, styles] = await Promise.all([
    loadVendors(), loadCustomers(), loadBrands(), loadPaymentTerms(), loadStyles(),
  ]);
  const refs = { entity, vendors, customers, brands, terms, styles };
  console.log(`refs: ${vendors.byName.size} vendor-names, ${customers.byName.size} customer-names, ${brands.size} brands, ${terms.size} terms, ${styles.size} styles`);
  if (!SO_ONLY) await importPOs(refs);
  if (SOS_NATIVE) await importSOsNative(refs);
  if (INCLUDE_SOS) await importSOs();
  console.log("\nDone.");
  process.exit(0);
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });

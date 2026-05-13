#!/usr/bin/env node
// Reads scripts/demo-data/celebpink-products.json and produces the row
// payloads needed to seed the demo Supabase project for the four apps in
// scope (Design Calendar, PO WIP, ATS, Inventory Planning).
//
// Default mode (no flags): writes scripts/demo-data/celebpink-seed.json
// for human review. Does NOT touch any database.
//
// Apply mode (--apply): POSTs rows to Supabase REST using SUPABASE_URL +
// SUPABASE_SERVICE_ROLE_KEY env. Uses Prefer: resolution=merge-duplicates
// so re-runs are idempotent.
//
// All generated identifiers are deterministic (hash-based, not random) so
// re-running produces identical output. All codes are prefixed DEMO-.
//
// Usage:
//   node scripts/seed-demo-celebpink.mjs           # generate JSON only
//   node scripts/seed-demo-celebpink.mjs --apply   # POST to Supabase
//   node scripts/seed-demo-celebpink.mjs --in <path> --out <path>

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (n) => argv.includes(`--${n}`);

const IN  = resolve(ROOT, arg("in",  "scripts/demo-data/celebpink-products.json"));
const OUT = resolve(ROOT, arg("out", "scripts/demo-data/celebpink-seed.json"));
const APPLY = flag("apply");

// Today's date — used for inventory snapshot date and task due dates.
// Hard-coded so re-runs are deterministic; override with --today YYYY-MM-DD.
const TODAY = arg("today", "2026-05-13");

// ── Deterministic helpers ────────────────────────────────────────────────
const hash = (s) => createHash("sha256").update(String(s)).digest("hex");
// Deterministic uuid v4-shaped from a string seed.
function uuidFrom(seed) {
  const h = hash(seed);
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    "4" + h.slice(13, 16),
    ((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20),
    h.slice(20, 32),
  ].join("-");
}
// Integer in [min, max] deterministic from seed.
function rngInt(seed, min, max) {
  const n = parseInt(hash(seed).slice(0, 8), 16);
  return min + (n % (max - min + 1));
}
function pick(seed, arr) { return arr[parseInt(hash(seed).slice(0, 8), 16) % arr.length]; }
function slugify(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}
function addDays(iso, days) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── Load ─────────────────────────────────────────────────────────────────
const raw = JSON.parse(readFileSync(IN, "utf-8"));
const products = raw.products || [];
console.log(`Loaded ${products.length} products from ${IN}`);

// ── Fixed actors / lists ─────────────────────────────────────────────────
const DEMO_VENDORS = [
  { code: "DEMO-VND-DENIMCO",  name: "Demo Denim Co.",       country: "VN", lead: 75,  moq: 300 },
  { code: "DEMO-VND-PINKTHRD", name: "Pink Threads Ltd.",    country: "CN", lead: 90,  moq: 500 },
  { code: "DEMO-VND-SUNSET",   name: "Sunset Apparel",       country: "MX", lead: 60,  moq: 250 },
  { code: "DEMO-VND-WESTWIND", name: "Westwind Garments",    country: "IN", lead: 105, moq: 400 },
];

const DEMO_COLLECTIONS = [
  { key: "DEMO-COL-SP26", name: "Spring 2026",     season: "Spring 2026" },
  { key: "DEMO-COL-SU26", name: "Summer 2026",     season: "Summer 2026" },
  { key: "DEMO-COL-FA26", name: "Fall 2026",       season: "Fall 2026" },
  { key: "DEMO-COL-HO26", name: "Holiday 2026",    season: "Holiday 2026" },
  { key: "DEMO-COL-PS27", name: "Pre-Spring 2027", season: "Pre-Spring 2027" },
  { key: "DEMO-COL-RS27", name: "Resort 2027",     season: "Resort 2027" },
];

// Category / sub-category mapping for the demo. ip_item_master.attributes
// uses `group_name` for Category and `category_name` for Sub Cat (the
// planning team's naming, see src/ats/itemMasterLookup.ts).
const CATEGORY_MAP = {
  "High Rise Straight":      { category: "DENIM",     sub: "WIDE LEG DENIM" },
  "High Rise Slim":          { category: "DENIM",     sub: "SKINNY" },
  "Ultra High Rise Short":   { category: "DENIM",     sub: "FLARE DENIM" },
  "High rise skinny":        { category: "DENIM",     sub: "SKINNY" },
  "Jumpsuit":                { category: "NON-DENIM", sub: "JUMPSUIT" },
  "Shortall":                { category: "NON-DENIM", sub: "SHORTALL" },
  "Tube Top":                { category: "NON-DENIM", sub: "TUBE TOP" },
  "Mid rise shorts":         { category: "DENIM",     sub: "SHORTS" },
  "High rise shorts":        { category: "DENIM",     sub: "SHORTS" },
  "Mid rise bermuda":        { category: "DENIM",     sub: "WIDE LEG DENIM" },
  "High rise bermuda":       { category: "DENIM",     sub: "WIDE LEG DENIM" },
  "High rise skirt":         { category: "DENIM",     sub: "SKIRT" },
  "Mid rise skinny crop":    { category: "DENIM",     sub: "SKINNY" },
  "Denim jacket":            { category: "OUTERWEAR", sub: "DENIM JACKET" },
  "Curvy mid rise slim":     { category: "DENIM",     sub: "SKINNY" },
};
function mapCategory(productType) {
  return CATEGORY_MAP[productType] || { category: "DENIM", sub: "OTHER" };
}

const TASK_PHASES = ["Design", "Tech Pack", "Proto Sample", "PP Sample", "Bulk PO", "Production", "Shipping"];
const TASK_STATUSES = ["Not Started", "In Progress", "Approved", "Complete"];
const DEMO_USERS = [
  { id: uuidFrom("user-designer"),  name: "Demo Designer",  initials: "DD" },
  { id: uuidFrom("user-merchant"),  name: "Demo Merchant",  initials: "DM" },
  { id: uuidFrom("user-planner"),   name: "Demo Planner",   initials: "DP" },
  { id: uuidFrom("user-techpack"),  name: "Demo Tech",      initials: "DT" },
];

// ── Build vendors (portal table + ip_vendor_master) ──────────────────────
// Columns mirror the real prod vendors table shape (legacy_blob_id, country,
// transit_days, categories[], contact, email, moq, status, etc.).
const portalVendors = DEMO_VENDORS.map(v => ({
  id: uuidFrom(`vendor-portal-${v.code}`),
  legacy_blob_id: `demo-${v.code.toLowerCase()}`,
  name: v.name,
  country: v.country,
  transit_days: 28,
  categories: ["denim", "bottoms"],
  contact: "Demo Contact",
  email: `contact@${slugify(v.name)}.demo`,
  moq: v.moq,
  status: "active",
}));

const ipVendors = DEMO_VENDORS.map((v, i) => ({
  id: uuidFrom(`vendor-ip-${v.code}`),
  vendor_code: v.code,
  name: v.name,
  country: v.country,
  default_lead_time_days: v.lead,
  moq_units: v.moq,
  active: true,
  portal_vendor_id: portalVendors[i].id,
  external_refs: { demo: true },
}));

const vendorByIdx = (i) => ipVendors[i % ipVendors.length];

// ── Build categories ─────────────────────────────────────────────────────
const productTypes = [...new Set(products.map(p => p.product_type).filter(Boolean))];
const ipCategories = productTypes.map(pt => ({
  id: uuidFrom(`cat-${pt}`),
  category_code: `DEMO-CAT-${slugify(pt).toUpperCase()}`,
  name: pt,
  segment: "both",
  active: true,
  external_refs: { demo: true },
}));
const categoryByType = new Map(ipCategories.map((c, i) => [productTypes[i], c]));

// ── Build items (one row per variant) ────────────────────────────────────
const ipItems = [];
const ipSnapshots = [];
const styleToItems = new Map();

// Strip celebpink's "copy-of-" prefixes (some duplicated 2-3 deep) and
// trailing underscores; collapse separators to dashes. Keeps style codes
// short enough to fit the planning grid's STYLE column without overflowing
// into DESCRIPTION.
function cleanStyleHandle(handle) {
  let s = String(handle || "").toLowerCase();
  while (s.startsWith("copy-of-")) s = s.slice("copy-of-".length);
  s = s.replace(/[_\s]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return s.slice(0, 20).toUpperCase();
}

products.forEach((p, pi) => {
  const cat = categoryByType.get(p.product_type);
  const vendor = vendorByIdx(pi);
  const styleSlug = cleanStyleHandle(p.handle);
  const styleCode = `DEMO-${styleSlug}`;
  const firstImage = p.images?.[0]?.src || null;

  p.variants.forEach((v) => {
    const price = Number(v.price) || 0;
    const cost = Math.round(price * 0.30 * 100) / 100;

    // Detect which option is size vs color heuristically by option name index.
    const sizeOptIdx = p.options.findIndex(o => /size/i.test(o.name));
    const colorOptIdx = p.options.findIndex(o => /color|wash/i.test(o.name));
    const size = sizeOptIdx === 0 ? v.option1 : sizeOptIdx === 1 ? v.option2 : v.option1;
    const color = colorOptIdx === 0 ? v.option1 : colorOptIdx === 1 ? v.option2 : v.option2;

    // SKU format chosen to match the app's size-parser expectation:
    // DEMO-{stylepart}-{colorpart}-{size}. The last dash-separated token
    // must pass isSizeToken (numeric or XS/S/M/L/XL etc.) so the PO
    // detail matrix renders correctly. See itemSizeLabel in GridView.tsx.
    // stylePart uses the same cleanStyleHandle helper so the SKU's style
    // segment matches style_code (modulo internal dashes that we strip
    // here so the size segment can still be parsed by its position).
    const stylePart = styleSlug.replace(/-/g, "") || "STYLE";
    const colorPart = String(color || "X").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 12) || "X";
    const sizePart  = String(size  || "OS").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 6) || "OS";
    const sku = `DEMO-${stylePart}-${colorPart}-${sizePart}`;
    const itemId = uuidFrom(`item-${sku}`);

    const cm = mapCategory(p.product_type);
    ipItems.push({
      id: itemId,
      sku_code: sku,
      style_code: styleCode,
      description: `${p.title} - ${size || ""} / ${color || ""}`.replace(/\s+/g, " ").trim(),
      category_id: cat?.id || null,
      vendor_id: vendor.id,
      color: color || null,
      size: size || null,
      uom: "each",
      unit_cost: cost,
      unit_price: price,
      lead_time_days: vendor.default_lead_time_days,
      moq_units: vendor.moq_units,
      lifecycle_status: "active",
      planning_class: pick(`pc-${sku}`, ["core", "seasonal", "fashion"]),
      active: true,
      external_refs: { demo: true, shopify_variant_id: v.id, shopify_product_id: p.id },
      attributes: {
        // Master metadata used by ATS enrichment + planning grid.
        // group_name = Category, category_name = Sub Cat (see ItemMasterRecord
        // in src/ats/itemMasterLookup.ts).
        group_name: cm.category,
        category_name: cm.sub,
        product_category: cm.category === "OUTERWEAR" ? "OUTERWEAR" : "BOTTOMS",
        gender: "Women",
        image_url: firstImage,
        product_handle: p.handle,
        product_title: p.title,
        product_type: p.product_type,
        original_sku: v.sku,
        shopify_available: v.available,
      },
    });

    // Snapshot: deterministic on-hand 0-200 with a few zeros for realism
    const onHand = rngInt(`oh-${sku}`, 0, 220);
    const committed = Math.min(onHand, rngInt(`cmt-${sku}`, 0, 60));
    const onOrder = rngInt(`oo-${sku}`, 0, 400);
    ipSnapshots.push({
      id: uuidFrom(`snap-${sku}-${TODAY}`),
      sku_id: itemId,
      warehouse_code: "DEMO-WH1",
      snapshot_date: TODAY,
      qty_on_hand: onHand,
      qty_available: Math.max(0, onHand - committed),
      qty_committed: committed,
      qty_on_order: onOrder,
      qty_in_transit: rngInt(`it-${sku}`, 0, 100),
      source: "manual",
    });

    if (!styleToItems.has(styleCode)) styleToItems.set(styleCode, { product: p, items: [] });
    styleToItems.get(styleCode).items.push({ itemId, sku, price, cost });
  });
});

// ── Add style-level master rows ──────────────────────────────────────────
// ATS's PO WIP fold (applyPOWIPDataToExcel + xoroSkuToExcel) reformats Xoro
// SKUs as "STYLE - COLOR" (no size suffix) and pushes them into ATS as new
// rows. Those rows then fail to match ip_item_master via the size-suffixed
// SKUs alone, so a style-level row per (style, color) gives them something
// to resolve against — exactly how prod's master is structured. Without
// these, the "N styles not in item master" banner reappears for every
// style+color combo seen in tanda_pos.
const styleLevelMap = new Map();
ipItems.forEach((it) => {
  const baseSku = `${it.sku_code.split("-").slice(0, -1).join("-")}`;
  if (!styleLevelMap.has(baseSku)) {
    styleLevelMap.set(baseSku, {
      id: uuidFrom(`style-level-${baseSku}`),
      sku_code: baseSku,
      style_code: baseSku,
      description: `${it.attributes?.product_title || ""} — style-level`.trim(),
      category_id: it.category_id,
      vendor_id: it.vendor_id,
      color: it.color,
      size: null,
      uom: "each",
      unit_cost: it.unit_cost,
      unit_price: it.unit_price,
      lead_time_days: it.lead_time_days,
      moq_units: it.moq_units,
      lifecycle_status: "active",
      planning_class: it.planning_class,
      active: true,
      external_refs: { demo: true, style_level: true },
      attributes: it.attributes,
    });
  }
});
const styleLevelItems = [...styleLevelMap.values()];
ipItems.push(...styleLevelItems);

// ── Build customer master ───────────────────────────────────────────────
// 5 demo customers across tiers so the planning grid shows real customer
// names (instead of "(Supply Only)" everywhere) and ABC analysis has data.
const DEMO_CUSTOMERS = [
  { code: "DEMO-CUST-WMT",   name: "Walmart",  tier: "major",    country: "US" },
  { code: "DEMO-CUST-MACYS", name: "Macy's",   tier: "major",    country: "US" },
  { code: "DEMO-CUST-DILL",  name: "Dillards", tier: "major",    country: "US" },
  { code: "DEMO-CUST-TJX",   name: "TJ Maxx",  tier: "off-price", country: "US" },
  { code: "DEMO-CUST-ROSS",  name: "Ross",     tier: "off-price", country: "US" },
];
const ipCustomers = DEMO_CUSTOMERS.map(c => ({
  id: uuidFrom(`cust-${c.code}`),
  customer_code: c.code,
  name: c.name,
  customer_tier: c.tier,
  country: c.country,
  active: true,
  external_refs: { demo: true },
}));

// ── Build prepack (PPK) styles ──────────────────────────────────────────
// Demo a few prepack SKUs to show the PPK explosion behaviour. The PPK
// detector in src/shared/prepack/index.ts looks for "PPKn" anywhere in
// the SKU and multiplies on-hand / on-PO / on-SO by n for display.
// We pick 5 distinct styles, generate a PPK<size-mix> variant per
// product-type with multipliers chosen for variety (6, 12, 24).
const PPK_DEFINITIONS = [
  { mult: 6,  label: "PPK6",  desc: "Pack of 6 (size run: 1×24, 2×26, 2×28, 1×30)" },
  { mult: 12, label: "PPK12", desc: "Pack of 12 (size run: 2×24, 3×26, 3×28, 2×30, 2×32)" },
  { mult: 24, label: "PPK24", desc: "Pack of 24 (full size run across 24-32)" },
  { mult: 6,  label: "PPK6",  desc: "Pack of 6 (size run: 1×26, 2×28, 2×30, 1×32)" },
  { mult: 12, label: "PPK12", desc: "Pack of 12 (size run: 2×25, 3×27, 3×29, 2×31, 2×33)" },
];
const prepackItems = [];
const prepackSnaps = [];
const ppkSourceProducts = products.slice(0, 5);
ppkSourceProducts.forEach((p, idx) => {
  const def = PPK_DEFINITIONS[idx];
  const cat = categoryByType.get(p.product_type);
  const vendor = vendorByIdx(idx);
  const styleSlug = cleanStyleHandle(p.handle);
  const stylePart = styleSlug.replace(/-/g, "") || "STYLE";
  // First color of this product, slugified
  const firstColor = p.options.find(o => /color|wash/i.test(o.name))?.values[0] || "BLACK";
  const colorPart = String(firstColor).replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 12);
  // SKU: DEMO-{style}-{color}-PPK{n}. PPK token is last so PPK detector
  // catches it; isSizeToken won't match so size column stays blank (correct
  // for prepacks — they aren't per-size).
  const sku = `DEMO-${stylePart}-${colorPart}-${def.label}`;
  const itemId = uuidFrom(`item-${sku}`);
  const unitPrice = Number(p.variants[0]?.price) || 49;
  // Pack-grain cost: avg per-unit cost × multiplier (Xoro stores prepack
  // cost at pack grain, not per-unit). avg unit cost = 30% of price.
  const unitCost = Math.round(unitPrice * 0.30 * 100) / 100;
  const packCost = Math.round(unitCost * def.mult * 100) / 100;

  const prepackItem = {
    id: itemId,
    sku_code: sku,
    style_code: `DEMO-${styleSlug}-PPK`,
    description: `${p.title} ${def.label} — ${firstColor} — ${def.desc}`,
    category_id: cat?.id || null,
    vendor_id: vendor.id,
    color: firstColor,
    size: def.label,
    uom: "pack",
    unit_cost: packCost,
    unit_price: unitPrice * def.mult,
    lead_time_days: vendor.default_lead_time_days,
    moq_units: 100,
    lifecycle_status: "active",
    planning_class: "core",
    active: true,
    external_refs: { demo: true, ppk: true, ppk_mult: def.mult },
    attributes: (() => {
      const cm = mapCategory(p.product_type);
      return {
        group_name: cm.category,
        category_name: cm.sub,
        product_category: cm.category === "OUTERWEAR" ? "OUTERWEAR" : "BOTTOMS",
        gender: "Women",
        image_url: p.images?.[0]?.src || null,
        product_handle: p.handle,
        product_title: p.title,
        product_type: p.product_type,
        is_prepack: true,
        ppk_mult: def.mult,
      };
    })(),
  };
  prepackItems.push(prepackItem);
  ipItems.push(prepackItem);

  // Inventory: prepacks are stocked at pack grain. Smaller numbers (3-15
  // packs) so the explosion math is visible (e.g. 5 packs × 24 = 120 units).
  const onHandPacks = rngInt(`ppk-oh-${sku}`, 3, 20);
  const onOrderPacks = rngInt(`ppk-oo-${sku}`, 0, 30);
  const snap = {
    id: uuidFrom(`snap-${sku}-${TODAY}`),
    sku_id: itemId,
    warehouse_code: "DEMO-WH1",
    snapshot_date: TODAY,
    qty_on_hand: onHandPacks,
    qty_available: onHandPacks,
    qty_committed: 0,
    qty_on_order: onOrderPacks,
    qty_in_transit: 0,
    source: "manual",
  };
  prepackSnaps.push(snap);
  ipSnapshots.push(snap);

  // Register the prepack style for inclusion in random POs below.
  styleToItems.set(prepackItem.style_code, {
    product: p,
    items: [{ itemId, sku, price: unitPrice * def.mult, cost: packCost }],
  });
});

// ── Build POs (20 POs, each with 3–6 styles × variants) ─────────────────
const styles = [...styleToItems.entries()];
const openPos = [];
const tandaPos = [];
const PO_STATUSES = ["issued", "in_production", "shipped", "received"];

for (let i = 0; i < 20; i++) {
  const poNumber = `DEMO-PO-${String(1000 + i).padStart(5, "0")}`;
  const vendor = vendorByIdx(i);
  const orderDate = addDays(TODAY, -rngInt(`pod-${i}`, 30, 120));
  const expectedDate = addDays(orderDate, vendor.default_lead_time_days);
  const status = PO_STATUSES[i % PO_STATUSES.length];
  const buyerPo = `BUYER-${String(2000 + i).padStart(4, "0")}`;

  const styleCount = rngInt(`scnt-${i}`, 3, 6);
  const pickedStyles = [];
  for (let s = 0; s < styleCount; s++) {
    pickedStyles.push(styles[(i * 7 + s * 13) % styles.length]);
  }

  // Build PO lines. Two shapes generated from the same loop:
  //   - openPos[] for ip_open_purchase_orders (snake_case, planning schema)
  //   - items[] for tanda_pos.data.Items (Xoro PascalCase, what the PO WIP
  //     UI reads — see XoroPOItem in src/utils/tandaTypes.ts).
  const items = [];
  pickedStyles.forEach(([styleCode, info], si) => {
    info.items.forEach((it, vi) => {
      const qty = rngInt(`poq-${i}-${si}-${vi}`, 6, 120);
      const received = status === "received" ? qty : status === "shipped" ? Math.floor(qty / 2) : 0;
      const lineNo = String(si * 100 + vi + 1);
      const skuObj = ipItems.find(x => x.id === it.itemId);
      const lineStatus = status === "received" ? "Closed" : "Open";
      openPos.push({
        id: uuidFrom(`opo-${poNumber}-${it.sku}`),
        sku_id: it.itemId,
        vendor_id: vendor.id,
        po_number: poNumber,
        po_line_number: lineNo,
        order_date: orderDate,
        expected_date: expectedDate,
        qty_ordered: qty,
        qty_received: received,
        qty_open: qty - received,
        unit_cost: it.cost,
        currency: "USD",
        status,
        source: "manual",
        source_line_key: `${poNumber}:${lineNo}`,
      });
      items.push({
        ItemNumber: it.sku,
        Description: skuObj?.description ?? "",
        QtyOrder: qty,
        QtyReceived: received,
        QtyRemaining: qty - received,
        UnitPrice: it.price,
        Discount: 0,
        StatusName: lineStatus,
        DateExpectedDelivery: expectedDate,
      });
    });
  });

  const totalQty = items.reduce((n, l) => n + (l.QtyOrder || 0), 0);
  const totalAmount = items.reduce((n, l) => n + (l.QtyOrder || 0) * (l.UnitPrice || 0), 0);

  const tandaId = uuidFrom(`tanda-${poNumber}`);
  const xoroStatus = status === "issued" ? "Released" : status === "in_production" ? "Released" : status === "shipped" ? "Released" : "Closed";
  tandaPos.push({
    uuid_id: tandaId,
    po_number: poNumber,
    vendor: vendor.name,
    vendor_id: portalVendors[ipVendors.indexOf(vendor)].id,
    buyer_name: "Celebrity Pink Jeans (DEMO)",
    buyer_po: buyerPo,
    date_order: orderDate,
    date_expected: expectedDate,
    date_expected_delivery: expectedDate,
    status,
    synced_at: new Date().toISOString(),
    data: {
      // Xoro-shaped PO header (see XoroPO interface in src/utils/tandaTypes.ts).
      // PascalCase is required — the PO WIP detail panels read these specific
      // field names. snake_case fields will leave the UI blank.
      PoNumber: poNumber,
      VendorName: vendor.name,
      DateOrder: orderDate,
      DateExpectedDelivery: expectedDate,
      StatusName: xoroStatus,
      CurrencyCode: "USD",
      BuyerName: "Celebrity Pink Jeans (DEMO)",
      BuyerPo: buyerPo,
      BrandName: "Celebrity Pink",
      TotalAmount: Math.round(totalAmount * 100) / 100,
      Items: items,
      // Legacy/extra fields useful for debugging; do not remove
      _demo: true,
      _totalQty: totalQty,
      _vendorCode: vendor.vendor_code,
    },
  });
}

// ── Build PO milestones (tanda_milestones) ──────────────────────────────
// Mirrors DEFAULT_WIP_TEMPLATES in src/utils/tandaTypes.ts. 20 phases per PO,
// expected_date = ddp - daysBeforeDDP, status varies by where the phase falls
// relative to TODAY so the WIP grid looks realistically in-flight.
const WIP_TEMPLATE = [
  { id: "wip_labdip",    phase: "Lab Dip / Strike Off",      category: "Pre-Production", daysBeforeDDP: 120 },
  { id: "wip_trims",     phase: "Trims",                     category: "Pre-Production", daysBeforeDDP: 110 },
  { id: "wip_rawgoods",  phase: "Raw Goods Available",       category: "Fabric T&A",     daysBeforeDDP: 100 },
  { id: "wip_fabprint",  phase: "Fabric at Printing Mill",   category: "Fabric T&A",     daysBeforeDDP: 90  },
  { id: "wip_fabfg",     phase: "Fabric Finished Goods",     category: "Fabric T&A",     daysBeforeDDP: 80  },
  { id: "wip_fabfact",   phase: "Fabric at Factory",         category: "Fabric T&A",     daysBeforeDDP: 70  },
  { id: "wip_fabcut",    phase: "Fabric at Cutting Line",    category: "Fabric T&A",     daysBeforeDDP: 60  },
  { id: "wip_fitsample", phase: "Fit Sample",                category: "Samples",        daysBeforeDDP: 90  },
  { id: "wip_ppsample",  phase: "PP Sample",                 category: "Samples",        daysBeforeDDP: 75  },
  { id: "wip_ppapproval",phase: "PP Approval",               category: "Samples",        daysBeforeDDP: 65  },
  { id: "wip_sizeset",   phase: "Size Set",                  category: "Samples",        daysBeforeDDP: 55  },
  { id: "wip_topsample", phase: "Top Sample",                category: "Samples",        daysBeforeDDP: 18  },
  { id: "wip_fabready",  phase: "Fabric Ready",              category: "Production",     daysBeforeDDP: 50  },
  { id: "wip_prodstart", phase: "Prod Start",                category: "Production",     daysBeforeDDP: 42  },
  { id: "wip_packstart", phase: "Packing Start",             category: "Production",     daysBeforeDDP: 28  },
  { id: "wip_prodend",   phase: "Prod End",                  category: "Production",     daysBeforeDDP: 21  },
  { id: "wip_exfactory", phase: "Ex Factory",                category: "Transit",        daysBeforeDDP: 14  },
  { id: "wip_packdocs",  phase: "Packing List / Docs Rec'd", category: "Transit",        daysBeforeDDP: 7   },
  { id: "wip_inhouse",   phase: "In House / DDP",            category: "Transit",        daysBeforeDDP: 0   },
];

const milestones = [];
tandaPos.forEach((po) => {
  WIP_TEMPLATE.forEach((tpl, idx) => {
    const expected = addDays(po.date_expected_delivery, -tpl.daysBeforeDDP);
    // Status logic: past + buffer → Complete; within buffer → In Progress;
    // future → Not Started. A small slice (~10%) becomes Delayed for realism.
    const dueOffset = (new Date(expected) - new Date(TODAY)) / 86_400_000;
    let status;
    let actual = null;
    if (dueOffset < -7)       { status = "Complete"; actual = expected; }
    else if (dueOffset < -2)  { status = (rngInt(`ms-delay-${po.po_number}-${idx}`, 0, 9) === 0) ? "Delayed" : "Complete"; if (status === "Complete") actual = expected; }
    else if (dueOffset < 7)   { status = "In Progress"; }
    else                      { status = "Not Started"; }
    const msId = "ms_" + hash(`${po.po_number}-${tpl.id}`).slice(0, 16);
    milestones.push({
      id: msId,
      data: {
        id: msId,
        po_number: po.po_number,
        phase: tpl.phase,
        category: tpl.category,
        sort_order: idx,
        days_before_ddp: tpl.daysBeforeDDP,
        expected_date: expected,
        actual_date: actual,
        status,
        status_date: actual,
        status_dates: null,
        notes: "",
        note_entries: null,
        updated_at: new Date().toISOString(),
        updated_by: "demo-seed",
        variant_statuses: null,
        variant_notes: null,
        _demo: true,
      },
    });
  });
});

// ── Build Design Calendar tasks (~6 per collection per style sample) ────
const tasks = [];
const styleSample = styles.slice(0, 8); // ~8 styles get task rows
styleSample.forEach(([styleCode, info], si) => {
  const collection = DEMO_COLLECTIONS[si % DEMO_COLLECTIONS.length];
  const product = info.product;
  TASK_PHASES.forEach((phase, pi) => {
    const dueOffset = (pi - 2) * 20 + rngInt(`due-${si}-${pi}`, -5, 5); // staggered ±90 days
    const due = addDays(TODAY, dueOffset);
    const status = pi <= 2 ? "Complete" : pi === 3 ? "In Progress" : pi === 4 ? "Not Started" : "Not Started";
    const assignee = DEMO_USERS[pi % DEMO_USERS.length];
    const taskId = uuidFrom(`task-${styleCode}-${phase}`);
    tasks.push({
      id: taskId,
      brand: "Celebrity Pink (DEMO)",
      collection: collection.key,
      season: collection.season,
      category: product.product_type,
      phase,
      due,
      status,
      assigneeId: assignee.id,
      assigneeName: assignee.name,
      vendorName: vendorByIdx(si).name,
      customer: "Demo Wholesale Account",
      orderType: "Bulk",
      channelType: "wholesale",
      notes: `${phase} for ${product.title} (${styleCode})`,
      images: product.images?.slice(0, 2).map(i => i.src) || [],
      updatedAt: new Date().toISOString(),
      updatedBy: "demo-seed",
      _demo: true,
    });
  });
});

// ── Build ats_excel_data blob (app_data) ───────────────────────────────
// The ATS app reads from app_data['ats_excel_data'] — a single jsonb row
// holding skus[], pos[], sos[] arrays + meta. Shape matches src/ats/types.ts
// ExcelData. PO events are derived from our openPos rows; SO events are
// synthesised across the next 90 days for realism.
// ATS skus: exclude style-level rows — those exist only to satisfy
// resolveStyle() lookups from the PO WIP fold; they don't represent real
// inventory units.
const atsSkus = ipItems.filter(it => !it.external_refs?.style_level).map(it => {
  const snap = ipSnapshots.find(s => s.sku_id === it.id);
  const posForSku = openPos.filter(p => p.sku_id === it.id);
  const onPO = posForSku.reduce((n, p) => n + Number(p.qty_open || 0), 0);
  return {
    sku: it.sku_code,
    description: it.description,
    category: it.attributes?.group_name || it.attributes?.product_type || "",
    gender: "Women",
    store: "DEMO-WH1",
    onHand: Number(snap?.qty_on_hand || 0),
    onPO,
    onOrder: Number(snap?.qty_on_order || 0),
    lastReceiptDate: addDays(TODAY, -rngInt(`rcpt-${it.sku_code}`, 5, 90)),
    totalAmount: Number(snap?.qty_on_hand || 0) * Number(it.unit_cost || 0),
    avgCost: Number(it.unit_cost || 0),
  };
});

const atsPos = [];
openPos.forEach((po) => {
  const item = ipItems.find(i => i.id === po.sku_id);
  if (!item || !po.qty_open) return;
  atsPos.push({
    sku: item.sku_code,
    date: po.expected_date,
    qty: Number(po.qty_open),
    poNumber: po.po_number,
    vendor: ipVendors.find(v => v.id === po.vendor_id)?.name || "Unknown",
    store: "DEMO-WH1",
    unitCost: Number(po.unit_cost || 0),
  });
});

// ── Build open SOs (ip_open_sales_orders) ───────────────────────────────
// Distributes ~70% of SKUs across the 5 retailers with 1-2 open commitments
// each, ship_dates spanning 4-180 days out so the planning grid shows
// multiple customers × multiple period buckets per SKU (not "Supply Only").
const ipOpenSos = [];
ipItems.forEach((it, idx) => {
  if (it.external_refs?.style_level) return;  // skip style-level rows
  const skuId = it.id;
  const hasSo = rngInt(`hasipso-${it.sku_code}`, 0, 9) >= 3; // ~70%
  if (!hasSo) return;
  const numCommits = 1 + rngInt(`nc-${it.sku_code}`, 0, 1);
  for (let k = 0; k < numCommits; k++) {
    const customer = ipCustomers[rngInt(`cust-${it.sku_code}-${k}`, 0, ipCustomers.length - 1)];
    const qty = rngInt(`soq-${it.sku_code}-${k}`, 6, 200);
    const shipped = rngInt(`shp-${it.sku_code}-${k}`, 0, 1) === 0 ? 0 : Math.floor(qty / 3);
    const daysOut = rngInt(`shd-${it.sku_code}-${k}`, 4, 180);
    const shipDate = addDays(TODAY, daysOut);
    const soNumber = `DEMO-SO-${String(5000 + idx * 3 + k).padStart(6, "0")}`;
    ipOpenSos.push({
      id: uuidFrom(`ipso-${it.sku_code}-${k}`),
      sku_id: skuId,
      customer_id: customer.id,
      customer_name: customer.name,
      so_number: soNumber,
      ship_date: shipDate,
      cancel_date: addDays(shipDate, 30),
      qty_ordered: qty,
      qty_shipped: shipped,
      qty_open: qty - shipped,
      unit_price: Number(it.unit_price || 0),
      currency: "USD",
      status: shipped > 0 ? "partial" : "open",
      store: "DEMO-WH1",
      source: "manual",
      source_line_key: `${soNumber}:${k}`,
    });
  }
});

// ── Build sales history (ip_sales_history_wholesale) ────────────────────
// 14 months of monthly sales per SKU split across the 5 retailers. Gives
// the planning grid usable T3 (trailing-3-month) and SP/LY (same-period-
// last-year) signals. Volume varies seasonally so charts look natural.
const ipSalesHistory = [];
const monthsBack = 14;
ipItems.forEach((it, idx) => {
  if (it.external_refs?.style_level) return;  // history is per-variant
  for (let m = 1; m <= monthsBack; m++) {
    // 1-2 transactions per month, ~3 of the 5 customers buying per SKU
    const customer = ipCustomers[(idx + m) % ipCustomers.length];
    const monthOffset = -m * 30 + rngInt(`hd-${it.sku_code}-${m}`, -10, 10);
    const txnDate = addDays(TODAY, monthOffset);
    // Seasonal multiplier: m near 6 (6 months ago = Nov) and m near 12 (May 2025)
    // skew higher to mimic spring/fall lifts.
    const month = new Date(txnDate + "T00:00:00Z").getUTCMonth() + 1;
    const seasonMult = [3, 4, 5].includes(month) ? 1.4 : [10, 11].includes(month) ? 1.25 : 1.0;
    const baseQty = rngInt(`hq-${it.sku_code}-${m}`, 8, 80);
    const qty = Math.round(baseQty * seasonMult);
    const unitPrice = Number(it.unit_price || 0);
    const gross = qty * unitPrice;
    const discountPct = rngInt(`dpct-${it.sku_code}-${m}`, 0, 25) / 100;
    const discount = Math.round(gross * discountPct * 100) / 100;
    const orderNumber = `DEMO-ORD-${idx}-${m}`;
    const invoiceNumber = `DEMO-INV-${idx}-${m}`;
    ipSalesHistory.push({
      id: uuidFrom(`hist-${it.sku_code}-${m}`),
      sku_id: it.id,
      customer_id: customer.id,
      category_id: it.category_id,
      order_number: orderNumber,
      invoice_number: invoiceNumber,
      txn_type: "invoice",
      txn_date: txnDate,
      qty,
      unit_price: unitPrice,
      gross_amount: gross,
      discount_amount: discount,
      net_amount: Math.round((gross - discount) * 100) / 100,
      currency: "USD",
      source: "demo",
      source_line_key: `${invoiceNumber}:${it.sku_code}`,
    });
  }
});

// Synthesise ATS-side SO commitments. ~25% of SKUs get a near-future SO so
// the ATS grid shows on-SO bars too (separate from ip_open_sales_orders
// above, which feeds the planning grid).
const atsSos = [];
ipItems.forEach((it, i) => {
  if (it.external_refs?.style_level) return;
  const hasSo = rngInt(`hasso-${it.sku_code}`, 0, 3) === 0;
  if (!hasSo) return;
  const qty = rngInt(`soq-${it.sku_code}`, 4, 80);
  const daysOut = rngInt(`sod-${it.sku_code}`, 14, 90);
  atsSos.push({
    sku: it.sku_code,
    date: addDays(TODAY, daysOut),
    qty,
    orderNumber: `DEMO-SO-${String(3000 + i).padStart(5, "0")}`,
    customerName: pick(`cust-${it.sku_code}`, ["Demo Wholesale Co.", "Acme Boutique", "Northshore Apparel", "Pacific Retail Group"]),
    unitPrice: Number(it.unit_price || 0),
    totalPrice: qty * Number(it.unit_price || 0),
    store: "DEMO-WH1",
  });
});

const atsExcelData = {
  syncedAt: new Date().toISOString(),
  skus: atsSkus,
  pos: atsPos,
  sos: atsSos,
  warnings: [],
  columnNames: {
    inventory: ["sku", "description", "category", "store", "onHand", "onPO", "onOrder", "avgCost"],
    purchases: ["sku", "date", "qty", "poNumber", "vendor", "store", "unitCost"],
    orders:    ["sku", "date", "qty", "orderNumber", "customerName", "unitPrice", "store"],
  },
  _demo: true,
};

// Collections payload (rows in collections table — id + data jsonb)
const collectionRows = DEMO_COLLECTIONS.map(c => ({
  id: c.key,
  data: {
    name: c.name,
    season: c.season,
    color: pick(`cc-${c.key}`, ["#F472B6", "#A78BFA", "#60A5FA", "#34D399", "#FBBF24", "#F87171"]),
    _demo: true,
    _updatedAt: new Date().toISOString(),
    _updatedBy: "demo-seed",
  },
}));

// users blob (app_data['users']) — seeded login + a few extra named users
// Password 'demo' (SHA-256 lowercase hex). Re-using the same hashing the
// existing seed-internal-admin.mjs script uses.
const usersBlob = [
  {
    id: uuidFrom("user-demo-login"),
    username: "demo",
    name: "Demo User",
    password: hash("demo"),
    role: "admin",
    color: "#EC4899",
    initials: "DU",
  },
  ...DEMO_USERS.map(u => ({
    id: u.id,
    username: slugify(u.name),
    name: u.name,
    password: hash("demo"),
    role: "designer",
    color: "#A78BFA",
    initials: u.initials,
  })),
];

// ── Bundle ────────────────────────────────────────────────────────────────
const bundle = {
  meta: {
    generated_at: new Date().toISOString(),
    source: IN,
    today: TODAY,
    counts: {
      portalVendors: portalVendors.length,
      ipVendors: ipVendors.length,
      ipCategories: ipCategories.length,
      ipItems: ipItems.length,
      ipSnapshots: ipSnapshots.length,
      openPos: openPos.length,
      tandaPos: tandaPos.length,
      tandaMilestones: milestones.length,
      tasks: tasks.length,
      collections: collectionRows.length,
      users: usersBlob.length,
      atsSkus: atsExcelData.skus.length,
      atsPos: atsExcelData.pos.length,
      atsSos: atsExcelData.sos.length,
      ipCustomers: ipCustomers.length,
      ipOpenSos: ipOpenSos.length,
      ipSalesHistory: ipSalesHistory.length,
    },
  },
  vendors:          portalVendors,
  ip_vendor_master: ipVendors,
  ip_customer_master: ipCustomers,
  ip_category_master: ipCategories,
  ip_item_master:   ipItems,
  ip_inventory_snapshot: ipSnapshots,
  ip_open_purchase_orders: openPos,
  ip_open_sales_orders: ipOpenSos,
  ip_sales_history_wholesale: ipSalesHistory,
  tanda_pos:        tandaPos,
  tanda_milestones: milestones,
  tasks:            tasks,
  collections:      collectionRows,
  app_data_users:   usersBlob,
  app_data_ats_excel_data: atsExcelData,
};

if (!APPLY) {
  writeFileSync(OUT, JSON.stringify(bundle, null, 2), "utf-8");
  console.log(`\n✓ Wrote ${OUT}`);
  console.log("  Counts:");
  for (const [k, v] of Object.entries(bundle.meta.counts)) console.log(`    ${k.padEnd(22)} ${v}`);
  console.log("\nNo DB writes performed. Re-run with --apply to POST to Supabase.");
  process.exit(0);
}

// ── Apply (wipe DEMO-* then POST to Supabase REST) ───────────────────────
const SB_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SERVICE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in env.");
  console.error("Refusing to apply — this script must NEVER run against prod.");
  process.exit(1);
}

// Refuse to run against anything that looks like prod.
const urlLower = SB_URL.toLowerCase();
if (urlLower.includes("prod") || urlLower.includes("production")) {
  console.error(`✗ Target URL contains 'prod' — refusing: ${SB_URL}`);
  process.exit(1);
}

console.log(`\n⚠ Apply mode. Target: ${SB_URL}`);
console.log("⚠ Confirm this is the DEMO/STAGING project. Aborting in 5s if not.");
await new Promise(r => setTimeout(r, 5000));

const REST = `${SB_URL}/rest/v1`;
const H_READ = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
const H_WRITE = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "resolution=merge-duplicates,return=minimal",
};

async function del(table, filter) {
  const url = `${REST}/${table}?${filter}`;
  const r = await fetch(url, { method: "DELETE", headers: H_READ });
  if (!r.ok && r.status !== 404) {
    throw new Error(`DELETE ${table}: HTTP ${r.status} ${await r.text()}`);
  }
  console.log(`  ✗ wiped ${table} (${filter})`);
}

// Delete dependents that FK to ip_item_master before deleting the items.
// Reads the current demo sku_id list from the DB (catches rows seeded in
// prior runs whose IDs may not match our current deterministic UUIDs).
async function wipeItemDependents() {
  const r = await fetch(`${REST}/ip_item_master?sku_code=like.DEMO-*&select=id`, { headers: H_READ });
  if (!r.ok) {
    console.log(`  (skip dependents wipe — no items present)`);
    return;
  }
  const rows = await r.json();
  if (!rows.length) { console.log(`  (no item dependents to wipe)`); return; }
  const ids = rows.map(x => x.id);
  console.log(`  (found ${ids.length} demo sku_ids — wiping dependents)`);
  // Tables that may have a sku_id FK to ip_item_master. We try them all;
  // the del() function tolerates 404 (table missing) and 400 (column missing)
  // so the misses are no-ops.
  const dependentTables = [
    "ip_wholesale_forecast", "ip_wholesale_forecast_tbd", "ip_wholesale_recommendations",
    "ip_ecom_forecast", "ip_ecom_override_events",
    "ip_planner_bucket_buys", "ip_planner_overrides",
    "ip_item_avg_cost", "ip_forecast_accuracy", "ip_forecast_actuals",
    "ip_planned_buys_supply", "ip_projected_inventory",
    "ip_inventory_recommendations", "ip_ai_suggestions",
    "ip_planning_anomalies", "ip_override_effectiveness",
    "ip_supply_exceptions", "ip_vendor_timing_signals",
    "ip_product_channel_status", "ip_allocation_rules",
    "ip_future_demand_requests", "ip_planning_approvals",
    "ip_execution_actions", "ip_scenario_assumptions",
    "ip_change_audit_log", "ip_action_templates",
    "ip_receipts_history", "ip_sales_history_ecom",
  ];
  const CHUNK = 50;
  for (const t of dependentTables) {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const filter = `sku_id=in.(${slice.join(",")})`;
      const url = `${REST}/${t}?${filter}`;
      const r = await fetch(url, { method: "DELETE", headers: H_READ });
      if (!r.ok && r.status !== 404 && r.status !== 400) {
        // 404 = table doesn't exist, 400 = column doesn't exist; both ok
        console.log(`    ⚠ ${t} chunk ${i / CHUNK + 1} HTTP ${r.status}`);
      }
    }
    console.log(`  ✗ wiped ${t} for demo sku_ids`);
  }
}

async function upsert(table, rows, onConflictHint) {
  if (rows.length === 0) return;
  // Chunk large arrays to keep payload + URL sizes sane.
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const url = `${REST}/${table}` + (onConflictHint ? `?on_conflict=${onConflictHint}` : "");
    const r = await fetch(url, { method: "POST", headers: H_WRITE, body: JSON.stringify(slice) });
    if (!r.ok) throw new Error(`upsert ${table}: HTTP ${r.status} ${await r.text()}`);
  }
  console.log(`  ✓ ${table} (${rows.length})`);
}

// ── Wipe in FK-reverse order ─────────────────────────────────────────────
console.log("\nWiping existing DEMO-* rows…");
await del("tasks", "data->>_demo=eq.true");
await del("collections", "id=like.DEMO-COL-*");
await del("tanda_milestones", "data->>_demo=eq.true");
await del("tanda_pos", "po_number=like.DEMO-PO-*");
await del("ip_sales_history_wholesale", "source=eq.demo");
await del("ip_open_sales_orders", "so_number=like.DEMO-SO-*");
await del("ip_open_purchase_orders", "po_number=like.DEMO-PO-*");
await del("ip_inventory_snapshot", "warehouse_code=eq.DEMO-WH1");
await wipeItemDependents();
await del("ip_item_master", "sku_code=like.DEMO-*");
await del("ip_customer_master", "customer_code=like.DEMO-CUST-*");
await del("ip_category_master", "category_code=like.DEMO-CAT-*");
await del("ip_vendor_master", "vendor_code=like.DEMO-VND-*");
const portalIds = portalVendors.map(v => v.id).join(",");
await del("vendors", `id=in.(${portalIds})`);

// ── Insert in FK order ───────────────────────────────────────────────────
console.log("\nInserting fresh DEMO rows…");
await upsert("vendors", portalVendors, "id");
await upsert("ip_vendor_master", ipVendors, "vendor_code");
await upsert("ip_category_master", ipCategories, "category_code");
await upsert("ip_customer_master", ipCustomers, "customer_code");
await upsert("ip_item_master", ipItems, "sku_code");
await upsert("ip_inventory_snapshot", ipSnapshots, "sku_id,warehouse_code,snapshot_date,source");
await upsert("ip_open_purchase_orders", openPos, "source,source_line_key");
await upsert("ip_open_sales_orders", ipOpenSos, "source,source_line_key");
await upsert("ip_sales_history_wholesale", ipSalesHistory, "source,source_line_key");
await upsert("tanda_pos", tandaPos, null);  // wiped above; plain insert
await upsert("tanda_milestones", milestones, "id");
await upsert("tasks", tasks.map(t => ({ id: t.id, data: t })), "id");
await upsert("collections", collectionRows, "id");

// ── app_data['users']: merge demo user(s) into existing blob ────────────
console.log("\nMerging demo user into app_data['users']…");
const usersRes = await fetch(`${REST}/app_data?key=eq.users&select=value`, { headers: H_READ });
let existing = [];
if (usersRes.ok) {
  const rows = await usersRes.json();
  if (rows.length) { try { existing = JSON.parse(rows[0].value) || []; } catch {} }
}
const seededUsernames = new Set(usersBlob.map(u => u.username.toLowerCase()));
const kept = existing.filter(u => !seededUsernames.has((u.username || "").toLowerCase()));
const merged = [...kept, ...usersBlob];
await upsert("app_data", [{ key: "users", value: JSON.stringify(merged) }], "key");
console.log(`  ✓ users blob: ${kept.length} existing kept + ${usersBlob.length} demo = ${merged.length} total`);

// ats_excel_data: single jsonb row keyed by 'ats_excel_data'. Replaces
// any existing value — that's intentional, demo's ATS state is canonical.
console.log("Writing app_data['ats_excel_data']…");
await upsert("app_data", [{ key: "ats_excel_data", value: JSON.stringify(atsExcelData) }], "key");
console.log(`  ✓ ats_excel_data: ${atsExcelData.skus.length} skus, ${atsExcelData.pos.length} POs, ${atsExcelData.sos.length} SOs`);

console.log("\n✓ Apply complete.");

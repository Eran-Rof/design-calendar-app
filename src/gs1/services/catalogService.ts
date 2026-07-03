// ── GS1 Styles Catalog — service layer ────────────────────────────────────────
//
// The catalog is workflow step 1: the publishable supplier catalog. This module:
//   • READS the PLM + pricing via the existing internal endpoints (auth + entity
//     headers are injected by installInternalApiAuth's fetch monkey-patch):
//        /api/internal/style-master        → style_code → {id, name, brand, ...}
//        /api/internal/pim/style-colors    → distinct (style_code, color) pairs
//        /api/internal/price-lists         → selectable price lists
//        /api/internal/price-list-items    → per-style prices for a chosen list
//   • READS/WRITES the catalog table (gs1_catalog_items) and pack_gtin_master via
//     direct Supabase REST with the anon key — the same single-tenant pattern the
//     rest of the GS1 module uses (see supabaseGs1.ts).
//   • EXPORTS the catalog as a GDSN CIN-style XML feed and a retail-portal CSV.
//
// Connecting to a live data pool (1WorldSync / GS1 Canada) needs that partner's
// credentials + GLN and is out of scope here — this generates the submission
// payload the operator hands to the data pool / retail portal.

import { SB_URL, SB_HEADERS } from "../../utils/supabase";
import type {
  CatalogItem,
  CatalogItemInput,
  CatalogSourceRow,
  PriceListOption,
  CatalogImportResult,
  CompanySettings,
} from "../types";

// ── Supabase REST helpers (catalog + pack GTIN tables) ────────────────────────

function rpc(path: string): string {
  return `${SB_URL}/rest/v1/${path}`;
}

async function sbFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { ...SB_HEADERS, ...(init.headers as Record<string, string> ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase request failed [${res.status}]: ${text.slice(0, 300)}`);
  if (!text) return [] as unknown as T;
  return JSON.parse(text) as T;
}

// ── Internal-endpoint helpers (PLM + pricing) ─────────────────────────────────

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Request failed [${res.status}] ${path}: ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : []) as T;
}

// ── Catalog CRUD ──────────────────────────────────────────────────────────────

export async function loadCatalog(): Promise<CatalogItem[]> {
  return sbFetch<CatalogItem[]>(
    `${rpc("gs1_catalog_items")}?order=style_no.asc,color.asc&limit=10000`
  );
}

// Upsert keyed on (style_no, color) — re-importing refreshes price/metadata
// without forking rows. Published rows keep their status (we only bump fields).
export async function upsertCatalogItems(items: CatalogItemInput[]): Promise<number> {
  if (items.length === 0) return 0;
  const rows = await sbFetch<CatalogItem[]>(
    `${rpc("gs1_catalog_items")}?on_conflict=style_no,color`,
    {
      method: "POST",
      body: JSON.stringify(items),
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    }
  );
  return rows.length;
}

export async function updateCatalogItem(
  id: string,
  patch: Partial<Pick<CatalogItem, "price_cents" | "status" | "gdsn_target" | "published_at" | "currency">>,
): Promise<CatalogItem | null> {
  const rows = await sbFetch<CatalogItem[]>(
    `${rpc("gs1_catalog_items")}?id=eq.${id}`,
    { method: "PATCH", body: JSON.stringify(patch), headers: { Prefer: "return=representation" } }
  );
  return rows[0] ?? null;
}

export async function deleteCatalogItem(id: string): Promise<void> {
  await sbFetch<void>(`${rpc("gs1_catalog_items")}?id=eq.${id}`, { method: "DELETE" });
}

// ── Price lists (for the picker) ──────────────────────────────────────────────

export async function loadPriceLists(): Promise<PriceListOption[]> {
  const rows = await apiGet<Array<{
    id: string; code: string; name: string; currency: string;
    is_default: boolean; item_count: number;
  }>>("/api/internal/price-lists");
  return rows.map((r) => ({
    id: r.id, code: r.code, name: r.name, currency: r.currency || "USD",
    is_default: !!r.is_default, item_count: r.item_count ?? 0,
  }));
}

// ── Import orchestration ──────────────────────────────────────────────────────

type StyleRow = {
  id: string; style_code: string; style_name?: string | null;
  description?: string | null; category_name?: string | null; brand_id?: string | null;
};
type StyleColor = { style_code: string; color: string };
type PriceItem = { style_id: string; price_cents: number; min_qty: number };
type PackGtinRow = { style_no: string; color: string; pack_gtin: string };
type BrandRow = { id: string; name: string };

const skKey = (s: string, c: string) => `${s.trim().toUpperCase()}|${c.trim().toUpperCase()}`;

// Enumerate every PLM style+color for the "add styles & colors" picker. No price
// is fetched here — the operator selects first, then import pulls the price.
// Rows already in the catalog are flagged so the picker can mark them.
export async function loadCatalogSource(): Promise<CatalogSourceRow[]> {
  const [styles, styleColors, packGtins, brands, existing] = await Promise.all([
    apiGet<StyleRow[]>("/api/internal/style-master?limit=10000"),
    apiGet<StyleColor[]>("/api/internal/pim/style-colors"),
    sbFetch<PackGtinRow[]>(`${rpc("pack_gtin_master")}?select=style_no,color,pack_gtin&status=eq.active`),
    apiGet<BrandRow[]>("/api/internal/brands").catch(() => [] as BrandRow[]),
    loadCatalog(),
  ]);

  const styleByCode = new Map<string, StyleRow>();
  for (const s of styles) if (s.style_code) styleByCode.set(s.style_code, s);
  const brandById = new Map<string, string>();
  for (const b of brands) brandById.set(b.id, b.name);
  const gtinByKey = new Map<string, string>();
  for (const g of packGtins) gtinByKey.set(skKey(g.style_no, g.color), g.pack_gtin);
  const inCatalog = new Set(existing.map((r) => skKey(r.style_no, r.color)));

  return styleColors.map((sc) => {
    const meta = styleByCode.get(sc.style_code);
    return {
      style_id: meta?.id ?? null,
      style_no: sc.style_code,
      style_name: meta?.style_name ?? null,
      color: sc.color,
      brand: meta?.brand_id ? brandById.get(meta.brand_id) ?? null : null,
      category: meta?.category_name ?? null,
      description: meta?.description ?? null,
      pack_gtin: gtinByKey.get(skKey(sc.style_code, sc.color)) ?? null,
      in_catalog: inCatalog.has(skKey(sc.style_code, sc.color)),
    };
  });
}

// Import ONLY the selected style+color pairs, pulling each style's price from
// the chosen price list + its pack GTIN, then upsert. Returns a summary.
export async function importSelectedStyleColors(
  priceListId: string,
  selections: Array<{ style_no: string; color: string }>,
): Promise<CatalogImportResult> {
  if (selections.length === 0) return { imported: 0, priced: 0, unpriced: 0, with_gtin: 0 };

  const [styles, priceItems, packGtins, brands, lists] = await Promise.all([
    apiGet<StyleRow[]>("/api/internal/style-master?limit=10000"),
    apiGet<Array<PriceItem & { style: { style_code: string } | null }>>(
      `/api/internal/price-list-items?price_list_id=${encodeURIComponent(priceListId)}`
    ),
    sbFetch<PackGtinRow[]>(`${rpc("pack_gtin_master")}?select=style_no,color,pack_gtin&status=eq.active`),
    apiGet<BrandRow[]>("/api/internal/brands").catch(() => [] as BrandRow[]),
    loadPriceLists(),
  ]);

  const styleByCode = new Map<string, StyleRow>();
  for (const s of styles) if (s.style_code) styleByCode.set(s.style_code, s);
  const brandById = new Map<string, string>();
  for (const b of brands) brandById.set(b.id, b.name);
  // style_id → base (lowest min_qty) price; price_list_items ordered min_qty asc → first wins.
  const priceByStyleId = new Map<string, number>();
  for (const p of priceItems) {
    if (!p.style_id || p.price_cents == null) continue;
    if (!priceByStyleId.has(p.style_id)) priceByStyleId.set(p.style_id, p.price_cents);
  }
  const gtinByKey = new Map<string, string>();
  for (const g of packGtins) gtinByKey.set(skKey(g.style_no, g.color), g.pack_gtin);

  const chosen = lists.find((l) => l.id === priceListId);
  const currency = chosen?.currency || "USD";
  const listCode = chosen?.code || null;

  const rows: CatalogItemInput[] = [];
  let priced = 0, withGtin = 0;
  for (const sel of selections) {
    const meta = styleByCode.get(sel.style_no);
    const price = meta ? priceByStyleId.get(meta.id) ?? null : null;
    const gtin = gtinByKey.get(skKey(sel.style_no, sel.color)) ?? null;
    if (price != null) priced++;
    if (gtin) withGtin++;
    rows.push({
      style_id: meta?.id ?? null,
      style_no: sel.style_no,
      style_name: meta?.style_name ?? null,
      color: sel.color,
      brand: meta?.brand_id ? brandById.get(meta.brand_id) ?? null : null,
      category: meta?.category_name ?? null,
      description: meta?.description ?? null,
      pack_gtin: gtin,
      price_cents: price,
      currency,
      price_list_id: priceListId,
      price_list_code: listCode,
      status: "draft",
    });
  }

  const imported = await upsertCatalogItems(rows);
  return { imported, priced, unpriced: rows.length - priced, with_gtin: withGtin };
}

// ── Publish: GDSN CIN-style XML + retail CSV ──────────────────────────────────

function xmlEscape(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : c === "'" ? "&apos;" : "&quot;");
}

function priceStr(cents: number | null): string {
  return cents == null ? "" : (cents / 100).toFixed(2);
}

// A pragmatic GDSN Catalogue Item Notification (CIN) payload. Each catalog row
// becomes one tradeItem keyed by its pack GTIN; the suggestedRetailPrice carries
// the (possibly overridden) list price. This is the submission payload for a data
// pool — not a live transmission.
export function buildGdsnXml(items: CatalogItem[], company: CompanySettings | null): string {
  const dataSource = company?.gs1_prefix ? `urn:gs1:gln:${company.gs1_prefix}` : "urn:gs1:gln:UNKNOWN";
  const provider = company?.company_name ? xmlEscape(company.company_name) : "Supplier";
  const tradeItems = items.map((it) => {
    const gtin = it.pack_gtin || "";
    return [
      `    <tradeItem>`,
      `      <gtin>${xmlEscape(gtin)}</gtin>`,
      `      <informationProviderOfTradeItem>${provider}</informationProviderOfTradeItem>`,
      `      <brandNameInformation><brandName>${xmlEscape(it.brand || "")}</brandName></brandNameInformation>`,
      `      <tradeItemDescription>${xmlEscape(it.style_name || it.description || it.style_no)}</tradeItemDescription>`,
      `      <styleNumber>${xmlEscape(it.style_no)}</styleNumber>`,
      `      <colourDescription>${xmlEscape(it.color)}</colourDescription>`,
      `      <tradeItemUnitDescriptor>CASE</tradeItemUnitDescriptor>`,
      `      <targetMarketCountryCode>840</targetMarketCountryCode>`,
      it.price_cents != null
        ? `      <suggestedRetailPrice currency="${xmlEscape(it.currency || "USD")}">${priceStr(it.price_cents)}</suggestedRetailPrice>`
        : `      <!-- no price on selected list -->`,
      `    </tradeItem>`,
    ].join("\n");
  }).join("\n");

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<catalogue_item_notification xmlns="urn:gs1:gdsn:catalogue_item_notification">`,
    `  <dataSource>${xmlEscape(dataSource)}</dataSource>`,
    `  <catalogueItems>`,
    tradeItems,
    `  </catalogueItems>`,
    `</catalogue_item_notification>`,
    ``,
  ].join("\n");
}

export function buildRetailCsv(items: CatalogItem[]): string {
  const header = ["GTIN", "StyleNumber", "StyleName", "Color", "Brand", "Category", "Price", "Currency", "Status"];
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = items.map((it) => [
    it.pack_gtin || "",
    it.style_no,
    it.style_name || "",
    it.color,
    it.brand || "",
    it.category || "",
    priceStr(it.price_cents),
    it.currency || "USD",
    it.status,
  ].map((v) => esc(String(v))).join(","));
  return [header.join(","), ...lines].join("\n") + "\n";
}

export function downloadTextFile(filename: string, content: string, mime = "text/plain"): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Mark a set of catalog rows published (after generating their feed). published_at
// is stamped server-side-equivalent here via the row trigger on update.
export async function markPublished(ids: string[], target: string): Promise<void> {
  const stamp = new Date().toISOString();
  await Promise.all(
    ids.map((id) => updateCatalogItem(id, { status: "published", gdsn_target: target, published_at: stamp }))
  );
}

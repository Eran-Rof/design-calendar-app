// ── Xoro UPC Sync Service ──────────────────────────────────────────────────────
// Pulls item/UPC data from a configured Xoro REST endpoint and normalises it
// into the app's UpcItemInput schema.
//
// If credentials or endpoint are not set, every function returns a graceful
// error result — the Excel import workflow is never blocked.

import type { CompanySettings, UpcItemInput } from "../types";

// ── Public result types ────────────────────────────────────────────────────────

export interface XoroConnectionResult {
  ok: boolean;
  message: string;
  statusCode?: number;
  itemCount?: number;
}

export interface XoroSyncResult {
  processed: number;
  normalized: number;
  skipped: number;
  items: UpcItemInput[];
  errors: string[];
}

// ── Config validation ─────────────────────────────────────────────────────────

function validateConfig(settings: CompanySettings): string | null {
  if (!settings.xoro_enabled) return "Xoro integration is disabled. Enable it in Company Setup.";
  if (!settings.xoro_api_base_url?.trim()) return "Xoro API base URL is required.";
  if (!settings.xoro_api_key_ref?.trim()) return "Xoro API key is required.";
  if (!settings.xoro_item_endpoint?.trim()) return "Xoro item endpoint path is required (e.g. /v1/items).";
  return null;
}

function buildUrl(settings: CompanySettings): string {
  const base = settings.xoro_api_base_url!.replace(/\/$/, "");
  const path = settings.xoro_item_endpoint!.replace(/^\//, "");
  return `${base}/${path}`;
}

function buildHeaders(settings: CompanySettings): HeadersInit {
  return {
    Authorization: `Bearer ${settings.xoro_api_key_ref}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

// ── Response normalisation ────────────────────────────────────────────────────
// Handles the variety of shapes Xoro (and similar ERPs) return:
//   { Data: [...] }  |  { data: [...] }  |  { Items: [...] }  |  [...]
//   { Result: "Success", ItemList: [...] }  |  { value: [...] } (OData)

function extractItemArray(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    for (const key of ["Data", "data", "Items", "items", "ItemList", "Result", "value", "records"]) {
      if (Array.isArray(b[key])) return b[key] as unknown[];
    }
  }
  return [];
}

// Try a list of candidate field names and return the first non-empty string value.
function pick(obj: Record<string, unknown>, candidates: string[]): string {
  for (const key of candidates) {
    const v = obj[key];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return "";
}

export function normalizeXoroItemToUpcMaster(raw: unknown): UpcItemInput | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  // UPC — digits only after stripping dashes/spaces
  const upcRaw = pick(r, ["UPC", "upc", "Upc", "ItemUpc", "item_upc", "barcode", "Barcode", "GTIN"]);
  const upc = upcRaw.replace(/[\s\-]/g, "").replace(/\D/g, "");
  if (!upc) return null;

  // Style number
  const style_no = pick(r, [
    "StyleNumber", "StyleNo", "style_no", "StyleCode", "Style",
    "StyleItem", "ParentItem", "ItemStyle",
  ]).toUpperCase();
  if (!style_no) return null;

  // Color
  const color = pick(r, [
    "ColorName", "Color", "ColorCode", "color", "ColorDescription", "Colour",
  ]).toUpperCase();

  // Size
  const size = pick(r, [
    "SizeName", "Size", "SizeCode", "size", "SizeDescription",
  ]).toUpperCase();

  if (!color || !size) return null;

  // Description
  const desc = pick(r, [
    "Description", "ItemDescription", "ItemName", "ShortDescription", "description",
  ]);

  return {
    upc,
    style_no,
    color,
    size,
    description: desc || undefined,
    source_method: "xoro",
  };
}

// ── testXoroConnection ────────────────────────────────────────────────────────
// Fires a quick GET and checks that the endpoint responds with parseable JSON
// containing at least one recognisable item array.

export async function testXoroConnection(settings: CompanySettings): Promise<XoroConnectionResult> {
  const err = validateConfig(settings);
  if (err) return { ok: false, message: err };

  const url = buildUrl(settings);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: buildHeaders(settings),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      return { ok: false, message: `HTTP ${res.status} ${res.statusText}`, statusCode: res.status };
    }

    let json: unknown;
    try { json = await res.json(); }
    catch { return { ok: false, message: "Response is not valid JSON.", statusCode: res.status }; }

    const items = extractItemArray(json);
    return {
      ok: true,
      message: `Connected — ${items.length.toLocaleString()} item(s) returned`,
      statusCode: res.status,
      itemCount: items.length,
    };
  } catch (e) {
    clearTimeout(timer);
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("abort")) return { ok: false, message: "Request timed out after 10 s." };
    return { ok: false, message: `Connection error: ${msg}` };
  }
}

// ── syncUpcItemsFromXoro ──────────────────────────────────────────────────────
// Fetches all items from the configured endpoint, normalises each one, and
// returns the UpcItemInput array ready for upsert.  DB operations stay in the
// store/supabaseGs1 layer — this function is pure-ish (just HTTP + normalise).

export async function syncUpcItemsFromXoro(settings: CompanySettings): Promise<XoroSyncResult> {
  const result: XoroSyncResult = { processed: 0, normalized: 0, skipped: 0, items: [], errors: [] };

  const configErr = validateConfig(settings);
  if (configErr) { result.errors.push(configErr); return result; }

  const url = buildUrl(settings);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: buildHeaders(settings),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      result.errors.push(`HTTP ${res.status} ${res.statusText}`);
      return result;
    }

    let json: unknown;
    try { json = await res.json(); }
    catch {
      result.errors.push("Response body is not valid JSON.");
      return result;
    }

    const rawItems = extractItemArray(json);
    result.processed = rawItems.length;

    for (const raw of rawItems) {
      const item = normalizeXoroItemToUpcMaster(raw);
      if (item) { result.items.push(item); result.normalized++; }
      else result.skipped++;
    }
  } catch (e) {
    clearTimeout(timer);
    const msg = e instanceof Error ? e.message : String(e);
    result.errors.push(msg.includes("abort") ? "Request timed out after 60 s." : `Fetch error: ${msg}`);
  }

  return result;
}

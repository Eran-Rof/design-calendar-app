// Costing Module — API client
// Thin fetch wrappers against /api/internal/costing/* (handlers in
// api/_handlers/internal/costing/, registered in routes.js as h475–h488).
// All return Promise<T>; throw on !response.ok.

import type {
  CostingProject,
  CostingProjectDetail,
  CostingProjectDraft,
  CostingProjectPatch,
  CostingLine,
  CostingLineVendor,
  CostingLineCompliance,
  CostingComplianceStatus,
  RfqListRow,
  RfqDetail,
  RfqPatch,
} from "../types";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const body = await res.json(); if (body?.error) msg = body.error; } catch { /* noop */ }
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as unknown as T;
  return res.json() as Promise<T>;
}

export interface ListProjectsFilters {
  entity_id?: string;
  status?: string;
  customer_id?: string;
  sales_rep_id?: string;
  brand?: string;
}

export async function listProjects(filters: ListProjectsFilters = {}): Promise<CostingProject[]> {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) sp.set(k, String(v));
  const qs = sp.toString();
  return json<CostingProject[]>(await fetch(`/api/internal/costing/projects${qs ? `?${qs}` : ""}`));
}

export async function getProject(id: string): Promise<CostingProjectDetail> {
  return json<CostingProjectDetail>(await fetch(`/api/internal/costing/projects/${id}`));
}

export async function createProject(draft: CostingProjectDraft): Promise<CostingProject> {
  return json<CostingProject>(await fetch(`/api/internal/costing/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draft),
  }));
}

export async function updateProject(id: string, patch: CostingProjectPatch): Promise<CostingProject> {
  return json<CostingProject>(await fetch(`/api/internal/costing/projects/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  }));
}

export async function deleteProject(id: string): Promise<void> {
  return json<void>(await fetch(`/api/internal/costing/projects/${id}`, { method: "DELETE" }));
}

// ── Lines ───────────────────────────────────────────────────────────────────

export async function listLines(projectId: string): Promise<CostingLine[]> {
  return json<CostingLine[]>(await fetch(`/api/internal/costing/projects/${projectId}/lines`));
}

export interface LineUpsertRow extends Partial<CostingLine> {
  id?: string;
}

/** Bulk upsert: rows with id are UPDATEd, rows without id are INSERTed. */
export async function upsertLines(projectId: string, lines: LineUpsertRow[]): Promise<CostingLine[]> {
  return json<CostingLine[]>(await fetch(`/api/internal/costing/projects/${projectId}/lines`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lines }),
  }));
}

export async function updateLine(lineId: string, patch: Partial<CostingLine>): Promise<CostingLine> {
  return json<CostingLine>(await fetch(`/api/internal/costing/lines/${lineId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  }));
}

export async function deleteLine(lineId: string): Promise<void> {
  return json<void>(await fetch(`/api/internal/costing/lines/${lineId}`, { method: "DELETE" }));
}

// Stage B fork: mark a Sent/Quoted line 'revised' (locked) server-side + close
// its superseded vendor RFQ. The new Draft copy is created by the caller via
// upsertLines. 409 if the line isn't Sent/Quoted.
export async function reviseLine(lineId: string): Promise<{ ok: boolean; revised_line_id: string }> {
  return json(await fetch(`/api/internal/costing/lines/${lineId}/revise`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }));
}

// ── Vendor quotes ───────────────────────────────────────────────────────────

export async function listQuotes(lineId: string): Promise<CostingLineVendor[]> {
  return json<CostingLineVendor[]>(await fetch(`/api/internal/costing/lines/${lineId}/quotes`));
}

export interface QuoteDraft {
  vendor_id: string;
  quoted_cost: number;
  currency?: string;
  lead_time_days?: number | null;
  moq?: number | null;
  quoted_date?: string | null;
  valid_until?: string | null;
  status?: string;
  notes?: string | null;
}

export async function createQuote(lineId: string, draft: QuoteDraft): Promise<CostingLineVendor> {
  return json<CostingLineVendor>(await fetch(`/api/internal/costing/lines/${lineId}/quotes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draft),
  }));
}

export async function updateQuote(
  lineId: string,
  quoteId: string,
  patch: Partial<QuoteDraft>,
): Promise<CostingLineVendor> {
  return json<CostingLineVendor>(await fetch(`/api/internal/costing/lines/${lineId}/quotes/${quoteId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  }));
}

export async function deleteQuote(lineId: string, quoteId: string): Promise<void> {
  return json<void>(await fetch(`/api/internal/costing/lines/${lineId}/quotes/${quoteId}`, {
    method: "DELETE",
  }));
}

// ── Compliance checklist ────────────────────────────────────────────────────

export interface ComplianceDraft {
  requirement_code: string;
  status?: CostingComplianceStatus;
  notes?: string | null;
  attachment_url?: string | null;
  completed_at?: string | null;
}

export async function listCompliance(lineId: string): Promise<CostingLineCompliance[]> {
  return json<CostingLineCompliance[]>(await fetch(`/api/internal/costing/lines/${lineId}/compliance`));
}

export async function createCompliance(lineId: string, draft: ComplianceDraft): Promise<CostingLineCompliance> {
  return json<CostingLineCompliance>(await fetch(`/api/internal/costing/lines/${lineId}/compliance`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draft),
  }));
}

export async function updateCompliance(lineId: string, reqId: string, patch: Partial<ComplianceDraft>): Promise<CostingLineCompliance> {
  return json<CostingLineCompliance>(await fetch(`/api/internal/costing/lines/${lineId}/compliance/${reqId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  }));
}

export async function deleteCompliance(lineId: string, reqId: string): Promise<void> {
  return json<void>(await fetch(`/api/internal/costing/lines/${lineId}/compliance/${reqId}`, {
    method: "DELETE",
  }));
}

export interface SelectQuoteResult {
  line: CostingLine;
  selected_quote_id: string;
  /** Number of ip_item_avg_cost rows whose standard_unit_price got rewritten. */
  cost_write_count: number;
  /** SKUs under this style that have no ip_item_avg_cost row yet (skipped to keep avg_cost Xoro-authoritative). */
  cost_write_missing_count: number;
  /** Set when the cost-write was deliberately skipped: no_style_code | non_usd_currency | no_skus_for_style. */
  cost_write_reason?: string;
  /** Set when the cost-write threw an exception. The quote promotion still succeeded; operator can re-select to retry. */
  cost_write_error?: string;
}

export interface GeneratedRfq {
  rfq_id: string;
  vendor_id: string;
  vendor: string;
  line_count: number;
  total_qty: number;
}

export interface GenerateRfqsResult {
  created: GeneratedRfq[];
  skipped_no_vendor: string[];
  errors?: { vendor_id: string; vendor: string; error: string }[];
  message?: string;
}

/** One existing style/color/vendor match surfaced by the dup-RFQ guard (409). */
export interface RfqDuplicate {
  vendor_id: string;
  vendor: string;
  style_code: string | null;
  color: string | null;
}

/** 409 body the create handler returns when a matching RFQ already exists. */
export interface GenerateRfqsNeedsConfirm {
  needs_confirm: true;
  reason: "duplicate_rfq";
  duplicates: RfqDuplicate[];
  message: string;
}

/**
 * Create RFQs from the selected costing lines.
 *
 * The handler refuses (HTTP 409 + needs_confirm) when an RFQ already exists
 * for the same style + color + vendor, UNLESS allowDuplicate is passed. The
 * caller should catch the needs-confirm result, show a confirm dialog, and
 * re-call with allowDuplicate=true on OK. Returns the normal result on success
 * or the needs-confirm payload on 409 (anything else throws).
 */
export async function generateRfqs(
  projectId: string,
  lineIds: string[],
  allowDuplicate = false,
): Promise<GenerateRfqsResult | GenerateRfqsNeedsConfirm> {
  const res = await fetch(
    `/api/internal/costing/projects/${projectId}/generate-rfqs`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ line_ids: lineIds, allow_duplicate: allowDuplicate }),
    },
  );
  if (res.status === 409) {
    const body = (await res.json()) as GenerateRfqsNeedsConfirm;
    if (body?.needs_confirm) return body;
  }
  return json<GenerateRfqsResult>(res);
}

export async function selectQuote(lineId: string, quoteId: string): Promise<SelectQuoteResult> {
  return json<SelectQuoteResult>(await fetch(
    `/api/internal/costing/lines/${lineId}/select-quote`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quote_id: quoteId }),
    },
  ));
}

// ── Autocomplete searches ───────────────────────────────────────────────────

export interface StyleHit {
  id: string;
  entity_id: string;
  style_code: string | null;
  style_name: string | null;
  description: string | null;
  gender_code: string | null;
  category_id: string | null;
  season: string | null;
  base_fabric: string | null;
  lifecycle_status: string | null;
}

export interface VendorHit {
  id: string;
  code: string | null;
  legal_name: string | null;
  country: string | null;
  default_currency: string | null;
  status: string | null;
  /**
   * 'portal' = vendors table (FK target for costing_line_vendors.vendor_id).
   * 'planning' = ip_vendor_master (Xoro nightly sync — most factories live
   *              here). On pick, the cell must materialize a portal row via
   *              addVendor() first before using the id in addQuote().
   */
  source?: "portal" | "planning";
}

export interface FabricHit {
  id: string;
  code: string | null;
  name: string | null;
  composition_text: string | null;
}

export async function searchStyles(q: string, opts?: { limit?: number | "all"; signal?: AbortSignal }): Promise<StyleHit[]> {
  const sp = new URLSearchParams();
  if (q) sp.set("q", q);
  if (opts?.limit !== undefined) sp.set("limit", String(opts.limit));
  const res = await fetch(`/api/internal/costing/search/styles?${sp.toString()}`, { signal: opts?.signal });
  const out = await json<{ rows: StyleHit[] }>(res);
  return out.rows || [];
}

export async function searchVendors(q: string, opts?: { limit?: number; signal?: AbortSignal }): Promise<VendorHit[]> {
  const sp = new URLSearchParams();
  if (q) sp.set("q", q);
  if (opts?.limit) sp.set("limit", String(opts.limit));
  const res = await fetch(`/api/internal/costing/search/vendors?${sp.toString()}`, { signal: opts?.signal });
  const out = await json<{ rows: VendorHit[] }>(res);
  return out.rows || [];
}

export async function searchFabrics(q: string, signal?: AbortSignal): Promise<FabricHit[]> {
  const sp = new URLSearchParams();
  if (q) sp.set("q", q);
  const res = await fetch(`/api/internal/costing/search/fabrics?${sp.toString()}`, { signal });
  const out = await json<{ rows: FabricHit[] }>(res);
  return out.rows || [];
}

export interface ScaleHit {
  id: string;
  scale_code: string;
  description: string | null;
  total_units: number | null;
}

export async function searchScales(signal?: AbortSignal): Promise<ScaleHit[]> {
  // scale_master is small (<200 rows typically); the handler returns all of
  // them so a single fetch hydrates the dropdown for every grid row.
  const res = await fetch(`/api/internal/costing/search/scales`, { signal });
  const out = await json<{ rows: ScaleHit[] }>(res);
  return out.rows || [];
}

// ── Tangerine Size-Scale master (size_scales) ───────────────────────────────
// Task 4 — the Scale cell now sources from the Tangerine size_scales master
// (not the legacy scale_master). The handler at /api/internal/size-scales
// returns a bare array of rows (NOT { rows }) and authenticates via the
// default-entity (ROF) scope, no internal token needed.

export interface SizeScaleHit {
  id: string;
  entity_id: string;
  code: string;
  name: string;
  sizes: string[] | null;
  sort_order: number | null;
  is_active: boolean | null;
}

export async function searchSizeScales(q?: string, signal?: AbortSignal): Promise<SizeScaleHit[]> {
  const sp = new URLSearchParams();
  if (q && q.trim()) sp.set("q", q.trim());
  const qs = sp.toString();
  const res = await fetch(`/api/internal/size-scales${qs ? `?${qs}` : ""}`, { signal });
  // size-scales returns a bare array, not { rows }.
  return json<SizeScaleHit[]>(res);
}

// ── Tangerine Payment Terms master (payment_terms) ──────────────────────────
// Task 10 — project-level Payment Terms dropdown. /api/internal/payment-terms
// returns a bare array of rows, authenticated via the default-entity scope.

export interface PaymentTermHit {
  id: string;
  entity_id: string;
  code: string;
  name: string;
  due_days: number | null;
  discount_pct: number | null;
  discount_days: number | null;
  is_active: boolean | null;
}

export async function listPaymentTerms(q?: string, signal?: AbortSignal): Promise<PaymentTermHit[]> {
  const sp = new URLSearchParams();
  if (q && q.trim()) sp.set("q", q.trim());
  const qs = sp.toString();
  const res = await fetch(`/api/internal/payment-terms${qs ? `?${qs}` : ""}`, { signal });
  return json<PaymentTermHit[]>(res);
}

export interface CustomerHit {
  id: string;
  entity_id: string | null;
  code: string | null;
  customer_type: string | null;
  default_currency: string | null;
  status: string | null;
  billing_address: { name?: string; company?: string; [k: string]: unknown } | null;
  payment_terms: string | null;
  /** Friendly display name resolved server-side from ip_customer_master.name
   *  (Xoro-synced, keyed by customer_code). Always preferred when present. */
  display_name?: string | null;
}

/** Strip the legacy Xoro "EXCEL:" tag that prefixes every customer code on
 *  the historic backfill. Safe on null / undefined / non-string input. */
export function stripExcelPrefix<T extends string | null | undefined>(s: T): T {
  if (typeof s !== "string") return s;
  return s.replace(/^EXCEL:/i, "") as T;
}

/** Helper to extract a readable display name from a customer hit.
 *  Preference order: ip_customer_master.name (display_name) → billing_address.name →
 *  billing_address.company → stripped customers.code → id. */
export function customerDisplayName(c: CustomerHit | null | undefined): string {
  if (!c) return "";
  if (typeof c.display_name === "string" && c.display_name.trim().length > 0) {
    return c.display_name;
  }
  const billing = c.billing_address;
  const name = typeof billing?.name === "string" ? billing.name : undefined;
  const company = typeof billing?.company === "string" ? billing.company : undefined;
  const raw = name || company || c.code;
  return typeof raw === "string" ? stripExcelPrefix(raw) : "—";
}

export async function searchCustomers(q: string, signal?: AbortSignal): Promise<CustomerHit[]> {
  const sp = new URLSearchParams();
  if (q) sp.set("q", q);
  const res = await fetch(`/api/internal/costing/search/customers?${sp.toString()}`, { signal });
  const out = await json<{ rows: CustomerHit[] }>(res);
  return out.rows || [];
}

export interface SalesRepHit {
  id: string;
  entity_id: string | null;
  display_name: string | null;
  email: string | null;
  default_commission_pct: number | null;
  is_active: boolean | null;
}

export async function searchSalesReps(q: string, signal?: AbortSignal): Promise<SalesRepHit[]> {
  const sp = new URLSearchParams();
  if (q) sp.set("q", q);
  const res = await fetch(`/api/internal/costing/search/sales-reps?${sp.toString()}`, { signal });
  const out = await json<{ rows: SalesRepHit[] }>(res);
  return out.rows || [];
}

export async function searchColors(
  q: string,
  opts?: { styleCode?: string | null; signal?: AbortSignal },
): Promise<string[]> {
  const sp = new URLSearchParams();
  if (q) sp.set("q", q);
  if (opts?.styleCode) sp.set("style_code", opts.styleCode);
  const res = await fetch(`/api/internal/costing/search/colors?${sp.toString()}`, { signal: opts?.signal });
  const out = await json<{ rows: string[] }>(res);
  return out.rows || [];
}

export async function addVendor(name: string, opts?: { code?: string; country?: string }): Promise<VendorHit> {
  return json<VendorHit>(await fetch(`/api/internal/costing/add-vendor`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, ...opts }),
  }));
}

// ── Freeform color/vendor masters (auto-pruned against canonical sources) ──
//
// Returns the operator-managed extras lists (server already drops anything
// that has since appeared in ip_item_master.color / ip_vendor_master /
// vendors). Backed by h527.

export type FreeformKind = "colors" | "vendors";

export interface FreeformMasters {
  colors: string[];
  vendors: string[];
}

export async function getFreeformMasters(): Promise<FreeformMasters> {
  return json<FreeformMasters>(await fetch(`/api/internal/costing/masters/freeform`));
}

export async function addFreeformMaster(kind: FreeformKind, name: string): Promise<string[]> {
  const r = await json<{ kind: FreeformKind; list: string[] }>(
    await fetch(`/api/internal/costing/masters/freeform`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, name }),
    }),
  );
  return r.list;
}

export async function renameFreeformMaster(kind: FreeformKind, oldName: string, newName: string): Promise<string[]> {
  const r = await json<{ kind: FreeformKind; list: string[] }>(
    await fetch(`/api/internal/costing/masters/freeform`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, oldName, newName }),
    }),
  );
  return r.list;
}

export async function deleteFreeformMaster(kind: FreeformKind, name: string): Promise<string[]> {
  const sp = new URLSearchParams({ kind, name });
  const r = await json<{ kind: FreeformKind; list: string[] }>(
    await fetch(`/api/internal/costing/masters/freeform?${sp.toString()}`, { method: "DELETE" }),
  );
  return r.list;
}

// ── Style → SKU / target-cost seed helper ───────────────────────────────────
//
// Given a style code, returns a representative SKU + its avg cost (from
// ip_item_avg_cost). Used by the style picker to seed target_cost on the new
// row via resolveCost(). This is a small Supabase REST fetch — the costing
// frontend is otherwise REST-only, so this matches the rest of the chunk.
//
// NOTE: We rely on PostgREST being publicly reachable via VITE_SUPABASE_URL
// (the same channel the rest of the app uses for read queries). If the
// environment locks that down later, this can switch to a dedicated
// /api/internal/costing/style/:code/cost-seed handler in a follow-up.

export interface StyleSkuSeed {
  sku_code: string;
  avg_cost: number | null;
}

export async function fetchStyleSeedSku(styleCode: string): Promise<StyleSkuSeed | null> {
  try {
    const SB_URL = (typeof import.meta !== "undefined" && (import.meta as { env?: { VITE_SUPABASE_URL?: string } }).env?.VITE_SUPABASE_URL) || "";
    const SB_ANON = (typeof import.meta !== "undefined" && (import.meta as { env?: { VITE_SUPABASE_ANON_KEY?: string } }).env?.VITE_SUPABASE_ANON_KEY) || "";
    if (!SB_URL) return null;
    const headers: Record<string, string> = {};
    if (SB_ANON) {
      headers.apikey = SB_ANON;
      headers.Authorization = `Bearer ${SB_ANON}`;
    }
    // Pull first SKU under this style + its avg cost (LEFT JOIN equivalent).
    const url = `${SB_URL}/rest/v1/ip_item_master?style_code=eq.${encodeURIComponent(styleCode)}&select=sku_code&limit=1`;
    const r = await fetch(url, { headers });
    if (!r.ok) return null;
    const rows = (await r.json()) as Array<{ sku_code: string | null }>;
    const sku = rows[0]?.sku_code;
    if (!sku) return null;

    const cUrl = `${SB_URL}/rest/v1/ip_item_avg_cost?sku_code=eq.${encodeURIComponent(sku)}&select=avg_cost&limit=1`;
    const cr = await fetch(cUrl, { headers });
    if (!cr.ok) return { sku_code: sku, avg_cost: null };
    const crows = (await cr.json()) as Array<{ avg_cost: number | null }>;
    const avg = crows[0]?.avg_cost ?? null;
    return { sku_code: sku, avg_cost: typeof avg === "number" ? avg : (avg ? Number(avg) : null) };
  } catch {
    return null;
  }
}

// ── RFQ list + detail ───────────────────────────────────────────────────────

export interface ListRfqsFilters {
  q?: string;
  status?: string;
  limit?: number;
}

export async function listRfqs(filters: ListRfqsFilters = {}): Promise<RfqListRow[]> {
  const sp = new URLSearchParams();
  if (filters.q)      sp.set("q", filters.q);
  if (filters.status) sp.set("status", filters.status);
  if (filters.limit)  sp.set("limit", String(filters.limit));
  const qs = sp.toString();
  const res = await fetch(`/api/internal/costing/rfqs${qs ? `?${qs}` : ""}`);
  const out = await json<{ rows: RfqListRow[] }>(res);
  return out.rows || [];
}

export async function getRfq(id: string): Promise<RfqDetail> {
  return json<RfqDetail>(await fetch(`/api/internal/costing/rfqs/${id}`));
}

export async function updateRfq(id: string, patch: RfqPatch): Promise<RfqListRow> {
  const out = await json<{ rfq: RfqListRow }>(await fetch(`/api/internal/costing/rfqs/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  }));
  return out.rfq;
}

export async function deleteRfq(id: string): Promise<void> {
  return json<void>(await fetch(`/api/internal/costing/rfqs/${id}`, { method: "DELETE" }));
}

export interface PublishRfqResult {
  ok: true;
  id: string;
  status: "published";
  /** Number of invited vendors that were (re-)notified via rfq_invited. */
  notified: number;
}

/**
 * "Send to Vendor" — publish the RFQ and notify every invited vendor.
 *
 * POSTs to the internal publish handler (api/_handlers/internal/rfqs/:id/publish.js,
 * routes.js h49). That handler flips rfqs.status draft → published and fires the
 * rfq_invited notification to each invited vendor; it is idempotent (re-publishing
 * a published RFQ re-sends, deduped server-side by rfq_id+vendor_id), so the
 * caller can offer a "Re-send" affordance safely. Same authenticateInternalCaller
 * gate the rest of /api/internal/costing/* uses, so it is reachable from the
 * costing app's auth context.
 */
export async function publishRfq(rfqId: string): Promise<PublishRfqResult> {
  return json<PublishRfqResult>(await fetch(`/api/internal/rfqs/${rfqId}/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  }));
}

export interface AwardRfqResult {
  ok: true;
  rfq_id: string;
  awarded_to: string;
  /** Count of losing vendors that received an rfq_not_awarded notification. */
  losers_notified: number;
  /** Whether the Production-Manager in-app/email notification was sent, and how the recipient was resolved. */
  pm_notify?: {
    sent: boolean;
    /** 'employee' = matched a Production-Manager employee; 'internal_procurement' = env fallback; 'none' = no recipient resolvable. */
    resolved_via: "employee" | "internal_procurement" | "none";
    recipients: number;
  };
  /** Costing write-back diagnostics (see award handler). */
  costing_writeback?: {
    written: number;
    skipped_reason: string | null;
    errors: Array<Record<string, unknown>>;
  };
}

/**
 * "Award" — award the RFQ to its invited vendor.
 *
 * POSTs to api/_handlers/internal/rfqs/:id/award/:vendor_id.js (routes.js).
 * The handler flips rfqs.status → 'awarded', marks the winning rfq_quote
 * 'awarded' + losers 'rejected', notifies the winner (rfq_awarded) and every
 * loser (rfq_not_awarded), notifies + emails the Production Manager, fires the
 * rfq_awarded workflow event, AND flows the awarded quote back into the source
 * costing project. It requires the awarded vendor to have a SUBMITTED quote —
 * returns 409 with a descriptive message otherwise (surfaced to the caller).
 */
export async function awardRfq(rfqId: string, vendorId: string): Promise<AwardRfqResult> {
  return json<AwardRfqResult>(await fetch(`/api/internal/rfqs/${rfqId}/award/${vendorId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  }));
}

// ── Compare RFQs (cross-RFQ vendor-quote comparison for one project) ─────────
// GET /api/internal/costing/rfq-compare?project_id=… → every RFQ in the
// project with its line items + submitted vendor quotes (+ per-line unit
// prices). The matrix math (cheapest-per-line, deltas) is computed client-side
// in RfqCompareView.

export interface RfqCompareLineItem {
  id: string;
  line_index: number | null;
  description: string | null;
  quantity: number | null;
  // Reference SELL price from the source costing line
  // (rfq_line_items.costing_line_id → costing_lines.sell_price). NULL when the
  // RFQ line was not originated from costing. Drives margin = (sell − quoted) / sell.
  sell_price: number | null;
}

export interface RfqCompareQuoteLine {
  rfq_line_item_id: string;
  unit_price: number | null;
  quantity: number | null;
  notes: string | null;
}

export interface RfqCompareQuote {
  vendor_id: string;
  vendor_name: string | null;
  status: string | null;
  total_price: number | null;
  lead_time_days: number | null;
  valid_until: string | null;
  notes: string | null;
  lines: RfqCompareQuoteLine[];
}

export interface RfqCompareRfq {
  id: string;
  code: string | null;
  title: string | null;
  status: string | null;
  line_items: RfqCompareLineItem[];
  quotes: RfqCompareQuote[];
}

export interface RfqCompareResult {
  project: { id: string; name: string };
  rfqs: RfqCompareRfq[];
}

export async function compareRfqs(projectId: string): Promise<RfqCompareResult> {
  const sp = new URLSearchParams({ project_id: projectId });
  return json<RfqCompareResult>(await fetch(`/api/internal/costing/rfq-compare?${sp.toString()}`));
}

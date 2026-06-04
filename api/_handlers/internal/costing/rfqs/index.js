// api/internal/costing/rfqs
//
// GET ?q=<text>&status=<status>&limit=<int>  → list RFQs
//
// Returns one row per RFQ with denormalized fields the list view needs:
//   vendor_id / vendor_name (from rfq_invitations + vendors)
//   customer_name (from source_costing_project_id → costing_projects.customer_id → customers)
//   project_name (from source_costing_project_id → costing_projects.project_name)
//   line_count + earliest_style_codes (preview for the "style" search column)
//
// The dynamic search (`q`) does ILIKE across:
//   • rfqs.title
//   • vendors.legal_name / vendors.code
//   • customers.code / customers.billing_address->>'name'
//   • rfq_line_items.description (style code is embedded there)
//
// We do the filtering in three passes to avoid PostgREST or-clause limits
// across joined tables: pull all RFQs, then filter in-memory by the
// search term against the denormalized fields. The list is small
// (typically <100 RFQs per entity) so the in-memory filter is fine.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../_lib/auth.js";

export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const __internalAuth = authenticateInternalCaller(req);
  if (!__internalAuth.ok) return res.status(__internalAuth.status).json({ error: __internalAuth.error });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const statusFilter = (url.searchParams.get("status") || "").trim();
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "200", 10) || 200, 500);
  const entityId = url.searchParams.get("entity_id") || req.headers["x-entity-id"];

  // 1. Pull RFQs. The source_costing_project_id column is from the
  // 20260623000001_rfqs_source_costing_project.sql migration; if that
  // migration hasn't applied yet (Supabase CLI push has been failing on
  // a schema_migrations PK collision unrelated to costing), the SELECT
  // 500s with "column does not exist". Retry without the column so the
  // list view still loads — customer + project_name columns will be
  // null until the migration runs.
  const baseCols = "id, entity_id, title, description, category, status, submission_deadline, delivery_required_by, estimated_quantity, estimated_budget, currency, created_at, updated_at";
  const colsWithSource = `${baseCols}, source_costing_project_id`;
  const colsWithSourceAndDates = `${colsWithSource}, request_date, due_date, projected_delivery_date`;
  const runQuery = (cols) => {
    let q1 = admin.from("rfqs")
      .select(cols)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (entityId) q1 = q1.eq("entity_id", entityId);
    if (statusFilter) q1 = q1.eq("status", statusFilter);
    return q1;
  };

  // Fallback ladder: with-dates → with-source-only → bare. Each step strips
  // the columns the previous step failed on so pre-migration deploys still
  // return a usable list.
  const colsTop = `${colsWithSourceAndDates}, intended_vendor_id`;
  let { data: rfqs, error: rfqsErr } = await runQuery(colsTop);
  // intended_vendor_id is the newest column — drop it first if it's not there yet.
  if (rfqsErr && /intended_vendor_id/.test(rfqsErr.message || "")) {
    ({ data: rfqs, error: rfqsErr } = await runQuery(colsWithSourceAndDates));
    if (rfqs) rfqs = rfqs.map((r) => ({ ...r, intended_vendor_id: null }));
  }
  if (rfqsErr && /column .* does not exist/i.test(rfqsErr.message || "") && /(request_date|due_date|projected_delivery_date)/.test(rfqsErr.message || "")) {
    ({ data: rfqs, error: rfqsErr } = await runQuery(colsWithSource));
    if (rfqs) rfqs = rfqs.map((r) => ({ ...r, request_date: null, due_date: null, projected_delivery_date: null }));
  }
  if (rfqsErr && /source_costing_project_id/.test(rfqsErr.message || "")) {
    // eslint-disable-next-line no-console
    console.warn("[costing/rfqs] source_costing_project_id missing — falling back to base columns. Run migration 20260623000001_rfqs_source_costing_project.sql to enable the customer/project join.");
    ({ data: rfqs, error: rfqsErr } = await runQuery(baseCols));
    if (rfqs) rfqs = rfqs.map((r) => ({ ...r, source_costing_project_id: null, request_date: null, due_date: null, projected_delivery_date: null }));
  }
  if (rfqsErr) return res.status(500).json({ error: rfqsErr.message });
  if (!rfqs || rfqs.length === 0) return res.status(200).json({ rows: [] });

  const rfqIds = rfqs.map((r) => r.id);

  // 2. Pull invitations + vendor info per rfq (single batched query).
  const [{ data: invitations }, { data: items }, { data: projects }] = await Promise.all([
    // vendors has both `name` (Phase 0 NOT NULL) and `legal_name` (post-P1,
    // mostly NULL on backfill) — include both, fallback in the dedup pass.
    admin.from("rfq_invitations")
      .select("rfq_id, vendor_id, status, vendors(id, code, name, legal_name)")
      .in("rfq_id", rfqIds),
    admin.from("rfq_line_items")
      .select("rfq_id, description, target_price, quantity")
      .in("rfq_id", rfqIds),
    (async () => {
      const projectIds = rfqs
        .map((r) => r.source_costing_project_id)
        .filter((v) => typeof v === "string");
      if (projectIds.length === 0) return { data: [] };
      return admin.from("costing_projects")
        .select("id, project_name, customer:customers(id, code, billing_address)")
        .in("id", projectIds);
    })(),
  ]);

  const invByRfq = new Map();
  for (const inv of invitations || []) {
    if (!invByRfq.has(inv.rfq_id)) invByRfq.set(inv.rfq_id, []);
    invByRfq.get(inv.rfq_id).push(inv);
  }
  const itemsByRfq = new Map();
  for (const it of items || []) {
    if (!itemsByRfq.has(it.rfq_id)) itemsByRfq.set(it.rfq_id, []);
    itemsByRfq.get(it.rfq_id).push(it);
  }
  const projectById = new Map();
  for (const p of projects || []) projectById.set(p.id, p);

  // Resolve intended vendors (the destined vendor on not-yet-sent drafts, which
  // have no invitation row yet). Used as the vendor fallback in the row map.
  const intendedIds = Array.from(new Set(rfqs.map((r) => r.intended_vendor_id).filter(Boolean)));
  const intendedVendorById = new Map();
  if (intendedIds.length > 0) {
    const { data: iv } = await admin.from("vendors").select("id, code, name, legal_name").in("id", intendedIds);
    for (const v of iv || []) intendedVendorById.set(v.id, v);
  }

  // Resolve Xoro-friendly customer names from ip_customer_master, keyed by
  // customer_code = customers.code. Same source ATS uses
  // (src/ats/exportSalesFetch.ts). 100% coverage of EXCEL:* codes today.
  const custCodes = Array.from(new Set(
    (projects || []).map((p) => p.customer?.code).filter((c) => typeof c === "string" && c.length > 0),
  ));
  const friendlyByCode = new Map();
  if (custCodes.length > 0) {
    try {
      const { data: ipcm } = await admin.from("ip_customer_master")
        .select("customer_code, name")
        .in("customer_code", custCodes);
      for (const r of ipcm || []) {
        if (r.customer_code && r.name) friendlyByCode.set(r.customer_code, r.name);
      }
    } catch (e) {
      console.warn("[costing/rfqs] ip_customer_master enrichment failed:", e.message);
    }
  }

  // 3. Denormalize + search-filter in-memory.
  const rows = rfqs.map((r) => {
    const invs = invByRfq.get(r.id) || [];
    const firstInv = invs[0];
    const intendedVendor = r.intended_vendor_id ? intendedVendorById.get(r.intended_vendor_id) : null;
    const vendor = firstInv?.vendors || intendedVendor || null;
    const vendorName = vendor?.legal_name || vendor?.name || vendor?.code || null;
    const project = r.source_costing_project_id ? projectById.get(r.source_costing_project_id) : null;
    const customer = project?.customer || null;
    // Preference: ip_customer_master.name → billing_address.name → stripped code.
    const friendly = customer?.code ? friendlyByCode.get(customer.code) : null;
    const billingName = (customer && typeof customer.billing_address === "object" && customer.billing_address && typeof customer.billing_address.name === "string")
      ? customer.billing_address.name
      : null;
    const rawCustomerName = friendly || billingName || customer?.code || null;
    // Strip legacy Xoro "EXCEL:" prefix as a final guard (in case
    // ip_customer_master is missing a row for some new code).
    const customerName = rawCustomerName ? rawCustomerName.replace(/^EXCEL:/i, "") : null;
    const lineItems = itemsByRfq.get(r.id) || [];
    // Target cost = the PER-UNIT target the vendor quotes against (operator:
    // NOT the extended total — that's already shown as Est Budget). Weighted
    // average per unit = Σ(target_price × qty) / Σ(qty); falls back to a plain
    // average of line target prices when quantities are absent. Null when no
    // line carries a numeric target_price (vs. 0 = priced-at-zero RFQ).
    let targetExtended = 0;
    let totalQty = 0;
    let targetPriceSum = 0;
    let targetPriceCount = 0;
    let anyTargetPriced = false;
    for (const it of lineItems) {
      if (typeof it.target_price === "number") {
        anyTargetPriced = true;
        const qty = typeof it.quantity === "number" ? it.quantity : 0;
        targetExtended += it.target_price * qty;
        totalQty += qty;
        targetPriceSum += it.target_price;
        targetPriceCount += 1;
      }
    }
    const targetCost = !anyTargetPriced ? null
      : totalQty > 0 ? targetExtended / totalQty
      : targetPriceCount > 0 ? targetPriceSum / targetPriceCount
      : null;
    return {
      ...r,
      vendor_id: firstInv?.vendor_id || r.intended_vendor_id || null,
      vendor_name: vendorName,
      // True once the RFQ has actually been sent (an invitation exists).
      sent: invs.length > 0,
      vendor_code: vendor?.code || null,
      customer_id: customer?.id || null,
      customer_name: customerName,
      project_name: project?.project_name || null,
      line_count: lineItems.length,
      target_cost: targetCost,
      // First 3 line descriptions (for the style-search match preview).
      preview_lines: lineItems.slice(0, 3).map((i) => i.description),
    };
  });

  const filtered = q
    ? rows.filter((r) => {
        const hay = [
          r.title,
          r.vendor_name,
          r.vendor_code,
          r.customer_name,
          r.project_name,
          ...(r.preview_lines || []),
        ].filter(Boolean).join(" ").toLowerCase();
        return hay.includes(q);
      })
    : rows;

  return res.status(200).json({ rows: filtered });
}

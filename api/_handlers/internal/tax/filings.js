// api/internal/tax/filings
//
// M19 — the CEO records a filing here. Bookkeeping only: recording a filing does
// NOT post a GL remittance (Xoro/bank already books the payment, which the mirror
// reflects as a debit to the payable account).
//
//   GET  /api/internal/tax/filings?jurisdiction=<code>   → filings (newest first)
//   POST /api/internal/tax/filings                        → record / upsert a filing
//        body { jurisdiction_code, period_start, period_end,
//               tax_collected_cents, tax_remitted_cents,
//               status? (draft|filed|paid), reference?, notes? }
//        Upserts on (entity, jurisdiction, period_start, period_end).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}
const STATUSES = new Set(["draft", "filed", "paid"]);

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });
  const { data: entity } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  if (!entity) return res.status(500).json({ error: "Default entity (ROF) not found" });

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const jurisdiction = (url.searchParams.get("jurisdiction") || "").trim();
    let q = admin
      .from("tax_filings")
      .select("id, jurisdiction_id, period_start, period_end, tax_collected_cents, tax_remitted_cents, net_due_cents, status, filed_at, reference, notes, created_at, tax_jurisdictions(code, label, flag)")
      .eq("entity_id", entity.id)
      .order("period_end", { ascending: false })
      .limit(1000);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    let rows = (data || []).map((r) => ({
      ...r,
      jurisdiction_code: r.tax_jurisdictions?.code || null,
      jurisdiction_label: r.tax_jurisdictions?.label || null,
      flag: r.tax_jurisdictions?.flag || null,
      tax_jurisdictions: undefined,
    }));
    if (jurisdiction) rows = rows.filter((r) => r.jurisdiction_code === jurisdiction);
    return res.status(200).json({ filings: rows });
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    body = body || {};

    const code = String(body.jurisdiction_code || "").trim();
    if (!code) return res.status(400).json({ error: "jurisdiction_code required" });
    if (!body.period_start || !body.period_end) return res.status(400).json({ error: "period_start and period_end required" });
    if (String(body.period_end) < String(body.period_start)) return res.status(400).json({ error: "period_end must be on/after period_start" });
    const status = body.status && STATUSES.has(body.status) ? body.status : "draft";
    if (body.status && !STATUSES.has(body.status)) return res.status(400).json({ error: "status must be draft, filed, or paid" });

    const { data: jur } = await admin
      .from("tax_jurisdictions")
      .select("id")
      .eq("entity_id", entity.id)
      .eq("code", code)
      .maybeSingle();
    if (!jur) return res.status(404).json({ error: `Jurisdiction ${code} not found` });

    const collected = Math.round(Number(body.tax_collected_cents) || 0);
    const remitted = Math.round(Number(body.tax_remitted_cents) || 0);
    const row = {
      entity_id: entity.id,
      jurisdiction_id: jur.id,
      period_start: body.period_start,
      period_end: body.period_end,
      tax_collected_cents: collected,
      tax_remitted_cents: remitted,
      net_due_cents: collected - remitted,
      status,
      filed_at: (status === "filed" || status === "paid") ? (body.filed_at || new Date().toISOString()) : null,
      reference: body.reference ? String(body.reference).trim() : null,
      notes: body.notes ? String(body.notes).trim() : null,
      created_by_user_id: body.created_by_user_id || null,
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await admin
      .from("tax_filings")
      .upsert(row, { onConflict: "entity_id,jurisdiction_id,period_start,period_end" })
      .select("id")
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ id: data.id, message: `Filing recorded for ${code} (${body.period_start} → ${body.period_end}).` });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

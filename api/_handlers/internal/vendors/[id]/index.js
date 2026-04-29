// api/internal/vendors/:id
//
// GET — full vendor profile for the internal drill-down view.
// PUT — update master record.
//   body: { name?, status?, payment_terms?, tax_id? }
//   If status transitions to 'inactive', all vendor_api_keys are revoked
//   and all vendor_users auth accounts are banned (blocks portal login).

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../_lib/auth.js";

export const config = { maxDuration: 30 };

function getId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("vendors");
  return idx >= 0 ? parts[idx + 1] : null;
}

function composite(ot, acc, ackHours) {
  if (ot == null && acc == null && ackHours == null) return null;
  const ackScore = ackHours == null ? 50 : Math.max(0, Math.min(100, 100 - (ackHours - 24) * 100 / 48));
  return Math.round(((ot ?? 0) * 0.5 + (acc ?? 0) * 0.4 + ackScore * 0.1) * 10) / 10;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Internal-API gate. PUT can deactivate vendors / revoke keys / ban
  // user accounts — must not be open. Even GET leaks vendor PII.
  const auth = authenticateInternalCaller(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const id = getId(req);
  if (!id) return res.status(400).json({ error: "Missing vendor id" });

  if (req.method === "GET") {
    const yearStart = new Date(new Date().getFullYear(), 0, 1).toISOString();
    const now = new Date();

    const [vRes, kpiRes, posRes, invRes, docTypesRes, docsRes, disRes, flagsRes, notesRes, contractsRes, usersRes] = await Promise.all([
      admin.from("vendors").select("*").eq("id", id).maybeSingle(),
      admin.from("vendor_kpi_live").select("*").eq("vendor_id", id).maybeSingle(),
      admin.from("tanda_pos").select("uuid_id, po_number, data, vendor_id").eq("vendor_id", id),
      admin.from("invoices").select("id, status, total, paid_at, submitted_at").eq("vendor_id", id),
      admin.from("compliance_document_types").select("id, name, required").eq("active", true),
      admin.from("compliance_documents").select("*").eq("vendor_id", id),
      admin.from("disputes").select("id, type, subject, status, priority, created_at").eq("vendor_id", id).not("status", "in", "(resolved,closed)").order("created_at", { ascending: false }),
      admin.from("vendor_flags").select("*").eq("vendor_id", id).eq("status", "open").order("created_at", { ascending: false }),
      admin.from("vendor_notes").select("*").eq("vendor_id", id).order("is_pinned", { ascending: false }).order("created_at", { ascending: false }).limit(20),
      admin.from("contracts").select("id, title, contract_type, status, start_date, end_date, value, currency").eq("vendor_id", id).order("created_at", { ascending: false }),
      admin.from("vendor_users").select("id, auth_id, display_name, role, last_login, created_at").eq("vendor_id", id),
    ]);

    if (vRes.error) return res.status(500).json({ error: vRes.error.message });
    if (!vRes.data || vRes.data.deleted_at) return res.status(404).json({ error: "Vendor not found" });

    const vendor = vRes.data;
    const activePos = ((posRes.data) || []).filter((p) => !p.data?._archived && !((p.data?.StatusName || "").toLowerCase().includes("closed")));
    const openInvoices = ((invRes.data) || []).filter((i) => !["paid", "rejected"].includes(i.status));
    const spendYtd = ((invRes.data) || [])
      .filter((i) => i.status === "paid" && i.paid_at && new Date(i.paid_at).toISOString() >= yearStart)
      .reduce((a, i) => a + (Number(i.total) || 0), 0);

    // Compliance summary by latest-per-type
    const requiredTypes = ((docTypesRes.data) || []).filter((t) => t.required).map((t) => t.id);
    const latestByType = new Map();
    for (const d of (docsRes.data || [])) {
      const prev = latestByType.get(d.document_type_id);
      if (!prev || new Date(d.uploaded_at) > new Date(prev.uploaded_at)) latestByType.set(d.document_type_id, d);
    }
    let complete = 0, missing = 0, expiringSoon = 0, expired = 0, rejected = 0;
    for (const tid of requiredTypes) {
      const d = latestByType.get(tid);
      if (!d) { missing++; continue; }
      if (d.status === "rejected") { rejected++; continue; }
      if (d.status !== "approved") { missing++; continue; }
      if (d.expiry_date) {
        const ms = new Date(d.expiry_date).getTime();
        if (ms < now.getTime()) expired++;
        else if (ms < now.getTime() + 30 * 86_400_000) expiringSoon++;
        else complete++;
      } else complete++;
    }

    const k = kpiRes.data;
    const latestScorecard = k ? {
      on_time_pct: k.on_time_delivery_pct == null ? null : Number(k.on_time_delivery_pct),
      accuracy_pct: k.invoice_accuracy_pct == null ? null : Number(k.invoice_accuracy_pct),
      avg_acknowledgment_hours: k.avg_acknowledgment_hours == null ? null : Number(k.avg_acknowledgment_hours),
      composite: composite(k.on_time_delivery_pct, k.invoice_accuracy_pct, k.avg_acknowledgment_hours),
    } : null;

    return res.status(200).json({
      vendor,
      compliance_summary: { complete, missing, expiring_soon: expiringSoon, expired, rejected, total_required: requiredTypes.length },
      active_contracts: (contractsRes.data || []).filter((c) => c.status === "signed" || c.status === "under_review" || c.status === "sent"),
      all_contracts: contractsRes.data || [],
      open_disputes: disRes.data || [],
      latest_scorecard: latestScorecard,
      open_flags: flagsRes.data || [],
      recent_notes: notesRes.data || [],
      spend_ytd: spendYtd,
      active_po_count: activePos.length,
      open_invoice_count: openInvoices.length,
      vendor_users: usersRes.data || [],
    });
  }

  if (req.method === "PUT") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const { name, status, payment_terms, tax_id } = body || {};
    const updates = {};
    if (name && String(name).trim()) updates.name = String(name).trim();
    if (status) {
      if (!["active", "inactive"].includes(status)) return res.status(400).json({ error: "status must be active or inactive" });
      updates.status = status;
    }
    if (payment_terms !== undefined) updates.payment_terms = payment_terms || null;
    if (tax_id !== undefined)        updates.tax_id = tax_id || null;
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: "No updatable fields" });
    updates.updated_at = new Date().toISOString();

    const { data: existing } = await admin.from("vendors").select("*").eq("id", id).maybeSingle();
    if (!existing || existing.deleted_at) return res.status(404).json({ error: "Vendor not found" });

    const { error: upErr } = await admin.from("vendors").update(updates).eq("id", id);
    if (upErr) return res.status(500).json({ error: upErr.message });

    // If flipping to inactive, revoke API keys and ban auth users
    if (updates.status === "inactive" && existing.status !== "inactive") {
      await admin.from("vendor_api_keys")
        .update({ revoked_at: new Date().toISOString() })
        .eq("vendor_id", id)
        .is("revoked_at", null);

      const { data: users } = await admin.from("vendor_users").select("auth_id").eq("vendor_id", id);
      await Promise.all((users || []).map(async (u) => {
        if (!u.auth_id) return;
        try {
          await admin.auth.admin.updateUserById(u.auth_id, { ban_duration: "876000h" }); // ~100 years
        } catch { /* continue */ }
      }));
    }

    // If re-activating, lift the ban
    if (updates.status === "active" && existing.status === "inactive") {
      const { data: users } = await admin.from("vendor_users").select("auth_id").eq("vendor_id", id);
      await Promise.all((users || []).map(async (u) => {
        if (!u.auth_id) return;
        try {
          await admin.auth.admin.updateUserById(u.auth_id, { ban_duration: "none" });
        } catch { /* continue */ }
      }));
    }

    return res.status(200).json({ ok: true, id });
  }

  return res.status(405).json({ error: "Method not allowed" });
}

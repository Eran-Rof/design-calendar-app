// api/internal/costing/projects/:id
//
// GET    — detail: { project, lines, vendor_quotes_by_line_id, compliance_by_line_id }
// PUT    — patch header (editable fields only)
// DELETE — cascade-delete project + lines + quotes + compliance

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../../_lib/auth.js";

export const config = { maxDuration: 15 };

const EDITABLE = [
  "project_name", "brand", "gender_code",
  "sales_rep_id", "customer_id",
  "request_date", "due_date", "projected_delivery_date",
  "status", "notes", "grid_state",
  "payment_terms_id", "payment_terms_name",
];

function getId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("projects");
  return idx >= 0 ? parts[idx + 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();

  const __internalAuth = authenticateInternalCaller(req);
  if (!__internalAuth.ok) return res.status(__internalAuth.status).json({ error: __internalAuth.error });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const id = getId(req);
  if (!id) return res.status(400).json({ error: "Missing project id" });

  if (req.method === "GET") {
    const [proj, lines] = await Promise.all([
      admin.from("costing_projects")
        .select("*, customer:customers(id, code, billing_address), sales_rep:sales_reps(id, display_name)")
        .eq("id", id).maybeSingle(),
      admin.from("costing_lines").select("*").eq("project_id", id).order("sort_order", { ascending: true }).range(0, 999),
    ]);
    if (!proj.data) return res.status(404).json({ error: "Project not found" });

    // Enrich the joined customer with ip_customer_master.name (Xoro friendly
    // name keyed by customer_code = customers.code). Mirrors how ATS resolves
    // customer names. 100% coverage of EXCEL:* codes today.
    if (proj.data.customer?.code) {
      try {
        const { data: ipcm } = await admin.from("ip_customer_master")
          .select("name")
          .eq("customer_code", proj.data.customer.code)
          .maybeSingle();
        if (ipcm?.name) proj.data.customer.display_name = ipcm.name;
      } catch (e) {
        console.warn("[costing/projects/:id] ip_customer_master enrichment failed:", e.message);
      }
    }

    const lineIds = (lines.data || []).map((l) => l.id);
    let vendorQuotesByLineId = {};
    let complianceByLineId = {};
    if (lineIds.length > 0) {
      const [quotes, compliance] = await Promise.all([
        admin.from("costing_line_vendors")
          .select("*, vendor:vendors(id, code, legal_name)")
          .in("costing_line_id", lineIds).range(0, 999),
        admin.from("costing_line_compliance").select("*").in("costing_line_id", lineIds).range(0, 999),
      ]);
      for (const q of quotes.data || []) {
        (vendorQuotesByLineId[q.costing_line_id] ||= []).push(q);
      }
      for (const c of compliance.data || []) {
        (complianceByLineId[c.costing_line_id] ||= []).push(c);
      }
    }

    return res.status(200).json({
      project: proj.data,
      lines: lines.data || [],
      vendor_quotes_by_line_id: vendorQuotesByLineId,
      compliance_by_line_id: complianceByLineId,
    });
  }

  if (req.method === "PUT") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }

    const updates = {};
    for (const f of EDITABLE) {
      if (body && Object.prototype.hasOwnProperty.call(body, f)) updates[f] = body[f];
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No editable fields in body" });
    }
    if (updates.status && !["draft","in_progress","quoted","awarded","closed","cancelled"].includes(updates.status)) {
      return res.status(400).json({ error: "invalid status" });
    }

    const { data, error } = await admin.from("costing_projects")
      .update(updates).eq("id", id).select("*").maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Project not found" });
    return res.status(200).json(data);
  }

  if (req.method === "DELETE") {
    // ON DELETE CASCADE handles lines / quotes / compliance.
    const { error } = await admin.from("costing_projects").delete().eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(204).end();
  }

  return res.status(405).json({ error: "Method not allowed" });
}

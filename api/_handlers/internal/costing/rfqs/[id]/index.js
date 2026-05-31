// api/internal/costing/rfqs/:id
//
// GET → full RFQ: header + line_items + invitations (+ source project for
//       customer name).
// PUT → update header. Whitelist below covers the editable fields; line
//       items are managed via a separate endpoint if/when needed.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../../_lib/auth.js";

export const config = { maxDuration: 15 };

const EDITABLE_FIELDS = [
  "title",
  "description",
  "category",
  "status",
  "submission_deadline",
  "delivery_required_by",
  "estimated_quantity",
  "estimated_budget",
  "currency",
];

function getId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("rfqs");
  return idx >= 0 ? parts[idx + 1] : null;
}

function pick(obj, fields) {
  const out = {};
  for (const f of fields) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, f)) out[f] = obj[f];
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();

  const __internalAuth = authenticateInternalCaller(req);
  if (!__internalAuth.ok) return res.status(__internalAuth.status).json({ error: __internalAuth.error });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const id = getId(req);
  if (!id) return res.status(400).json({ error: "Missing RFQ id" });

  if (req.method === "GET") {
    const [{ data: rfq, error: rfqErr }, { data: items }, { data: invitations }] = await Promise.all([
      admin.from("rfqs").select("*").eq("id", id).maybeSingle(),
      admin.from("rfq_line_items").select("*").eq("rfq_id", id).order("line_index", { ascending: true }),
      admin.from("rfq_invitations").select("id, vendor_id, status, vendors(id, code, name, legal_name, country, default_currency)").eq("rfq_id", id),
    ]);
    if (rfqErr) return res.status(500).json({ error: rfqErr.message });
    if (!rfq) return res.status(404).json({ error: "RFQ not found" });

    // Joined source project + customer for the edit view header strip.
    let project = null;
    if (rfq.source_costing_project_id) {
      const { data: pr } = await admin.from("costing_projects")
        .select("id, project_name, customer:customers(id, code, billing_address)")
        .eq("id", rfq.source_costing_project_id).maybeSingle();
      project = pr || null;
      // Enrich the joined customer with ip_customer_master.name so the
      // header strip can render the Xoro-friendly name ("Ross Procurement")
      // instead of the raw "EXCEL:ROSSPROCUREMENT" code. Same source ATS uses.
      if (project?.customer?.code) {
        try {
          const { data: ipcm } = await admin.from("ip_customer_master")
            .select("name")
            .eq("customer_code", project.customer.code)
            .maybeSingle();
          if (ipcm?.name) project.customer.display_name = ipcm.name;
        } catch (e) {
          console.warn("[costing/rfqs/:id] ip_customer_master enrichment failed:", e.message);
        }
      }
    }

    return res.status(200).json({
      rfq,
      line_items: items || [],
      invitations: invitations || [],
      source_project: project,
    });
  }

  if (req.method === "PUT") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const patch = pick(body || {}, EDITABLE_FIELDS);
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: "No editable fields in body" });
    }
    patch.updated_at = new Date().toISOString();

    const { data, error } = await admin.from("rfqs")
      .update(patch).eq("id", id).select("*").maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "RFQ not found" });
    return res.status(200).json({ rfq: data });
  }

  if (req.method === "DELETE") {
    // CASCADE on rfq_line_items + rfq_invitations means a single delete
    // tears down the whole RFQ (header + lines + invitations + quotes).
    const { error } = await admin.from("rfqs").delete().eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(204).end();
  }

  return res.status(405).json({ error: "Method not allowed" });
}

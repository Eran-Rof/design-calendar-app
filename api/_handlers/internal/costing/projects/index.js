// api/internal/costing/projects
//
// GET — list costing projects for an entity.
//   ?entity_id=<uuid> (or X-Entity-ID)
//   ?status=draft|in_progress|quoted|awarded|closed|cancelled
//   ?customer_id=<uuid>
//   ?sales_rep_id=<uuid>
//   ?brand=<text>
//
// POST — create header.
//   body: { entity_id?, project_name, brand?, gender_code?, sales_rep_id?, customer_id?,
//           request_date?, due_date?, projected_delivery_date?, notes?, status?,
//           grid_state?, user_id? }

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../_lib/auth.js";

export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();

  const __internalAuth = authenticateInternalCaller(req);
  if (!__internalAuth.ok) return res.status(__internalAuth.status).json({ error: __internalAuth.error });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const entityId = url.searchParams.get("entity_id") || req.headers["x-entity-id"];
    const status = url.searchParams.get("status");
    const customerId = url.searchParams.get("customer_id");
    const salesRepId = url.searchParams.get("sales_rep_id");
    const brand = url.searchParams.get("brand");

    let q = admin.from("costing_projects").select(
      "*, customer:customers(id, code, billing_address), sales_rep:sales_reps(id, display_name)"
    );
    if (entityId)    q = q.eq("entity_id", entityId);
    if (status)      q = q.eq("status", status);
    if (customerId)  q = q.eq("customer_id", customerId);
    if (salesRepId)  q = q.eq("sales_rep_id", salesRepId);
    if (brand)       q = q.eq("brand", brand);

    const { data, error } = await q.order("created_at", { ascending: false }).range(0, 999);
    if (error) return res.status(500).json({ error: error.message });

    // Enrich each project's joined customer with ip_customer_master.name so
    // the projects-list customer column shows the friendly name. Bulk lookup
    // by customer_code; 100% coverage of EXCEL:* codes today.
    const codes = Array.from(new Set(
      (data || []).map((p) => p.customer?.code).filter((c) => typeof c === "string" && c.length > 0),
    ));
    if (codes.length > 0) {
      try {
        const { data: ipcm } = await admin.from("ip_customer_master")
          .select("customer_code, name")
          .in("customer_code", codes);
        const nameByCode = new Map();
        for (const r of ipcm || []) {
          if (r.customer_code && r.name) nameByCode.set(r.customer_code, r.name);
        }
        for (const p of data || []) {
          if (p.customer?.code) {
            const friendly = nameByCode.get(p.customer.code);
            if (friendly) p.customer.display_name = friendly;
          }
        }
      } catch (e) {
        console.warn("[costing/projects] ip_customer_master enrichment failed:", e.message);
      }
    }
    return res.status(200).json(data || []);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const {
      entity_id, project_name, brand, gender_code,
      sales_rep_id, customer_id,
      request_date, due_date, projected_delivery_date,
      notes, status, grid_state, user_id, created_by_user_id,
    } = body || {};

    if (!project_name || !String(project_name).trim()) {
      return res.status(400).json({ error: "project_name is required" });
    }
    if (status && !["draft","in_progress","quoted","awarded","closed","cancelled"].includes(status)) {
      return res.status(400).json({ error: "invalid status" });
    }

    // Resolve entity_id: body → X-Entity-ID header → first entities row.
    // current_entity_id() DEFAULT returns NULL under service_role (no
    // auth.uid()), so the handler must explicitly inject the value.
    let resolvedEntityId = entity_id || req.headers["x-entity-id"] || null;
    if (!resolvedEntityId) {
      const { data: ent } = await admin.from("entities").select("id").limit(1).maybeSingle();
      resolvedEntityId = ent?.id || null;
    }
    if (!resolvedEntityId) {
      return res.status(400).json({ error: "Could not resolve entity_id (no body, no header, no entities row)" });
    }

    const insert = {
      entity_id: resolvedEntityId,
      project_name: String(project_name).trim(),
      brand: brand || null,
      gender_code: gender_code || null,
      sales_rep_id: sales_rep_id || null,
      customer_id: customer_id || null,
      request_date: request_date || null,
      due_date: due_date || null,
      projected_delivery_date: projected_delivery_date || null,
      notes: notes || null,
      status: status || "draft",
      grid_state: grid_state || {},
      user_id: user_id || null,
      created_by_user_id: created_by_user_id || null,
    };

    const { data, error } = await admin.from("costing_projects").insert(insert).select("*").single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json(data);
  }

  return res.status(405).json({ error: "Method not allowed" });
}

// api/internal/customer-buyers/:id
//
// GET    — one buyer, decorated with reports_to_name + scopes:[{id,name}].
// PATCH  — update supplied fields; if scope_ids[] supplied, replace the join
//          rows. name/phone/email/title (when supplied) re-validate as required.
// DELETE — remove the buyer (scope joins cascade; any buyer reporting to it has
//          its reports_to_buyer_id set null by the FK; any SO buyer_id → null).
//
// Tangerine — Customer Buyers (#1156).

import { createClient } from "@supabase/supabase-js";
import { decorateBuyers, validateBuyer, isValidManagerReport } from "./index.js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

async function replaceScopes(admin, buyerId, scopeIds) {
  await admin.from("customer_buyer_scopes").delete().eq("buyer_id", buyerId);
  const clean = [...new Set((scopeIds || []).filter((s) => UUID_RE.test(String(s))))];
  if (clean.length) {
    const rows = clean.map((scope_id) => ({ buyer_id: buyerId, scope_id }));
    const { error } = await admin.from("customer_buyer_scopes").insert(rows);
    if (error) return error;
  }
  return null;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  // Per feedback_dispatcher_query_not_params: read path params from req.query.
  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: "Invalid id" });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: buyer, error: bErr } = await admin
    .from("customer_buyers").select("*").eq("id", id).maybeSingle();
  if (bErr) return res.status(500).json({ error: bErr.message });
  if (!buyer) return res.status(404).json({ error: "Buyer not found" });

  if (req.method === "GET") {
    // Decorate against all buyers on the customer so reports_to_name resolves.
    const { data: siblings } = await admin
      .from("customer_buyers").select("*").eq("customer_id", buyer.customer_id);
    const decorated = await decorateBuyers(admin, siblings || [buyer]);
    const me = decorated.find((b) => b.id === id) || (await decorateBuyers(admin, [buyer]))[0];
    return res.status(200).json(me);
  }

  if (req.method === "PATCH") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    body = body || {};
    const v = validateBuyer(body, { requireRequired: false });
    if (v.error) return res.status(400).json({ error: v.error });

    // If reports_to is being set, validate it's a manager on the same customer
    // and not self.
    const effReportsTo = "reports_to_buyer_id" in v.data ? v.data.reports_to_buyer_id : buyer.reports_to_buyer_id;
    if (effReportsTo) {
      const okRep = await isValidManagerReport(admin, buyer.customer_id, effReportsTo, id);
      if (okRep.error) return res.status(400).json({ error: okRep.error });
    }

    // If this buyer is being demoted from manager, no other buyer may still
    // report to it.
    if ("is_manager" in v.data && v.data.is_manager === false) {
      const { count } = await admin
        .from("customer_buyers")
        .select("id", { count: "exact", head: true })
        .eq("reports_to_buyer_id", id);
      if ((count || 0) > 0) {
        return res.status(409).json({ error: `Cannot clear the manager flag: ${count} buyer(s) report to this buyer. Reassign their Report first.` });
      }
    }

    if (Object.keys(v.data).length > 0) {
      const { error } = await admin
        .from("customer_buyers")
        .update({ ...v.data, updated_at: new Date().toISOString() })
        .eq("id", id);
      if (error) return res.status(500).json({ error: error.message });
    }

    if (Array.isArray(body.scope_ids)) {
      const sErr = await replaceScopes(admin, id, body.scope_ids);
      if (sErr) return res.status(500).json({ error: `Buyer saved but scopes failed: ${sErr.message}` });
    }

    const { data: siblings } = await admin
      .from("customer_buyers").select("*").eq("customer_id", buyer.customer_id);
    const decorated = await decorateBuyers(admin, siblings || []);
    return res.status(200).json(decorated.find((b) => b.id === id) || null);
  }

  if (req.method === "DELETE") {
    const { error } = await admin.from("customer_buyers").delete().eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ deleted: true, id });
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

// api/internal/sales-reps
//
// GET — list sales reps. Sales reps ARE sales-role employees
//       (employee_titles.is_sales_role). This sources from employees and
//       returns, for each, the commission-subledger shadow sales_reps.id (via
//       sales_rep_for_employee) so the returned ids are FK-valid for the
//       commission panels' filters (commission_accruals.sales_rep_id etc.).
//       Filters: ?include_inactive=1, ?q=<substring>, ?limit=N (default 200, max 500)
//
// POST — RETIRED. The standalone Sales Reps master was unified into Employees;
//        create a sales rep by adding an employee with a sales-role title.
//        Returns 410 Gone.
//
// Shape (unchanged for consumers): rows of
//   { id, entity_id, employee_id, display_name, email,
//     default_commission_pct, payout_terms_days, is_active }

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

async function resolveDefaultEntity(admin) {
  const { data } = await admin
    .from("entities")
    .select("id")
    .eq("code", "ROF")
    .maybeSingle();
  return data || null;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const entity = await resolveDefaultEntity(admin);
  if (!entity) return res.status(500).json({ error: "Default entity (ROF) not found" });
  const entityId = entity.id;

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
    const params = Object.fromEntries(url.searchParams.entries());
    const v = parseListQuery(params);
    if (v.error) return res.status(400).json({ error: v.error });

    let query = admin
      .from("employees")
      .select(
        "id, entity_id, display_name, first_name, last_name, email, " +
        "is_active, commission_wholesale_pct, employee_titles!inner(is_sales_role)",
      )
      .eq("entity_id", entityId)
      .eq("employee_titles.is_sales_role", true)
      .order("display_name", { ascending: true })
      .limit(v.data.limit);

    if (!v.data.include_inactive) query = query.eq("is_active", true);
    if (v.data.q) {
      query = query.or(
        `display_name.ilike.%${v.data.q}%,first_name.ilike.%${v.data.q}%,` +
        `last_name.ilike.%${v.data.q}%,email.ilike.%${v.data.q}%`,
      );
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const rows = [];
    for (const e of data || []) {
      const name = (e.display_name && e.display_name.trim())
        || `${e.first_name || ""} ${e.last_name || ""}`.trim()
        || e.email
        || "(no name)";
      // Resolve-or-create the shadow sales_reps row (id used by commission FKs).
      const { data: repId, error: rpcErr } = await admin.rpc("sales_rep_for_employee", {
        p_employee_id: e.id,
      });
      if (rpcErr || !repId) continue;
      rows.push({
        id: repId,
        entity_id: e.entity_id,
        employee_id: e.id,
        display_name: name,
        email: e.email,
        default_commission_pct: Number(e.commission_wholesale_pct || 0),
        payout_terms_days: 30,
        is_active: !!e.is_active,
      });
    }
    return res.status(200).json(rows);
  }

  if (req.method === "POST") {
    return res.status(410).json({
      error: "Sales Reps master was unified into Employees. Create a sales rep " +
             "by adding an employee with a sales-role title (Employees panel).",
    });
  }

  res.setHeader("Allow", "GET");
  return res.status(405).json({ error: "Method not allowed" });
}

// ────────────────────────────────────────────────────────────────────────
// Validation — exported for unit tests.
// ────────────────────────────────────────────────────────────────────────

export function parseListQuery(params) {
  const q = (params.q || "").trim();
  const include_inactive = params.include_inactive === "1" ||
                           params.include_inactive === "true";

  let limit = parseInt(params.limit || "200", 10);
  if (Number.isNaN(limit) || limit < 1) limit = 200;
  if (limit > 500) limit = 500;

  if (q.length > 200) {
    return { error: "q must be ≤ 200 chars" };
  }

  return {
    data: {
      q: q || null,
      include_inactive,
      limit,
    },
  };
}

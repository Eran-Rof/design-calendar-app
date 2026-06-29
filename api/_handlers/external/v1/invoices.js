// GET /api/external/v1/invoices
//
// READ-ONLY AR (customer) invoices, scoped to the API key's entity. Customer is
// resolved to its code/name (no raw uuid). Void invoices are excluded by
// default; pass ?include_void=1 to include them.
//
// Query: ?limit=&offset=&status=&include_void=

import { withApiKey, pageEnvelope } from "../../../_lib/external/handlerKit.js";

export const config = { maxDuration: 20 };

export default withApiKey(async ({ req, res, admin, auth, limit, offset }) => {
  const status = typeof req.query?.status === "string" ? req.query.status.trim() : "";
  const includeVoid = ["1", "true", "yes"].includes(String(req.query?.include_void || "").toLowerCase());

  let q = admin
    .from("ar_invoices")
    .select("invoice_number, invoice_kind, gl_status, invoice_date, due_date, total_amount_cents, paid_amount_cents, customers(code, name)")
    .eq("entity_id", auth.entity_id)
    .order("invoice_date", { ascending: false })
    .range(offset, offset + limit - 1);
  if (status) q = q.eq("gl_status", status);
  else if (!includeVoid) q = q.neq("gl_status", "void");

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: "query_failed", message: error.message });

  const rows = (data || []).map((iv) => {
    const c = iv.customers || {};
    const total = Number(iv.total_amount_cents) || 0;
    const paid = Number(iv.paid_amount_cents) || 0;
    return {
      invoice_number: iv.invoice_number,
      invoice_kind: iv.invoice_kind || null,
      status: iv.gl_status || null,
      customer_code: c.code || null,
      customer_name: c.name || null,
      invoice_date: iv.invoice_date,
      due_date: iv.due_date,
      currency: "USD",
      total: total / 100,
      paid: paid / 100,
      balance: (total - paid) / 100,
      total_cents: total,
    };
  });
  return pageEnvelope(res, { data: rows, limit, offset });
});

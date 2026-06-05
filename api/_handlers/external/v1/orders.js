// GET /api/external/v1/orders
//
// READ-ONLY sales orders, scoped to the API key's entity. Customer is resolved
// to its code/name (no raw customer uuid). Amounts are returned in cents AND as
// a decimal for convenience.
//
// Query: ?limit=&offset=&status=

import { withApiKey, pageEnvelope } from "../../../_lib/external/handlerKit.js";

export const config = { maxDuration: 20 };

export default withApiKey(async ({ req, res, admin, auth, limit, offset }) => {
  const status = typeof req.query?.status === "string" ? req.query.status.trim() : "";

  let q = admin
    .from("sales_orders")
    .select("so_number, order_date, requested_ship_date, cancel_date, status, currency, subtotal_cents, total_cents, customers(code, name)")
    .eq("entity_id", auth.entity_id)
    .order("order_date", { ascending: false })
    .range(offset, offset + limit - 1);
  if (status) q = q.eq("status", status);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: "query_failed", message: error.message });

  const rows = (data || []).map((o) => {
    const c = o.customers || {};
    return {
      so_number: o.so_number,
      customer_code: c.code || null,
      customer_name: c.name || null,
      order_date: o.order_date,
      requested_ship_date: o.requested_ship_date,
      cancel_date: o.cancel_date,
      status: o.status,
      currency: o.currency || "USD",
      subtotal: (Number(o.subtotal_cents) || 0) / 100,
      total: (Number(o.total_cents) || 0) / 100,
      total_cents: Number(o.total_cents) || 0,
    };
  });
  return pageEnvelope(res, { data: rows, limit, offset });
});

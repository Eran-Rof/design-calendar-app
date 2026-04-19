// api/vendor/reports/pos.js
//
// GET — paginated PO history for the caller's vendor, with timeline fields.
//   ?status=<issued|acknowledged|fulfilled|closed>
//   ?from=YYYY-MM-DD&to=YYYY-MM-DD
//   ?limit=50&offset=0
//
// Response: { rows: [...], total, limit, offset }
// Each row: { po_number, issued_at, acknowledged_at, fulfilled_at,
//             required_by, total_amount, status, on_time }

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

async function resolveVendor(admin, authHeader) {
  const jwt = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!jwt) return null;
  try {
    const { data, error } = await admin.auth.getUser(jwt);
    if (error || !data?.user) return null;
    const { data: vu } = await admin.from("vendor_users").select("vendor_id").eq("auth_id", data.user.id).maybeSingle();
    return vu ? { vendor_id: vu.vendor_id } : null;
  } catch { return null; }
}

function bucketPo(po, ackSet) {
  const statusName = ((po.data && po.data.StatusName) || "").toLowerCase();
  if (statusName.includes("closed")) return "closed";
  if (statusName.includes("partial")) return "partially_received";
  if (statusName.includes("received") || statusName.includes("shipped") || statusName.includes("fulfilled")) return "fulfilled";
  if (ackSet.has(po.po_number)) return "acknowledged";
  return "issued";
}

function pctReceived(po) {
  const items = Array.isArray(po.data?.Items) ? po.data.Items
              : Array.isArray(po.data?.PoLineArr) ? po.data.PoLineArr
              : [];
  if (items.length === 0) return null;
  let ordered = 0, received = 0;
  for (const it of items) {
    ordered += Number(it?.QtyOrder) || 0;
    received += Number(it?.QtyReceived) || 0;
  }
  if (ordered <= 0) return null;
  return Math.round((received / ordered) * 100);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const caller = await resolveVendor(admin, req.headers.authorization);
  if (!caller) return res.status(401).json({ error: "Authentication required" });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const status = url.searchParams.get("status");
  // If from/to are omitted, return all — the report dashboard passes them.
  const fromDate = url.searchParams.get("from");
  const toDate = url.searchParams.get("to");
  const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);

  const [poRes, ackRes] = await Promise.all([
    admin.from("tanda_pos")
      .select("uuid_id, po_number, data, date_expected_delivery, buyer_name")
      .eq("vendor_id", caller.vendor_id),
    admin.from("po_acknowledgments").select("po_number, acknowledged_at"),
  ]);
  if (poRes.error)  return res.status(500).json({ error: poRes.error.message });
  if (ackRes.error) return res.status(500).json({ error: ackRes.error.message });

  const acks = ackRes.data || [];
  const ackSet = new Set(acks.map((a) => a.po_number));
  const ackAtByPo = new Map(acks.map((a) => [a.po_number, a.acknowledged_at]));
  const allPos = poRes.data || [];

  const fromMs = fromDate ? new Date(fromDate + "T00:00:00").getTime() : -Infinity;
  const toMs = toDate ? new Date(toDate + "T23:59:59").getTime() : Infinity;
  const nowMs = Date.now();

  const enriched = allPos
    .filter((p) => !p.data?._archived)
    .filter((p) => {
      const d = p.data?.DateOrder ? new Date(p.data.DateOrder).getTime() : 0;
      return d >= fromMs && d <= toMs;
    })
    .map((p) => {
      const bucket = bucketPo(p, ackSet);
      const ddp = p.date_expected_delivery || p.data?.DateExpectedDelivery || null;
      const requiredMs = ddp ? new Date(ddp).getTime() : null;
      const issued_at = p.data?.DateOrder || null;
      const acknowledged_at = ackAtByPo.get(p.po_number) || null;
      // Derive fulfilled_at from LastShippedDate / data.DateClosed if present
      let fulfilled_at = null;
      if ((p.data?.StatusName || "").toLowerCase().includes("closed")) {
        fulfilled_at = p.data?.DateClosed || p.data?.DateModified || null;
      } else if (bucket === "fulfilled" || bucket === "partially_received") {
        fulfilled_at = p.data?.LastShippedDate || p.data?.DateModified || null;
      }
      const on_time = requiredMs == null ? null : requiredMs >= nowMs;
      return {
        po_number: p.po_number,
        buyer_name: p.buyer_name || p.data?.BuyerName || null,
        issued_at,
        acknowledged_at,
        fulfilled_at,
        required_by: ddp,
        total_amount: Number(p.data?.TotalAmount) || null,
        status: bucket,
        pct_received: pctReceived(p),
        on_time,
      };
    })
    .filter((r) => !status || r.status === status)
    .sort((a, b) => {
      const ta = a.issued_at ? new Date(a.issued_at).getTime() : 0;
      const tb = b.issued_at ? new Date(b.issued_at).getTime() : 0;
      return tb - ta;
    });

  const total = enriched.length;
  const rows = enriched.slice(offset, offset + limit);
  return res.status(200).json({ rows, total, limit, offset });
}

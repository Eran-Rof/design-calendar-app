// api/internal/payments/:id/fx-detail
//
// GET — FX breakdown for a specific payment (the linked international_payments row).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 10 };

function getId(req) {
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("fx-detail");
  return idx > 0 ? parts[idx - 1] : null;
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

  const id = getId(req);
  if (!id) return res.status(400).json({ error: "Missing payment id" });

  const [{ data: payment }, { data: ip }] = await Promise.all([
    admin.from("payments").select("id, amount, currency, status").eq("id", id).maybeSingle(),
    admin.from("international_payments").select("*").eq("payment_id", id).maybeSingle(),
  ]);
  if (!payment) return res.status(404).json({ error: "Payment not found" });

  return res.status(200).json({ payment, fx: ip || null });
}

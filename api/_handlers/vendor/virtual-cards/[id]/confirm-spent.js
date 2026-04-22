// api/vendor/virtual-cards/:id/confirm-spent
//
// POST — vendor marks the card as fully spent.
// Sets status = spent, spent_at = now. Idempotent: already-spent returns 200.

import { createClient } from "@supabase/supabase-js";
import { authenticateVendor } from "../../../../_lib/vendor-auth.js";

export const config = { maxDuration: 10 };

function getId(req) {
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("confirm-spent");
  return idx > 0 ? parts[idx - 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const authRes = await authenticateVendor(admin, req);
  if (!authRes.ok) return res.status(authRes.status || 401).json({ error: authRes.error });

  const id = getId(req);
  if (!id) return res.status(400).json({ error: "Missing card id" });

  const { data: card } = await admin.from("virtual_cards")
    .select("id, vendor_id, status").eq("id", id).maybeSingle();
  if (!card || card.vendor_id !== authRes.auth.vendor_id) return res.status(404).json({ error: "Card not found" });
  if (card.status === "spent") return res.status(200).json({ ok: true, id, status: "spent" });
  if (card.status !== "active") return res.status(409).json({ error: `Card is ${card.status}` });

  const nowIso = new Date().toISOString();
  const { error } = await admin.from("virtual_cards")
    .update({ status: "spent", spent_at: nowIso, updated_at: nowIso })
    .eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true, id, status: "spent" });
}

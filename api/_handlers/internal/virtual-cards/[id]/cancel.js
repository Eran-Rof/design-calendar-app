// api/internal/virtual-cards/:id/cancel
//
// PUT — cancel an active virtual card.

import { createClient } from "@supabase/supabase-js";
import { cancelCardWithProvider, maskCard } from "../../../../_lib/virtual-card.js";

export const config = { maxDuration: 15 };

function getId(req) {
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("cancel");
  return idx > 0 ? parts[idx - 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "PUT") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const id = getId(req);
  if (!id) return res.status(400).json({ error: "Missing card id" });

  const { data: card } = await admin.from("virtual_cards").select("*").eq("id", id).maybeSingle();
  if (!card) return res.status(404).json({ error: "Card not found" });
  if (card.status !== "active") return res.status(409).json({ error: `Card is ${card.status}` });

  try { await cancelCardWithProvider({ provider: card.provider, provider_card_id: card.provider_card_id }); }
  catch (err) { return res.status(502).json({ error: `Provider cancel failed: ${err?.message || err}` }); }

  const nowIso = new Date().toISOString();
  const { error } = await admin.from("virtual_cards")
    .update({ status: "cancelled", updated_at: nowIso })
    .eq("id", id);
  if (error) return res.status(500).json({ error: error.message });

  // Notify vendor
  try {
    const origin = `https://${req.headers.host}`;
    await fetch(`${origin}/api/send-notification`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_type: "virtual_card_cancelled",
        title: `Virtual card cancelled (ending ${card.card_number_last4})`,
        body: `A virtual card ending in ${card.card_number_last4} has been cancelled and can no longer be charged.`,
        link: "/vendor/virtual-cards",
        metadata: { card_id: id, last4: card.card_number_last4 },
        recipient: { vendor_id: card.vendor_id },
        dedupe_key: `virtual_card_cancelled_${id}`,
        email: true,
      }),
    }).catch(() => {});
  } catch { /* non-blocking */ }

  return res.status(200).json({ ok: true, id, status: "cancelled", card: maskCard({ ...card, status: "cancelled" }) });
}

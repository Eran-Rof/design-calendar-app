// api/internal/messages/unread-count.js
//
// GET — { count } of unread messages from vendors across all POs.
// Used by the TandA Messages tab badge.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 10 };

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

  const { count, error } = await admin
    .from("po_messages")
    .select("*", { count: "exact", head: true })
    .eq("sender_type", "vendor")
    .eq("read_by_internal", false);
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ count: count || 0 });
}

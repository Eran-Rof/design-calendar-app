// api/internal/channels
//
// P15 Brand Master — Chunk 2: list channels for the <ChannelSwitcher>.
//
// GET /api/internal/channels → { channels: [{ id, code, name, sort_order }] }
//
// Channels are global (entity-agnostic). Read-only, ungated (needed to render
// the global channel picker). Seeded in C1 / migration-managed.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 10 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID, X-Channel-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data, error } = await admin
    .from("channel_master")
    .select("id, code, name, sort_order")
    .order("sort_order", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ channels: data || [] });
}

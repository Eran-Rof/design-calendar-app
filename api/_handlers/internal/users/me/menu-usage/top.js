// api/internal/users/me/menu-usage/top
//
// Cross-cutter T4-2 — Personalization: top-N "Most Used" menu items.
//
// GET ?limit=N  (default 10, max 50)
//
//   • Returns the authenticated user's user_menu_usage rows sorted by
//     click_count_30d DESC, then last_clicked_at DESC. The 30d counter
//     is the rolling decay-adjusted score (T4-1's nightly cron decays
//     each row's count by ceil(count/30)), so this surface naturally
//     prioritises recently-active menu items over historical favourites.
//   • Returns up to LIMIT rows. Missing or non-numeric limit defaults
//     to 10; >50 clamps to 50; <1 clamps to 1.
//   • Each row is { menu_key, click_count_30d, click_count_alltime,
//     last_clicked_at }. The client looks up the human label + route
//     via MENU_KEY_BY_KEY from src/lib/menuKeys.ts.
//
// Auth — Bearer JWT.

import { createClient } from "@supabase/supabase-js";
import { authenticateCaller } from "../../../../../_lib/auth.js";

export const config = { maxDuration: 10 };

const DEFAULT_LIMIT = 10;
const MAX_LIMIT     = 50;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

/**
 * Clamp a caller-supplied limit string to the [1, MAX_LIMIT] range.
 * Exposed for unit-test coverage of the clamp logic.
 *
 * @param {string|number|undefined|null} raw
 * @returns {number}
 */
export function clampLimit(raw) {
  if (raw == null || raw === "") return DEFAULT_LIMIT;
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  if (n < 1) return 1;
  if (n > MAX_LIMIT) return MAX_LIMIT;
  return Math.floor(n);
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

  const auth = await authenticateCaller(req, admin);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  const limit = clampLimit(url.searchParams.get("limit"));

  const { data, error } = await admin
    .from("user_menu_usage")
    .select("menu_key, click_count_30d, click_count_alltime, last_clicked_at")
    .eq("user_id", auth.authId)
    .order("click_count_30d", { ascending: false })
    .order("last_clicked_at", { ascending: false })
    .limit(limit);
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ rows: data || [], limit });
}

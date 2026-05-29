// api/cron/menu-usage-decay
//
// Cross-cutter T4-1 — Nightly decay cron for user_menu_usage.click_count_30d.
//
// The 30-day click window is approximated by decaying each row's count by
// ceil(count/30) every night. Floored at 0. Run as a single UPDATE
// statement (no per-row roundtrip) for table-scan efficiency.
//
//   UPDATE user_menu_usage
//   SET click_count_30d = GREATEST(0, click_count_30d - CEIL(click_count_30d / 30.0))
//   WHERE click_count_30d > 0;
//
// Schedule: 03:00 UTC daily (vercel.json crons[]). Idempotent: re-running
// is safe — already-decayed rows just decay again, which is correct
// behavior for a missed night.
//
// Returns { rows_updated: N, errors: [...] }.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });

  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  try {
    const out = await runMenuUsageDecay(admin);
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Decays click_count_30d on every user_menu_usage row by ceil(count/30),
 * floored at 0. Uses a single UPDATE so there is no per-row roundtrip.
 *
 * Path A (preferred): calls the optional `menu_usage_decay_30d` SQL
 * function (a simple wrapper around the UPDATE). If it exists, we use it.
 *
 * Path B (fallback): runs the UPDATE via supabase-js by selecting then
 * upserting in batches. This is only used when the RPC is not deployed
 * yet (e.g. fresh staging).
 *
 * @param {Object} supabase service-role client
 * @returns {Promise<{rows_updated:number, errors:string[], path:string}>}
 */
export async function runMenuUsageDecay(supabase) {
  const summary = { rows_updated: 0, errors: [], path: "rpc" };

  // Path A — single-UPDATE via RPC.
  const { data: rpcData, error: rpcErr } = await supabase.rpc("menu_usage_decay_30d");
  if (!rpcErr) {
    const n = typeof rpcData === "number" ? rpcData : Number(rpcData?.rows_updated || 0);
    summary.rows_updated = Number.isFinite(n) ? n : 0;
    return summary;
  }

  // RPC missing or errored — fall back to select+update in batches.
  summary.path = "fallback";
  const PAGE = 1000;
  let from = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data: rows, error: selErr } = await supabase
      .from("user_menu_usage")
      .select("user_id, entity_id, menu_key, click_count_30d")
      .gt("click_count_30d", 0)
      .range(from, from + PAGE - 1);
    if (selErr) {
      summary.errors.push(`select failed: ${selErr.message}`);
      return summary;
    }
    if (!rows || rows.length === 0) break;

    for (const row of rows) {
      const decay = Math.ceil((row.click_count_30d || 0) / 30);
      const next = Math.max(0, (row.click_count_30d || 0) - decay);
      const { error: updErr } = await supabase
        .from("user_menu_usage")
        .update({ click_count_30d: next })
        .eq("user_id", row.user_id)
        .eq("entity_id", row.entity_id)
        .eq("menu_key", row.menu_key);
      if (updErr) {
        summary.errors.push(`update ${row.menu_key}: ${updErr.message}`);
        continue;
      }
      summary.rows_updated += 1;
    }

    // If we got back fewer than the page size, we are done.
    if (rows.length < PAGE) break;
    from += rows.length;
  }

  return summary;
}

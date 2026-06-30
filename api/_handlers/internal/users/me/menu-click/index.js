// api/internal/users/me/menu-click
//
// Cross-cutter T4-2 — Personalization: click telemetry.
//
// POST body: { menu_key: string }
//
//   • Validates menu_key against MENU_KEY_SET (400 on unknown).
//   • UPSERT into user_menu_usage:
//       - first click for (user, entity, menu_key)   → INSERT with both
//         counters at 1 and last_clicked_at = now()
//       - subsequent clicks                          → UPDATE both
//         counters += 1 and bump last_clicked_at
//     Done via supabase-js upsert with the T4-1 SQL function
//     menu_usage_increment if available (single atomic statement), with a
//     read-modify-write fallback when the RPC isn't deployed yet.
//   • Returns the post-increment counters so the client can render the
//     "Most Used" tile without a follow-up GET.
//
// Auth — Bearer JWT.

import { createClient } from "@supabase/supabase-js";
import { resolveUserId } from "../../../../../_lib/auth.js";
import { isKnownMenuKey } from "../../../../../_lib/menuKeys.js";

export const config = { maxDuration: 10 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Auth-User-Id, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

async function resolveDefaultEntityId(admin) {
  const { data, error } = await admin
    .from("entities")
    .select("id")
    .eq("code", "ROF")
    .maybeSingle();
  if (error || !data) return null;
  return data.id;
}

/**
 * Validate the click-telemetry body.
 *
 * @param {unknown} body
 * @returns {{data?: {menu_key: string}, error?: string}}
 */
export function validateClickBody(body) {
  if (!body || typeof body !== "object") {
    return { error: "Body must be a JSON object" };
  }
  const { menu_key } = body;
  if (typeof menu_key !== "string" || menu_key.length === 0) {
    return { error: "menu_key must be a non-empty string" };
  }
  if (!isKnownMenuKey(menu_key)) {
    return { error: `unknown menu_key: ${menu_key}` };
  }
  return { data: { menu_key } };
}

/**
 * Increment the click counters for (user_id, entity_id, menu_key). Tries an
 * RPC first (single atomic statement); falls back to a select+upsert pair
 * when the RPC isn't deployed.
 *
 * Exported so the unit tests can exercise both branches.
 *
 * @returns {Promise<{ok: boolean, row?: {click_count_30d:number, click_count_alltime:number, last_clicked_at:string}, error?: string}>}
 */
export async function incrementClick(admin, { userId, entityId, menuKey }) {
  // Path A — single-statement RPC (deployed by a follow-up T4 migration).
  const rpc = await admin.rpc("menu_usage_increment", {
    p_user_id: userId,
    p_entity_id: entityId,
    p_menu_key: menuKey,
  });
  if (!rpc.error && rpc.data) {
    // RPC returns the updated row as either a JSON object or a row array.
    const row = Array.isArray(rpc.data) ? rpc.data[0] : rpc.data;
    if (row && typeof row === "object") {
      return {
        ok: true,
        row: {
          click_count_30d:     Number(row.click_count_30d ?? 0),
          click_count_alltime: Number(row.click_count_alltime ?? 0),
          last_clicked_at:     row.last_clicked_at ?? new Date().toISOString(),
        },
      };
    }
  }

  // Path B — fallback. Read existing counters, increment, upsert.
  // Race window is tolerable: two concurrent clicks from one user landing
  // in the same millisecond is vanishingly rare for a personal counter
  // (we are not tracking session-level analytics). When it does happen,
  // we lose at most ONE increment — the worse outcome is a slightly
  // under-counted "Most Used" tile, no data integrity issue.
  const sel = await admin
    .from("user_menu_usage")
    .select("click_count_30d, click_count_alltime")
    .eq("user_id", userId)
    .eq("entity_id", entityId)
    .eq("menu_key", menuKey)
    .maybeSingle();
  if (sel.error) {
    return { ok: false, error: `select failed: ${sel.error.message}` };
  }

  const prev30d  = Number(sel.data?.click_count_30d ?? 0);
  const prevAll  = Number(sel.data?.click_count_alltime ?? 0);
  const next30d  = prev30d + 1;
  const nextAll  = prevAll + 1;
  const lastTs   = new Date().toISOString();

  const ups = await admin
    .from("user_menu_usage")
    .upsert(
      {
        user_id: userId,
        entity_id: entityId,
        menu_key: menuKey,
        click_count_30d: next30d,
        click_count_alltime: nextAll,
        last_clicked_at: lastTs,
      },
      { onConflict: "user_id,entity_id,menu_key" },
    )
    .select("click_count_30d, click_count_alltime, last_clicked_at")
    .single();
  if (ups.error) {
    return { ok: false, error: `upsert failed: ${ups.error.message}` };
  }
  return {
    ok: true,
    row: {
      click_count_30d:     Number(ups.data?.click_count_30d ?? next30d),
      click_count_alltime: Number(ups.data?.click_count_alltime ?? nextAll),
      last_clicked_at:     ups.data?.last_clicked_at ?? lastTs,
    },
  };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const auth = await resolveUserId(req, admin);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  const v = validateClickBody(body || {});
  if (v.error) return res.status(400).json({ error: v.error });

  const entityId = await resolveDefaultEntityId(admin);
  if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

  const result = await incrementClick(admin, {
    userId: auth.authId,
    entityId,
    menuKey: v.data.menu_key,
  });
  if (!result.ok) return res.status(500).json({ error: result.error });

  return res.status(200).json({
    menu_key: v.data.menu_key,
    ...result.row,
  });
}

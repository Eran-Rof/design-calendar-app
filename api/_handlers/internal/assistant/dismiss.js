// api/internal/assistant/dismiss
//
// P28-1-2 — "done for today" on a Today-page item.
//   POST   { item_key }  → hide the item for the caller until tomorrow (UTC)
//   DELETE { item_key }  → undo today's dismissal
//
// item_key must be a registered provider key (registry allowlist) — the
// table is per-user UX state, not a free-form store. Requires a resolvable
// user id (there is nothing sensible to dismiss anonymously).

import { createClient } from "@supabase/supabase-js";
import { allProviderKeys } from "../../../_lib/assistant/registry.js";
import { todayISO } from "../../../_lib/assistant/today.js";
import { readAuthUserId } from "./today.js";

export const config = { maxDuration: 10 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID, X-Auth-User-Id");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

/** Pure body validation — exported for tests. */
export function validateDismissBody(body, knownKeys) {
  const itemKey = typeof body?.item_key === "string" ? body.item_key.trim() : "";
  if (!itemKey) return { error: "item_key is required" };
  if (!knownKeys.includes(itemKey)) return { error: `unknown item_key "${itemKey}"` };
  return { item_key: itemKey };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST" && req.method !== "DELETE") {
    res.setHeader("Allow", "POST, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const authUserId = readAuthUserId(req);
  if (!authUserId) return res.status(401).json({ error: "No per-user identity — sign in to dismiss items" });

  const v = validateDismissBody(req.body || {}, allProviderKeys());
  if (v.error) return res.status(400).json({ error: v.error });

  const day = todayISO();
  if (req.method === "POST") {
    const { error } = await admin
      .from("assistant_dismissals")
      .upsert(
        { user_id: authUserId, item_key: v.item_key, dismissed_on: day },
        { onConflict: "user_id,item_key,dismissed_on", ignoreDuplicates: true },
      );
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, item_key: v.item_key, dismissed_on: day });
  }

  const { error } = await admin
    .from("assistant_dismissals")
    .delete()
    .eq("user_id", authUserId)
    .eq("item_key", v.item_key)
    .eq("dismissed_on", day);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true, item_key: v.item_key, undone: true });
}

// api/cron/fx-rate-sync
//
// Every 4 hours: fetch current rates for all currency pairs in use by
// active vendors (preferred_currency != base), write to currency_rates.
//
// Base currency defaults to USD. Override via env FX_BASE_CURRENCY.

import { createClient } from "@supabase/supabase-js";
import { fetchRates } from "../../_lib/fx.js";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const expectedSecret = process.env.CRON_SECRET;
  if (expectedSecret) {
    const got = req.headers.authorization || "";
    if (got !== `Bearer ${expectedSecret}`) return res.status(401).json({ error: "Unauthorized" });
  }

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const base = process.env.FX_BASE_CURRENCY || "USD";
  const result = { started_at: new Date().toISOString(), base, symbols: [], inserted: 0, errors: [] };

  try {
    // Gather target currencies from vendor preferences + any default pairs
    const { data: prefs } = await admin.from("vendor_payment_preferences")
      .select("preferred_currency");
    const pairSet = new Set((prefs || []).map((p) => p.preferred_currency).filter((c) => c && c !== base));
    // Common extras if nobody's set a preference yet
    if (pairSet.size === 0) {
      ["EUR", "GBP", "CAD", "MXN", "CNY"].forEach((c) => pairSet.add(c));
    }
    const symbols = [...pairSet];
    result.symbols = symbols;

    const rates = await fetchRates(base, symbols);
    if (rates.length === 0) {
      result.errors.push({ error: "No rates returned from provider" });
    } else {
      const nowIso = new Date().toISOString();
      const rows = rates.map((r) => ({
        from_currency: r.from, to_currency: r.to, rate: r.rate,
        source: r.source, snapshotted_at: nowIso,
      }));
      const { error } = await admin.from("currency_rates").insert(rows);
      if (error) result.errors.push({ error: error.message });
      else result.inserted = rows.length;
    }
  } catch (err) {
    result.errors.push({ error: err?.message || String(err) });
  }

  result.finished_at = new Date().toISOString();
  return res.status(result.errors.length ? 207 : 200).json(result);
}

// api/marketplace/listings
//
// GET — search published listings.
//   ?q=<text>                    full-text across title / description / capabilities
//   ?category=<text>
//   ?certification=<c1>,<c2>     require ALL
//   ?geography=<g1>,<g2>         match ANY
//   ?min_order_value=<n>         filter listings whose MOV is ≤ this
//   ?limit=&offset=
// Sort: featured desc, views desc, esg overall desc.

import { createClient } from "@supabase/supabase-js";
import { matchesSearch, matchesFilters, rankListings, esgMapForVendors } from "../../../_lib/marketplace.js";

export const config = { maxDuration: 15 };

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

  const url = new URL(req.url, `https://${req.headers.host}`);
  const q = url.searchParams.get("q") || "";
  const category = url.searchParams.get("category") || null;
  const certifications = (url.searchParams.get("certification") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const geographic_coverage = (url.searchParams.get("geography") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const min_order_value = url.searchParams.get("min_order_value");
  const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);

  const { data: raw, error } = await admin
    .from("marketplace_listings")
    .select("*, vendor:vendors(id, name)")
    .eq("status", "published");
  if (error) return res.status(500).json({ error: error.message });

  const filtered = (raw || [])
    .filter((l) => matchesFilters(l, { category, certifications, geographic_coverage, min_order_value }))
    .filter((l) => matchesSearch(l, q));

  const vendorIds = [...new Set(filtered.map((l) => l.vendor_id))];
  const esg = await esgMapForVendors(admin, vendorIds);
  const ranked = rankListings(filtered, esg);

  const page = ranked.slice(offset, offset + limit).map((l) => ({
    ...l,
    esg_overall_score: esg[l.vendor_id] ?? null,
  }));
  return res.status(200).json({ rows: page, total: ranked.length, limit, offset });
}

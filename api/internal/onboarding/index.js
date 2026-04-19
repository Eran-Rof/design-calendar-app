// api/internal/onboarding
//
// GET — list of onboarding workflows for internal review.
//   ?status=not_started|in_progress|pending_review|approved|rejected
// Sorted by status priority (pending_review first) then started_at desc.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const STATUS_RANK = { pending_review: 4, in_progress: 3, rejected: 2, not_started: 1, approved: 0 };

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
  const status = url.searchParams.get("status");

  let q = admin.from("onboarding_workflows").select("*, vendor:vendors(id, name, status)");
  if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  const rows = (data || []).slice().sort((a, b) => {
    const ra = STATUS_RANK[a.status] ?? 0;
    const rb = STATUS_RANK[b.status] ?? 0;
    if (ra !== rb) return rb - ra;
    return new Date(b.started_at || b.created_at).getTime() - new Date(a.started_at || a.created_at).getTime();
  });
  return res.status(200).json(rows);
}

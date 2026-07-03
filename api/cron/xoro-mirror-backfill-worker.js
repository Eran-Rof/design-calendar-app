// api/cron/xoro-mirror-backfill-worker
//
// Drains the xoro_mirror_backfill_jobs queue. Each tick claims the oldest
// actionable job and processes as many chunks as fit in the time budget, then
// releases it back to 'pending' (or marks it complete/failed). Scheduled every
// few minutes in vercel.json; also POSTable to nudge a job immediately.
//
// Idempotent + safe to overlap: claimNextJob uses an optimistic (status,
// updated_at) lock so two ticks can't process the same job, and a crashed
// worker's job is reclaimed once its heartbeat goes stale.

import { createClient } from "@supabase/supabase-js";
import { claimNextJob, advanceJob } from "../_lib/xoro-mirror/backfillJobs.js";

export const config = { maxDuration: 300 };

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  try {
    const out = await drainOnce(admin);
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}

// Claim + advance a single job. Exposed for tests.
export async function drainOnce(admin, opts = {}) {
  const job = await claimNextJob(admin, opts.claim);
  if (!job) return { claimed: false };
  const result = await advanceJob(admin, job, opts.advance);
  return {
    claimed: true,
    job_id: job.id,
    from: job.from_date,
    to: job.to_date,
    ...result,
  };
}

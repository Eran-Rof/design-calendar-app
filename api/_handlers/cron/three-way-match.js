// api/cron/three-way-match — nightly 3-way match engine run (06:45 UTC,
// after the 05:30 bank mirror and the 06:00 subledger tie-out).
//
// Re-runs run_three_way_match() over ALL AP bills (idempotent; the engine
// only upserts ap_bill_matches rows whose verdict changed, so unchanged
// bills produce zero writes/audit rows). Notifies accounting when the run
// leaves OPEN over-billed exceptions. Errors land in app_errors with
// source 'cron'.

import { createClient } from "@supabase/supabase-js";
import { enqueue as enqueueNotification } from "../../_lib/notifications/index.js";
import { captureError } from "../../_lib/errorCapture.js";

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !KEY) return res.status(500).json({ error: "Supabase admin not configured" });
  const admin = createClient(SB_URL, KEY, { auth: { persistSession: false } });

  try {
    const { data: summary, error } = await admin.rpc("run_three_way_match");
    if (error) throw new Error(error.message);

    // Alert accounting on OPEN over-billed exceptions (the control breach
    // that actually leaks cash). Accepted/disputed ones stay quiet.
    const { count, error: qErr } = await admin
      .from("ap_bill_matches")
      .select("id", { count: "exact", head: true })
      .eq("status", "over_billed_vs_received")
      .eq("resolution", "open");
    if (qErr) throw new Error(qErr.message);

    if ((count || 0) > 0) {
      const { data: ent } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
      if (ent?.id) {
        try {
          await enqueueNotification(admin, {
            entity_id: ent.id,
            kind: "three_way_match_exceptions",
            severity: "warning",
            subject: `3-Way Match: ${count} open over-billed bill(s)`,
            body: `The nightly 3-way match run found ${count} AP bill(s) billed beyond received value (open, unresolved). Review them in Tangerine > Procurement > 3-Way Match.`,
            context_table: "ap_bill_matches",
            context_id: null,
            payload: { summary },
            recipient_roles: ["admin", "accounting"],
          });
        } catch { /* notification is best-effort; the run itself succeeded */ }
      }
    }

    return res.status(200).json({ ok: true, summary, open_over_billed: count || 0 });
  } catch (e) {
    await captureError({
      source: "cron",
      route: "/api/cron/three-way-match",
      message: e?.message || String(e),
      stack: e?.stack,
      context: { kind: "three_way_match" },
    });
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}

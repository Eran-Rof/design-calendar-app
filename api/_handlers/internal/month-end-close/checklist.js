// api/internal/month-end-close/checklist
//
// GET ?month=YYYY-MM — the full checklist for one period: the gl_periods row,
// the close_periods row (or null if checks have never been run), and every
// checklist item ordered by sort_order with signer labels (never raw UUIDs).
//
// Read-only. The close_periods row + items are created by run-checks; before
// the first run this returns close_period=null and the panel shows a
// "Run checks to start the close" empty state.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../_lib/auth.js";
import {
  MONTH_RE,
  resolveDefaultEntityId,
  resolvePeriodForMonth,
  fetchChecklistItems,
  resolveSignerLabels,
  checklistComplete,
} from "../../../_lib/accounting/closeChecklist.js";
import { buildManualReviewContext, buildAutoReviewContext } from "../../../_lib/accounting/closeReviewContext.js";

export const config = { maxDuration: 15 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
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

  const auth = authenticateInternalCaller(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  try {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const month = (url.searchParams.get("month") || "").trim();
    if (!MONTH_RE.test(month)) {
      return res.status(400).json({ error: "month must be YYYY-MM" });
    }

    const entityId = await resolveDefaultEntityId(admin);
    if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

    const period = await resolvePeriodForMonth(admin, entityId, month);
    if (!period) return res.status(404).json({ error: `No accounting period found for ${month}` });

    const { data: cp, error: cErr } = await admin
      .from("close_periods")
      .select("id, status, checks_last_run_at, closed_at, reopened_at")
      .eq("entity_id", entityId)
      .eq("period_id", period.id)
      .maybeSingle();
    if (cErr) return res.status(500).json({ error: cErr.message });

    let items = [];
    if (cp) {
      items = await resolveSignerLabels(admin, await fetchChecklistItems(admin, cp.id));
      // Per-item review context: what to review + a count for the period + the
      // panel to open — for BOTH the manual sign-offs (query a live source) and
      // the automated checks (derive from each check's stored detail, plus a
      // filtered drill for draft JEs and 8007). Best-effort — never blocks the
      // checklist read.
      try {
        const autoItems = items.filter((i) => i.kind === "auto");
        const [manualReview, autoReview] = await Promise.all([
          buildManualReviewContext(admin, entityId, period, month, items),
          buildAutoReviewContext(admin, entityId, period, month, autoItems),
        ]);
        items = items.map((i) => {
          const review = i.kind === "manual" ? manualReview[i.item_key] : autoReview[i.item_key];
          return { ...i, review: review || null };
        });
      } catch {
        /* review context is additive — a failure must not break the checklist */
      }
    }

    return res.status(200).json({
      month,
      period: {
        fiscal_year: period.fiscal_year,
        period_number: period.period_number,
        starts_on: period.starts_on,
        ends_on: period.ends_on,
        gl_status: period.status,
      },
      close_period: cp
        ? {
            status: cp.status,
            checks_last_run_at: cp.checks_last_run_at,
            closed_at: cp.closed_at,
            reopened_at: cp.reopened_at,
          }
        : null,
      items,
      ready_to_close: cp ? checklistComplete(items) : false,
    });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}

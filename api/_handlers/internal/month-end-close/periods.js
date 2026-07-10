// api/internal/month-end-close/periods
//
// GET — close-calendar summary: the last N calendar periods (default 12,
// newest first) with their gl_periods status, close_periods status, and
// checklist progress counts. Drives the panel's calendar strip.
//
// Auth: static internal token (authenticateInternalCaller); RBAC maps the
// month-end-close segment to the gl_periods module (read).

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../_lib/auth.js";
import { resolveDefaultEntityId } from "../../../_lib/accounting/closeChecklist.js";

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
    const entityId = await resolveDefaultEntityId(admin);
    if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

    const url = new URL(req.url, `https://${req.headers.host}`);
    const months = Math.min(36, Math.max(1, parseInt(url.searchParams.get("months") || "12", 10) || 12));

    // Last N periods whose month has started (no future months).
    const today = new Date().toISOString().slice(0, 10);
    const { data: periods, error: pErr } = await admin
      .from("gl_periods")
      .select("id, fiscal_year, period_number, starts_on, ends_on, status")
      .eq("entity_id", entityId)
      .lte("starts_on", today)
      .order("starts_on", { ascending: false })
      .limit(months);
    if (pErr) return res.status(500).json({ error: pErr.message });

    const periodIds = (periods || []).map((p) => p.id);
    let closeByPeriod = new Map();
    let itemsByClose = new Map();
    if (periodIds.length > 0) {
      const { data: cps, error: cErr } = await admin
        .from("close_periods")
        .select("id, period_id, status, checks_last_run_at, closed_at")
        .eq("entity_id", entityId)
        .in("period_id", periodIds);
      if (cErr) return res.status(500).json({ error: cErr.message });
      closeByPeriod = new Map((cps || []).map((c) => [c.period_id, c]));

      const closeIds = (cps || []).map((c) => c.id);
      if (closeIds.length > 0) {
        const { data: items, error: iErr } = await admin
          .from("close_checklist_items")
          .select("close_period_id, kind, status")
          .in("close_period_id", closeIds);
        if (iErr) return res.status(500).json({ error: iErr.message });
        for (const it of items || []) {
          const agg = itemsByClose.get(it.close_period_id) || {
            auto_pass: 0, auto_fail: 0, auto_pending: 0, manual_signed: 0, manual_pending: 0,
          };
          if (it.kind === "auto") {
            if (it.status === "pass") agg.auto_pass += 1;
            else if (it.status === "fail") agg.auto_fail += 1;
            else agg.auto_pending += 1;
          } else if (it.status === "signed_off") agg.manual_signed += 1;
          else agg.manual_pending += 1;
          itemsByClose.set(it.close_period_id, agg);
        }
      }
    }

    const rows = (periods || []).map((p) => {
      const cp = closeByPeriod.get(p.id) || null;
      return {
        month: p.starts_on.slice(0, 7),
        period_id: p.id,
        fiscal_year: p.fiscal_year,
        period_number: p.period_number,
        starts_on: p.starts_on,
        ends_on: p.ends_on,
        gl_status: p.status,
        close_status: cp?.status || "open",
        checks_last_run_at: cp?.checks_last_run_at || null,
        closed_at: cp?.closed_at || null,
        items: (cp && itemsByClose.get(cp.id)) || {
          auto_pass: 0, auto_fail: 0, auto_pending: 0, manual_signed: 0, manual_pending: 0,
        },
      };
    });

    return res.status(200).json({ rows });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}

// POST /api/ats/upload — scriptable ATS ingest.
//
// Replaces the in-app UploadModal "Process Files" flow when driven by
// the daily-design-calendar-sync skill. Accepts the two Xoro reports
// as a single multipart/form-data POST and runs the same end-to-end
// pipeline the modal triggers, persisting the result to Supabase so
// the planning views see it.
//
//   curl -F "inventory_snapshot=@Inventory_Snapshot_YYYY-MM-DD.xlsx" \
//        -F "all_orders_report=@All_Orders_Report_YYYY-MM-DD.xlsx" \
//        -H "Authorization: Bearer $DESIGN_CALENDAR_API_TOKEN" \
//        https://design-calendar-app.vercel.app/api/ats/upload
//
// Auth: bearer-token gate via authenticateDesignCalendarCaller — uses
// crypto.timingSafeEqual for constant-time compare. The endpoint
// returns 500 if DESIGN_CALENDAR_API_TOKEN is unset (no soft-warn
// fallback — this surface must be locked before deploy).
//
// Rate limit: 60 req/hour. The skill runs the daily sync once (~3
// calls including the two sync endpoints), so 60 leaves plenty of
// headroom for retries / manual reruns. Bucket is keyed on the token
// so unauthenticated traffic never burns the legitimate caller's
// budget.
//
// Pipeline (mirrors src/ats/hooks/useExcelUpload.ts):
//   1. Parse inventory + orders → ExcelData
//   2. Fold tanda_pos rows into onPO + pos events (PO WIP merge)
//   3. Dedupe sku entries → baseData snapshot
//   4. Replay ats_merge_history merge ops on top of base
//   5. Auto-apply known ats_norm_decisions; surface unknowns as
//      review_required: true so the skill can stop and let a human
//      handle the decision in the modal.
//   6. Save final blob to app_data['ats_excel_data']
//      Save base snapshot to app_data['ats_base_data'] (so undo works)
//
// Field aliases preserved so legacy callers keep working:
//   inventory_snapshot   ← required (also accepts: inventory, inv)
//   all_orders_report    ← required (also accepts: all_orders, orders, ord)
//   purchases            ← optional (PO data normally comes from PO WIP)

import { randomUUID } from "node:crypto";
import formidable from "formidable";
import { parseExcelRows, readSheetFromPath } from "../../_lib/ats-parse.js";
import {
  applyPOWIPData,
  dedupeExcelData,
  mergeExcelDataSkus,
  detectNormChanges,
  partitionNormChanges,
  applyNormChanges,
  loadNormDecisions,
  loadMergeHistory,
  saveExcelData,
  saveBaseData,
} from "../../_lib/ats-pipeline.js";
import { authenticateDesignCalendarCaller, rateLimit } from "../../_lib/auth.js";

export const config = { api: { bodyParser: false }, maxDuration: 300 };

const RATE_LIMIT = { limit: 60, windowMs: 60 * 60 * 1000 };

function pickFile(files, ...keys) {
  for (const k of keys) {
    const v = files[k];
    if (v) return Array.isArray(v) ? v[0] : v;
  }
  return null;
}

// Compact textual diff for the response. The skill checks
// review_required: true and stops; a human reads diff_summary in the
// log to decide whether to open the modal.
function summarizeDiff(unknown) {
  if (unknown.length === 0) return "";
  const head = unknown.slice(0, 8).map((u) => `"${u.original}" → "${u.normalized}"`);
  const tail = unknown.length > 8 ? ` … +${unknown.length - 8} more` : "";
  return `${unknown.length} unknown SKU normalization${unknown.length === 1 ? "" : "s"}: ${head.join(", ")}${tail}`;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const auth = authenticateDesignCalendarCaller(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  // Bucket key: last 8 chars of the token. Avoid storing the full
  // token in memory, but still partition usage between callers.
  const tok = String(req.headers.authorization || "").slice(-8);
  const rl = rateLimit(`ats-upload:${tok}`, RATE_LIMIT);
  if (!rl.ok) {
    res.setHeader("Retry-After", String(rl.retry_after_s));
    return res.status(rl.status).json({ error: rl.error, retry_after_s: rl.retry_after_s });
  }

  const SB_URL = (process.env.VITE_SUPABASE_URL || "").trim();
  const SB_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || "").trim();
  if (!SB_URL || !SB_KEY) {
    return res.status(500).json({ error: "Supabase not configured (VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required)" });
  }

  const requestId = randomUUID();
  const form = formidable({ maxFileSize: 30 * 1024 * 1024, multiples: true });
  let files;
  try {
    [, files] = await form.parse(req);
  } catch (e) {
    return res.status(400).json({ error: "Multipart parse error", details: e.message });
  }

  const inv = pickFile(files, "inventory_snapshot", "inventory", "inv");
  const ord = pickFile(files, "all_orders_report", "all_orders", "orders", "ord");
  const pur = pickFile(files, "purchases", "purchased_items", "pur");

  if (!inv) {
    return res.status(400).json({
      error: "Missing 'inventory_snapshot' field",
      details: "Expected the Inventory Snapshot xlsx (also accepts: inventory, inv)",
    });
  }
  if (!ord) {
    return res.status(400).json({
      error: "Missing 'all_orders_report' field",
      details: "Expected the All Orders Report xlsx (also accepts: all_orders, orders, ord)",
    });
  }

  try {
    // 1. Parse workbooks
    const invStart = Date.now();
    const invRows = readSheetFromPath(inv.filepath);
    const invElapsed = Date.now() - invStart;
    const purRows = pur ? readSheetFromPath(pur.filepath) : [];
    const ordStart = Date.now();
    const ordRows = readSheetFromPath(ord.filepath);
    const ordElapsed = Date.now() - ordStart;
    let data = parseExcelRows(invRows, purRows, ordRows);

    // 2. PO WIP fold — best-effort, swallow errors as the modal does.
    try {
      data = await applyPOWIPData(data, SB_URL, SB_KEY);
    } catch (e) {
      console.warn(`[ats/upload ${requestId}] PO WIP fold failed:`, e.message);
    }

    // 3. Dedupe → base snapshot.
    const baseData = dedupeExcelData(data);
    data = baseData;

    // 4. Replay user-recorded merges over the fresh upload.
    const mergeHistory = await loadMergeHistory(SB_URL, SB_KEY);
    for (const op of mergeHistory) {
      if (op && op.fromSku && op.toSku) {
        data = mergeExcelDataSkus(data, op.fromSku, op.toSku);
      }
    }

    // 5. Auto-apply known SKU normalizations; collect unknowns.
    const allChanges = detectNormChanges(data);
    const decisions  = await loadNormDecisions(SB_URL, SB_KEY);
    const { known, unknown } = partitionNormChanges(allChanges, decisions);
    const autoAccepted = known.filter((c) => c.accepted);
    if (autoAccepted.length > 0) {
      data = applyNormChanges(data, autoAccepted);
    }

    // 6. Persist. Order: base before live so a crash leaves base usable.
    await saveBaseData(SB_URL, SB_KEY, baseData);
    await saveExcelData(SB_URL, SB_KEY, data);

    const reviewRequired = unknown.length > 0;
    return res.status(200).json({
      processed: true,
      review_required: reviewRequired,
      request_id: requestId,
      inventory: {
        rows: invRows.length,
        skus: data.skus.length,
        elapsed_ms: invElapsed,
      },
      all_orders: {
        rows: ordRows.length,
        elapsed_ms: ordElapsed,
      },
      normalization: {
        applied: autoAccepted.length > 0,
        changed_skus: autoAccepted.length,
        unknown_skus: unknown.length,
        diff_summary: summarizeDiff(unknown),
        unknowns: unknown.slice(0, 50).map((u) => ({
          original: u.original,
          normalized: u.normalized,
          sources: u.sources,
        })),
      },
      warnings: data.warnings ?? [],
    });
  } catch (e) {
    console.error(`[ats/upload ${requestId}] failed:`, e);
    return res.status(500).json({
      error: "Upload pipeline failed",
      request_id: requestId,
    });
  }
}

// POST /api/ats/upload — scriptable ATS ingest.
//
// Accepts the two Xoro reports as a single multipart/form-data POST and runs
// the same end-to-end pipeline the in-app UploadModal triggers, then persists
// the result to Supabase so the planning views see it. This makes the whole
// Xoro download → ATS upload → planning sync flow runnable from cron / curl
// without a browser.
//
//   curl -F "inventory=@Inventory_Snapshot_YYYY-MM-DD.xlsx" \
//        -F "all_orders=@All_Orders_Report_YYYY-MM-DD.xlsx" \
//        -H "X-ATS-Upload-Token: <ATS_UPLOAD_TOKEN env>" \
//        https://design-calendar-app.vercel.app/api/ats/upload
//
// Field aliases (any of these work):
//   inventory   ← required: Inventory Snapshot xlsx
//   all_orders  ← required: All Orders Report xlsx (also accepts: orders)
//   purchases   ← optional: Purchased Items Report xlsx — by default PO data
//                 comes from PO WIP, mirroring the modal's behavior. Provide
//                 this only if you have a reason to override.
//
// Auth: if env var ATS_UPLOAD_TOKEN is set, the request must include the same
// value in either an `X-ATS-Upload-Token` header or `Authorization: Bearer ...`.
// If unset, the endpoint is open (matching the modal's anon-key trust model).
//
// Pipeline (matches src/ats/hooks/useExcelUpload.ts):
//   1. Parse inventory + orders (and purchases if present) → ExcelData
//   2. Fold tanda_pos rows into onPO + pos events            (PO WIP merge)
//   3. Dedupe sku entries → baseData snapshot
//   4. Replay ats_merge_history merge ops on top of base
//   5. Auto-apply known ats_norm_decisions; report unknown ones in response
//   6. Save final blob to app_data['ats_excel_data']
//      Save base snapshot to app_data['ats_base_data'] (so undo works)
//
// Unknown normalizations are NOT a hard failure — the modal pauses for review,
// but a script can't, so we save the data as-is and surface the unknown SKUs
// in the response so a human can hit the modal later.

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

export const config = { api: { bodyParser: false }, maxDuration: 300 };

function pickFile(files, ...keys) {
  for (const k of keys) {
    const v = files[k];
    if (v) return Array.isArray(v) ? v[0] : v;
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-ATS-Upload-Token");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Optional shared-secret auth. Skip when not configured so the endpoint
  // remains usable without extra setup; once a token is set in Vercel env
  // vars it becomes mandatory.
  const expected = (process.env.ATS_UPLOAD_TOKEN || "").trim();
  if (expected) {
    const headerTok = String(req.headers["x-ats-upload-token"] || "").trim();
    const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    if (headerTok !== expected && bearer !== expected) {
      return res.status(401).json({ error: "Invalid or missing ATS upload token" });
    }
  }

  const SB_URL = (process.env.VITE_SUPABASE_URL || "").trim();
  const SB_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || "").trim();
  if (!SB_URL || !SB_KEY) {
    return res.status(500).json({ error: "Supabase not configured (VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY or VITE_SUPABASE_ANON_KEY required)" });
  }

  const form = formidable({ maxFileSize: 30 * 1024 * 1024, multiples: true });
  let files;
  try {
    [, files] = await form.parse(req);
  } catch (e) {
    return res.status(400).json({ error: "Multipart parse error", detail: e.message });
  }

  const inv = pickFile(files, "inventory", "inv", "inventory_snapshot");
  const ord = pickFile(files, "all_orders", "orders", "ord", "all_orders_report");
  const pur = pickFile(files, "purchases", "purchased_items", "pur");

  if (!inv) return res.status(400).json({ error: "Missing 'inventory' field — expected the Inventory Snapshot xlsx" });
  if (!ord) return res.status(400).json({ error: "Missing 'all_orders' field — expected the All Orders Report xlsx (also accepts 'orders')" });

  try {
    // 1. Parse workbooks
    const invRows = readSheetFromPath(inv.filepath);
    const purRows = pur ? readSheetFromPath(pur.filepath) : [];
    const ordRows = readSheetFromPath(ord.filepath);
    let data = parseExcelRows(invRows, purRows, ordRows);

    // 2. Fold PO WIP (tanda_pos) into the blob — same as the modal does.
    let powipResult = { applied: false, error: null };
    try {
      const beforeSkus = data.skus.length;
      const beforePos  = data.pos.length;
      data = await applyPOWIPData(data, SB_URL, SB_KEY);
      powipResult = {
        applied: true,
        addedSkus: data.skus.length - beforeSkus,
        addedPoEvents: data.pos.length - beforePos,
        error: null,
      };
    } catch (e) {
      // PO WIP fold is best-effort — the modal also swallows this and
      // proceeds, so the script does too. Surface the error in the response.
      powipResult.error = e.message;
    }

    // 3. Dedupe → this is the snapshot we store as ats_base_data so undo
    //    can replay merges against fresh data instead of last week's.
    const baseData = dedupeExcelData(data);
    data = baseData;

    // 4. Replay any user-recorded merges over the fresh upload.
    const mergeHistory = await loadMergeHistory(SB_URL, SB_KEY);
    for (const op of mergeHistory) {
      if (op && op.fromSku && op.toSku) {
        data = mergeExcelDataSkus(data, op.fromSku, op.toSku);
      }
    }

    // 5. Auto-apply previously-decided SKU normalizations. Unknown ones go
    //    back to the caller — a human still has to approve them in the modal,
    //    but we don't block the upload on it.
    const allChanges = detectNormChanges(data);
    const decisions  = await loadNormDecisions(SB_URL, SB_KEY);
    const { known, unknown } = partitionNormChanges(allChanges, decisions);
    const autoAccepted = known.filter(c => c.accepted);
    if (autoAccepted.length > 0) {
      data = applyNormChanges(data, autoAccepted);
    }

    // 6. Persist. Order matters: write base before overwriting the live blob,
    //    so a crash between the two leaves base usable for the next undo.
    await saveBaseData(SB_URL, SB_KEY, baseData);
    await saveExcelData(SB_URL, SB_KEY, data);

    return res.status(200).json({
      ok: true,
      syncedAt: data.syncedAt,
      counts: {
        skus: data.skus.length,
        pos:  data.pos.length,
        sos:  data.sos.length,
        warnings: data.warnings.length,
        autoAppliedNormalizations: autoAccepted.length,
        knownRejectedNormalizations: known.length - autoAccepted.length,
        unknownNormalizations: unknown.length,
        mergeHistoryReplayed: mergeHistory.length,
      },
      warnings: data.warnings,
      // Cap at 50 so a runaway diff doesn't bloat the response.
      unknownNormalizations: unknown.slice(0, 50).map(u => ({
        original: u.original,
        normalized: u.normalized,
        sources: u.sources,
      })),
      powip: powipResult,
      filesReceived: {
        inventory: inv.originalFilename || inv.newFilename || null,
        all_orders: ord.originalFilename || ord.newFilename || null,
        purchases: pur ? (pur.originalFilename || pur.newFilename || null) : null,
      },
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

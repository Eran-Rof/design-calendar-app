// api/internal/style-master/auto-assign-scales
//
// Bulk best-match assignment of size scales to styles. For every style with
// non-PPK size variants (and, unless ?overwrite=1, no scale yet) it runs the
// pure matcher (api/_lib/sizeScaleMatch.js) against the size_scales master and
// proposes the best-fitting scale.
//
//   GET  → PREVIEW only (no writes): summary + per-scale counts + a sample.
//   POST → APPLY: writes via the apply_size_scale_assignments RPC, returns count.
//
// Query param ?overwrite=1 also re-assigns styles that already have a scale.

import { createClient } from "@supabase/supabase-js";
import { bestScaleFor } from "../../../_lib/sizeScaleMatch.js";

export const config = { maxDuration: 60 };

function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const overwrite = String(req.query?.overwrite || "") === "1" || req.body?.overwrite === true;
  const apply = req.method === "POST";
  // source=sales backfills from what was actually SOLD (v_style_sold_sizes);
  // default 'skus' uses the full SKU catalog (v_style_scale_candidates).
  const source = String(req.query?.source || req.body?.source || "skus");
  const CANDIDATE_VIEW = source === "sales" ? "v_style_sold_sizes" : "v_style_scale_candidates";

  // 1. Active size scales.
  const { data: scales, error: se } = await admin
    .from("size_scales").select("id, code, name, sizes").or("is_active.is.null,is_active.eq.true");
  if (se) return res.status(500).json({ error: se.message });
  if (!scales || !scales.length) return res.status(200).json({ error: "No size scales defined — create some in Style Master → Size Scales first.", matched: 0 });

  // 2. Page through the candidate view.
  const PAGE = 1000;
  const wantSkipped = String(req.query?.skipped || "") === "1"; // include the full skipped list (for download)
  const proposals = [];
  const skipped_styles = [];
  const by_scale = {};
  const skip_reasons = {};
  let considered = 0, from = 0;
  for (;;) {
    let q = admin.from(CANDIDATE_VIEW)
      .select("style_code, gender_code, size_scale_id, variants")
      .not("variants", "is", null)
      .range(from, from + PAGE - 1);
    if (!overwrite) q = q.is("size_scale_id", null);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    if (!data || !data.length) break;
    for (const row of data) {
      considered++;
      const r = bestScaleFor(row.variants, scales, row.gender_code);
      if (r.size_scale_id) {
        proposals.push({ style_code: row.style_code, size_scale_id: r.size_scale_id });
        by_scale[r.code] = (by_scale[r.code] || 0) + 1;
      } else {
        skip_reasons[r.reason] = (skip_reasons[r.reason] || 0) + 1;
        if (wantSkipped) {
          skipped_styles.push({
            style_code: row.style_code,
            sizes: Array.isArray(row.variants) ? row.variants.join(", ") : "",
            gender: row.gender_code || "",
            reason: r.reason,
          });
        }
      }
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }

  // Sample (first 25) for the UI confirmation dialog.
  const sample = proposals.slice(0, 25).map((p) => {
    const sc = scales.find((s) => s.id === p.size_scale_id);
    return { style_code: p.style_code, scale: sc ? `${sc.code}` : p.size_scale_id };
  });

  const base = {
    considered,
    matched: proposals.length,
    skipped: considered - proposals.length,
    by_scale,
    skip_reasons,
    overwrite,
    sample,
    ...(wantSkipped ? { skipped_styles } : {}),
  };

  if (!apply) return res.status(200).json({ ...base, applied: false });

  // 3. Apply via the bulk RPC (one round trip).
  const { data: updated, error: ue } = await admin.rpc("apply_size_scale_assignments", {
    _assignments: proposals,
    _overwrite: overwrite,
  });
  if (ue) return res.status(500).json({ error: ue.message, ...base, applied: false });

  return res.status(200).json({ ...base, applied: true, updated: typeof updated === "number" ? updated : proposals.length });
}

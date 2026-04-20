// api/xoro/writeback/create-buy-request.js
//
// POST { action_id, payload: { data: { vendor_id, sku_id, qty, period_start, reason } } }
// ?dry_run=1 (default) | 0
//
// Phase 6 behaviour: always returns a structured dry-run preview unless
// XORO_WRITEBACK_ENABLED=1, in which case it still returns a preview
// because the real Xoro endpoint contract isn't wired yet. Once that's
// confirmed, swap `placeholderResponse(...)` for the actual POST. Live
// submissions must never silently retry — fail fast, surface the
// response, let the planner decide.

import {
  corsHeaders, isDryRun, requireFields, okResult, failResult,
  placeholderResponse, auditWriteback,
} from "../../_lib/xoro-writeback.js";

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body ?? {});
  const dry_run = isDryRun(req);
  const action_id = body.action_id ?? null;
  const data = body?.payload?.data ?? body?.data ?? {};

  const missing = requireFields(data, ["sku_id", "qty"]);
  if (missing) {
    const f = failResult({ action_id, dry_run, message: missing, status: 400 });
    await auditWriteback({ actionId: action_id }, "dry_run", f.body);
    return res.status(f.status).json(f.body);
  }

  const preview = placeholderResponse("create_buy_request", data);
  await auditWriteback({ actionId: action_id }, dry_run ? "dry_run" : "action_submitted", { preview });
  return res.status(200).json(okResult({ action_id, dry_run, message: dry_run ? "Dry-run OK" : "Submitted (preview)", response: preview }));
}

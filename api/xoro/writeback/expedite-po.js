// api/xoro/writeback/expedite-po.js

import {
  corsHeaders, isDryRun, requireFields, okResult, failResult,
  placeholderResponse, auditWriteback,
} from "../../_lib/xoro-writeback.js";
import { requirePermission } from "../../_lib/ip-permissions.js";

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const user = await requirePermission(req, res, "run_writeback");
  if (!user) return;

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body ?? {});
  const dry_run = isDryRun(req);
  const action_id = body.action_id ?? null;
  const data = body?.payload?.data ?? body?.data ?? {};

  const missing = requireFields(data, ["po_number", "sku_id"]);
  if (missing) {
    const f = failResult({ action_id, dry_run, message: missing, status: 400 });
    await auditWriteback({ actionId: action_id }, "dry_run", f.body);
    return res.status(f.status).json(f.body);
  }

  const preview = placeholderResponse("expedite_po", data);
  await auditWriteback({ actionId: action_id }, dry_run ? "dry_run" : "action_submitted", { preview });
  return res.status(200).json(okResult({ action_id, dry_run, message: dry_run ? "Dry-run OK" : "Submitted (preview)", response: preview }));
}

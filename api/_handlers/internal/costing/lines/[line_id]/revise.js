// api/internal/costing/lines/:line_id/revise
//
// POST → Stage B "fork on edit". When the operator edits a SENT or QUOTED
// costing line, the row must not be mutated in place — we freeze it and carry
// the work forward on a fresh Draft copy. This endpoint owns the SERVER side of
// that split:
//   1. mark the source line 'revised' (only moves from sent|quoted; 409 otherwise)
//   2. close the source's now-superseded vendor RFQ (lockSupersededVendorRfqs)
// The NEW Draft copy itself is created by the client via the normal lines upsert
// (so the column allowlist + sort/reindex logic stay in one place).

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../../_lib/auth.js";
import { markLineRevised, lockSupersededVendorRfqs } from "../../../../../_lib/costingLineStatus.js";

export const config = { maxDuration: 15 };

function getLineId(req) {
  if (req.query && req.query.line_id) return req.query.line_id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("lines");
  return idx >= 0 ? parts[idx + 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const auth = authenticateInternalCaller(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const lineId = getLineId(req);
  if (!lineId) return res.status(400).json({ error: "Missing line id" });

  const { data: src, error: srcErr } = await admin
    .from("costing_lines").select("id, status").eq("id", lineId).maybeSingle();
  if (srcErr) return res.status(500).json({ error: srcErr.message });
  if (!src) return res.status(404).json({ error: "Line not found" });

  // Freeze the source. markLineRevised only moves sent|quoted → revised.
  const rev = await markLineRevised(admin, lineId, { note: "edit_forked" });
  if (!rev.moved.includes(lineId)) {
    return res.status(409).json({ error: `Line is ${src.status} — only Sent or Quoted lines fork on edit.` });
  }

  // Close the source's now-superseded vendor RFQ (best-effort; only if the whole
  // RFQ is now terminal — leaves mixed RFQs with live lines open).
  await lockSupersededVendorRfqs(admin, [lineId], { note: "revised" }).catch(() => {});

  return res.status(200).json({ ok: true, revised_line_id: lineId });
}

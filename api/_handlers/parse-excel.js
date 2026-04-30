// api/parse-excel.js — Vercel Serverless Function
// Accepts 3 files: inventory (on-hand), purchases (POs), orders (sales orders)
// Returns compact { skus, pos, sos, syncedAt, warnings } — ATS timeline
// computed client-side. The parse logic itself lives in api/_lib/ats-parse.js
// so it can be reused by api/_handlers/ats/upload.js (the curl-driven endpoint).

import formidable from "formidable";
import {
  parseExcelRows,
  readSheetFromPath,
  detectSkuStore as _detectSkuStore,
  detectPoStore as _detectPoStore,
  detectSoStore as _detectSoStore,
} from "../_lib/ats-parse.js";

// Re-exported so existing tests
// (src/ats/__tests__/parseExcelStoreAttribution.test.ts) keep importing the
// store-detection helpers from this path.
export const detectSkuStore = _detectSkuStore;
export const detectPoStore  = _detectPoStore;
export const detectSoStore  = _detectSoStore;

// 300s ceiling — Excel parse + 3-file ingest can exceed Vercel's 10s default
// on large workbooks. The router (api/dispatch.js) is the outer function and
// its maxDuration takes precedence at runtime; this declaration documents the
// inner intent and applies when the handler is mounted standalone.
export const config = { api: { bodyParser: false }, maxDuration: 300 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  const form = formidable({ maxFileSize: 20 * 1024 * 1024, multiples: true });

  let files;
  try {
    [, files] = await form.parse(req);
  } catch (err) {
    return res.status(400).json({ error: "File parse error" });
  }

  const inv = Array.isArray(files.inventory) ? files.inventory[0] : files.inventory;
  const pur = Array.isArray(files.purchases) ? files.purchases[0] : files.purchases;
  const ord = Array.isArray(files.orders)    ? files.orders[0]    : files.orders;

  if (!inv || !ord) {
    return res.status(400).json({ error: "Inventory and Orders files are required" });
  }

  try {
    const invRows = readSheetFromPath(inv.filepath);
    const purRows = pur ? readSheetFromPath(pur.filepath) : [];
    const ordRows = readSheetFromPath(ord.filepath);
    const result = parseExcelRows(invRows, purRows, ordRows);
    res.status(200).json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

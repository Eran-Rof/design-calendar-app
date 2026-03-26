// api/parse-excel.js — Vercel Serverless Function
// Parses uploaded Excel/CSV files into ATS snapshot rows.
// Requires: npm install xlsx formidable

import formidable from "formidable";
import * as XLSX from "xlsx";
import fs from "fs";

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  const form = formidable({ maxFileSize: 10 * 1024 * 1024 });

  form.parse(req, async (err, _fields, files) => {
    if (err) return res.status(400).json({ error: "File parse error" });

    const file = Array.isArray(files.file) ? files.file[0] : files.file;
    if (!file) return res.status(400).json({ error: "No file provided" });

    try {
      const buffer = fs.readFileSync(file.filepath);
      const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

      const now = new Date().toISOString();
      const today = new Date().toISOString().split("T")[0];

      const snapshots = rawRows
        .filter(r => r.SKU || r.sku || r["Item Number"] || r.ItemNumber)
        .map(r => {
          const sku         = String(r.SKU ?? r.sku ?? r["Item Number"] ?? r.ItemNumber ?? "").trim();
          const description = String(r.Description ?? r.description ?? r.Desc ?? "").trim();
          const category    = String(r.Category ?? r.category ?? r.Cat ?? "").trim() || undefined;
          const dateRaw     = r.Date ?? r.date ?? r["Avail Date"] ?? today;
          const date        = parseDate(dateRaw);
          const qty_available = toInt(r["Qty Available"] ?? r.QtyAvailable ?? r.Available ?? r.ATS ?? 0);
          const qty_on_hand   = toInt(r["Qty On Hand"]  ?? r.QtyOnHand  ?? r.OnHand  ?? qty_available);
          const qty_on_order  = toInt(r["Qty On Order"] ?? r.QtyOnOrder ?? r.OnOrder ?? 0);

          return { sku, description, category, date, qty_available, qty_on_hand, qty_on_order, source: "excel", synced_at: now };
        })
        .filter(s => s.sku && s.date);

      res.status(200).json(snapshots);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

function toInt(v) {
  const n = parseInt(String(v).replace(/[^0-9.-]/g, ""), 10);
  return isNaN(n) ? 0 : n;
}

function parseDate(v) {
  if (!v) return new Date().toISOString().split("T")[0];
  if (v instanceof Date) return v.toISOString().split("T")[0];
  if (typeof v === "number") {
    const d = XLSX.SSF.parse_date_code(v);
    if (d) return `${d.y}-${String(d.m).padStart(2,"0")}-${String(d.d).padStart(2,"0")}`;
  }
  const d = new Date(String(v));
  if (!isNaN(d.getTime())) return d.toISOString().split("T")[0];
  return new Date().toISOString().split("T")[0];
}

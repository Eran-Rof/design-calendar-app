// api/parse-excel.js — Vercel Serverless Function
// Accepts 3 files: inventory (on-hand), purchases (POs), orders (sales orders)
// Computes ATS per SKU per date and returns ATSSnapshot array.

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

  const form = formidable({ maxFileSize: 20 * 1024 * 1024, multiples: true });

  form.parse(req, async (err, _fields, files) => {
    if (err) return res.status(400).json({ error: "File parse error" });

    const inv = Array.isArray(files.inventory) ? files.inventory[0] : files.inventory;
    const pur = Array.isArray(files.purchases)  ? files.purchases[0]  : files.purchases;
    const ord = Array.isArray(files.orders)     ? files.orders[0]     : files.orders;

    if (!inv || !pur || !ord) {
      return res.status(400).json({ error: "All three files are required: inventory, purchases, orders" });
    }

    try {
      const invRows = readSheet(inv.filepath);
      const purRows = readSheet(pur.filepath);
      const ordRows = readSheet(ord.filepath);

      const now   = new Date().toISOString();
      const today = now.split("T")[0];

      // ── 1. Inventory Snapshot → on-hand per SKU ────────────────────────────
      // Columns: Store, Brand, Base Part No, Description, Option 1 Value,
      //          Last Receipt Date, Total Sum of Qty, Avrg Cost, Total Sum of Amount Home Currency
      const skuMap = {};

      for (const r of invRows) {
        const base  = str(r["Base Part No"]);
        const color = str(r["Option 1 Value"]);
        if (!base) continue;
        const sku = color ? `${base} - ${color}` : base;
        if (!skuMap[sku]) {
          skuMap[sku] = {
            sku,
            description: str(r["Description"]),
            category:    str(r["Brand"]) || undefined,
            onHand:      0,
          };
        }
        skuMap[sku].onHand += toNum(r["Total Sum of Qty"]);
      }

      // ── 2. Purchased Items Report → POs (incoming) ────────────────────────
      // Columns: Brand Name, Vendor, PO, BasePart, Option 1 Value,
      //          Expected Delivery Date, Description, Total Sum of Qty Ordered,
      //          Total Average of PO Unit Cost, Total $ Open
      const poMap = {}; // sku → [{date, qty}]

      for (const r of purRows) {
        const base  = str(r["BasePart"]);
        const color = str(r["Option 1 Value"]);
        if (!base) continue;
        const sku  = color ? `${base} - ${color}` : base;
        const date = parseDate(r["Expected Delivery Date"]);
        const qty  = toNum(r["Total Sum of Qty Ordered"]);
        if (!qty) continue;

        if (!poMap[sku]) poMap[sku] = [];
        poMap[sku].push({ date, qty });

        if (!skuMap[sku]) {
          skuMap[sku] = {
            sku,
            description: str(r["Description"]),
            category:    str(r["Brand Name"]) || undefined,
            onHand:      0,
          };
        }
      }

      // ── 3. All Orders Report → Sales Orders (outgoing) ────────────────────
      // Columns: Sale Store, Brand, Order Number, Customer Name,
      //          Order Date to be Shipped, Date to be Cancelled, Order Line Status,
      //          Base Part, Option 1 Value, Total Sum of Qty Ordered,
      //          Unit Price, Total Sum of Total Price
      const soMap = {}; // sku → [{date, qty}]

      for (const r of ordRows) {
        const base  = str(r["Base Part"]);
        const color = str(r["Option 1 Value"]);
        if (!base) continue;
        const sku  = color ? `${base} - ${color}` : base;
        const date = parseDate(r["Order Date to be Shipped"]);
        const qty  = toNum(r["Total Sum of Qty Ordered"]);
        if (!qty) continue;

        if (!soMap[sku]) soMap[sku] = [];
        soMap[sku].push({ date, qty });
      }

      // ── 4. Compute ATS across a 120-day window ─────────────────────────────
      const dates = buildDateRange(today, 120);
      const snapshots = [];

      for (const [sku, info] of Object.entries(skuMap)) {
        const pos = poMap[sku] || [];
        const sos = soMap[sku] || [];
        const totalOnOrder = pos.reduce((s, p) => s + p.qty, 0);

        let ats = info.onHand;

        for (const date of dates) {
          // POs arriving on this date add to available
          const arriving = pos
            .filter(p => p.date === date)
            .reduce((s, p) => s + p.qty, 0);
          // Sales orders shipping on this date reduce available
          const shipping = sos
            .filter(s => s.date === date)
            .reduce((s, o) => s + o.qty, 0);

          ats += arriving - shipping;
          if (ats < 0) ats = 0;

          snapshots.push({
            sku,
            description:   info.description,
            category:      info.category,
            date,
            qty_available: ats,
            qty_on_hand:   info.onHand,
            qty_on_order:  totalOnOrder,
            source:        "excel",
            synced_at:     now,
          });
        }
      }

      res.status(200).json(snapshots);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function readSheet(filepath) {
  const buffer = fs.readFileSync(filepath);
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
}

function str(v) {
  return String(v ?? "").trim();
}

function toNum(v) {
  const n = parseFloat(String(v).replace(/[^0-9.-]/g, ""));
  return isNaN(n) ? 0 : Math.round(n);
}

function parseDate(v) {
  if (!v) return new Date().toISOString().split("T")[0];
  if (v instanceof Date) return v.toISOString().split("T")[0];
  if (typeof v === "number") {
    const d = XLSX.SSF.parse_date_code(v);
    if (d) return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
  }
  const d = new Date(String(v));
  if (!isNaN(d.getTime())) return d.toISOString().split("T")[0];
  return new Date().toISOString().split("T")[0];
}

function buildDateRange(startIso, days) {
  const result = [];
  const start = new Date(startIso + "T00:00:00");
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    result.push(d.toISOString().split("T")[0]);
  }
  return result;
}

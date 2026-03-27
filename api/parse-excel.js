// api/parse-excel.js — Vercel Serverless Function
// Accepts 3 files: inventory (on-hand), purchases (POs), orders (sales orders)
// Returns compact { skus, pos, sos, syncedAt } — ATS timeline computed client-side.

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

      const now = new Date().toISOString();

      // ── 1. Inventory Snapshot → on-hand per SKU ────────────────────────────
      // Columns: Store, Brand, Base Part No, Description, Option 1 Value,
      //          Last Receipt Date, Total Sum of Qty, ...
      const skuMap = {};

      for (const r of invRows) {
        const base  = str(r["Base Part No"]);
        const color = str(r["Option 1 Value"]);
        if (!base) continue;
        const sku = color ? `${base} - ${color}` : base;
        if (!skuMap[sku]) {
          skuMap[sku] = { sku, description: str(r["Description"]), category: str(r["Brand"]) || undefined, onHand: 0, onOrder: 0 };
        }
        skuMap[sku].onHand += toNum(r["Total Sum of Qty"]);
      }

      // ── 2. Purchased Items Report → PO events (incoming) ──────────────────
      // Columns: Brand Name, Vendor, PO, BasePart, Option 1 Value,
      //          Expected Delivery Date, Description, Total Sum of Qty Ordered, ...
      const pos = [];

      for (const r of purRows) {
        const base  = str(r["BasePart"]);
        const color = str(r["Option 1 Value"]);
        if (!base) continue;
        const sku = color ? `${base} - ${color}` : base;
        const qty = toNum(r["Total Sum of Qty Ordered"]);

        // Always register SKU (even if qty is 0) so it appears in the grid
        if (!skuMap[sku]) {
          skuMap[sku] = { sku, description: str(r["Description"]), category: str(r["Brand Name"]) || undefined, onHand: 0, onOrder: 0 };
        }
        if (qty > 0) {
          const date = parseDate(r["Expected Delivery Date"]);
          skuMap[sku].onOrder += qty;
          pos.push({ sku, date, qty, poNumber: str(r["PO"]), vendor: str(r["Vendor"]) });
        }
      }

      // ── 3. All Orders Report → SO events (outgoing) ───────────────────────
      // Columns: Sale Store, Brand, Order Number, Customer Name,
      //          Order Date to be Shipped, ..., Base Part, Option 1 Value,
      //          Total Sum of Qty Ordered, ...
      const sos = [];

      for (const r of ordRows) {
        const base  = str(r["Base Part"]);
        const color = str(r["Option 1 Value"]);
        if (!base) continue;
        const sku = color ? `${base} - ${color}` : base;
        const qty = toNum(r["Total Sum of Qty Ordered"]);

        if (!skuMap[sku]) {
          skuMap[sku] = { sku, description: "", category: str(r["Brand"]) || undefined, onHand: 0, onOrder: 0 };
        }
        if (qty > 0) {
          // Use cancel date as the date SO qty is applied to ATS
          const date = parseDate(r["Date to be Cancelled"] || r["Order Date to be Shipped"]);
          sos.push({
            sku, date, qty,
            orderNumber:  str(r["Order Number"]),
            customerName: str(r["Customer Name"]),
            unitPrice:    parseFloat(String(r["Unit Price"]).replace(/[^0-9.-]/g, "")) || 0,
            totalPrice:   parseFloat(String(r["Total Sum of Total Price"]).replace(/[^0-9.-]/g, "")) || 0,
          });
        }
      }

      // Build onCommitted (total open SO qty) per SKU
      const committedBySku = {};
      for (const s of sos) {
        committedBySku[s.sku] = (committedBySku[s.sku] || 0) + s.qty;
      }

      // Drop SKUs with zero activity across all three files
      const poSkus = new Set(pos.map(p => p.sku));
      const soSkus = new Set(sos.map(s => s.sku));
      const activeSkus = Object.values(skuMap)
        .filter(s => s.onHand > 0 || poSkus.has(s.sku) || soSkus.has(s.sku))
        .map(s => ({ ...s, onCommitted: committedBySku[s.sku] || 0 }));

      res.status(200).json({
        syncedAt: now,
        skus: activeSkus,
        pos,
        sos,
      });
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

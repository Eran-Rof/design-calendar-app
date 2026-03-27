// api/parse-excel.js — Vercel Serverless Function
// Accepts 3 files: inventory (on-hand), purchases (POs), orders (sales orders)
// Returns compact { skus, pos, sos, syncedAt, warnings } — ATS timeline computed client-side.

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
      const skuMap = {};

      for (const r of invRows) {
        const base  = str(r["Base Part No"]);
        const color = str(r["Option 1 Value"]);
        if (!base) continue;
        const sku = color ? `${base} - ${color}` : base;
        if (!skuMap[sku]) {
          skuMap[sku] = { sku, description: str(r["Description"]), category: str(r["Brand"]) || undefined, onHand: 0, onOrder: 0, onCommitted: 0 };
        }
        skuMap[sku].onHand += toNum(r["Total Sum of Qty"]);
      }

      // ── 2. Purchased Items Report → PO events (incoming) ──────────────────
      const pos = [];
      let poTotal = 0, poNoDate = 0, poNoPoNum = 0, poNoVendor = 0;

      for (const r of purRows) {
        const base  = str(r["BasePart"]);
        const color = str(r["Option 1 Value"]);
        if (!base) continue;
        const sku = color ? `${base} - ${color}` : base;
        const qty = toNum(r["Total Sum of Qty Ordered"]);

        if (!skuMap[sku]) {
          skuMap[sku] = { sku, description: str(r["Description"]), category: str(r["Brand Name"]) || undefined, onHand: 0, onOrder: 0, onCommitted: 0 };
        }
        if (qty > 0) {
          poTotal++;
          skuMap[sku].onOrder += qty;

          const date     = parseDate(r["Expected Delivery Date"]);
          const poNumber = str(r["PO"] || r["PO #"] || r["PO Number"] || r["Purchase Order"] || r["PO No"]);
          const vendor   = str(r["Vendor"] || r["Vendor Name"] || r["Supplier"] || r["Vendor/Supplier"]);

          if (!date)     poNoDate++;
          if (!poNumber) poNoPoNum++;
          if (!vendor)   poNoVendor++;

          if (date) {
            pos.push({ sku, date, qty, poNumber, vendor });
          }
        }
      }

      // ── 3. All Orders Report → SO events (outgoing) ───────────────────────
      const sos = [];
      let soTotal = 0, soNoDate = 0, soNoOrderNum = 0, soNoCustName = 0;

      for (const r of ordRows) {
        const base  = str(r["Base Part"]);
        const color = str(r["Option 1 Value"]);
        if (!base) continue;
        const sku = color ? `${base} - ${color}` : base;
        const qty = toNum(r["Total Sum of Qty Ordered"]);

        if (!skuMap[sku]) {
          skuMap[sku] = { sku, description: "", category: str(r["Brand"]) || undefined, onHand: 0, onOrder: 0, onCommitted: 0 };
        }
        if (qty > 0) {
          soTotal++;
          skuMap[sku].onCommitted += qty;

          const rawDate      = r["Date to be Cancelled"] || r["Cancel Date"] || r["Order Date to be Shipped"] || r["Ship Date"] || r["Requested Ship Date"];
          const date         = parseDate(rawDate);
          const orderNumber  = str(r["Order Number"] || r["Order #"] || r["SO Number"] || r["SO #"] || r["Sales Order"] || r["Order No"]);
          const customerName = str(r["Customer Name"] || r["Customer"] || r["Bill To Name"] || r["Ship To Name"] || r["Client Name"]);
          const unitPrice    = parseFloat(String(r["Unit Price"] || r["Unit Cost"] || r["Price"] || 0).replace(/[^0-9.-]/g, "")) || 0;
          const totalPrice   = parseFloat(String(r["Total Sum of Total Price"] || r["Total Price"] || r["Extended Price"] || 0).replace(/[^0-9.-]/g, "")) || 0;

          if (!date)        soNoDate++;
          if (!orderNumber) soNoOrderNum++;
          if (!customerName) soNoCustName++;

          if (date) {
            sos.push({ sku, date, qty, orderNumber, customerName, unitPrice, totalPrice });
          }
        }
      }

      // ── Build warnings ────────────────────────────────────────────────────
      const warnings = [];

      if (soNoDate > 0) {
        warnings.push({
          severity: "error",
          field: "Sales Order Cancel/Ship Date",
          affected: soNoDate,
          total: soTotal,
          message: `${soNoDate} of ${soTotal} sales order lines have no valid cancel or ship date. These orders will NOT move the ATS timeline (they are still counted in the On Order total).`,
        });
      }
      if (soNoOrderNum > 0) {
        warnings.push({
          severity: "warn",
          field: "Sales Order Number",
          affected: soNoOrderNum,
          total: soTotal,
          message: `${soNoOrderNum} of ${soTotal} sales order lines are missing an order number. Right-click details will show "—" for those orders.`,
        });
      }
      if (soNoCustName > 0) {
        warnings.push({
          severity: "warn",
          field: "Customer Name",
          affected: soNoCustName,
          total: soTotal,
          message: `${soNoCustName} of ${soTotal} sales order lines are missing a customer name.`,
        });
      }
      if (poNoDate > 0) {
        warnings.push({
          severity: "error",
          field: "PO Expected Delivery Date",
          affected: poNoDate,
          total: poTotal,
          message: `${poNoDate} of ${poTotal} purchase order lines have no valid expected delivery date. These POs will NOT move the ATS timeline (they are still counted in the On PO total).`,
        });
      }
      if (poNoPoNum > 0) {
        warnings.push({
          severity: "warn",
          field: "PO Number",
          affected: poNoPoNum,
          total: poTotal,
          message: `${poNoPoNum} of ${poTotal} purchase order lines are missing a PO number.`,
        });
      }
      if (poNoVendor > 0) {
        warnings.push({
          severity: "warn",
          field: "Vendor Name",
          affected: poNoVendor,
          total: poTotal,
          message: `${poNoVendor} of ${poTotal} purchase order lines are missing a vendor name.`,
        });
      }

      // ── Active SKUs ───────────────────────────────────────────────────────
      const poSkus = new Set(pos.map(p => p.sku));
      const soSkus = new Set(sos.map(s => s.sku));
      const activeSkus = Object.values(skuMap)
        .filter(s => s.onHand > 0 || s.onOrder > 0 || s.onCommitted > 0 || poSkus.has(s.sku) || soSkus.has(s.sku));

      res.status(200).json({
        syncedAt: now,
        skus: activeSkus,
        pos,
        sos,
        warnings,
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

// Returns YYYY-MM-DD string or null if date is missing/unparseable.
// Never defaults to today — that would cause all undated events to cluster
// on the upload date and cancel each other out in the ATS timeline.
function parseDate(v) {
  if (!v || String(v).trim() === "") return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return v.toISOString().split("T")[0];
  }
  if (typeof v === "number") {
    const d = XLSX.SSF.parse_date_code(v);
    if (d) return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
    return null;
  }
  const d = new Date(String(v));
  if (!isNaN(d.getTime())) return d.toISOString().split("T")[0];
  return null;
}

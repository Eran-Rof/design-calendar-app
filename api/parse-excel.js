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

    if (!inv || !ord) {
      return res.status(400).json({ error: "Inventory and Orders files are required" });
    }

    try {
      const invRows = readSheet(inv.filepath);
      const purRows = pur ? readSheet(pur.filepath) : [];
      const ordRows = readSheet(ord.filepath);

      // Capture actual column headers from each file (first data row)
      const columnNames = {
        inventory: invRows[0] ? Object.keys(invRows[0]) : [],
        purchases:  purRows[0] ? Object.keys(purRows[0]) : [],
        orders:     ordRows[0] ? Object.keys(ordRows[0]) : [],
      };

      const now = new Date().toISOString();

      // ── 1. Inventory Snapshot → on-hand per SKU ────────────────────────────
      const skuMap = {};

      for (const r of invRows) {
        const base  = str(r["Base Part No"]);
        const color = str(r["Option 1 Value"]);
        if (!base) continue;
        const sku = color ? `${base} - ${color}` : base;
        const brand = str(r["Brand"]);
        const rawStore = str(r["Store"]).toUpperCase();
        const storeCol = rawStore.includes("ECOM") ? "ROF ECOM"
          : (rawStore.includes("PSYCHO") || rawStore.includes("PTUNA") || rawStore.includes("P TUNA") || rawStore === "PT" || rawStore.startsWith("PREBOOK")) ? "PT"
          : rawStore.includes("ROF") || rawStore.includes("RING") ? "ROF"
          : "";
        const store = storeCol || detectSkuStore(brand);
        // Key by sku + store so each store gets its own row
        const key = `${sku}::${store}`;
        if (!skuMap[key]) {
          skuMap[key] = {
            sku,
            description: str(r["Description"]),
            category: brand || undefined,
            store,
            onHand: 0,
            onOrder: 0,
            onCommitted: 0,
            lastReceiptDate: toIsoDate(r["Last Receipt Date"]) || undefined,
            totalAmount: 0,
            avgCost: parseFloat(String(r["Avrg Cost"] || 0).replace(/[^0-9.-]/g, "")) || 0,
          };
        }
        skuMap[key].onHand += toNum(r["Total Sum of Qty"]);
        skuMap[key].totalAmount = (skuMap[key].totalAmount || 0) + toNum(r["Total Sum of Amount Home Currency"]);
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

        const poBrand = str(r["Brand Name"] || r["Brand"] || "");
        const poStore = detectSkuStore(poBrand);
        // Find existing SKU entry for any store
        const poKey = Object.keys(skuMap).find(k => k.startsWith(sku + "::")) || `${sku}::${poStore}`;
        const poDesc = str(r["Description"]);
        if (!skuMap[poKey]) {
          skuMap[poKey] = { sku, description: poDesc, category: poBrand || undefined, store: poStore, onHand: 0, onOrder: 0, onCommitted: 0 };
        } else if (!skuMap[poKey].description && poDesc) {
          skuMap[poKey].description = poDesc;
        }
        if (qty > 0) {
          poTotal++;
          skuMap[poKey].onOrder += qty;

          const date     = parseDate(r["Expected Delivery Date"]);
          const poNumber = str(r["PO"] || r["PO #"] || r["PO Number"] || r["Purchase Order"] || r["PO No"]);
          const vendor   = str(r["Vendor"] || r["Vendor Name"] || r["Supplier"] || r["Vendor/Supplier"]);

          if (!date)     poNoDate++;
          if (!poNumber) poNoPoNum++;
          if (!vendor)   poNoVendor++;

          const brandName = str(r["Brand Name"] || r["Brand"] || "");
          const store    = detectPoStore(poNumber, brandName);
          const unitCost = parseFloat(String(r["Total Average of PO Unit Cost"] || r["Unit Cost"] || r["Cost"] || r["Unit Price"] || r["Price"] || 0).replace(/[^0-9.-]/g, "")) || 0;

          if (date) {
            pos.push({ sku, date, qty, poNumber, vendor, store, unitCost });
          }
        }
      }

      // ── 3. All Orders Report → SO events (outgoing) ───────────────────────
      const sos = [];
      let soTotal = 0, soNoDate = 0, soNoOrderNum = 0, soNoCustName = 0;
      let soNoUnitPrice = 0;

      for (const r of ordRows) {
        const base  = str(r["Base Part"]);
        const color = str(r["Option 1 Value"]);
        if (!base) continue;
        const sku = color ? `${base} - ${color}` : base;
        const qty = toNum(r["Total Sum of Qty Ordered"]);

        // Determine the SO's true store from order number + sale store + brand,
        // not brand alone. A "Ring of Fire"-branded SO with Sale Store "PT"
        // belongs to PT — detectSkuStore(brand) alone would mis-bucket it.
        const soBrand     = str(r["Brand"] || r["Brand Name"] || "");
        const saleStore   = str(r["Sale Store"] || r["Store"] || r["Channel"] || "");
        const orderNumber = str(r["Order Number"] || r["Order #"] || r["SO Number"] || r["SO #"] || r["Sales Order"] || r["Order No"]);
        const soStore     = detectSoStore(orderNumber, saleStore, soBrand);
        // Prefer the sku row matching the SO's actual store (including ROF
        // ECOM — the inventory loop does produce ECOM rows when the file's
        // Store column says so). Only fall back to any-store match when the
        // preferred row doesn't exist yet, so non-ECOM stores still light up
        // when inventory and SO happen to disagree on store.
        const preferredKey = `${sku}::${soStore}`;
        const soKey = skuMap[preferredKey]
          ? preferredKey
          : (Object.keys(skuMap).find(k => k.startsWith(sku + "::")) || preferredKey);
        // Pull description from the order row — the orders file uses a few
        // different header spellings, so try each. Items that exist only in
        // the SO file (no inventory row) would otherwise render with a blank
        // description column.
        const soDesc = str(r["Description"] || r["Item Description"] || r["Product Name"] || r["Item Name"] || "");
        if (!skuMap[soKey]) {
          skuMap[soKey] = { sku, description: soDesc, category: soBrand || undefined, store: soStore, onHand: 0, onOrder: 0, onCommitted: 0 };
        } else if (!skuMap[soKey].description && soDesc) {
          skuMap[soKey].description = soDesc;
        }
        if (qty > 0) {
          soTotal++;
          skuMap[soKey].onCommitted += qty;

          const rawDate      = r["Date to be Cancelled"] || r["Cancel Date"] || r["Order Date to be Shipped"] || r["Ship Date"] || r["Requested Ship Date"];
          const date         = parseDate(rawDate);
          const customerName = str(r["Customer Name"] || r["Customer"] || r["Bill To Name"] || r["Ship To Name"] || r["Client Name"]);
          const unitPrice    = parseFloat(String(
            r["Unit Price"] || r["Unit Cost"] || r["Price"] ||
            r["Total Average of Unit Price"] || r["Total Sum of Unit Price"] ||
            r["Average of Unit Price"] || r["Sum of Unit Price"] ||
            r["Total Average of Unit Cost"] || r["Item Price"] || r["Item Cost"] ||
            0
          ).replace(/[^0-9.-]/g, "")) || 0;
          const totalPrice   = parseFloat(String(
            r["Total Sum of Total Price"] || r["Total Price"] || r["Extended Price"] ||
            r["Sum of Total Price"] || r["Total Sum of Amount"] ||
            r["Total Sum of Amount Home Currency"] || r["Amount"] ||
            0
          ).replace(/[^0-9.-]/g, "")) || 0;

          if (!date)        soNoDate++;
          if (!orderNumber) soNoOrderNum++;
          if (!customerName) soNoCustName++;
          if (unitPrice <= 0 && totalPrice <= 0) soNoUnitPrice++;

          if (date) {
            sos.push({ sku, date, qty, orderNumber, customerName, unitPrice, totalPrice, store: soStore });
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
      // If *every* sales order line came through with 0 unit & total price, the
      // file almost certainly uses a column name we don't recognize. Surface the
      // detected headers so the user can tell us which one to add.
      if (soTotal > 0 && soNoUnitPrice === soTotal) {
        const priceLikeHeaders = columnNames.orders.filter(h =>
          /price|cost|amount/i.test(h)
        );
        warnings.push({
          severity: "warn",
          field: "Order Unit Price",
          affected: soTotal,
          total: soTotal,
          message:
            `All ${soTotal} sales order lines have $0 for unit/total price — ` +
            `no recognized price column was found. $ on Order and margin will be 0. ` +
            (priceLikeHeaders.length
              ? `Detected price-like headers: ${priceLikeHeaders.map(h => `"${h}"`).join(", ")}.`
              : `No price-like headers were detected in the order file.`),
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
        columnNames,
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

// Excel cells parsed with cellDates:true become JS Date objects. Stringify
// them as YYYY-MM-DD so downstream display (fmtDateDisplay) can format them
// consistently as MMM/DD/YYYY without timezone drift.
function toIsoDate(v) {
  if (!v) return "";
  if (v instanceof Date && !isNaN(v.getTime())) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(v).trim();
}

// Derive store for an inventory SKU from its brand name (no ECOM distinction at SKU level)
export function detectSkuStore(brandName) {
  const bn = (brandName || "").toUpperCase();
  if (bn.includes("PSYCHO") || bn.includes("PTUNA") || bn.includes("P TUNA") || bn === "PT" || bn.startsWith("PT ")) return "PT";
  return "ROF";
}

// Derive store from PO number and brand name
// ROF ECOM = PO number contains "ECOM"
// PT       = brand contains "Psycho" / "PTUNA" / "P TUNA" or starts with "PT"
// ROF      = everything else (Ring of Fire)
export function detectPoStore(poNumber, brandName) {
  const pn = (poNumber || "").toUpperCase();
  const bn = (brandName || "").toUpperCase();
  if (pn.includes("ECOM")) return "ROF ECOM";
  if (bn.includes("PSYCHO") || bn.includes("PTUNA") || bn.includes("P TUNA") || bn === "PT" || bn.startsWith("PT ")) return "PT";
  return "ROF";
}

// Derive store from order number, sale store field, and brand
export function detectSoStore(orderNumber, saleStore, brand) {
  const on = (orderNumber || "").toUpperCase();
  const ss = (saleStore || "").toUpperCase();
  const br = (brand || "").toUpperCase();
  if (on.includes("ECOM") || ss.includes("ECOM")) return "ROF ECOM";
  if (br.includes("PSYCHO") || ss.includes("PSYCHO") || br.includes("PTUNA") || ss.includes("PTUNA") ||
      br.includes("P TUNA") || ss.includes("P TUNA") || br === "PT" || ss === "PT" || br.startsWith("PT ") || ss.startsWith("PT ")) return "PT";
  return "ROF";
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

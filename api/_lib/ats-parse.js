// Shared Excel parser for ATS uploads — used by both:
//   - api/_handlers/parse-excel.js (legacy: returns parsed JSON to the client)
//   - api/_handlers/ats/upload.js  (scriptable: parses + persists in one shot)
//
// Pure parse logic; no HTTP, no DB. Mirrors src/ats/parseExcelClient.ts so the
// browser modal and the curl-driven endpoint produce identical ExcelData blobs
// from the same Xoro reports.

import * as XLSX from "xlsx";
import fs from "fs";

// ── Store detection ──────────────────────────────────────────────────────────

export function detectSkuStore(brandName) {
  const bn = (brandName || "").toUpperCase();
  if (bn.includes("PSYCHO") || bn.includes("PTUNA") || bn.includes("P TUNA") || bn === "PT" || bn.startsWith("PT ")) return "PT";
  return "ROF";
}

export function detectPoStore(poNumber, brandName) {
  const pn = (poNumber || "").toUpperCase();
  const bn = (brandName || "").toUpperCase();
  if (pn.includes("ECOM")) return "ROF ECOM";
  if (bn.includes("PSYCHO") || bn.includes("PTUNA") || bn.includes("P TUNA") || bn === "PT" || bn.startsWith("PT ")) return "PT";
  return "ROF";
}

export function detectSoStore(orderNumber, saleStore, brand) {
  const on = (orderNumber || "").toUpperCase();
  const ss = (saleStore || "").toUpperCase();
  const br = (brand || "").toUpperCase();
  if (on.includes("ECOM") || ss.includes("ECOM")) return "ROF ECOM";
  if (br.includes("PSYCHO") || ss.includes("PSYCHO") || br.includes("PTUNA") || ss.includes("PTUNA") ||
      br.includes("P TUNA") || ss.includes("P TUNA") || br === "PT" || ss === "PT" || br.startsWith("PT ") || ss.startsWith("PT ")) return "PT";
  return "ROF";
}

// ── Cell helpers ─────────────────────────────────────────────────────────────

function str(v) {
  return String(v ?? "").trim();
}

function toNum(v) {
  const n = parseFloat(String(v).replace(/[^0-9.-]/g, ""));
  return isNaN(n) ? 0 : Math.round(n);
}

function toIsoDate(v) {
  if (!v) return "";
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return "";
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  if (typeof v === "number") {
    const p = XLSX.SSF.parse_date_code(v);
    if (p) return `${p.y}-${String(p.m).padStart(2,"0")}-${String(p.d).padStart(2,"0")}`;
    return "";
  }
  const s = String(v).trim();
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const slashDot = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
  if (slashDot) {
    const A = parseInt(slashDot[1], 10), B = parseInt(slashDot[2], 10), y = slashDot[3];
    let month, day;
    if (A > 12)      { day = A; month = B; }
    else if (B > 12) { month = A; day = B; }
    else             { month = A; day = B; }
    return `${y}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
  }
  const yFirst = s.match(/^(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})$/);
  if (yFirst) return `${yFirst[1]}-${yFirst[2].padStart(2,"0")}-${yFirst[3].padStart(2,"0")}`;
  const named = new Date(s);
  if (!isNaN(named.getTime())) {
    return `${named.getFullYear()}-${String(named.getMonth() + 1).padStart(2,"0")}-${String(named.getDate()).padStart(2,"0")}`;
  }
  return "";
}

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

// Add N days to an ISO "YYYY-MM-DD" string, returning ISO. UTC-based so it
// never shifts across a day boundary from a local-timezone offset.
function addDaysIso(iso, n) {
  if (!iso) return iso;
  const d = new Date(`${iso}T00:00:00Z`);
  if (isNaN(d.getTime())) return iso;
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split("T")[0];
}

// ── Sheet readers ────────────────────────────────────────────────────────────

export function readSheetFromPath(filepath) {
  const buffer = fs.readFileSync(filepath);
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
}

export function readSheetFromBuffer(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
}

// ── Main parse ───────────────────────────────────────────────────────────────
// Takes already-parsed sheet rows (from readSheet*) and produces the same
// ExcelData shape the client expects: { syncedAt, skus, pos, sos, warnings,
// columnNames }. purRows may be empty — PO data normally comes from PO WIP.

const CATEGORY_COLS = ["Catergory", "Category", "Item Category", "Item Group", "Product Group", "Product Category", "Category Code", "Category Name", "Group", "Class", "Item Class"];

export function parseExcelRows(invRows, purRows, ordRows) {
  const columnNames = {
    inventory: invRows[0] ? Object.keys(invRows[0]) : [],
    purchases:  purRows[0] ? Object.keys(purRows[0]) : [],
    orders:     ordRows[0] ? Object.keys(ordRows[0]) : [],
  };

  const now = new Date().toISOString();

  // ── 1. Inventory Snapshot → on-hand per SKU ──────────────────────────────
  const skuMap = {};

  for (const r of invRows) {
    const base  = str(r["Base Part No"]);
    const color = str(r["Option 1 Value"]);
    if (!base) continue;
    const sku = color ? `${base} - ${color}` : base;
    const brand = str(r["Brand"]);
    const category = str(r["Catergory"] || r["Category"] || r["Item Category"] || r["Item Group"] || r["Product Group"] || r["Product Category"] || r["Category Code"] || r["Category Name"] || r["Group"] || r["Class"] || r["Item Class"] || "") || undefined;
    const gender = str(r["Gender"] || r["Dept"] || r["Department"] || r["Gender Code"] || "") || undefined;
    const rawStore = str(r["Store"]).toUpperCase();
    const storeCol = rawStore.includes("ECOM") ? "ROF ECOM"
      : (rawStore.includes("PSYCHO") || rawStore.includes("PTUNA") || rawStore.includes("P TUNA") || rawStore === "PT" || rawStore.startsWith("PREBOOK")) ? "PT"
      : rawStore.includes("ROF") || rawStore.includes("RING") ? "ROF"
      : "";
    const store = storeCol || detectSkuStore(brand);
    const key = `${sku}::${store}`;
    if (!skuMap[key]) {
      skuMap[key] = {
        sku, description: str(r["Description"]), category, gender, store,
        onHand: 0, onOrder: 0, onCommitted: 0,
        lastReceiptDate: toIsoDate(r["Last Receipt Date"]) || undefined,
        totalAmount: 0,
        avgCost: parseFloat(String(r["Avrg Cost"] || 0).replace(/[^0-9.-]/g, "")) || 0,
      };
    }
    skuMap[key].onHand += toNum(r["Total Sum of Qty"] ?? r["Qty"]);
    skuMap[key].totalAmount = (skuMap[key].totalAmount || 0) + toNum(r["Total Sum of Amount Home Currency"] ?? r["Amount Home Currency"]);
  }

  // ── 2. Purchased Items Report → PO events ────────────────────────────────
  const pos = [];
  let poTotal = 0, poNoDate = 0, poNoPoNum = 0, poNoVendor = 0;
  const poNoDateItems = [];

  for (const r of purRows) {
    const base  = str(r["BasePart"]);
    const color = str(r["Option 1 Value"]);
    if (!base) continue;
    const sku = color ? `${base} - ${color}` : base;
    const qty = toNum(r["Total Sum of Qty Ordered"] ?? r["Qty Ordered"]);

    const poBrand = str(r["Brand Name"] || r["Brand"] || "");
    const poStore = detectSkuStore(poBrand);
    const poKey = Object.keys(skuMap).find(k => k.startsWith(sku + "::")) || `${sku}::${poStore}`;
    const poDesc = str(r["Description"]);
    if (!skuMap[poKey]) {
      skuMap[poKey] = { sku, description: poDesc, category: undefined, store: poStore, onHand: 0, onOrder: 0, onCommitted: 0 };
    } else if (!skuMap[poKey].description && poDesc) {
      skuMap[poKey].description = poDesc;
    }
    if (qty > 0) {
      poTotal++;
      skuMap[poKey].onOrder += qty;

      const date     = parseDate(r["Expected Delivery Date"]);
      const poNumber = str(r["PO"] || r["PO #"] || r["PO Number"] || r["Purchase Order"] || r["PO No"]);
      const vendor   = str(r["Vendor"] || r["Vendor Name"] || r["Supplier"] || r["Vendor/Supplier"]);

      if (!date) { poNoDate++; poNoDateItems.push({ sku, qty, poNumber: poNumber || undefined, vendor: vendor || undefined }); }
      if (!poNumber) poNoPoNum++;
      if (!vendor)   poNoVendor++;

      const brandName = str(r["Brand Name"] || r["Brand"] || "");
      const store    = detectPoStore(poNumber, brandName);
      const unitCost = parseFloat(String(r["Total Average of PO Unit Cost"] || r["Unit Cost"] || r["Cost"] || r["Unit Price"] || r["Price"] || 0).replace(/[^0-9.-]/g, "")) || 0;

      // Always push, even when date is empty (Xoro PO with no DDP).
      // Empty-date events are excluded from time-period columns by
      // getEventsInPeriod (date "" < any periodStart) but INCLUDED in
      // $ on PO totals at ATS.tsx:941. Without this, undated POs
      // silently dropped from $ on PO while their qty stayed in the
      // QTY stat — confusing low-by-$X numbers (the "$1M off" bug
      // user found 2026-05-12). Mirrors the parseExcelClient fix.
      pos.push({ sku, date, qty, poNumber, vendor, store, unitCost });
    }
  }

  // ── 3. All Orders Report → SO events ─────────────────────────────────────
  const sos = [];
  let soTotal = 0, soNoDate = 0, soNoOrderNum = 0, soNoCustName = 0, soNoUnitPrice = 0;
  const soNoDateItems = [];

  // Open-orders only. A fully-shipped / cancelled / voided / closed line has
  // no open commitment, so it must NOT count toward On Order or the ATS
  // projection. The nightly feed is Xoro's "All Orders Report" (every
  // status) and these CSVs carry no "Qty Remaining to Ship" column, so
  // without this guard a Shipped line was counted at full ordered qty —
  // overstating On Order (e.g. MMG cancel 5/9-6/16 read 92,980 vs the
  // open-only 87,512; the 5,468 delta was Shipped lines). Keep Released +
  // Partially Shipped (and any other non-terminal status); drop terminal.
  const TERMINAL_SO_STATUSES = new Set([
    "shipped", "fully shipped", "cancelled", "canceled",
    "void", "voided", "closed", "complete", "completed",
  ]);
  for (const r of ordRows) {
    const base  = str(r["Base Part"]);
    const color = str(r["Option 1 Value"]);
    if (!base) continue;
    const soStatus = str(r["Order Line Status"] || r["Order Status"] || r["Status"] || "").toLowerCase();
    if (TERMINAL_SO_STATUSES.has(soStatus)) continue;
    const sku = color ? `${base} - ${color}` : base;
    const qty = toNum(r["Total Sum of Qty Ordered"] ?? r["Qty Ordered"]);

    const soBrand     = str(r["Brand"] || r["Brand Name"] || "");
    const saleStore   = str(r["Sale Store"] || r["Store"] || r["Channel"] || "");
    const orderNumber = str(r["Order Number"] || r["Order #"] || r["SO Number"] || r["SO #"] || r["Sales Order"] || r["Order No"]);
    const soStore     = detectSoStore(orderNumber, saleStore, soBrand);
    const preferredKey = `${sku}::${soStore}`;
    const soKey = skuMap[preferredKey]
      ? preferredKey
      : (Object.keys(skuMap).find(k => k.startsWith(sku + "::")) || preferredKey);
    const soDesc = str(r["Description"] || r["Item Description"] || r["Product Name"] || r["Item Name"] || "");
    const soCategory = str(r["item category"] || r["Item Category"] || r["Catergory"] || r["Category"] || r["Item Group"] || r["Product Group"] || "") || undefined;
    if (!skuMap[soKey]) {
      skuMap[soKey] = { sku, description: soDesc, category: soCategory, store: soStore, onHand: 0, onOrder: 0, onCommitted: 0 };
    } else {
      if (!skuMap[soKey].description && soDesc) skuMap[soKey].description = soDesc;
      if (!skuMap[soKey].category && soCategory) skuMap[soKey].category = soCategory;
    }
    if (qty > 0) {
      soTotal++;
      skuMap[soKey].onCommitted += qty;

      // SO timeline date = the Xoro "Date to be Cancelled". When that's
      // blank, derive a cancel date as ship date + 6 days (operator rule:
      // Xoro cancel dates trail the ship date by ~6 days) so null-cancel
      // SOs still land on the timeline instead of falling back to the raw
      // ship date (which mis-buckets them in the cancel-date-keyed views).
      const cancelRaw    = r["Date to be Cancelled"] || r["Cancel Date"];
      const shipRaw      = r["Order Date to be Shipped"] || r["Ship Date"] || r["Requested Ship Date"];
      let date           = parseDate(cancelRaw);
      if (!date && shipRaw) {
        const shipIso = parseDate(shipRaw);
        if (shipIso) date = addDaysIso(shipIso, 6);
      }
      const customerName = str(r["Customer Name"] || r["Customer"] || r["Bill To Name"] || r["Ship To Name"] || r["Client Name"]);
      const unitPrice    = parseFloat(String(
        r["Unit Price"] || r["Unit Cost"] || r["Price"] ||
        r["Total Average of Unit Price"] || r["Total Sum of Unit Price"] ||
        r["Average of Unit Price"] || r["Sum of Unit Price"] ||
        r["Total Average of Unit Cost"] || r["Item Price"] || r["Item Cost"] || 0
      ).replace(/[^0-9.-]/g, "")) || 0;
      let totalPrice = parseFloat(String(
        r["Total Sum of Total Price"] || r["Total Price"] || r["Extended Price"] ||
        r["Sum of Total Price"] || r["Total Sum of Amount"] ||
        r["Total Sum of Amount Home Currency"] || r["Amount"] || 0
      ).replace(/[^0-9.-]/g, "")) || 0;
      // CSV row-level exports omit Total Price; derive it from unit × qty
      // so $-on-order totals don't collapse to zero on the nightly upload.
      if (totalPrice <= 0 && unitPrice > 0 && qty > 0) {
        totalPrice = unitPrice * qty;
      }

      if (!date) { soNoDate++; soNoDateItems.push({ sku, qty, orderNumber: orderNumber || undefined, customerName: customerName || undefined }); }
      if (!orderNumber) soNoOrderNum++;
      if (!customerName) soNoCustName++;
      if (unitPrice <= 0 && totalPrice <= 0) soNoUnitPrice++;

      // Always push, even when date is empty (SO with no ship/cancel
      // date — backorders, freshly-created orders before DDP, etc.).
      // Same rationale as PO undated above: undated SOs WERE silently
      // dropped from $ on SO total at ATS.tsx:937 while their qty
      // stayed in the On Order stat. The warning at line 325
      // ("are still counted in the On Order total") documented the
      // intent; this matches it.
      sos.push({ sku, date, qty, orderNumber, customerName, unitPrice, totalPrice, store: soStore });
    }
  }

  // ── Build warnings ────────────────────────────────────────────────────────
  const warnings = [];

  const foundCategoryCol = columnNames.inventory.find(h => CATEGORY_COLS.includes(h));
  if (!foundCategoryCol) {
    const catLike = columnNames.inventory.filter(h => /categor|group|class|dept|division/i.test(h));
    warnings.push({
      severity: "warn",
      field: "Category Column",
      affected: 0,
      total: 0,
      message: `No recognized category column found in the inventory file. The Category filter will be empty. ` +
        (catLike.length
          ? `Possible match(es): ${catLike.map(h => `"${h}"`).join(", ")} — let the developer know which one to use.`
          : `No category-like columns detected. See "Show detected column names" below for the full list.`),
    });
  }
  if (soNoDate > 0) warnings.push({ severity: "error", field: "Sales Order Cancel/Ship Date", affected: soNoDate, total: soTotal, message: `${soNoDate} of ${soTotal} sales order lines have no valid cancel or ship date. These orders will NOT move the ATS timeline (they are still counted in the On Order total).`, items: soNoDateItems });
  if (soNoOrderNum > 0) warnings.push({ severity: "warn", field: "Sales Order Number", affected: soNoOrderNum, total: soTotal, message: `${soNoOrderNum} of ${soTotal} sales order lines are missing an order number. Right-click details will show "—" for those orders.` });
  if (soNoCustName > 0) warnings.push({ severity: "warn", field: "Customer Name", affected: soNoCustName, total: soTotal, message: `${soNoCustName} of ${soTotal} sales order lines are missing a customer name.` });
  if (soTotal > 0 && soNoUnitPrice === soTotal) {
    const priceLikeHeaders = columnNames.orders.filter(h => /price|cost|amount/i.test(h));
    warnings.push({ severity: "warn", field: "Order Unit Price", affected: soTotal, total: soTotal, message: `All ${soTotal} sales order lines have $0 for unit/total price — no recognized price column was found. $ on Order and margin will be 0. ` + (priceLikeHeaders.length ? `Detected price-like headers: ${priceLikeHeaders.map(h => `"${h}"`).join(", ")}.` : `No price-like headers were detected in the order file.`) });
  }
  if (poNoDate > 0) warnings.push({ severity: "error", field: "PO Expected Delivery Date", affected: poNoDate, total: poTotal, message: `${poNoDate} of ${poTotal} purchase order lines have no valid expected delivery date. These POs will NOT move the ATS timeline (they are still counted in the On PO total).`, items: poNoDateItems });
  if (poNoPoNum > 0) warnings.push({ severity: "warn", field: "PO Number", affected: poNoPoNum, total: poTotal, message: `${poNoPoNum} of ${poTotal} purchase order lines are missing a PO number.` });
  if (poNoVendor > 0) warnings.push({ severity: "warn", field: "Vendor Name", affected: poNoVendor, total: poTotal, message: `${poNoVendor} of ${poTotal} purchase order lines are missing a vendor name.` });

  // ── Active SKUs ───────────────────────────────────────────────────────────
  const poSkus = new Set(pos.map(p => p.sku));
  const soSkus = new Set(sos.map(s => s.sku));
  const skus = Object.values(skuMap)
    .filter(s => s.onHand > 0 || s.onOrder > 0 || s.onCommitted > 0 || poSkus.has(s.sku) || soSkus.has(s.sku));

  return { syncedAt: now, skus, pos, sos, warnings, columnNames };
}

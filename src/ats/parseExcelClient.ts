// Client-side Excel parser — mirrors api/parse-excel.js but runs in the browser.
// Accepts File objects, reads them as ArrayBuffer, and returns the same shape
// as the server API so useExcelUpload needs no structural changes.

import * as XLSX from "xlsx";
import type { ExcelData, UploadWarning } from "./types";

// ── Store detection (kept in sync with api/parse-excel.js) ──────────────────

function detectSkuStore(brandName: string): string {
  const bn = (brandName || "").toUpperCase();
  if (bn.includes("PSYCHO") || bn.includes("PTUNA") || bn.includes("P TUNA") || bn === "PT" || bn.startsWith("PT ")) return "PT";
  return "ROF";
}

function detectPoStore(poNumber: string, brandName: string): string {
  const pn = (poNumber || "").toUpperCase();
  const bn = (brandName || "").toUpperCase();
  if (pn.includes("ECOM")) return "ROF ECOM";
  if (bn.includes("PSYCHO") || bn.includes("PTUNA") || bn.includes("P TUNA") || bn === "PT" || bn.startsWith("PT ")) return "PT";
  return "ROF";
}

function detectSoStore(orderNumber: string, saleStore: string, brand: string): string {
  const on = (orderNumber || "").toUpperCase();
  const ss = (saleStore || "").toUpperCase();
  const br = (brand || "").toUpperCase();
  if (on.includes("ECOM") || ss.includes("ECOM")) return "ROF ECOM";
  if (br.includes("PSYCHO") || ss.includes("PSYCHO") || br.includes("PTUNA") || ss.includes("PTUNA") ||
      br.includes("P TUNA") || ss.includes("P TUNA") || br === "PT" || ss === "PT" || br.startsWith("PT ") || ss.startsWith("PT ")) return "PT";
  return "ROF";
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function str(v: unknown): string {
  return String(v ?? "").trim();
}

// Quantity-only — rounds to integer because qty fields are always whole
// units in this dataset. Do NOT use for money: it would lose cents.
function toNum(v: unknown): number {
  const n = parseFloat(String(v).replace(/[^0-9.-]/g, ""));
  return isNaN(n) ? 0 : Math.round(n);
}

// Money — preserves decimals. Used for "Total Sum of Amount" / "Unit
// Price" / "Unit Cost" cells. The previous code routed these through
// toNum() which rounded to whole dollars and silently dropped up to
// $0.99 per row from inventory totals.
function toMoney(v: unknown): number {
  const n = parseFloat(String(v).replace(/[^0-9.-]/g, ""));
  return isNaN(n) ? 0 : n;
}

function toIsoDate(v: unknown): string {
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
    if (p) return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
    return "";
  }
  const s = String(v).trim();
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const slashDot = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (slashDot) {
    const A = parseInt(slashDot[1], 10), B = parseInt(slashDot[2], 10), y = slashDot[3];
    let month: number, day: number;
    if (A > 12) { day = A; month = B; }
    else if (B > 12) { month = A; day = B; }
    else { month = A; day = B; }
    return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  const yFirst = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (yFirst) return `${yFirst[1]}-${yFirst[2].padStart(2, "0")}-${yFirst[3].padStart(2, "0")}`;
  const named = new Date(s);
  if (!isNaN(named.getTime())) {
    return `${named.getFullYear()}-${String(named.getMonth() + 1).padStart(2, "0")}-${String(named.getDate()).padStart(2, "0")}`;
  }
  return "";
}

function parseDate(v: unknown): string | null {
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

// Add N days to an ISO "YYYY-MM-DD" string, UTC-based (no timezone drift).
function addDaysIso(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (isNaN(d.getTime())) return iso;
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split("T")[0];
}

async function readSheet(file: File): Promise<Record<string, unknown>[]> {
  const buffer = await file.arrayBuffer();
  const wb = XLSX.read(buffer, { type: "array", cellDates: true });
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]], { defval: "" });
}

// ── Main parser ───────────────────────────────────────────────────────────────

export async function parseExcelFiles(
  inv: File,
  pur: File | null,
  ord: File
): Promise<ExcelData & { columnNames: { inventory: string[]; purchases: string[]; orders: string[] } }> {
  const [invRows, purRows, ordRows] = await Promise.all([
    readSheet(inv),
    pur ? readSheet(pur) : Promise.resolve([] as Record<string, unknown>[]),
    readSheet(ord),
  ]);

  const columnNames = {
    inventory: invRows[0] ? Object.keys(invRows[0]) : [],
    purchases: purRows[0] ? Object.keys(purRows[0]) : [],
    orders: ordRows[0] ? Object.keys(ordRows[0]) : [],
  };

  const now = new Date().toISOString();

  // ── 1. Inventory Snapshot → on-hand per SKU ──────────────────────────────
  const skuMap: Record<string, {
    sku: string; description: string; category?: string; gender?: string; store: string;
    onHand: number; onOrder: number; onCommitted: number;
    lastReceiptDate?: string; totalAmount?: number; avgCost?: number;
  }> = {};

  const CATEGORY_COLS = ["Catergory", "Category", "Item Category", "Item Group", "Product Group", "Product Category", "Category Code", "Category Name", "Group", "Class", "Item Class"];

  // Column-name flexibility — Xoro inventory exports use varying
  // capitalization / spacing for the base-part column. Match on the
  // first column whose value is non-empty.
  const BASE_PART_COLS = ["Base Part No", "BasePartNumber", "Base Part Number", "Base Part", "BasePart", "Base_Part_No", "BasePartNo"];
  const QTY_COLS = ["Total Sum of Qty", "Total Qty", "Qty On Hand", "OnHand", "On Hand", "Qty"];
  const AMOUNT_COLS = ["Total Sum of Amount Home Currency", "Amount Home Currency"];
  function pickCell(row: Record<string, unknown>, names: string[]): string {
    for (const n of names) {
      const v = str(row[n]);
      if (v) return v;
    }
    return "";
  }
  function pickNum(row: Record<string, unknown>, names: string[]): number {
    for (const n of names) {
      if (row[n] !== undefined && row[n] !== null && row[n] !== "") return toNum(row[n]);
    }
    return 0;
  }
  function pickMoney(row: Record<string, unknown>, names: string[]): number {
    for (const n of names) {
      if (row[n] !== undefined && row[n] !== null && row[n] !== "") return toMoney(row[n]);
    }
    return 0;
  }

  let invParsed = 0;
  for (const r of invRows) {
    const base = pickCell(r, BASE_PART_COLS);
    const color = str(r["Option 1 Value"]) || str(r["Option1Value"]);
    if (!base) continue;
    invParsed++;
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
    skuMap[key].onHand += pickNum(r, QTY_COLS);
    skuMap[key].totalAmount = (skuMap[key].totalAmount || 0) + pickMoney(r, AMOUNT_COLS);
  }
  console.warn(`[ATS parse] inventory: ${invRows.length} rows in file, ${invParsed} parsed (${invRows.length - invParsed} skipped — likely missing base-part column). Inventory column names: ${columnNames.inventory.join(", ")}`);

  // ── 2. Purchased Items Report → PO events ────────────────────────────────
  const pos: ExcelData["pos"] = [];
  let poTotal = 0, poNoDate = 0, poNoPoNum = 0, poNoVendor = 0;
  const poNoDateItems: { sku: string; qty: number; poNumber?: string; vendor?: string }[] = [];

  let purParsed = 0;
  for (const r of purRows) {
    const base = pickCell(r, BASE_PART_COLS);
    const color = str(r["Option 1 Value"]) || str(r["Option1Value"]);
    if (!base) continue;
    purParsed++;
    const sku = color ? `${base} - ${color}` : base;
    const qty = toNum(r["Total Sum of Qty Ordered"]);
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
      const date = parseDate(r["Expected Delivery Date"]);
      const poNumber = str(r["PO"] || r["PO #"] || r["PO Number"] || r["Purchase Order"] || r["PO No"]);
      const vendor = str(r["Vendor"] || r["Vendor Name"] || r["Supplier"] || r["Vendor/Supplier"]);
      if (!date) { poNoDate++; poNoDateItems.push({ sku, qty, poNumber: poNumber || undefined, vendor: vendor || undefined }); }
      if (!poNumber) poNoPoNum++;
      if (!vendor) poNoVendor++;
      const brandName = str(r["Brand Name"] || r["Brand"] || "");
      const store = detectPoStore(poNumber, brandName);
      const unitCost = parseFloat(String(r["Total Average of PO Unit Cost"] || r["Unit Cost"] || r["Cost"] || r["Unit Price"] || r["Price"] || 0).replace(/[^0-9.-]/g, "")) || 0;
      // Always push — see ats-parse.js for the rationale. Undated POs
      // count toward $ on PO total but stay out of time-period columns.
      // (PO Excel-upload path is mostly retired since POs come from
      // PO WIP nightly, but kept consistent here for any emergency
      // dev-console manual upload.)
      pos.push({ sku, date, qty, poNumber, vendor, store, unitCost });
    }
  }
  console.warn(`[ATS parse] purchases: ${purRows.length} rows in file, ${purParsed} parsed (${purRows.length - purParsed} skipped — likely missing base-part column). Purchase column names: ${columnNames.purchases.join(", ")}`);

  // ── 3. All Orders Report → SO events ─────────────────────────────────────
  const sos: ExcelData["sos"] = [];
  let soTotal = 0, soNoDate = 0, soNoOrderNum = 0, soNoCustName = 0, soNoUnitPrice = 0;
  const soNoDateItems: { sku: string; qty: number; orderNumber?: string; customerName?: string }[] = [];

  // Open-orders only — drop terminal-status lines (Shipped / Cancelled /
  // Void / Closed). They carry no open commitment, so counting them
  // overstates On Order and double-subtracts from the ATS projection
  // (on-hand already reflects the shipment). Keep Released + Partially
  // Shipped. Mirrors api/_lib/ats-parse.js. (When a "Qty Remaining to
  // Ship" column is present this is belt-and-suspenders; for All-Orders
  // CSVs without it, it's load-bearing.)
  const TERMINAL_SO_STATUSES = new Set([
    "shipped", "fully shipped", "cancelled", "canceled",
    "void", "voided", "closed", "complete", "completed",
  ]);
  let ordParsed = 0;
  for (const r of ordRows) {
    const base = pickCell(r, BASE_PART_COLS);
    const color = str(r["Option 1 Value"]) || str(r["Option1Value"]);
    if (!base) continue;
    const soStatus = (str(r["Order Line Status"]) || str(r["Order Status"]) || str(r["Status"]) || "").toLowerCase();
    if (TERMINAL_SO_STATUSES.has(soStatus)) continue;
    ordParsed++;
    const sku = color ? `${base} - ${color}` : base;
    // Qty priority: "Qty Remaining to Ship" first — that's the
    // open-commitment qty (drops to zero as lines ship), which is
    // what ATS's "On SO" math wants. Falls back to the older Xoro
    // export column names so previous Excel files still work.
    const qty = toNum(
      r["Qty Remaining to Ship"]
        || r["Total Sum of Qty Ordered"]
        || r["Qty Ordered"]
    );
    const soBrand = str(r["Brand"] || r["Brand Name"] || "");
    const saleStore = str(r["Sale Store"] || r["Store"] || r["Channel"] || "");
    const orderNumber = str(r["Order Number"] || r["Order #"] || r["SO Number"] || r["SO #"] || r["Sales Order"] || r["Order No"]);
    const soStore = detectSoStore(orderNumber, saleStore, soBrand);
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
      // SO timeline date = the Xoro "Date to be Cancelled". When blank,
      // derive cancel = ship date + 5 days (operator rule) so null-cancel
      // SOs still land on the timeline rather than mis-bucketing on the
      // raw ship date. Mirrors api/_lib/ats-parse.js.
      const cancelRaw = r["Date to be Cancelled"] || r["Cancel Date"];
      const shipRaw = r["Order Date to be Shipped"] || r["Ship Date"] || r["Requested Ship Date"];
      let date = parseDate(cancelRaw);
      if (!date && shipRaw) {
        const shipIso = parseDate(shipRaw);
        if (shipIso) date = addDaysIso(shipIso, 5);
      }
      const customerName = str(r["Customer Name"] || r["Customer"] || r["Bill To Name"] || r["Ship To Name"] || r["Client Name"]);
      // Customer's own PO number (the customer-side reference; distinct
      // from our SO number and our PO-to-vendor number). Optional —
      // shown in the right-click menu when present.
      const customerPo = str(
        r["Customer PO"] || r["Cust PO"] || r["Customer PO #"] || r["Customer PO Number"]
        || r["Customer PO Num"] || r["CustomerPONumber"] || r["CustomerPO"]
        || r["Customer Purchase Order"] || r["Cust PO #"]
      );
      const unitPrice = parseFloat(String(
        r["Unit Price"] || r["Unit Cost"] || r["Price"] ||
        r["Total Average of Unit Price"] || r["Total Sum of Unit Price"] ||
        r["Average of Unit Price"] || r["Sum of Unit Price"] ||
        r["Total Average of Unit Cost"] || r["Item Price"] || r["Item Cost"] || 0
      ).replace(/[^0-9.-]/g, "")) || 0;
      // Total-price priority: "Total Remaining to Ship" first — pairs
      // with "Qty Remaining to Ship" above and represents the dollar
      // value of the open commitment. Falls back to the older totals
      // and finally to unitPrice × qty if no totals column exists at
      // all (some report variants only emit unit price).
      const totalPrice = parseFloat(String(
        r["Total Remaining to Ship"] || r["Total Sum of Total Price"] ||
        r["Total Price"] || r["Extended Price"] ||
        r["Sum of Total Price"] || r["Total Sum of Amount"] ||
        r["Total Sum of Amount Home Currency"] || r["Amount"] || 0
      ).replace(/[^0-9.-]/g, "")) || (unitPrice * qty);
      if (!date) { soNoDate++; soNoDateItems.push({ sku, qty, orderNumber: orderNumber || undefined, customerName: customerName || undefined }); }
      if (!orderNumber) soNoOrderNum++;
      if (!customerName) soNoCustName++;
      if (unitPrice <= 0 && totalPrice <= 0) soNoUnitPrice++;
      // Always push — see ats-parse.js for the rationale. Undated SOs
      // count toward $ on SO total but stay out of time-period columns.
      sos.push({ sku, date, qty, orderNumber, customerName, unitPrice, totalPrice, store: soStore, customerPo: customerPo || undefined });
    }
  }
  console.warn(`[ATS parse] orders: ${ordRows.length} rows in file, ${ordParsed} parsed (${ordRows.length - ordParsed} skipped — likely missing base-part column). Order column names: ${columnNames.orders.join(", ")}`);

  // ── Build warnings ────────────────────────────────────────────────────────
  const warnings: UploadWarning[] = [];

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

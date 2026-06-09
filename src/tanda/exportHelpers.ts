import { type XoroPO, type Milestone, type LocalNote, itemQty, normalizeSize, sizeSort } from "../utils/tandaTypes";
import { extractPpk } from "../shared/prepack";
import { newWorkbook, addLogoBanner, downloadExcelWorkbook, argb, xfill, xthin, type ExcelJS } from "../shared/excelLogo";

// Mirror of the EXPLODE PPK toggle in poMatrixTab — same localStorage
// key. When ON (default), the matrix export's Total column shows
// unit-grain (qty × PPKn for prepack rows). When OFF, it shows pack
// counts (legacy behavior). Per-size cells stay in pack grain
// regardless, matching what the UI displays per size column.
function readExplodePpk(): boolean {
  try { return localStorage.getItem("tanda_matrix_explode_ppk") !== "false"; }
  catch { return true; }
}

export function printPODetail() {
  const content = document.getElementById("po-detail-content");
  if (!content) return;
  const win = window.open("", "_blank", "width=900,height=700");
  if (!win) return;
  win.document.write(`<!DOCTYPE html><html><head><title>PO Detail</title><style>
    body { font-family: 'DM Sans','Segoe UI',sans-serif; color: #1a1a1a; padding: 24px; font-size: 13px; }
    table { border-collapse: collapse; width: 100%; margin: 12px 0; }
    th, td { border: 1px solid #ccc; padding: 6px 10px; text-align: left; font-size: 12px; }
    th { background: #f0f0f0; font-weight: 700; text-transform: uppercase; font-size: 10px; letter-spacing: 0.5px; }
    h1 { font-size: 20px; margin: 0 0 4px; } h2 { font-size: 14px; color: #666; margin: 0 0 16px; }
    .section { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #888; font-weight: 600; margin: 16px 0 8px; }
    .info-grid { display: grid; grid-template-columns: repeat(5,1fr); gap: 8px; margin-bottom: 16px; }
    .info-cell { border: 1px solid #ddd; border-radius: 6px; padding: 8px; }
    .info-label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; color: #888; margin-bottom: 2px; }
    .info-value { font-size: 13px; font-weight: 600; }
    iframe { display: none; } button { display: none; } input { display: none; } textarea { display: none; } select { display: none; }
    @media print { body { padding: 0; } }
  </style></head><body>`);
  win.document.write(content.innerHTML);
  win.document.write("</body></html>");
  win.document.close();
  setTimeout(() => { win.print(); win.close(); }, 400);
}

export async function exportPOExcel(po: XoroPO, items: any[], mode: string, milestones: Record<string, Milestone[]>, notes: LocalNote[]) {
  const { wb, fileName } = buildPOWorkbook(po, items, mode, milestones, notes);
  await downloadExcelWorkbook(wb, fileName);
}

// Builds the ROF-branded ExcelJS workbook + filename for a PO export.
// Separated from the browser download so it can be unit-tested.
export function buildPOWorkbook(po: XoroPO, items: any[], mode: string, milestones: Record<string, Milestone[]>, notes: LocalNote[]): { wb: ExcelJS.Workbook; fileName: string } {
  const poNum = po.PoNumber ?? "PO";
  const totalVal = items.reduce((s: number, i: any) => s + itemQty(i) * (i.UnitPrice ?? 0), 0);
  const today = new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });
  let fileName = "";

  // ── Canonical "ATS look" palette ──
  const BRAND = "1F497D"; const WHITE = "FFFFFF"; const LIGHT_GRAY = "EEF3FA"; const GRY = "D0D8E4"; const BODY = "1A202C";
  const allBorder = { top: xthin(GRY), bottom: xthin(GRY), left: xthin(GRY), right: xthin(GRY) };
  const FMT_QTY = "#,##0";
  const FMT_USD = "$#,##0.00";

  const poInfoBlock: any[][] = [
    ["PO Number", po.PoNumber ?? "", "Vendor", po.VendorName ?? "", "Status", po.StatusName ?? ""],
    ["Order Date", po.DateOrder ?? "", "Expected Delivery", po.DateExpectedDelivery ?? "", "Currency", po.CurrencyCode ?? "USD"],
    ["Payment Terms", po.PaymentTermsName ?? "", "Ship Method", po.ShipMethodName ?? "", "Buyer", po.BuyerName ?? ""],
  ];
  if (po.Memo) poInfoBlock.push(["Memo", po.Memo, "", "", "", ""]);

  const wb = newWorkbook();

  // Build one styled, logo'd worksheet from a header+data table.
  function styleSheet(name: string, tableData: any[][], colWidths: number[], opts?: { totalRow?: boolean; dollarCols?: number[]; qtyCols?: number[] }) {
    const cols = Math.max(tableData[0]?.length || 2, 6);
    const ws = wb.addWorksheet(name);
    const start = addLogoBanner(wb, ws, { cols }); // rows 1-2 logo; report has its own title

    ws.mergeCells(start, 1, start, cols);
    const tc = ws.getCell(start, 1);
    tc.value = `${po.VendorName ?? ""} — ${poNum}`;
    tc.font = { bold: true, size: 14, color: { argb: argb(WHITE) }, name: "Calibri" };
    tc.fill = xfill(BRAND); tc.alignment = { horizontal: "left", vertical: "middle" }; tc.border = allBorder;
    ws.getRow(start).height = 28;

    const subR = start + 1;
    ws.mergeCells(subR, 1, subR, cols);
    const sc = ws.getCell(subR, 1);
    sc.value = `Generated: ${today}`;
    sc.font = { italic: true, size: 10, color: { argb: argb("BBD0EC") }, name: "Calibri" };
    sc.fill = xfill(BRAND); sc.alignment = { horizontal: "left", vertical: "middle" }; sc.border = allBorder;
    ws.getRow(subR).height = 18;

    let r = subR + 1;
    poInfoBlock.forEach((info, idx) => {
      const isEven = idx % 2 === 0;
      for (let c = 0; c < cols; c++) {
        const cell = ws.getCell(r, c + 1);
        cell.value = (info[c] ?? "") as ExcelJS.CellValue;
        cell.fill = xfill(isEven ? LIGHT_GRAY : WHITE);
        cell.border = allBorder;
        cell.alignment = { vertical: "middle" };
        cell.font = c % 2 === 0
          ? { bold: true, size: 11, color: { argb: argb(BRAND) }, name: "Calibri" }
          : { size: 11, color: { argb: argb(BODY) }, name: "Calibri" };
      }
      if (po.Memo && idx === poInfoBlock.length - 1) ws.mergeCells(r, 2, r, cols);
      r++;
    });

    for (let c = 0; c < cols; c++) { const cell = ws.getCell(r, c + 1); cell.fill = xfill(WHITE); cell.border = allBorder; }
    r++;

    const headerVals = tableData[0];
    for (let c = 0; c < cols; c++) {
      const cell = ws.getCell(r, c + 1);
      cell.value = (headerVals[c] ?? "") as ExcelJS.CellValue;
      cell.fill = xfill(BRAND);
      cell.font = { bold: true, size: 11, color: { argb: argb(WHITE) }, name: "Calibri" };
      cell.alignment = { horizontal: c === 0 ? "left" : "center", vertical: "middle" };
      cell.border = allBorder;
    }
    r++;

    const dataRows = tableData.slice(1);
    dataRows.forEach((dr, di) => {
      const isLast = !!opts?.totalRow && di === dataRows.length - 1;
      const isEven = di % 2 === 0;
      for (let c = 0; c < cols; c++) {
        const v = dr[c] ?? "";
        const cell = ws.getCell(r, c + 1);
        cell.value = v as ExcelJS.CellValue;
        cell.border = allBorder;
        const isNum = typeof v === "number";
        if (isLast) {
          cell.fill = xfill(BRAND);
          cell.font = { bold: true, size: 11, color: { argb: argb(WHITE) }, name: "Calibri" };
          cell.alignment = { horizontal: "center", vertical: "middle" };
          if (isNum) {
            if (opts?.dollarCols?.includes(c)) cell.numFmt = FMT_USD;
            else if (opts?.qtyCols?.includes(c)) cell.numFmt = FMT_QTY;
          }
        } else if (isNum) {
          cell.fill = xfill(isEven ? LIGHT_GRAY : WHITE);
          cell.font = { size: 11, color: { argb: argb(BODY) }, name: "Calibri" };
          cell.alignment = { horizontal: "right", vertical: "middle" };
          cell.numFmt = opts?.dollarCols?.includes(c) ? FMT_USD : FMT_QTY;
        } else {
          cell.fill = xfill(isEven ? LIGHT_GRAY : WHITE);
          cell.font = { size: 11, color: { argb: argb(BODY) }, name: "Calibri" };
          cell.alignment = { horizontal: c === 0 ? "left" : "center", vertical: "middle" };
        }
      }
      r++;
    });

    for (let c = 0; c < cols; c++) ws.getColumn(c + 1).width = colWidths[c] || 14;
    return ws;
  }

  if (mode === "po" || mode === "header" || mode === "matrix") {
    const parsed = items.map((item: any) => {
      const sku = item.ItemNumber ?? ""; const parts = sku.split("-");
      const color = parts.length === 4 ? `${parts[1]}-${parts[2]}` : (parts.length >= 2 ? parts[1] : "");
      const sz = normalizeSize(parts.length === 4 ? parts[3] : parts.length >= 3 ? parts.slice(2).join("-") : "");
      return { base: parts[0] || sku, color, size: sz, qty: itemQty(item), price: item.UnitPrice ?? 0, desc: item.Description ?? "" };
    });
    const sizeSet = new Set<string>();
    parsed.forEach((p: any) => { if (p.size) sizeSet.add(p.size); });
    const sizeOrder = [...sizeSet].sort(sizeSort);
    const mxRows: any[][] = [["Base Part", "Description", "Color", ...sizeOrder, "Total", "PO Cost", "Total Cost"]];
    const bases: string[] = [];
    const byBase: Record<string, { color: string; desc: string; sizes: Record<string, number>; price: number }[]> = {};
    parsed.forEach((p: any) => {
      if (!byBase[p.base]) { byBase[p.base] = []; bases.push(p.base); }
      let row = byBase[p.base].find((r: any) => r.color === p.color);
      if (!row) { row = { color: p.color, desc: p.desc, sizes: {}, price: p.price }; byBase[p.base].push(row); }
      row.sizes[p.size] = (row.sizes[p.size] || 0) + p.qty;
    });
    // Match the matrix tab's EXPLODE PPK toggle so the export shows
    // the same Total column the planner is looking at on screen.
    // When ON, multiply each size's qty by its PPKn factor (1 for
    // non-PPK sizes) before summing into the row Total + Grand Total.
    // PO Cost stays driven by the pack-grain total because UnitPrice
    // is per-pack — matches the on-screen behavior.
    const explode = readExplodePpk();
    const rowTotal = (sizes: Record<string, number>): number => Object.entries(sizes)
      .reduce((s, [sz, q]) => s + (q as number) * (explode ? (extractPpk(sz) ?? 1) : 1), 0);
    bases.forEach(base => { byBase[base].forEach(row => {
      const rtPacks = Object.values(row.sizes).reduce((s, q) => s + q, 0);
      const rt = rowTotal(row.sizes);
      mxRows.push([base, row.desc, row.color, ...sizeOrder.map(sz => row.sizes[sz] || 0), rt, row.price, rtPacks * row.price]);
    }); });
    const grandTotal = parsed.reduce((s: number, p: any) => s + p.qty * (explode ? (extractPpk(p.size) ?? 1) : 1), 0);
    mxRows.push(["", "", "GRAND TOTAL", ...sizeOrder.map(sz => parsed.filter((p: any) => p.size === sz).reduce((s: number, p: any) => s + p.qty, 0)), grandTotal, "", totalVal]);
    const nSz = sizeOrder.length;
    const mxDollar = [3 + nSz + 1, 3 + nSz + 2];
    const mxQty = [...sizeOrder.map((_: any, i: number) => 3 + i), 3 + nSz];
    const mxW = [18, 26, 14, ...sizeOrder.map(() => 10), 10, 12, 14];
    styleSheet("Matrix", mxRows, mxW, { totalRow: true, dollarCols: mxDollar, qtyCols: mxQty });
    const lineData: any[][] = [["SKU", "Description", "Qty", "Unit Price", "Total"]];
    items.forEach((item: any) => { lineData.push([item.ItemNumber ?? "", item.Description ?? "", itemQty(item), item.UnitPrice ?? 0, itemQty(item) * (item.UnitPrice ?? 0)]); });
    lineData.push(["TOTAL", "", items.reduce((s: number, i: any) => s + itemQty(i), 0), "", totalVal]);
    styleSheet("Line Items", lineData, [22, 32, 12, 14, 16], { totalRow: true, dollarCols: [3, 4], qtyCols: [2] });
    fileName = `${poNum}_PO_Details.xlsx`;

  } else if (mode === "milestones") {
    const poMs = milestones[poNum] || [];
    const rows: any[][] = [["Category", "Milestone", "Expected Date", "Status", "Status Date", "Notes"]];
    poMs.forEach((m: Milestone) => { rows.push([m.category, m.phase, m.expected_date ?? "", m.status, m.status_date ?? "", m.notes ?? ""]); });
    styleSheet("Milestones", rows, [20, 26, 14, 14, 14, 30]);
    fileName = `${poNum}_Milestones.xlsx`;

  } else if (mode === "notes") {
    const poNotes = notes.filter((n: any) => n.poNumber === poNum || n.po_number === poNum);
    const rows: any[][] = [["Date", "User", "Note"]];
    poNotes.forEach((n: any) => { rows.push([n.date ?? n.created_at ?? "", n.user ?? n.user_name ?? "", n.text ?? n.note ?? ""]); });
    styleSheet("Notes", rows, [22, 18, 52]);
    fileName = `${poNum}_Notes.xlsx`;

  } else if (mode === "all") {
    const lineData: any[][] = [["SKU", "Description", "Qty", "Unit Price", "Total"]];
    items.forEach((item: any) => { lineData.push([item.ItemNumber ?? "", item.Description ?? "", itemQty(item), item.UnitPrice ?? 0, itemQty(item) * (item.UnitPrice ?? 0)]); });
    lineData.push(["TOTAL", "", items.reduce((s: number, i: any) => s + itemQty(i), 0), "", totalVal]);
    styleSheet("Line Items", lineData, [22, 32, 12, 14, 16], { totalRow: true, dollarCols: [3, 4], qtyCols: [2] });
    const poMs = milestones[poNum] || [];
    if (poMs.length > 0) {
      const msRows: any[][] = [["Category", "Milestone", "Expected Date", "Status", "Status Date", "Notes"]];
      poMs.forEach((m: Milestone) => { msRows.push([m.category, m.phase, m.expected_date ?? "", m.status, m.status_date ?? "", m.notes ?? ""]); });
      styleSheet("Milestones", msRows, [20, 26, 14, 14, 14, 30]);
    }
    fileName = `${poNum}_All.xlsx`;
  } else {
    throw new Error("Excel export not available for this tab.");
  }

  return { wb, fileName };
}

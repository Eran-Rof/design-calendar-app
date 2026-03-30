import { type XoroPO, type Milestone, type LocalNote, itemQty, normalizeSize, sizeSort } from "../utils/tandaTypes";

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

export function exportPOExcel(po: XoroPO, items: any[], mode: string, milestones: Record<string, Milestone[]>, notes: LocalNote[]) {
  const XLSX = (window as any).XLSX;
  if (!XLSX) throw new Error("Excel library still loading — try again in a moment.");
  _exportPOExcelInner(XLSX, po, items, mode, milestones, notes);
}

function _exportPOExcelInner(XLSX: any, po: XoroPO, items: any[], mode: string, milestones: Record<string, Milestone[]>, notes: LocalNote[]) {
  const poNum = po.PoNumber ?? "PO";
  const totalVal = items.reduce((s: number, i: any) => s + itemQty(i) * (i.UnitPrice ?? 0), 0);
  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  // ── Style definitions ──
  const BRAND = "1E293B"; const BRAND_LT = "334155"; const WHITE = "FFFFFF"; const LIGHT_GRAY = "F1F5F9";
  const bdr = { style: "thin", color: { rgb: "CBD5E0" } };
  const border = { top: bdr, bottom: bdr, left: bdr, right: bdr };
  const fill = (rgb: string) => ({ patternType: "solid", fgColor: { rgb } });
  const titleStyle = { font: { bold: true, sz: 14, color: { rgb: WHITE } }, fill: fill(BRAND), alignment: { horizontal: "left", vertical: "center" }, border };
  const subtitleStyle = { font: { sz: 10, color: { rgb: "94A3B8" }, italic: true }, fill: fill(BRAND), alignment: { horizontal: "left" }, border };
  const colHeaderStyle = { font: { bold: true, sz: 11, color: { rgb: WHITE } }, fill: fill(BRAND_LT), alignment: { horizontal: "center", vertical: "center" }, border };
  const colHeaderLeftStyle = { font: { bold: true, sz: 11, color: { rgb: WHITE } }, fill: fill(BRAND_LT), alignment: { horizontal: "left", vertical: "center" }, border };
  const cellStyle = (isEven: boolean) => ({ font: { sz: 11, color: { rgb: "1A202C" } }, fill: fill(isEven ? LIGHT_GRAY : WHITE), border, alignment: { vertical: "center" } });
  const cellCenterStyle = (isEven: boolean) => ({ font: { sz: 11, color: { rgb: "1A202C" } }, fill: fill(isEven ? LIGHT_GRAY : WHITE), border, alignment: { horizontal: "center", vertical: "center" } });
  const cellRightStyle = (isEven: boolean) => ({ font: { sz: 11, color: { rgb: "1A202C" } }, fill: fill(isEven ? LIGHT_GRAY : WHITE), border, alignment: { horizontal: "right", vertical: "center" } });
  const totalCenterStyle = { font: { bold: true, sz: 11, color: { rgb: WHITE } }, fill: fill(BRAND), border, alignment: { horizontal: "center", vertical: "center" } };
  const labelStyle = (isEven: boolean) => ({ font: { bold: true, sz: 11, color: { rgb: BRAND_LT } }, fill: fill(isEven ? LIGHT_GRAY : WHITE), border, alignment: { vertical: "center" } });
  const valStyle = (isEven: boolean) => ({ font: { sz: 11, color: { rgb: "1A202C" } }, fill: fill(isEven ? LIGHT_GRAY : WHITE), border, alignment: { vertical: "center" } });

  const FMT_QTY = "#,##0";
  const FMT_USD = "$#,##0.00";

  const poInfoBlock: any[][] = [
    ["PO Number", po.PoNumber ?? "", "Vendor", po.VendorName ?? "", "Status", po.StatusName ?? ""],
    ["Order Date", po.DateOrder ?? "", "Expected Delivery", po.DateExpectedDelivery ?? "", "Currency", po.CurrencyCode ?? "USD"],
    ["Payment Terms", po.PaymentTermsName ?? "", "Ship Method", po.ShipMethodName ?? "", "Buyer", po.BuyerName ?? ""],
  ];
  if (po.Memo) poInfoBlock.push(["Memo", po.Memo, "", "", "", ""]);

  function styleSheet(tableData: any[][], colWidths: number[], opts?: { totalRow?: boolean; dollarCols?: number[]; qtyCols?: number[] }) {
    const cols = Math.max(tableData[0]?.length || 2, 6);
    const all: any[][] = [];
    const titleRow = [po.VendorName + " — " + poNum]; for (let i = 1; i < cols; i++) titleRow.push("");
    all.push(titleRow);
    const subRow = ["Generated: " + today]; for (let i = 1; i < cols; i++) subRow.push("");
    all.push(subRow);
    poInfoBlock.forEach(row => { const r = [...row]; while (r.length < cols) r.push(""); all.push(r); });
    const blankRow: string[] = []; for (let i = 0; i < cols; i++) blankRow.push(""); all.push(blankRow);
    const dataStart = all.length;
    tableData.forEach(row => { const r = [...row]; while (r.length < cols) r.push(""); all.push(r); });

    const sheet = XLSX.utils.aoa_to_sheet(all);
    sheet["!merges"] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: cols - 1 } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: cols - 1 } },
    ];
    if (po.Memo) {
      const memoRowIdx = 2 + poInfoBlock.length - 1;
      sheet["!merges"].push({ s: { r: memoRowIdx, c: 1 }, e: { r: memoRowIdx, c: cols - 1 } });
    }
    const finalWidths: number[] = [];
    for (let i = 0; i < cols; i++) finalWidths.push(colWidths[i] || 14);
    sheet["!cols"] = finalWidths.map((w: number) => ({ wch: w }));
    sheet["!rows"] = [{ hpt: 28 }, { hpt: 18 }];

    const range = XLSX.utils.decode_range(sheet["!ref"]);
    for (let r = range.s.r; r <= range.e.r; r++) {
      for (let c = range.s.c; c <= range.e.c; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        if (!sheet[addr]) sheet[addr] = { v: "", t: "s" };
        const cell = sheet[addr];

        if (r === 0) { cell.s = titleStyle; }
        else if (r === 1) { cell.s = subtitleStyle; }
        else if (r >= 2 && r < dataStart - 1) {
          const isEven = (r - 2) % 2 === 0;
          cell.s = (c % 2 === 0) ? labelStyle(isEven) : valStyle(isEven);
        }
        else if (r === dataStart - 1) { cell.s = { fill: fill(WHITE), border }; }
        else if (r === dataStart) {
          cell.s = c === 0 ? colHeaderLeftStyle : colHeaderStyle;
        }
        else if (opts?.totalRow && r === range.e.r) {
          cell.s = totalCenterStyle;
          if (opts?.dollarCols?.includes(c) && typeof cell.v === "number") { cell.z = FMT_USD; cell.t = "n"; }
          else if (opts?.qtyCols?.includes(c) && typeof cell.v === "number") { cell.z = FMT_QTY; cell.t = "n"; }
        }
        else {
          const isEven = (r - dataStart - 1) % 2 === 0;
          if (typeof cell.v === "number") {
            cell.s = cellRightStyle(isEven);
            if (opts?.dollarCols?.includes(c)) { cell.z = FMT_USD; cell.t = "n"; }
            else if (opts?.qtyCols?.includes(c)) { cell.z = FMT_QTY; cell.t = "n"; }
            else { cell.z = FMT_QTY; cell.t = "n"; }
          } else {
            cell.s = c === 0 ? cellStyle(isEven) : cellCenterStyle(isEven);
          }
        }
      }
    }
    return sheet;
  }

  const wb = XLSX.utils.book_new();

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
    bases.forEach(base => { byBase[base].forEach(row => {
      const rt = Object.values(row.sizes).reduce((s, q) => s + q, 0);
      mxRows.push([base, row.desc, row.color, ...sizeOrder.map(sz => row.sizes[sz] || 0), rt, row.price, rt * row.price]);
    }); });
    mxRows.push(["", "", "GRAND TOTAL", ...sizeOrder.map(sz => parsed.filter((p: any) => p.size === sz).reduce((s: number, p: any) => s + p.qty, 0)), items.reduce((s: number, i: any) => s + itemQty(i), 0), "", totalVal]);
    const nSz = sizeOrder.length;
    const mxDollar = [3 + nSz + 1, 3 + nSz + 2];
    const mxQty = [...sizeOrder.map((_: any, i: number) => 3 + i), 3 + nSz];
    const mxW = [18, 26, 14, ...sizeOrder.map(() => 10), 10, 12, 14];
    XLSX.utils.book_append_sheet(wb, styleSheet(mxRows, mxW, { totalRow: true, dollarCols: mxDollar, qtyCols: mxQty }), "Matrix");
    const lineData: any[][] = [["SKU", "Description", "Qty", "Unit Price", "Total"]];
    items.forEach((item: any) => { lineData.push([item.ItemNumber ?? "", item.Description ?? "", itemQty(item), item.UnitPrice ?? 0, itemQty(item) * (item.UnitPrice ?? 0)]); });
    lineData.push(["TOTAL", "", items.reduce((s: number, i: any) => s + itemQty(i), 0), "", totalVal]);
    XLSX.utils.book_append_sheet(wb, styleSheet(lineData, [22, 32, 12, 14, 16], { totalRow: true, dollarCols: [3, 4], qtyCols: [2] }), "Line Items");
    XLSX.writeFile(wb, `${poNum}_PO_Details.xlsx`);

  } else if (mode === "milestones") {
    const poMs = milestones[poNum] || [];
    const rows: any[][] = [["Category", "Milestone", "Expected Date", "Status", "Status Date", "Notes"]];
    poMs.forEach((m: Milestone) => { rows.push([m.category, m.phase, m.expected_date ?? "", m.status, m.status_date ?? "", m.notes ?? ""]); });
    XLSX.utils.book_append_sheet(wb, styleSheet(rows, [20, 26, 14, 14, 14, 30]), "Milestones");
    XLSX.writeFile(wb, `${poNum}_Milestones.xlsx`);

  } else if (mode === "notes") {
    const poNotes = notes.filter((n: any) => n.poNumber === poNum || n.po_number === poNum);
    const rows: any[][] = [["Date", "User", "Note"]];
    poNotes.forEach((n: any) => { rows.push([n.date ?? n.created_at ?? "", n.user ?? n.user_name ?? "", n.text ?? n.note ?? ""]); });
    XLSX.utils.book_append_sheet(wb, styleSheet(rows, [22, 18, 52]), "Notes");
    XLSX.writeFile(wb, `${poNum}_Notes.xlsx`);

  } else if (mode === "all") {
    const lineData: any[][] = [["SKU", "Description", "Qty", "Unit Price", "Total"]];
    items.forEach((item: any) => { lineData.push([item.ItemNumber ?? "", item.Description ?? "", itemQty(item), item.UnitPrice ?? 0, itemQty(item) * (item.UnitPrice ?? 0)]); });
    lineData.push(["TOTAL", "", items.reduce((s: number, i: any) => s + itemQty(i), 0), "", totalVal]);
    XLSX.utils.book_append_sheet(wb, styleSheet(lineData, [22, 32, 12, 14, 16], { totalRow: true, dollarCols: [3, 4], qtyCols: [2] }), "Line Items");
    const poMs = milestones[poNum] || [];
    if (poMs.length > 0) {
      const msRows: any[][] = [["Category", "Milestone", "Expected Date", "Status", "Status Date", "Notes"]];
      poMs.forEach((m: Milestone) => { msRows.push([m.category, m.phase, m.expected_date ?? "", m.status, m.status_date ?? "", m.notes ?? ""]); });
      XLSX.utils.book_append_sheet(wb, styleSheet(msRows, [20, 26, 14, 14, 14, 30]), "Milestones");
    }
    XLSX.writeFile(wb, `${poNum}_All.xlsx`);
  } else {
    throw new Error("Excel export not available for this tab.");
  }
}

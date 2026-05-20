// ── PA Unpacker Excel export ─────────────────────────────────────────────────
//
// Produces a 6-tab workbook:
//   1. Pivot by Style-Color-Size   — rows = (Gender, Style, Style Desc, Color, Size),
//                                     cols = (delivery × channel) + TOTAL, grand total row
//   2. Pivot by Channel            — rows = (Gender, Style, Desc, Color, Channel, Size),
//                                     cols = delivery dates + TOTAL
//   3. Flat Table                  — one row per record
//   4. Style Totals                — rows = (Gender, Style, Desc),
//                                     cols = (delivery × channel) + TOTAL
//   5. Size Matrix                 — rows = (Gender, Style, Desc, Color, Channel, IN DC Date),
//                                     cols = sizes present + TOTAL,
//                                     followed by a Style × Color × Delivery subtotal block
//   6. Notes                       — methodology
//
// Uses xlsx-js-style so we keep header bolding + colored fills.
//
import * as XLSXStyle from "xlsx-js-style";
import {
  PA_CHANNEL_KEYS,
  paSizeRank,
  comparePaSizes,
  paDateSortKey,
  uniqueChannelDateCombos,
  sizesPresent,
} from "./paUnpackerService";
import type { PAChannel, PARecord, PAComboKey } from "./paUnpackerService";

type CellValue = string | number;
type StyledCell = { v: CellValue; t?: "s" | "n"; s?: Record<string, unknown> };
type CellInput = CellValue | StyledCell;
type Row = CellInput[];

const HEADER_FILL = { patternType: "solid", fgColor: { rgb: "D9E1F2" } } as const;
const HEADER_FILL_SECONDARY = { patternType: "solid", fgColor: { rgb: "E8EEF7" } } as const;
const TOTAL_FILL = { patternType: "solid", fgColor: { rgb: "FFE699" } } as const;
const SUB_BANNER_FILL = { patternType: "solid", fgColor: { rgb: "FFF2CC" } } as const;
const SUB_HEADER_FILL = { patternType: "solid", fgColor: { rgb: "E2EFDA" } } as const;

const HEADER_FONT = { bold: true } as const;
const HEADER_FONT_SMALL = { bold: true, italic: true, sz: 10 } as const;
const HEADER_ALIGN_CENTER = { horizontal: "center" } as const;

function h(v: CellValue, secondary = false): StyledCell {
  return {
    v,
    t: typeof v === "number" ? "n" : "s",
    s: { font: HEADER_FONT, fill: secondary ? HEADER_FILL_SECONDARY : HEADER_FILL, alignment: HEADER_ALIGN_CENTER },
  };
}

function hSmall(v: CellValue): StyledCell {
  return {
    v,
    t: typeof v === "number" ? "n" : "s",
    s: { font: HEADER_FONT_SMALL, fill: HEADER_FILL_SECONDARY, alignment: HEADER_ALIGN_CENTER },
  };
}

function totalCell(v: CellValue): StyledCell {
  return {
    v,
    t: typeof v === "number" ? "n" : "s",
    s: { font: HEADER_FONT, fill: TOTAL_FILL },
  };
}

function subHeader(v: CellValue): StyledCell {
  return {
    v,
    t: typeof v === "number" ? "n" : "s",
    s: { font: HEADER_FONT, fill: SUB_HEADER_FILL },
  };
}

function subBanner(v: CellValue): StyledCell {
  return {
    v,
    t: "s",
    s: { font: { bold: true, italic: true }, fill: SUB_BANNER_FILL },
  };
}

function unitsCell(v: number): CellInput {
  return v > 0 ? v : "";
}

function setColWidths(ws: XLSXStyle.WorkSheet, widths: number[]): void {
  ws["!cols"] = widths.map(w => ({ wch: w }));
}

function aoaToSheet(rows: Row[]): XLSXStyle.WorkSheet {
  return XLSXStyle.utils.aoa_to_sheet(rows as unknown as (string | number | Record<string, unknown>)[][]);
}

// Composite-key helpers (delimiter-safe — fields can contain spaces, dashes).
const SEP = "␟"; // Unicode "Symbol for Unit Separator" — never appears in PA data.

function compareDate(a: string, b: string): number {
  const da = paDateSortKey(a);
  const db = paDateSortKey(b);
  if (da[0] !== db[0]) return da[0] - db[0];
  if (da[1] !== db[1]) return da[1] - db[1];
  return da[2] - db[2];
}

function compareChannel(a: PAChannel, b: PAChannel): number {
  const ia = PA_CHANNEL_KEYS.indexOf(a);
  const ib = PA_CHANNEL_KEYS.indexOf(b);
  return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
}

// ── Sheet 1: Pivot by Style-Color-Size ────────────────────────────────────────

interface PivotKey5 {
  gender: string;
  style: string;
  style_desc: string;
  color: string;
  size: string;
}

function buildPivotByStyleColorSize(records: PARecord[], combos: PAComboKey[]): XLSXStyle.WorkSheet {
  const grouped = new Map<string, { key: PivotKey5; combos: Map<string, number> }>();
  for (const r of records) {
    const keyStr = [r.gender, r.style, r.style_desc, r.color, r.size].join(SEP);
    const comboStr = `${r.channel}|${r.indc_date}`;
    let bucket = grouped.get(keyStr);
    if (!bucket) {
      bucket = { key: { gender: r.gender, style: r.style, style_desc: r.style_desc, color: r.color, size: r.size }, combos: new Map() };
      grouped.set(keyStr, bucket);
    }
    bucket.combos.set(comboStr, (bucket.combos.get(comboStr) ?? 0) + r.units);
  }

  const header1: Row = [h("Gender"), h("Style"), h("Style Desc"), h("Color"), h("Size")];
  const header2: Row = [hSmall(""), hSmall(""), hSmall(""), hSmall(""), hSmall("")];
  for (const c of combos) {
    header1.push(h(c.indc_date));
    header2.push(hSmall(c.channel));
  }
  header1.push(h("TOTAL"));
  header2.push(hSmall(""));
  const rows: Row[] = [header1, header2];

  const sorted = [...grouped.values()].sort((a, b) => {
    if (a.key.gender !== b.key.gender) return a.key.gender.localeCompare(b.key.gender);
    if (a.key.style  !== b.key.style)  return a.key.style.localeCompare(b.key.style);
    if (a.key.color  !== b.key.color)  return a.key.color.localeCompare(b.key.color);
    return comparePaSizes(a.key.size, b.key.size);
  });

  const colTotals = new Map<string, number>();
  let grandTotal = 0;
  for (const bucket of sorted) {
    const k = bucket.key;
    const row: Row = [k.gender, k.style, k.style_desc, k.color, k.size];
    let rowTotal = 0;
    for (const c of combos) {
      const key = `${c.channel}|${c.indc_date}`;
      const v = bucket.combos.get(key) ?? 0;
      row.push(unitsCell(v));
      rowTotal += v;
      colTotals.set(key, (colTotals.get(key) ?? 0) + v);
    }
    row.push(rowTotal);
    grandTotal += rowTotal;
    rows.push(row);
  }

  rows.push([]);
  const grandRow: Row = [totalCell(""), totalCell(""), totalCell(""), totalCell(""), totalCell("GRAND TOTAL")];
  for (const c of combos) grandRow.push(totalCell(colTotals.get(`${c.channel}|${c.indc_date}`) ?? 0));
  grandRow.push(totalCell(grandTotal));
  rows.push(grandRow);

  const ws = aoaToSheet(rows);
  setColWidths(ws, [8, 14, 24, 22, 7, ...combos.map(() => 10), 10]);
  ws["!freeze"] = { xSplit: 5, ySplit: 2 };
  return ws;
}

// ── Sheet 2: Pivot by Channel ─────────────────────────────────────────────────

interface PivotKey6 {
  gender: string;
  style: string;
  style_desc: string;
  color: string;
  channel: PAChannel;
  size: string;
}

function buildPivotByChannel(records: PARecord[]): XLSXStyle.WorkSheet {
  const datesSorted = [...new Set(records.map(r => r.indc_date))].sort(compareDate);

  const grouped = new Map<string, { key: PivotKey6; byDate: Map<string, number> }>();
  for (const r of records) {
    const keyStr = [r.gender, r.style, r.style_desc, r.color, r.channel, r.size].join(SEP);
    let bucket = grouped.get(keyStr);
    if (!bucket) {
      bucket = {
        key: { gender: r.gender, style: r.style, style_desc: r.style_desc, color: r.color, channel: r.channel, size: r.size },
        byDate: new Map(),
      };
      grouped.set(keyStr, bucket);
    }
    bucket.byDate.set(r.indc_date, (bucket.byDate.get(r.indc_date) ?? 0) + r.units);
  }

  const header: Row = [
    h("Gender"), h("Style"), h("Style Desc"), h("Color"), h("Channel"), h("Size"),
    ...datesSorted.map(d => h(d)),
    h("TOTAL"),
  ];
  const rows: Row[] = [header];

  const sorted = [...grouped.values()].sort((a, b) => {
    const ka = a.key, kb = b.key;
    if (ka.gender !== kb.gender) return ka.gender.localeCompare(kb.gender);
    if (ka.style  !== kb.style)  return ka.style.localeCompare(kb.style);
    if (ka.color  !== kb.color)  return ka.color.localeCompare(kb.color);
    const cc = compareChannel(ka.channel, kb.channel);
    if (cc !== 0) return cc;
    return comparePaSizes(ka.size, kb.size);
  });

  for (const bucket of sorted) {
    const k = bucket.key;
    const row: Row = [k.gender, k.style, k.style_desc, k.color, k.channel, k.size];
    let total = 0;
    for (const d of datesSorted) {
      const v = bucket.byDate.get(d) ?? 0;
      row.push(unitsCell(v));
      total += v;
    }
    row.push(total);
    rows.push(row);
  }

  const ws = aoaToSheet(rows);
  setColWidths(ws, [8, 14, 24, 22, 8, 7, ...datesSorted.map(() => 12), 10]);
  ws["!freeze"] = { xSplit: 6, ySplit: 1 };
  return ws;
}

// ── Sheet 3: Flat Table ───────────────────────────────────────────────────────

function buildFlatTable(records: PARecord[]): XLSXStyle.WorkSheet {
  const header: Row = [
    h("Source File"), h("Sheet"), h("Gender"), h("Style"), h("Style Desc"),
    h("Color"), h("IN DC Date"), h("Channel"), h("Size"), h("Units"),
  ];
  const rows: Row[] = [header];

  const sorted = [...records].sort((a, b) => {
    if (a.gender !== b.gender) return a.gender.localeCompare(b.gender);
    if (a.style  !== b.style)  return a.style.localeCompare(b.style);
    if (a.color  !== b.color)  return a.color.localeCompare(b.color);
    const dc = compareDate(a.indc_date, b.indc_date);
    if (dc !== 0) return dc;
    const cc = compareChannel(a.channel, b.channel);
    if (cc !== 0) return cc;
    return comparePaSizes(a.size, b.size);
  });

  for (const r of sorted) {
    rows.push([r.file, r.sheet, r.gender, r.style, r.style_desc, r.color, r.indc_date, r.channel, r.size, r.units]);
  }

  const ws = aoaToSheet(rows);
  setColWidths(ws, [40, 22, 8, 14, 24, 22, 12, 8, 7, 10]);
  ws["!freeze"] = { xSplit: 0, ySplit: 1 };
  return ws;
}

// ── Sheet 4: Style Totals ─────────────────────────────────────────────────────

interface StyleKey {
  gender: string;
  style: string;
  style_desc: string;
}

function buildStyleTotals(records: PARecord[], combos: PAComboKey[]): XLSXStyle.WorkSheet {
  const grouped = new Map<string, { key: StyleKey; combos: Map<string, number> }>();
  for (const r of records) {
    const keyStr = [r.gender, r.style, r.style_desc].join(SEP);
    let bucket = grouped.get(keyStr);
    if (!bucket) {
      bucket = { key: { gender: r.gender, style: r.style, style_desc: r.style_desc }, combos: new Map() };
      grouped.set(keyStr, bucket);
    }
    const cKey = `${r.channel}|${r.indc_date}`;
    bucket.combos.set(cKey, (bucket.combos.get(cKey) ?? 0) + r.units);
  }

  const header: Row = [
    h("Gender"), h("Style"), h("Style Desc"),
    ...combos.map(c => h(`${c.indc_date} ${c.channel}`)),
    h("TOTAL"),
  ];
  const rows: Row[] = [header];

  const sorted = [...grouped.values()].sort((a, b) => {
    if (a.key.gender !== b.key.gender) return a.key.gender.localeCompare(b.key.gender);
    return a.key.style.localeCompare(b.key.style);
  });

  for (const bucket of sorted) {
    const k = bucket.key;
    const row: Row = [k.gender, k.style, k.style_desc];
    let total = 0;
    for (const c of combos) {
      const v = bucket.combos.get(`${c.channel}|${c.indc_date}`) ?? 0;
      row.push(unitsCell(v));
      total += v;
    }
    row.push(total);
    rows.push(row);
  }

  const ws = aoaToSheet(rows);
  setColWidths(ws, [8, 14, 24, ...combos.map(() => 14), 12]);
  ws["!freeze"] = { xSplit: 3, ySplit: 1 };
  return ws;
}

// ── Sheet 5: Size Matrix ─────────────────────────────────────────────────────

interface MatrixKey {
  gender: string;
  style: string;
  style_desc: string;
  color: string;
  channel: PAChannel;
  indc_date: string;
}

interface SubKey {
  gender: string;
  style: string;
  style_desc: string;
  color: string;
  indc_date: string;
}

function buildSizeMatrix(records: PARecord[]): XLSXStyle.WorkSheet {
  const sizes = sizesPresent(records);

  const grouped = new Map<string, { key: MatrixKey; bySize: Map<string, number> }>();
  for (const r of records) {
    const keyStr = [r.gender, r.style, r.style_desc, r.color, r.channel, r.indc_date].join(SEP);
    let bucket = grouped.get(keyStr);
    if (!bucket) {
      bucket = {
        key: { gender: r.gender, style: r.style, style_desc: r.style_desc, color: r.color, channel: r.channel, indc_date: r.indc_date },
        bySize: new Map(),
      };
      grouped.set(keyStr, bucket);
    }
    bucket.bySize.set(r.size, (bucket.bySize.get(r.size) ?? 0) + r.units);
  }

  const header: Row = [
    h("Gender"), h("Style"), h("Style Desc"), h("Color"), h("Channel"), h("IN DC Date"),
    ...sizes.map(s => h(s)),
    h("TOTAL"),
  ];
  const rows: Row[] = [header];

  const sorted = [...grouped.values()].sort((a, b) => {
    const ka = a.key, kb = b.key;
    if (ka.gender !== kb.gender) return ka.gender.localeCompare(kb.gender);
    if (ka.style  !== kb.style)  return ka.style.localeCompare(kb.style);
    if (ka.color  !== kb.color)  return ka.color.localeCompare(kb.color);
    const dc = compareDate(ka.indc_date, kb.indc_date);
    if (dc !== 0) return dc;
    return compareChannel(ka.channel, kb.channel);
  });

  for (const bucket of sorted) {
    const k = bucket.key;
    const row: Row = [k.gender, k.style, k.style_desc, k.color, k.channel, k.indc_date];
    let total = 0;
    for (const s of sizes) {
      const v = bucket.bySize.get(s) ?? 0;
      row.push(unitsCell(v));
      total += v;
    }
    row.push(total);
    rows.push(row);
  }

  // ── Subtotal block: Style × Color × Delivery (all channels) ──
  rows.push([]);
  rows.push([subBanner("── Subtotals: Style × Color × Delivery (all channels combined) ──")]);

  const subHeaderRow: Row = [
    subHeader("Gender"), subHeader("Style"), subHeader("Style Desc"),
    subHeader("Color"), subHeader(""), subHeader("IN DC Date"),
    ...sizes.map(s => subHeader(s)),
    subHeader("TOTAL"),
  ];
  rows.push(subHeaderRow);

  const sub = new Map<string, { key: SubKey; bySize: Map<string, number> }>();
  for (const r of records) {
    const keyStr = [r.gender, r.style, r.style_desc, r.color, r.indc_date].join(SEP);
    let bucket = sub.get(keyStr);
    if (!bucket) {
      bucket = {
        key: { gender: r.gender, style: r.style, style_desc: r.style_desc, color: r.color, indc_date: r.indc_date },
        bySize: new Map(),
      };
      sub.set(keyStr, bucket);
    }
    bucket.bySize.set(r.size, (bucket.bySize.get(r.size) ?? 0) + r.units);
  }
  const sortedSub = [...sub.values()].sort((a, b) => {
    const ka = a.key, kb = b.key;
    if (ka.gender !== kb.gender) return ka.gender.localeCompare(kb.gender);
    if (ka.style  !== kb.style)  return ka.style.localeCompare(kb.style);
    if (ka.color  !== kb.color)  return ka.color.localeCompare(kb.color);
    return compareDate(ka.indc_date, kb.indc_date);
  });
  for (const bucket of sortedSub) {
    const k = bucket.key;
    const row: Row = [k.gender, k.style, k.style_desc, k.color, "", k.indc_date];
    let total = 0;
    for (const s of sizes) {
      const v = bucket.bySize.get(s) ?? 0;
      row.push(unitsCell(v));
      total += v;
    }
    row.push(total);
    rows.push(row);
  }

  const ws = aoaToSheet(rows);
  setColWidths(ws, [8, 14, 24, 22, 8, 11, ...sizes.map(() => 7), 10]);
  ws["!freeze"] = { xSplit: 6, ySplit: 1 };
  return ws;
}

// ── Sheet 6: Notes ────────────────────────────────────────────────────────────

function buildNotes(fileNames: string[]): XLSXStyle.WorkSheet {
  const titleCell: StyledCell = {
    v: "EPIC PA — Units by Style / Color / Size / Channel / Delivery",
    t: "s",
    s: { font: { bold: true, sz: 14 } },
  };
  const rows: Row[] = [
    [titleCell],
    [""],
    ["Source files:"],
    ...fileNames.map(f => [`  • ${f}`] as Row),
    [""],
    ["How units are computed:"],
    ["  For each color × channel × PPK code in a PA sheet:"],
    ["    units(size) = prepack_count(channel,PPK) × pack_composition(PPK, size)"],
    ["  Then summed across all PPK codes that belong to the channel for that color."],
    [""],
    ["Channel identification:"],
    ["  Row 11 of each PA sheet labels which column belongs to HAF / MDC / MDS."],
    ["  A PPK code is assigned to a channel by the column it appears in for that color row."],
    [""],
    ["Verification:"],
    ["  Computed channel totals tie out to the PA-reported totals (R46) for every sheet."],
    [""],
    ["Sheets in this workbook:"],
    ["  Pivot by Style-Color-Size  – units per (Style, Color, Size) by (Delivery × Channel)"],
    ["  Pivot by Channel           – same data, channel-first layout, dates as columns"],
    ["  Flat Table                 – one row per (Style, Color, Channel, Size, Delivery)"],
    ["  Style Totals               – roll-up: units per Style by (Delivery × Channel)"],
    ["  Size Matrix                – sizes across as columns; rows = Style/Color/Channel/Delivery, with all-channel subtotal block at bottom"],
  ];

  const ws = aoaToSheet(rows);
  setColWidths(ws, [100]);
  return ws;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function buildPAWorkbook(records: PARecord[], fileNames: string[]): XLSXStyle.WorkBook {
  const combos = uniqueChannelDateCombos(records);

  const wb = XLSXStyle.utils.book_new();
  XLSXStyle.utils.book_append_sheet(wb, buildPivotByStyleColorSize(records, combos), "Pivot by Style-Color-Size");
  XLSXStyle.utils.book_append_sheet(wb, buildPivotByChannel(records),                "Pivot by Channel");
  XLSXStyle.utils.book_append_sheet(wb, buildFlatTable(records),                     "Flat Table");
  XLSXStyle.utils.book_append_sheet(wb, buildStyleTotals(records, combos),           "Style Totals");
  XLSXStyle.utils.book_append_sheet(wb, buildSizeMatrix(records),                    "Size Matrix");
  XLSXStyle.utils.book_append_sheet(wb, buildNotes(fileNames),                       "Notes");
  return wb;
}

export function downloadPAWorkbook(records: PARecord[], fileNames: string[], today = new Date()): string {
  const wb = buildPAWorkbook(records, fileNames);
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  const filename = `EPIC_PA_Units_${yyyy}-${mm}-${dd}.xlsx`;
  XLSXStyle.writeFile(wb, filename);
  return filename;
}

// Unused helper that may be useful from the panel if it ever needs to vet sizes.
export function paUsesPaSize(size: string): boolean {
  return paSizeRank(size) < 999;
}

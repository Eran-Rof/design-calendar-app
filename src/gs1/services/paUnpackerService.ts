// ── PA (Macy's Pack Assortment) Unpacker ──────────────────────────────────────
//
// Parses one or more Macy's PA (.xls / .xlsx) workbooks and computes
// total units by Style / Color / Size / Channel (HAF, MDC, MDS) / Delivery
// (IN-DC date). Pure-functions, no DOM, no I/O — feed it an ArrayBuffer.
//
// File layout (per sheet — reverse-engineered from sample PA files):
//   R3  col 15  → master item / style number (e.g. "100213301GK")
//   R3  col 5   → gender ("GIRLS" / "BOYS")
//   R7  col 1   → IN DC date (e.g. "02/01/27") — "delivery"
//   R8  col 1   → style description
//   R11 cols    → channel labels at cols 7, 11, 15, …  ("HAF" / "MDC" / "MDS")
//   R12 col 47  → "SIZE" header
//   R12 col 49+ → PPK code headers (e.g. "DA", "DB", "UR", …)
//   R13..R~22 col 47   → size labels ("5", "6", "12M", "XS 5-6", …)
//   R13..R~22 cols 49+ → per-size units composition of each PPK pack
//   Color blocks (left side) — row where col 0 starts with "100" and col 1 is
//   the color name starts a new block; runs until next color row or row 46.
//   Within each color block, for every channel column (4-col block UNITS|PPK|count|A),
//   each row may list a PPK code in (channel_col+1) and a prepack count in (channel_col+2).
//   R46 col channel_col → reported channel total (used as ground-truth check).
//
// Formula:
//   units(style, color, size, channel, delivery)
//     = Σ over PPK codes appearing under that channel for that color:
//         prepack_count(color, channel, PPK) × pack_composition(PPK, size)
//
import * as XLSX from "xlsx";

export const PA_CHANNEL_KEYS = ["HAF", "MDC", "MDS"] as const;
export type PAChannel = (typeof PA_CHANNEL_KEYS)[number];

// Canonical size ordering — toddler first, then numeric kids, then set sizes.
export const PA_SIZE_ORDER: readonly string[] = [
  "12M", "18M", "2T", "3T", "4T", "5T",
  "5", "6", "7", "8", "10", "12", "14", "16", "18", "20",
  "XS 5-6", "S 7-8", "M 10-12", "L 14-16", "XL 18-20",
] as const;

const SIZE_RANK = new Map<string, number>(PA_SIZE_ORDER.map((s, i) => [s, i]));

export function paSizeRank(size: string): number {
  const r = SIZE_RANK.get(size);
  return r == null ? 999 : r;
}

export function comparePaSizes(a: string, b: string): number {
  const ra = paSizeRank(a);
  const rb = paSizeRank(b);
  if (ra !== rb) return ra - rb;
  return a.localeCompare(b);
}

// MM/DD/YY → comparable tuple for stable sort.
export function paDateSortKey(dt: string): [number, number, number] {
  const parts = dt.split("/");
  if (parts.length === 3) {
    const m = parseInt(parts[0], 10);
    const d = parseInt(parts[1], 10);
    const y = parseInt(parts[2], 10);
    if (!isNaN(m) && !isNaN(d) && !isNaN(y)) return [y, m, d];
  }
  return [9999, 99, 99];
}

export interface PARecord {
  file: string;
  sheet: string;
  style: string;        // master_item from R3:15
  style_desc: string;   // R8:1
  gender: string;       // R3:5  (GIRLS / BOYS)
  color: string;        // first cell of color block (col 1)
  channel: PAChannel;
  size: string;
  units: number;
  indc_date: string;    // R7:1, the delivery date string
}

export interface PASheetCheck {
  file: string;
  sheet: string;
  channel: PAChannel;
  computed: number;
  reported: number;
  ok: boolean;
}

export interface PAParseError {
  file: string;
  sheet: string | null;
  message: string;
}

export interface PAParsedFile {
  fileName: string;
  records: PARecord[];
  checks: PASheetCheck[];
  errors: PAParseError[];
}

type Cell = string | number | boolean | Date | null | undefined;
type AoA = Cell[][];

function trimVal(v: Cell): Cell {
  return typeof v === "string" ? v.trim() : v;
}

function asString(v: Cell): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") {
    return Number.isInteger(v) ? String(v) : String(v);
  }
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function isNum(v: Cell): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function getCell(aoa: AoA, r: number, c: number): Cell {
  const row = aoa[r];
  if (!row) return undefined;
  return row[c];
}

// Convert a date-like cell value into the "MM/DD/YY" string used in PA files.
function formatIndcDate(v: Cell): string {
  if (v instanceof Date) {
    const m = String(v.getUTCMonth() + 1).padStart(2, "0");
    const d = String(v.getUTCDate()).padStart(2, "0");
    const y = String(v.getUTCFullYear()).slice(-2);
    return `${m}/${d}/${y}`;
  }
  return asString(v);
}

// Format a size cell. Numeric sizes (5, 6, 12) come through as numbers in BIFF.
function formatSize(v: Cell): string {
  if (v == null) return "";
  if (typeof v === "number") {
    return Number.isInteger(v) ? String(v) : String(v);
  }
  if (typeof v === "string") return v.trim();
  return String(v);
}

// ── Per-sheet parser ──────────────────────────────────────────────────────────

interface ParsedSheetResult {
  records: PARecord[];
  checks: PASheetCheck[];
  skipped: boolean;
  skipReason?: string;
}

function parseSheet(aoa: AoA, fileName: string, sheetName: string): ParsedSheetResult {
  const nrows = aoa.length;
  if (nrows < 47) {
    return { records: [], checks: [], skipped: true, skipReason: "sheet too short (<47 rows)" };
  }
  const ncols = Math.max(...aoa.map(r => (r ? r.length : 0)));

  // --- header ---
  const master_item = asString(trimVal(getCell(aoa, 3, 15)));
  const style_desc  = asString(trimVal(getCell(aoa, 8, 1)));
  const indc_date   = formatIndcDate(trimVal(getCell(aoa, 7, 1)));
  const gender      = asString(trimVal(getCell(aoa, 3, 5)));

  if (!master_item || !master_item.toUpperCase().startsWith("100")) {
    return { records: [], checks: [], skipped: true, skipReason: `no master item at R3:15 (got "${master_item}")` };
  }

  // --- channel column positions from R11 ---
  const channel_cols = new Map<number, PAChannel>();
  for (let c = 0; c < ncols; c++) {
    const v = trimVal(getCell(aoa, 11, c));
    if (typeof v === "string") {
      const up = v.toUpperCase();
      if (up === "HAF" || up === "MDC" || up === "MDS") {
        channel_cols.set(c, up);
      }
    }
  }

  // --- size scale table ---
  const sizes_by_row = new Map<number, string>();
  for (let r = 13; r < Math.min(nrows, 35); r++) {
    const v = getCell(aoa, r, 47);
    if (v === "" || v == null || (typeof v === "string" && v.trim() === "")) break;
    const sizeLabel = formatSize(v);
    if (!sizeLabel) break;
    sizes_by_row.set(r, sizeLabel);
  }

  // PPK code columns from row 12, col 49+
  const ppk_cols = new Map<number, string>();
  for (let c = 49; c < ncols; c++) {
    const v = trimVal(getCell(aoa, 12, c));
    if (v === "" || v == null || (typeof v === "string" && v.trim() === "")) break;
    if (typeof v === "string") ppk_cols.set(c, v);
  }

  // Build per-PPK size composition: ppk_code -> Map<size, units_per_pack>
  const pack_composition = new Map<string, Map<string, number>>();
  for (const [c, code] of ppk_cols) {
    const comp = new Map<string, number>();
    for (const [r, size] of sizes_by_row) {
      const cell = getCell(aoa, r, c);
      if (isNum(cell) && cell !== 0) {
        comp.set(size, Math.trunc(cell));
      }
    }
    pack_composition.set(code, comp);
  }

  // --- color blocks ---
  // Block starts where col 0 begins with the master item (or "100"…) and col 1
  // is a non-empty color name. Block extends until next color row, capped at row 46.
  const color_starts: Array<{ row: number; color: string }> = [];
  const lastDataRow = Math.min(nrows, 45);
  for (let r = 13; r < lastDataRow; r++) {
    const c0 = trimVal(getCell(aoa, r, 0));
    const c1 = trimVal(getCell(aoa, r, 1));
    if (c0 == null || c1 == null) continue;
    const c0s = typeof c0 === "string" ? c0 : String(c0);
    const c1s = typeof c1 === "string" ? c1 : String(c1);
    if (!c0s || !c1s.trim()) continue;
    if (c0s.toUpperCase().startsWith("100")) {
      color_starts.push({ row: r, color: c1s.trim() });
    }
  }

  const blocks: Array<{ rStart: number; rEnd: number; color: string }> = [];
  for (let i = 0; i < color_starts.length; i++) {
    const { row, color } = color_starts[i];
    const rEnd = i + 1 < color_starts.length ? color_starts[i + 1].row : 46;
    blocks.push({ rStart: row, rEnd, color });
  }

  // --- accumulate units per (color, channel, size) ---
  const records: PARecord[] = [];
  for (const { rStart, rEnd, color } of blocks) {
    const agg = new Map<string, number>(); // "channel|size" -> units
    for (let r = rStart; r < rEnd; r++) {
      for (const [ch_col, ch_name] of channel_cols) {
        const ppk_code_raw = trimVal(getCell(aoa, r, ch_col + 1));
        const prepack_cell = getCell(aoa, r, ch_col + 2);
        if (typeof ppk_code_raw !== "string") continue;
        const ppk_code = ppk_code_raw.trim();
        if (!ppk_code) continue;
        if (!isNum(prepack_cell)) continue;
        const prepack_count = Math.trunc(prepack_cell);
        if (prepack_count === 0) continue;
        const comp = pack_composition.get(ppk_code);
        if (!comp) continue;
        for (const [size, units_per_pack] of comp) {
          const k = `${ch_name}|${size}`;
          agg.set(k, (agg.get(k) ?? 0) + prepack_count * units_per_pack);
        }
      }
    }
    for (const [k, units] of agg) {
      const [channel, size] = k.split("|") as [PAChannel, string];
      records.push({
        file: fileName,
        sheet: sheetName,
        style: master_item,
        style_desc,
        gender,
        color,
        channel,
        size,
        units,
        indc_date,
      });
    }
  }

  // --- verification check vs R46 ---
  const computedTotals = new Map<PAChannel, number>();
  for (const rec of records) {
    computedTotals.set(rec.channel, (computedTotals.get(rec.channel) ?? 0) + rec.units);
  }
  const reportedTotals = new Map<PAChannel, number>();
  for (const [c, name] of channel_cols) {
    const v = getCell(aoa, 46, c);
    if (isNum(v)) reportedTotals.set(name, Math.trunc(v));
  }

  const checks: PASheetCheck[] = [];
  const allChannels = new Set<PAChannel>([
    ...computedTotals.keys(),
    ...reportedTotals.keys(),
  ]);
  for (const ch of [...allChannels].sort()) {
    const computed = computedTotals.get(ch) ?? 0;
    const reported = reportedTotals.get(ch) ?? 0;
    checks.push({
      file: fileName,
      sheet: sheetName,
      channel: ch,
      computed,
      reported,
      ok: computed === reported,
    });
  }

  return { records, checks, skipped: false };
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface ParsePAOptions {
  fileName: string;
}

export function parsePAWorkbook(buf: ArrayBuffer | Uint8Array, opts: ParsePAOptions): PAParsedFile {
  const result: PAParsedFile = {
    fileName: opts.fileName,
    records: [],
    checks: [],
    errors: [],
  };
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buf, { type: "array", cellDates: true });
  } catch (err) {
    result.errors.push({
      file: opts.fileName,
      sheet: null,
      message: `Cannot read workbook: ${(err as Error).message}`,
    });
    return result;
  }

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    let aoa: AoA;
    try {
      aoa = XLSX.utils.sheet_to_json<Cell[]>(ws, {
        header: 1,
        raw: true,
        defval: "",
      }) as AoA;
    } catch (err) {
      result.errors.push({
        file: opts.fileName,
        sheet: sheetName,
        message: `sheet_to_json failed: ${(err as Error).message}`,
      });
      continue;
    }
    try {
      const out = parseSheet(aoa, opts.fileName, sheetName);
      if (out.skipped) {
        // Skipped sheets aren't errors — many PA workbooks have a summary tab.
        continue;
      }
      result.records.push(...out.records);
      result.checks.push(...out.checks);
    } catch (err) {
      result.errors.push({
        file: opts.fileName,
        sheet: sheetName,
        message: `Sheet parse error: ${(err as Error).message}`,
      });
    }
  }
  return result;
}

// ── Aggregations used by the panel + export ──────────────────────────────────

export interface PAComboKey {
  channel: PAChannel;
  indc_date: string;
}

export function uniqueChannelDateCombos(records: PARecord[]): PAComboKey[] {
  const seen = new Map<string, PAComboKey>();
  for (const r of records) {
    const k = `${r.indc_date}|${r.channel}`;
    if (!seen.has(k)) seen.set(k, { channel: r.channel, indc_date: r.indc_date });
  }
  return [...seen.values()].sort((a, b) => {
    const da = paDateSortKey(a.indc_date);
    const db = paDateSortKey(b.indc_date);
    if (da[0] !== db[0]) return da[0] - db[0];
    if (da[1] !== db[1]) return da[1] - db[1];
    if (da[2] !== db[2]) return da[2] - db[2];
    return PA_CHANNEL_KEYS.indexOf(a.channel) - PA_CHANNEL_KEYS.indexOf(b.channel);
  });
}

export function sizesPresent(records: PARecord[]): string[] {
  const set = new Set<string>();
  for (const r of records) set.add(r.size);
  return [...set].sort(comparePaSizes);
}

export function aggregateVerifyAllOk(parsed: PAParsedFile[]): {
  total: number;
  passed: number;
  mismatches: PASheetCheck[];
} {
  let total = 0;
  let passed = 0;
  const mismatches: PASheetCheck[] = [];
  for (const f of parsed) {
    for (const c of f.checks) {
      total += 1;
      if (c.ok) passed += 1;
      else mismatches.push(c);
    }
  }
  return { total, passed, mismatches };
}

export function flattenRecords(parsed: PAParsedFile[]): PARecord[] {
  const out: PARecord[] = [];
  for (const f of parsed) out.push(...f.records);
  return out;
}

export function summarizeRecords(records: PARecord[]): {
  recordCount: number;
  styleCount: number;
  comboCount: number;
} {
  const styles = new Set<string>();
  const combos = new Set<string>();
  for (const r of records) {
    styles.add(r.style);
    combos.add(`${r.indc_date}|${r.channel}`);
  }
  return { recordCount: records.length, styleCount: styles.size, comboCount: combos.size };
}

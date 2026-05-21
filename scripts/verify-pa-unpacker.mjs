// Node-runnable verification harness for the PA Unpacker parser.
// Loads the 4 sample PA files from ~/Downloads, runs the TS parser via
// dynamic import (transpiled by tsx) — but since we don't have tsx here,
// we reimplement the parser in-line as a one-off node script via XLSX.
//
// Strategy: import the compiled JS produced by `vite build` … nope, simpler:
// inline-import the source via tsx. If tsx isn't installed we fall back to
// porting the helpers locally — which we do here to avoid extra deps.
//
// Run:  node scripts/verify-pa-unpacker.mjs

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as XLSX from "xlsx";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const DOWNLOADS = path.join(os.homedir(), "Downloads");
const FILES = [
  "Q1 27 KID GIRL EPIC PA ROF.xls",
  "Q4 KID GIRL EPIC PA - Ring of Fire 5.1.xls",
  "KID EPIC BOYS Q1 Flows from Q4 ROF PA.xls",
  "TDLR EPIC BOYS Q1 Flows from Q4 ROF PA.xls",
];

// Use tsx-style on-demand transpilation by spawning a child node with tsx loader.
// Simpler: inline-compile the TS by using esbuild if available — but we don't
// want to add deps. The pragmatic path: import the source via `register/esbuild`
// hook installed by vitest. Since this is a one-shot verification script, we
// re-implement parseSheet's logic by porting it 1:1 from the TS file (we keep
// it in lockstep manually — if the TS changes, update this script).
//
// To avoid drift we instead import the TS source directly through Node's ESM
// loader by reading & evaluating it via a Function constructor. That's
// brittle. Best: use a small helper that invokes our TS via the project's
// node loader if any. Fallback path: port logic.
//
// IMPORTANT: We pick the simplest deterministic approach — re-export the
// service from a tiny JS shim by compiling on the fly with sucrase if
// available, else fall back to local reimplementation. For maximum
// portability, we keep a JS reimplementation here.

const PA_CHANNEL_KEYS = ["HAF", "MDC", "MDS"];

function asString(v) {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  if (v instanceof Date) return v.toISOString();
  return String(v);
}
function isNum(v) { return typeof v === "number" && Number.isFinite(v); }
function getCell(aoa, r, c) {
  const row = aoa[r];
  if (!row) return undefined;
  return row[c];
}
function trimVal(v) { return typeof v === "string" ? v.trim() : v; }
function formatIndcDate(v) {
  if (v instanceof Date) {
    const m = String(v.getUTCMonth() + 1).padStart(2, "0");
    const d = String(v.getUTCDate()).padStart(2, "0");
    const y = String(v.getUTCFullYear()).slice(-2);
    return `${m}/${d}/${y}`;
  }
  return asString(v);
}
function formatSize(v) {
  if (v == null) return "";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v);
  if (typeof v === "string") return v.trim();
  return String(v);
}

function parseSheet(aoa, fileName, sheetName) {
  const nrows = aoa.length;
  if (nrows < 47) return { records: [], checks: [], skipped: true };
  const ncols = Math.max(...aoa.map(r => (r ? r.length : 0)));

  const master_item = asString(trimVal(getCell(aoa, 3, 15)));
  const style_desc  = asString(trimVal(getCell(aoa, 8, 1)));
  const indc_date   = formatIndcDate(trimVal(getCell(aoa, 7, 1)));
  const gender      = asString(trimVal(getCell(aoa, 3, 5)));
  if (!master_item || !master_item.toUpperCase().startsWith("100")) {
    return { records: [], checks: [], skipped: true };
  }

  const channel_cols = new Map();
  for (let c = 0; c < ncols; c++) {
    const v = trimVal(getCell(aoa, 11, c));
    if (typeof v === "string") {
      const up = v.toUpperCase();
      if (up === "HAF" || up === "MDC" || up === "MDS") channel_cols.set(c, up);
    }
  }

  const sizes_by_row = new Map();
  for (let r = 13; r < Math.min(nrows, 35); r++) {
    const v = getCell(aoa, r, 47);
    if (v === "" || v == null || (typeof v === "string" && v.trim() === "")) break;
    const sizeLabel = formatSize(v);
    if (!sizeLabel) break;
    sizes_by_row.set(r, sizeLabel);
  }

  const ppk_cols = new Map();
  for (let c = 49; c < ncols; c++) {
    const v = trimVal(getCell(aoa, 12, c));
    if (v === "" || v == null || (typeof v === "string" && v.trim() === "")) break;
    if (typeof v === "string") ppk_cols.set(c, v);
  }

  const pack_composition = new Map();
  for (const [c, code] of ppk_cols) {
    const comp = new Map();
    for (const [r, size] of sizes_by_row) {
      const cell = getCell(aoa, r, c);
      if (isNum(cell) && cell !== 0) comp.set(size, Math.trunc(cell));
    }
    pack_composition.set(code, comp);
  }

  const color_starts = [];
  const lastDataRow = Math.min(nrows, 45);
  for (let r = 13; r < lastDataRow; r++) {
    const c0 = trimVal(getCell(aoa, r, 0));
    const c1 = trimVal(getCell(aoa, r, 1));
    if (c0 == null || c1 == null) continue;
    const c0s = typeof c0 === "string" ? c0 : String(c0);
    const c1s = typeof c1 === "string" ? c1 : String(c1);
    if (!c0s || !c1s.trim()) continue;
    if (c0s.toUpperCase().startsWith("100")) color_starts.push({ row: r, color: c1s.trim() });
  }

  const blocks = [];
  for (let i = 0; i < color_starts.length; i++) {
    const { row, color } = color_starts[i];
    const rEnd = i + 1 < color_starts.length ? color_starts[i + 1].row : 46;
    blocks.push({ rStart: row, rEnd, color });
  }

  const records = [];
  for (const { rStart, rEnd, color } of blocks) {
    const agg = new Map();
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
      const [channel, size] = k.split("|");
      records.push({
        file: fileName, sheet: sheetName, style: master_item,
        style_desc, gender, color, channel, size, units, indc_date,
      });
    }
  }

  const computedTotals = new Map();
  for (const rec of records) computedTotals.set(rec.channel, (computedTotals.get(rec.channel) ?? 0) + rec.units);
  const reportedTotals = new Map();
  for (const [c, name] of channel_cols) {
    const v = getCell(aoa, 46, c);
    if (isNum(v)) reportedTotals.set(name, Math.trunc(v));
  }
  const checks = [];
  const all = new Set([...computedTotals.keys(), ...reportedTotals.keys()]);
  for (const ch of [...all].sort()) {
    const computed = computedTotals.get(ch) ?? 0;
    const reported = reportedTotals.get(ch) ?? 0;
    checks.push({ file: fileName, sheet: sheetName, channel: ch, computed, reported, ok: computed === reported });
  }
  return { records, checks, skipped: false };
}

function parseFile(fileName) {
  const buf = fs.readFileSync(path.join(DOWNLOADS, fileName));
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
  const records = [];
  const checks = [];
  for (const sn of wb.SheetNames) {
    const ws = wb.Sheets[sn];
    if (!ws) continue;
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" });
    const out = parseSheet(aoa, fileName, sn);
    records.push(...out.records);
    checks.push(...out.checks);
  }
  return { records, checks };
}

function main() {
  let allRecords = [];
  let allChecks = [];
  for (const f of FILES) {
    const { records, checks } = parseFile(f);
    allRecords.push(...records);
    allChecks.push(...checks);
  }
  const styles = new Set(allRecords.map(r => r.style));
  const combos = new Set(allRecords.map(r => `${r.indc_date}|${r.channel}`));
  const mismatches = allChecks.filter(c => !c.ok);
  console.log(`Total records:        ${allRecords.length}`);
  console.log(`Distinct styles:      ${styles.size}`);
  console.log(`Distinct combos:      ${combos.size}`);
  console.log(`Verification rows:    ${allChecks.length}`);
  console.log(`Mismatches:           ${mismatches.length}`);
  if (mismatches.length > 0) {
    for (const m of mismatches) {
      console.log(`  ✗ ${m.file} / ${m.sheet} / ${m.channel}: computed=${m.computed} reported=${m.reported}`);
    }
    process.exit(1);
  }
  // Expected aggregate: 324 records, 16 styles, 10 combos, 0 mismatches.
  const fail = [];
  if (allRecords.length !== 324) fail.push(`records ${allRecords.length} != 324`);
  if (styles.size !== 16) fail.push(`styles ${styles.size} != 16`);
  if (combos.size !== 10) fail.push(`combos ${combos.size} != 10`);
  if (mismatches.length !== 0) fail.push(`mismatches ${mismatches.length} != 0`);
  if (fail.length > 0) {
    console.error("Expected aggregate mismatch:", fail.join(", "));
    process.exit(1);
  }
  console.log("\n✓ Expected aggregate matches: 324 records, 16 styles, 10 combos, 0 mismatches.");
}

main();

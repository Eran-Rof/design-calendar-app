// Web Worker that runs the heavy synchronous XLSX parse off the main
// thread. A 32k-row .xlsx takes >5s for XLSX.read() + sheet_to_json()
// on a typical laptop — long enough that Chrome shows the
// "Page Unresponsive — Wait / Exit page" dialog. Offloading both
// calls into a dedicated worker keeps the main thread free to paint
// the upload progress UI and respond to user input throughout.
//
// Wire-up:
//   parseWorkbook() in excelIngestService.ts spawns this worker via
//     new Worker(new URL("./excelParseWorker.ts", import.meta.url),
//                { type: "module" })
//   and transfers the file's ArrayBuffer in (no copy). Worker posts
//   { ok, sheetName, rows } or { ok: false, error } back.
//
// Vite handles the worker bundle automatically — XLSX is bundled
// once for the worker chunk and once for the main bundle (the main
// thread still uses XLSX.SSF.parse_date_code in toIsoDate). The
// duplication is intentional; sharing would require a more complex
// build setup for marginal savings on a feature that runs once per
// upload.

import * as XLSX from "xlsx";

interface WorkerOk {
  ok: true;
  sheetName: string;
  rows: Array<Record<string, unknown>>;
}

interface WorkerErr {
  ok: false;
  error: string;
}

export type WorkerResult = WorkerOk | WorkerErr;

self.onmessage = (e: MessageEvent<ArrayBuffer>) => {
  try {
    const wb = XLSX.read(e.data, { type: "array", cellDates: true });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) {
      const msg: WorkerErr = { ok: false, error: "The spreadsheet has no sheets." };
      (self as unknown as Worker).postMessage(msg);
      return;
    }
    const sheet = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
    const msg: WorkerOk = { ok: true, sheetName, rows };
    (self as unknown as Worker).postMessage(msg);
  } catch (err) {
    const msg: WorkerErr = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    (self as unknown as Worker).postMessage(msg);
  }
};

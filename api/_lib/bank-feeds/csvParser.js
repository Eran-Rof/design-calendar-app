// api/_lib/bank-feeds/csvParser.js
//
// CSV parsing + normalization for the bank-feeds CSV upload path (P6-3).
// Pure functions — no DB calls. Handler does the inserts.

import { createHash } from "node:crypto";

/**
 * Parse a CSV string into an array of row objects keyed by trimmed header.
 *
 * Permissive — handles:
 *   - quoted fields with embedded commas
 *   - escaped quotes ("")
 *   - CRLF or LF line endings
 *   - BOM at the start of the file
 *
 * NOT supported (deferred): tab-separated values, semicolon delimiters
 * (European banks). Operator must export as comma-separated.
 *
 * @param {string} csvText
 * @returns {{headers: string[], rows: Record<string,string>[]}}
 */
export function parseCsv(csvText) {
  if (typeof csvText !== "string") throw new Error("parseCsv: input must be a string");
  let text = csvText;
  // Strip BOM
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  // Normalize line endings
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const rows = [];
  const buf = [];
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { buf.push('"'); i++; }
        else { inQuotes = false; }
      } else {
        buf.push(c);
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        row.push(buf.join("")); buf.length = 0;
      } else if (c === "\n") {
        row.push(buf.join("")); buf.length = 0;
        rows.push(row); row = [];
      } else {
        buf.push(c);
      }
    }
  }
  // Trailing field / row
  if (buf.length > 0 || row.length > 0) {
    row.push(buf.join("")); rows.push(row);
  }
  // Drop trailing empty rows from a final newline
  while (rows.length > 0 && rows[rows.length - 1].every((f) => f === "")) rows.pop();

  if (rows.length === 0) return { headers: [], rows: [] };
  const headers = rows[0].map((h) => h.trim());
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = (r[j] ?? "").trim();
    }
    out.push(obj);
  }
  return { headers, rows: out };
}

/**
 * Common bank-export column-name aliases. Used by inferColumnMapping()
 * when the operator hasn't supplied an explicit mapping.
 */
const ALIASES = {
  date: ["Date", "Transaction Date", "Posted Date", "Posting Date", "Effective Date", "Trans Date"],
  amount: ["Amount", "Transaction Amount", "Net Amount"],
  debit: ["Debit", "Debits", "Withdrawal", "Withdrawals", "Money Out"],
  credit: ["Credit", "Credits", "Deposit", "Deposits", "Money In"],
  description: [
    "Description", "Memo", "Details", "Transaction Details",
    "Merchant Name", "Payee", "Narrative", "Reference",
  ],
};

/**
 * Inspect headers and guess which columns map to date / amount / debit /
 * credit / description. Returns the same shape as bank_accounts.csv_column_mapping.
 *
 * Strategy: case-insensitive exact match on each alias; first hit wins.
 * Operator can override the inferred mapping via the upload UI.
 *
 * @param {string[]} headers
 * @returns {Object}  e.g. {date: "Date", amount: "Amount", description: "Description"}
 */
export function inferColumnMapping(headers) {
  if (!Array.isArray(headers)) return {};
  const lc = new Map(headers.map((h) => [h.toLowerCase(), h]));
  const out = {};
  for (const [key, aliases] of Object.entries(ALIASES)) {
    for (const a of aliases) {
      const hit = lc.get(a.toLowerCase());
      if (hit) { out[key] = hit; break; }
    }
  }
  return out;
}

/**
 * Apply a column mapping to a parsed-row object and produce the
 * normalized `bank_transactions` row shape (without entity_id/bank_account_id;
 * the handler attaches those before insert).
 *
 * Amount conventions:
 *   - If mapping.amount is set, use that column. Sign convention: positive =
 *     deposit, negative = withdrawal. (Banks vary; operator picks the
 *     amount-side convention via mapping.amount_sign: 'as_is' | 'invert'.)
 *   - If mapping.debit + mapping.credit are set, compute amount =
 *     credit - debit. (Two-column format common in QuickBooks-style exports.)
 *
 * Date convention: ISO YYYY-MM-DD strongly preferred. Falls back to Date.parse
 * with a best-effort YYYY-MM-DD output. Rejects rows that don't parse.
 *
 * @param {Object} parsedRow      row from parseCsv
 * @param {Object} mapping        { date, amount, debit, credit, description, amount_sign? }
 * @returns {{ row: Object } | { error: string }}
 */
export function normalizeRow(parsedRow, mapping) {
  if (!parsedRow || typeof parsedRow !== "object") {
    return { error: "row must be an object" };
  }
  if (!mapping || typeof mapping !== "object") {
    return { error: "mapping must be an object" };
  }

  // Date
  const dateRaw = mapping.date ? parsedRow[mapping.date] : "";
  if (!dateRaw) return { error: "missing date column" };
  const isoDate = coerceDate(dateRaw);
  if (!isoDate) return { error: `unparseable date: ${dateRaw}` };

  // Amount
  let amountCents;
  if (mapping.amount) {
    const raw = parsedRow[mapping.amount];
    if (raw == null || raw === "") return { error: "missing amount value" };
    const parsed = parseMoney(raw);
    if (parsed === null) return { error: `unparseable amount: ${raw}` };
    amountCents = mapping.amount_sign === "invert" ? -parsed : parsed;
  } else if (mapping.debit || mapping.credit) {
    const debitStr  = mapping.debit  ? parsedRow[mapping.debit]  : "";
    const creditStr = mapping.credit ? parsedRow[mapping.credit] : "";
    const debit  = debitStr  ? parseMoney(debitStr)  : 0;
    const credit = creditStr ? parseMoney(creditStr) : 0;
    if (debit === null || credit === null) return { error: "unparseable debit/credit" };
    amountCents = credit - debit;
  } else {
    return { error: "mapping needs either 'amount' or both 'debit'+'credit' columns" };
  }

  const description = mapping.description ? parsedRow[mapping.description] : null;

  // external_txn_id = stable hash of (date|amount|description) for dedup
  // across re-uploads of the same CSV (operator may upload twice by mistake).
  const externalTxnId = createHash("sha256")
    .update(`${isoDate}|${amountCents}|${description || ""}`)
    .digest("hex")
    .slice(0, 32);

  return {
    row: {
      source: "csv_upload",
      external_txn_id: externalTxnId,
      posted_date: isoDate,
      amount_cents: amountCents,
      description: description || null,
      pending: false,
      raw_payload: parsedRow,
    },
  };
}

/**
 * Normalize a date string to YYYY-MM-DD. Accepts:
 *   YYYY-MM-DD, MM/DD/YYYY, M/D/YYYY, YYYY/MM/DD
 *   anything that Date.parse() understands.
 * Returns null on failure.
 */
export function coerceDate(s) {
  if (!s || typeof s !== "string") return null;
  const trimmed = s.trim();
  // Exact ISO already
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  // US-style MM/DD/YYYY
  const m = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    let yr = parseInt(m[3], 10);
    if (yr < 100) yr += 2000;
    const mo = parseInt(m[1], 10);
    const da = parseInt(m[2], 10);
    if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
    return `${yr}-${String(mo).padStart(2, "0")}-${String(da).padStart(2, "0")}`;
  }
  // Date.parse fallback
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return null;
  const yr = d.getUTCFullYear();
  const mo = d.getUTCMonth() + 1;
  const da = d.getUTCDate();
  return `${yr}-${String(mo).padStart(2, "0")}-${String(da).padStart(2, "0")}`;
}

/**
 * Parse a money string into integer cents. Accepts $ sign + thousands
 * separators + parens-negative (e.g. "(123.45)" = -123.45).
 * Returns null on failure.
 */
export function parseMoney(s) {
  if (s == null) return null;
  let str = String(s).trim();
  if (str === "") return null;
  let neg = false;
  if (/^\(.*\)$/.test(str)) {
    neg = true;
    str = str.slice(1, -1);
  }
  // Strip $ and thousands separators; keep optional leading minus
  str = str.replace(/[$£€¥,\s]/g, "");
  if (str.startsWith("-")) { neg = !neg; str = str.slice(1); }
  if (!/^\d+(\.\d+)?$/.test(str)) return null;
  const [whole, frac = ""] = str.split(".");
  const padded = (frac + "00").slice(0, 2);
  const cents = (parseInt(whole, 10) * 100) + parseInt(padded || "0", 10);
  return neg ? -cents : cents;
}

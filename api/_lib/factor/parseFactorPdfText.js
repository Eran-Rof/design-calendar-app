// api/_lib/factor/parseFactorPdfText.js
//
// Factor Module Phase 1 — pure text parsers for the two Rosenthal Capital
// Group monthly PDFs. The importer (scripts/import-factor-pdfs.mjs) extracts
// text with pypdf (one text-run per line) and feeds it here; keeping the
// parsing pure lets vitest cover it with fixture snippets (no PDFs, no
// python) — see __tests__/parseFactorPdfText.test.js.
//
// Report shapes (pypdf emits `LABEL\nVALUE` pairs / one token per line):
//
//   CLIENT RECAP — "FOR THE MONTH OF JULY, 2025", then label/value pairs.
//     Ambiguous labels (ADVANCES, ACCRUED FEES/OTHER TRANSFERS) repeat in the
//     per-facility loan blocks; the unambiguous copies live on the NET DUE
//     CLIENT page (after "PRIOR PERIOD NET DUE CLIENT") and under the
//     "(FACILITY)" suffix — we anchor there.
//
//   FACTORED AR DETAILED — "As Of 7/31/2025", then per-customer blocks:
//     "BEALL`S INC. ( 111987 )" header → address/aging junk → invoice rows:
//     ItemNum, Type(I|O), [PO Num], ItemDate, [DueDate], [Terms], Gross,
//     Balance. Some pages GLUE the type onto the item num ("ROF-I014115I");
//     OAP deduction rows ("OAP0024700269", type O) carry no PO/due/terms and
//     negative amounts. Footer: "--- TOTALS ---" then the 11 aging columns
//     (Net OAR first, Total OAR second).

const MONEY_RE = /^-?\d{1,3}(?:,\d{3})*\.\d{2}$/;
const DATE_RE = /^\d{1,2}\/\d{1,2}\/\d{4}$/;
// Terms tokens vary by vintage: "0000060", "Net 30", "Net 10+75 E" (2026
// files). In the row grammar the terms slot sits between the dates and the
// two money columns, so "anything that isn't a money value" is the reliable
// discriminator (OAP rows skip the slot entirely — the next token IS money).
const TERMS_RE = /^(?!-?\d{1,3}(?:,\d{3})*\.\d{2}$).+$/;
// Item rows: "ROF-I012063" / "PT-I013802", OAP deductions "OAP0024700269",
// plus later vintages: "SR-11484110" / lowercase "pt-i147867" (type O) and
// DASHLESS credit-memo refs "PTI015496" (6/2026). Optional glued trailing
// UPPERCASE I/O ("ROF-I014115I") — the glue marker stays case-strict so it
// never eats a legit trailing character.
const ITEM_RE = /^(?:([A-Za-z]{2,5}-?[A-Za-z]?\d{3,})|(OAP\d{5,}))([IO])?$/;

const MONTHS = {
  JANUARY: 1, FEBRUARY: 2, MARCH: 3, APRIL: 4, MAY: 5, JUNE: 6,
  JULY: 7, AUGUST: 8, SEPTEMBER: 9, OCTOBER: 10, NOVEMBER: 11, DECEMBER: 12,
};

/** "1,234.56" | "-17,960.00" → integer cents. Throws on non-money input. */
export function moneyToCents(s) {
  const t = String(s ?? "").trim();
  if (!MONEY_RE.test(t)) throw new Error(`Not a money value: "${s}"`);
  const neg = t.startsWith("-");
  const [whole, frac] = t.replace(/^-/, "").replace(/,/g, "").split(".");
  const cents = Number(whole) * 100 + Number(frac);
  return neg ? -cents : cents;
}

/** "7/31/2025" → "2025-07-31". Throws on non-date input. */
export function usDateToISO(s) {
  const t = String(s ?? "").trim();
  if (!DATE_RE.test(t)) throw new Error(`Not a M/D/YYYY date: "${s}"`);
  const [m, d, y] = t.split("/").map(Number);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function toLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^=== PAGE \d+ ===$/.test(l));
}

/** Value (cents) on the line following the `occurrence`-th exact `label` line at/after `fromIdx`. */
function valueAfterLabel(lines, label, { occurrence = 1, fromIdx = 0 } = {}) {
  let seen = 0;
  for (let i = fromIdx; i < lines.length - 1; i++) {
    if (lines[i] === label) {
      seen += 1;
      if (seen === occurrence) return moneyToCents(lines[i + 1]);
    }
  }
  throw new Error(`CLIENT RECAP: label not found: "${label}" (occurrence ${occurrence})`);
}

/** Sum of the values following EVERY exact `label` line (per-facility repeats). */
function sumAfterEveryLabel(lines, label) {
  let sum = 0;
  let seen = false;
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i] === label) { seen = true; sum += moneyToCents(lines[i + 1]); }
  }
  if (!seen) throw new Error(`CLIENT RECAP: label not found: "${label}"`);
  return sum;
}

/**
 * Parse a CLIENT RECAP statement text → factor_statements row shape.
 * All *_cents integers; cash_collections and commissions stored positive.
 */
export function parseClientRecap(text) {
  const lines = toLines(text);

  const monthLine = lines.find((l) => /^FOR THE MONTH OF [A-Z]+, \d{4}$/.test(l));
  if (!monthLine) throw new Error("CLIENT RECAP: month header not found");
  const [, monthName, year] = monthLine.match(/^FOR THE MONTH OF ([A-Z]+), (\d{4})$/);
  const month = MONTHS[monthName];
  if (!month) throw new Error(`CLIENT RECAP: unknown month "${monthName}"`);
  const statement_month = `${year}-${String(month).padStart(2, "0")}-01`;

  // The NET DUE CLIENT page anchors the unambiguous ADVANCES copy (the label
  // also appears in every per-facility loan block with per-facility values).
  const netDueIdx = lines.indexOf("PRIOR PERIOD NET DUE CLIENT");
  if (netDueIdx === -1) throw new Error("CLIENT RECAP: NET DUE CLIENT section not found");

  const netDueLines = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (/^NET DUE CLIENT \(FACTOR\) AS OF /.test(lines[i])) netDueLines.push(moneyToCents(lines[i + 1]));
  }
  if (netDueLines.length < 2) throw new Error("CLIENT RECAP: expected 2 NET DUE CLIENT AS OF lines");

  const row = {
    statement_month,
    factor_name: "Rosenthal",
    net_sales_cents: valueAfterLabel(lines, "NET SALES"),
    cash_collections_cents: Math.abs(valueAfterLabel(lines, "CASH COLLECTIONS")),
    chargebacks_net_cents: valueAfterLabel(lines, "CHARGEBACKS(-)/CREDITBACKS/RECOVERIES"),
    commissions_cents: Math.abs(valueAfterLabel(lines, "COMMISSIONS")),
    interest_cents: valueAfterLabel(lines, "TOTAL INTEREST"),
    fees_other_cents: valueAfterLabel(lines, "ACCRUED FEES/OTHER TRANSFERS (FACILITY)"),
    advances_cents: valueAfterLabel(lines, "ADVANCES", { fromIdx: netDueIdx }),
    beginning_net_oar_cents: valueAfterLabel(lines, "BEGINNING NET OAR BALANCE"),
    ending_net_oar_cents: valueAfterLabel(lines, "ENDING NET OAR"),
    net_due_client_beginning_cents: netDueLines[0],
    net_due_client_ending_cents: netDueLines[netDueLines.length - 1],
    total_loans_cents: valueAfterLabel(lines, "TOTAL LOANS"),
    // ── Phase 2 cost decomposition ─────────────────────────────────────────
    // fees_other ("ACCRUED FEES/OTHER TRANSFERS (FACILITY)") is NOT pure fee
    // cost: per facility block it is ACCRUED INTEREST (the PRIOR month's
    // TOTAL INTEREST now charged to the loan) + FEES + OTHER. The factoring-
    // cost JE must therefore take FEES+OTHER only (interest is expensed in
    // its accrual month via TOTAL INTEREST + PRIOR MONTH INT. ADJ.).
    prior_month_interest_adj_cents: valueAfterLabel(lines, "PRIOR MONTH INT. ADJ."),
    facility_accrued_interest_cents: sumAfterEveryLabel(lines, "ACCRUED INTEREST"),
    facility_fees_cents: sumAfterEveryLabel(lines, "FEES"),
    facility_other_cents: sumAfterEveryLabel(lines, "OTHER"),
  };

  // Decomposition sanity: the (FACILITY) total must equal its parts. One
  // caveat: the page-3 DEBITS/CREDITS table encodes sign by COLUMN POSITION,
  // which text extraction loses — a net-credit month (e.g. Oct-24) prints the
  // total unsigned while the facility components (genuinely signed on page 1)
  // sum negative. When |parts| == |total| but the sign flips, the components
  // are the truth: override the total.
  const feesParts =
    row.facility_accrued_interest_cents + row.facility_fees_cents + row.facility_other_cents;
  if (feesParts !== row.fees_other_cents) {
    if (feesParts === -row.fees_other_cents) {
      row.fees_other_cents = feesParts;
    } else {
      throw new Error(
        `CLIENT RECAP ${statement_month}: fees/other decomposition mismatch (parts ${feesParts} vs total ${row.fees_other_cents})`,
      );
    }
  }

  // Rollforward sanity (all terms as printed/signed): beginning + net invoice
  // sales + credit memo + cash collections(−) + chargebacks + excl/bad debt +
  // misc adjustment = ending.
  const roll =
    row.beginning_net_oar_cents +
    valueAfterLabel(lines, "NET INVOICE SALES") +
    valueAfterLabel(lines, "CREDIT MEMO") +
    valueAfterLabel(lines, "CASH COLLECTIONS") +
    row.chargebacks_net_cents +
    valueAfterLabel(lines, "EXCL/BAD DEBT ITEMS PAID") +
    valueAfterLabel(lines, "MISC. ADJUSTMENT");
  if (roll !== row.ending_net_oar_cents) {
    throw new Error(
      `CLIENT RECAP ${statement_month}: OAR rollforward mismatch (computed ${roll} vs ending ${row.ending_net_oar_cents})`,
    );
  }

  return row;
}

const AGING_LABELS = [
  "net_oar", "total_oar", "current", "past_due", "b1_15", "b16_30",
  "b31_60", "b61_90", "over_90", "credit_memo", "oap",
];

/**
 * Parse a FACTORED AR DETAILED report text.
 * @returns {{ as_of_date: string, items: Array<object>, totals: object|null }}
 *   items: { factor_customer_no, customer_name, item_num, item_type, po_num,
 *            item_date, due_date, terms, gross_amt_cents, item_balance_cents }
 *   totals: { net_oar_cents, total_oar_cents, ... } from the --- TOTALS --- footer.
 */
export function parseArDetail(text) {
  const lines = toLines(text);

  const asOfLine = lines.find((l) => /^As Of \d{1,2}\/\d{1,2}\/\d{4}$/.test(l));
  if (!asOfLine) throw new Error("AR DETAIL: 'As Of' date not found");
  const as_of_date = usDateToISO(asOfLine.slice("As Of ".length));

  // Customer block headers: "NAME ( 111987 )". Name must contain a letter so
  // phone numbers / stray parens can't match.
  const CUSTOMER_RE = /^(.*[A-Za-z].*?)\s*\(\s*(\d{4,7})\s*\)$/;

  const items = [];
  let totals = null;
  let customer = null; // { no, name }
  let inTotals = false;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line === "--- TOTALS ---") {
      inTotals = true;
      i += 1;
      continue;
    }

    if (inTotals) {
      // After the footer's aging labels ("Net OAR" … "OAP") come 11 money
      // values in the same order. Collect the first 11 money tokens.
      if (MONEY_RE.test(line) && totals === null) {
        const vals = [];
        let j = i;
        while (j < lines.length && vals.length < AGING_LABELS.length) {
          if (MONEY_RE.test(lines[j])) vals.push(moneyToCents(lines[j]));
          j += 1;
        }
        if (vals.length === AGING_LABELS.length) {
          totals = Object.fromEntries(AGING_LABELS.map((k, idx) => [`${k}_cents`, vals[idx]]));
        }
        i = j;
        continue;
      }
      i += 1;
      continue;
    }

    const cust = line.match(CUSTOMER_RE);
    // Guard: a header line, not a phone/address ("(941)747-2355" has no
    // pre-paren name; "Client #/TS #: 11548 / 01" has no parens).
    if (cust && !/^Contact Name:/i.test(line) && !/^Last Check:/i.test(line)) {
      customer = { no: cust[2], name: cust[1].trim() };
      i += 1;
      continue;
    }

    const im = line.match(ITEM_RE);
    if (im && customer) {
      const item_num = im[1] || im[2];
      let item_type = im[3] || null; // glued suffix ("ROF-I014115I")
      let j = i + 1;
      // Type tokens observed: I (invoice), O (open A/P deduction), RI
      // (re-invoiced deduction, 4/2026). Permissive 1–2 uppercase letters —
      // PO nums are longer/alphanumeric so this can't eat the next column.
      if (!item_type && /^[A-Z]{1,2}$/.test(lines[j] || "")) {
        item_type = lines[j];
        j += 1;
      }
      if (!item_type) item_type = item_num.startsWith("OAP") ? "O" : "I";

      // Optional PO Num: next token when it isn't already the item date / an amount.
      let po_num = null;
      if (j < lines.length && !DATE_RE.test(lines[j]) && !MONEY_RE.test(lines[j])) {
        po_num = lines[j];
        j += 1;
      }
      let item_date = null;
      if (j < lines.length && DATE_RE.test(lines[j])) { item_date = usDateToISO(lines[j]); j += 1; }
      let due_date = null;
      if (j < lines.length && DATE_RE.test(lines[j])) { due_date = usDateToISO(lines[j]); j += 1; }
      let terms = null;
      if (j < lines.length && TERMS_RE.test(lines[j])) { terms = lines[j]; j += 1; }

      if (j + 1 >= lines.length || !MONEY_RE.test(lines[j]) || !MONEY_RE.test(lines[j + 1])) {
        throw new Error(`AR DETAIL: malformed row at "${item_num}" (expected Gross Amt + Item Balance)`);
      }
      const gross_amt_cents = moneyToCents(lines[j]);
      const item_balance_cents = moneyToCents(lines[j + 1]);
      j += 2;

      items.push({
        factor_customer_no: customer.no,
        customer_name: customer.name,
        item_num,
        item_type,
        po_num,
        item_date,
        due_date,
        terms,
        gross_amt_cents,
        item_balance_cents,
      });
      i = j;
      continue;
    }

    i += 1;
  }

  if (!items.length) throw new Error("AR DETAIL: no invoice rows parsed");
  if (!totals) throw new Error("AR DETAIL: --- TOTALS --- footer not parsed");

  const sum = items.reduce((a, r) => a + r.item_balance_cents, 0);
  if (sum !== totals.net_oar_cents) {
    throw new Error(
      `AR DETAIL ${as_of_date}: Σ item_balance ${sum} ≠ footer Net OAR ${totals.net_oar_cents}`,
    );
  }

  return { as_of_date, items, totals };
}

// ═══ Chargeback Report ("Charge Back Analysis" + CHARGEBACK/CREDITBACK ═════
// SUMMARY + reason-code rollup) — Phase 2.
//
// The monthly "Chargeback Report MM.YY.pdf" bundles THREE sections:
//   1. Charge Back Analysis (item grain): rows of
//      [Customer#, Client Customer (free text, optional), Customer Name,
//       Item#, Item Date, Amount, Batch, C/B Date], footer "TradeStyle
//       Total:". Sign as printed: positive = charge back (deduction),
//       negative = credit back / recovery. The recap's CHARGEBACKS(-)/
//       CREDITBACKS/RECOVERIES equals the NEGATED TradeStyle total.
//   2. CHARGEBACK/CREDITBACK SUMMARY (reason grain): rows of
//      [Date, Client Customer?, Customer Name, "Charge Back"|"Credit Back",
//       Reason, Reference?, Amount] with per-date subtotals, footer "TS
//       TOTAL". Reasons here are best-effort attached to the detail rows.
//   3. "Summary by Customer and Reason Code" — reason text → 3-digit code.

const CB_MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

/**
 * @returns {{ report_month, details: Array, tradestyle_total_cents,
 *             summary: Array, ts_total_cents, reason_codes: Record<string,string> }}
 */
export function parseChargebackReport(text) {
  const lines = toLines(text);

  const periodLine = lines.find((l) => /^Accounting Period:\s+[A-Z][a-z]{2} \d{4}$/.test(l));
  if (!periodLine) throw new Error("CHARGEBACK: 'Accounting Period' header not found");
  const [, mon, year] = periodLine.match(/([A-Z][a-z]{2}) (\d{4})$/);
  const report_month = `${year}-${String(CB_MONTHS[mon]).padStart(2, "0")}-01`;

  const summaryStart = lines.findIndex((l) => l === "CHARGEBACK/CREDITBACK SUMMARY");

  // ── Section 1: detail rows ──
  const details = [];
  let tradestyle_total_cents = null;
  {
    const end = summaryStart === -1 ? lines.length : summaryStart;
    let i = 0;
    while (i < end) {
      const line = lines[i];
      if (line === "TradeStyle Total:") {
        tradestyle_total_cents = moneyToCents(lines[i + 1]);
        break;
      }
      if (!/^\d{5,7}$/.test(line)) { i += 1; continue; } // junk between rows
      // Row: no, [client cust…], name, item#, itemDate, amount, batch, cbDate
      let d = i + 1;
      while (d < end && !DATE_RE.test(lines[d])) d += 1;
      if (d >= end) break;
      const itemIdx = d - 1;
      if (itemIdx <= i) { i += 1; continue; } // date right after customer# — not a row
      const nameIdx = itemIdx - 1;
      if (nameIdx <= i) { i += 1; continue; }
      const amount = lines[d + 1];
      // Batch can be EMPTY (4/2026 vintage): the amount is then followed
      // directly by the C/B date. Batches are never M/D/YYYY-shaped
      // ("0728250070", "Z1172547559", "072425M41"), so a date right after
      // the amount means the batch column was blank.
      const batchless = DATE_RE.test(lines[d + 2] || "");
      const batch = batchless ? "" : lines[d + 2];
      const cbDate = batchless ? lines[d + 2] : lines[d + 3];
      if (!MONEY_RE.test(amount) || !DATE_RE.test(cbDate || "")) {
        throw new Error(`CHARGEBACK ${report_month}: malformed detail row near "${lines[itemIdx]}"`);
      }
      details.push({
        factor_customer_no: line,
        client_customer: lines.slice(i + 1, nameIdx).join(" ") || null,
        customer_name: lines[nameIdx],
        item_num: lines[itemIdx],
        item_date: usDateToISO(lines[d]),
        amount_cents: moneyToCents(amount),
        batch,
        cb_date: usDateToISO(cbDate),
      });
      i = d + (batchless ? 3 : 4);
    }
  }
  if (!details.length) throw new Error("CHARGEBACK: no detail rows parsed");
  if (tradestyle_total_cents === null) throw new Error("CHARGEBACK: TradeStyle Total not found");
  const detSum = details.reduce((a, r) => a + r.amount_cents, 0);
  if (detSum !== tradestyle_total_cents) {
    throw new Error(`CHARGEBACK ${report_month}: Σ detail ${detSum} ≠ TradeStyle Total ${tradestyle_total_cents}`);
  }

  // ── Section 2: reason summary rows ──
  const summary = [];
  let ts_total_cents = null;
  if (summaryStart !== -1) {
    let i = summaryStart;
    while (i < lines.length) {
      const line = lines[i];
      if (line === "TS TOTAL") { ts_total_cents = moneyToCents(lines[i + 1]); break; }
      if (!DATE_RE.test(line)) { i += 1; continue; } // skips headers + bare subtotal amounts
      // Row: date, [client cust…], name, type, reason, [reference…], amount
      let t = i + 1;
      while (t < lines.length && lines[t] !== "Charge Back" && lines[t] !== "Credit Back") {
        // A date or money before the type token means this "row" wasn't one.
        if (DATE_RE.test(lines[t]) || MONEY_RE.test(lines[t])) break;
        t += 1;
      }
      if (t >= lines.length || (lines[t] !== "Charge Back" && lines[t] !== "Credit Back")) { i += 1; continue; }
      const nameIdx = t - 1;
      const reason = lines[t + 1];
      let a = t + 2;
      const refParts = [];
      while (a < lines.length && !MONEY_RE.test(lines[a])) { refParts.push(lines[a]); a += 1; }
      if (a >= lines.length) break;
      summary.push({
        date: usDateToISO(line),
        client_customer: lines.slice(i + 1, nameIdx).join(" ") || null,
        customer_name: lines[nameIdx],
        item_type: lines[t],
        reason,
        reference: refParts.join(" ") || null,
        amount_cents: moneyToCents(lines[a]),
      });
      i = a + 1;
    }
    const sumSum = summary.reduce((acc, r) => acc + r.amount_cents, 0);
    if (ts_total_cents !== null && sumSum !== ts_total_cents) {
      throw new Error(`CHARGEBACK ${report_month}: Σ summary ${sumSum} ≠ TS TOTAL ${ts_total_cents}`);
    }
    if (ts_total_cents !== null && ts_total_cents !== tradestyle_total_cents) {
      throw new Error(`CHARGEBACK ${report_month}: TS TOTAL ${ts_total_cents} ≠ TradeStyle Total ${tradestyle_total_cents}`);
    }
  }

  // ── Section 3: reason text → 3-digit code (rollup lines "Reason(597)") ──
  const reason_codes = {};
  const rollupStart = lines.findIndex((l) => l.startsWith("Summary by Customer and Reason Code"));
  if (rollupStart !== -1) {
    for (let i = rollupStart; i < lines.length; i++) {
      const m = lines[i].match(/^(.+?)\s*\((\d{3})\)$/); // (111987) customer nos are 5-7 digits — excluded
      if (m) reason_codes[m[1].trim()] = m[2];
    }
  }

  return { report_month, details, tradestyle_total_cents, summary, ts_total_cents, reason_codes };
}

// Normalize an identifier to an uppercased alphanumeric key ("ROF-I007539" →
// "ROFI007539"). Empty / meaningless tokens ("GLOBAL") are dropped by callers.
function normalizeRefKey(s) {
  if (s == null) return "";
  return String(s).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Whitespace-split a summary reference ("GLOBAL 0711250030") into normalized
// tokens, dropping empties and the generic "GLOBAL" placeholder that names no
// single item.
function referenceTokens(ref) {
  if (ref == null) return [];
  return String(ref)
    .split(/\s+/)
    .map((t) => normalizeRefKey(t))
    .filter((t) => t && t !== "GLOBAL");
}

// The identifiers a detail row can be referenced by: its item/chargeback number
// and its batch number.
function detailRefKeys(d) {
  const keys = [];
  for (const v of [d.item_num, d.batch]) {
    const k = normalizeRefKey(v);
    if (k) keys.push(k);
  }
  return keys;
}

/**
 * Best-effort reason attachment: summary rows are (date, customer, reason,
 * reference, amount) — sometimes merged across items ("GLOBAL"). Per (customer,
 * C/B date) group, in order: a single distinct reason applies to every detail
 * row; else an exact unique amount match wins; else a summary whose REFERENCE
 * number names this detail row's item/chargeback number or batch wins; else the
 * reason stays null.
 * Mutates `details` (adds reason / reason_code / reference).
 */
export function attachChargebackReasons(details, summary, reasonCodes = {}) {
  const groups = new Map();
  for (const s of summary) {
    const k = `${s.customer_name}|${s.date}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  let attached = 0;
  for (const d of details) {
    const g = groups.get(`${d.customer_name}|${d.cb_date}`) || [];
    if (!g.length) continue;
    const reasons = [...new Set(g.map((s) => s.reason))];
    let pick = null;
    if (reasons.length === 1) {
      pick = g[0];
    } else {
      const exact = g.filter((s) => s.amount_cents === d.amount_cents);
      if (new Set(exact.map((s) => s.reason)).size === 1 && exact.length) pick = exact[0];
      // Ambiguous by reason AND by amount: fall back to the reference number.
      // A summary row whose reference token equals this detail's item/batch key
      // uniquely identifies it — but only when the reference-matched rows agree
      // on a single reason (else stay null: a wrong reason is worse than none).
      if (!pick) {
        const dKeys = detailRefKeys(d);
        if (dKeys.length) {
          const refMatch = g.filter((s) => referenceTokens(s.reference).some((t) => dKeys.includes(t)));
          if (refMatch.length && new Set(refMatch.map((s) => s.reason)).size === 1) pick = refMatch[0];
        }
      }
    }
    if (pick) {
      d.reason = pick.reason;
      d.reason_code = reasonCodes[pick.reason] || null;
      d.reference = pick.reference;
      attached += 1;
    }
  }
  return attached;
}

/** Report-type sniffing for the importer. */
export function detectReportType(text) {
  const t = String(text || "");
  if (t.includes("CLIENT ACCOUNTS RECEIVABLE DETAIL")) return "ar_detail";
  if (t.includes("Charge Back Analysis")) return "chargeback_report";
  if (t.includes("CLIENT RECAP")) return "client_recap";
  return null;
}

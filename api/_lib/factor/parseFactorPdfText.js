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
const TERMS_RE = /^(?:\d{7}|Net\s?\d{1,3})$/;
// Item rows: "ROF-I012063" / "PT-I013802" / OAP deductions "OAP0024700269".
// Optional glued trailing I/O (seen on some pages: "ROF-I014115I").
const ITEM_RE = /^(?:([A-Z]{2,5}-[A-Z]\d{3,})|(OAP\d{5,}))([IO])?$/;

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
  };

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
      if (!item_type && (lines[j] === "I" || lines[j] === "O")) {
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

/** Report-type sniffing for the importer. */
export function detectReportType(text) {
  const t = String(text || "");
  if (t.includes("CLIENT ACCOUNTS RECEIVABLE DETAIL")) return "ar_detail";
  if (t.includes("CLIENT RECAP")) return "client_recap";
  return null;
}

// Factor Module Phase 1 — parser unit tests.
//
// Fixtures are extracted-text snippets in the exact shape pypdf emits for the
// Rosenthal PDFs (one text-run per line; label→value pairs for the recap,
// token streams for the AR detail). NOT the PDFs themselves.

import { describe, it, expect } from "vitest";
import {
  moneyToCents,
  usDateToISO,
  parseClientRecap,
  parseArDetail,
  parseChargebackReport,
  attachChargebackReasons,
  detectReportType,
} from "../parseFactorPdfText.js";

describe("moneyToCents", () => {
  it("parses plain and thousands-grouped values", () => {
    expect(moneyToCents("0.00")).toBe(0);
    expect(moneyToCents("693.00")).toBe(69300);
    expect(moneyToCents("2,600,036.92")).toBe(260003692);
  });
  it("keeps the sign on negatives (OAP deductions)", () => {
    expect(moneyToCents("-17,960.00")).toBe(-1796000);
    expect(moneyToCents("-49.05")).toBe(-4905);
  });
  it("rejects non-money tokens", () => {
    expect(() => moneyToCents("Net 30")).toThrow();
    expect(() => moneyToCents("34259")).toThrow(); // PO num — no decimals
  });
});

describe("usDateToISO", () => {
  it("parses M/D/YYYY", () => {
    expect(usDateToISO("7/31/2025")).toBe("2025-07-31");
    expect(usDateToISO("9/9/2025")).toBe("2025-09-09");
  });
  it("rejects date+time page-header tokens", () => {
    expect(() => usDateToISO("9/30/2025 11:22:09 PM")).toThrow();
  });
});

// ── CLIENT RECAP ────────────────────────────────────────────────────────────
// Condensed July 2025 fixture: keeps every label the parser anchors on,
// including the ambiguous repeats (ADVANCES / ACCRUED FEES/OTHER TRANSFERS in
// facility blocks) that must NOT be picked up.
const RECAP_FIXTURE = `
=== PAGE 1 ===
CLIENT STATEMENT
CLIENT RECAP
FOR THE MONTH OF JULY, 2025
BEGINNING AR - 01 FACILITY (USD)
2,961,460.92
PRIOR MONTH INT. ADJ.
-49.05
TRADESTYLE TOTAL
4,184,084.51
ADVANCES
1,828,000.00
TOTAL INTEREST
34,096.60
INVOICES
2,600,036.92
ACCRUED INTEREST
39,814.98
FEES
0.00
NET SALES
2,600,036.92
OTHER
174.00
ACCRUED FEES/OTHER TRANSFERS
39,988.98
COMMISSIONS
-16,340.95
CHARGEBACKS(-)/CREDITBACKS/RECOVERIES
188,164.95
BEGINNING IN - V1 FACILITY (USD)
1,576,395.28
ADVANCES
0.00
ACCRUED FEES/OTHER TRANSFERS
0.00
BEGINNING NET OAR BALANCE
3,916,875.91
NET INVOICE SALES
2,600,036.92
CREDIT MEMO
0.00
CASH COLLECTIONS
-2,939,281.46
CHARGEBACKS(-)/CREDITBACKS/RECOVERIES
188,164.95
EXCL/BAD DEBT ITEMS PAID
0.00
MISC. ADJUSTMENT
0.00
ENDING NET OAR
3,765,796.32
=== PAGE 2 ===
TOTAL LOANS
3,765,937.52
=== PAGE 3 ===
PRIOR PERIOD NET DUE CLIENT
353,771.69
NET DUE CLIENT (FACTOR) AS OF 7/1/2025
353,771.69
NET SALES
2,600,036.92
COMMISSIONS
16,340.95
ACCRUED FEES/OTHER TRANSFERS (FACILITY)
39,988.98
ADVANCES
1,828,000.00
NET DUE CLIENT (FACTOR) AS OF 7/31/2025
550,100.25
`;

describe("parseClientRecap", () => {
  const row = parseClientRecap(RECAP_FIXTURE);

  it("resolves the statement month", () => {
    expect(row.statement_month).toBe("2025-07-01");
  });
  it("parses the tradestyle economics (collections/commissions positive)", () => {
    expect(row.net_sales_cents).toBe(260003692);
    expect(row.cash_collections_cents).toBe(293928146);
    expect(row.chargebacks_net_cents).toBe(18816495);
    expect(row.commissions_cents).toBe(1634095);
    expect(row.interest_cents).toBe(3409660);
  });
  it("anchors ambiguous labels on the NET DUE CLIENT page / (FACILITY) suffix", () => {
    expect(row.fees_other_cents).toBe(3998898);   // NOT the 0.00 facility repeats
    expect(row.advances_cents).toBe(182800000);   // NOT the V1 facility 0.00
  });
  it("decomposes fees/other into accrued-interest + fees + other (Phase 2)", () => {
    expect(row.prior_month_interest_adj_cents).toBe(-4905);
    expect(row.facility_accrued_interest_cents).toBe(3981498);
    expect(row.facility_fees_cents).toBe(0);
    expect(row.facility_other_cents).toBe(17400);
    // parts sum to the (FACILITY) total — enforced by the parser
    expect(row.facility_accrued_interest_cents + row.facility_fees_cents + row.facility_other_cents)
      .toBe(row.fees_other_cents);
  });

  it("parses the OAR rollforward + net due client + total loans", () => {
    expect(row.beginning_net_oar_cents).toBe(391687591);
    expect(row.ending_net_oar_cents).toBe(376579632);
    expect(row.net_due_client_beginning_cents).toBe(35377169);
    expect(row.net_due_client_ending_cents).toBe(55010025);
    expect(row.total_loans_cents).toBe(376593752);
  });
  it("rejects a broken rollforward", () => {
    expect(() => parseClientRecap(RECAP_FIXTURE.replace("3,765,796.32", "3,765,796.33"))).toThrow(/rollforward/);
  });

  // Older vintages (Rosenthal & Rosenthal of California, e.g. May/Jun 2025 and
  // Oct 2024) print NEGATIVE chargebacks and negative accrued fees — signs are
  // stored as printed and the rollforward must still balance.
  it("keeps printed signs (negative chargebacks / fees) and still rolls forward", () => {
    const neg = parseClientRecap(
      RECAP_FIXTURE
        .replaceAll("CHARGEBACKS(-)/CREDITBACKS/RECOVERIES\n188,164.95", "CHARGEBACKS(-)/CREDITBACKS/RECOVERIES\n-13,605.56")
        .replace("ACCRUED FEES/OTHER TRANSFERS (FACILITY)\n39,988.98", "ACCRUED FEES/OTHER TRANSFERS (FACILITY)\n-154,304.02")
        .replace("OTHER\n174.00", "OTHER\n-194,119.00") // decomposition still holds
        .replace("ENDING NET OAR\n3,765,796.32", "ENDING NET OAR\n3,564,025.81"),
    );
    expect(neg.chargebacks_net_cents).toBe(-1360556);
    expect(neg.fees_other_cents).toBe(-15430402);
    expect(neg.facility_other_cents).toBe(-19411900);
    expect(neg.ending_net_oar_cents).toBe(356402581);
  });

  // Page-3 prints the (FACILITY) total by debit/credit COLUMN, which text
  // extraction flattens to an unsigned value. When the signed facility
  // components sum to exactly −total (net-credit month, e.g. Oct-24), the
  // components win and the total flips sign.
  it("trusts the signed facility components over the unsigned page-3 total", () => {
    const flipped = parseClientRecap(
      RECAP_FIXTURE
        .replace("ACCRUED INTEREST\n39,814.98", "ACCRUED INTEREST\n-39,814.98")
        .replace("OTHER\n174.00", "OTHER\n-174.00"),
      // fees_other still printed +39,988.98 → parts −39,988.98 → override
    );
    expect(flipped.fees_other_cents).toBe(-3998898);
    expect(flipped.facility_accrued_interest_cents).toBe(-3981498);
  });
});

// ── FACTORED AR DETAILED ────────────────────────────────────────────────────
// Token-stream fixture covering: customer header + aging junk skipping, a
// 0000060-terms row, a "Net 30" row with a numeric PO, the GLUED type suffix
// ("ROF-I014115I" — no separate I token), an OAP deduction row (no PO / due /
// terms, negative amounts), a mid-stream page header, and the TOTALS footer.
const AR_FIXTURE = `
9/30/2025 11:22:09 PM
Page: 1
Rosenthal Capital Group
CLIENT ACCOUNTS RECEIVABLE DETAIL
FACRD2R.Batch
As Of 9/30/2025
TS Name: RING OF FIRE CLOTHING
Client #/TS #: 11548 / 01
BEALL\`S INC. ( 111987 )
Last Check: 9,051.77
Date Received: 9/22/2025
P O BOX 25030
BRADENTON, FL  34206
(941)747-2355
Net OAR
Total OAR
Current
Past Due
1 to 15
16 to 30
31 to 60
61 to 90
Over 90
Credit Memo
OAP
41,325.50
41,325.50
30,491.75
10,833.75
0.00
10,833.75
0.00
0.00
0.00
0.00
0.00
Item Num
Type
PO Num
Store Num
Item Date
Due Date
Terms
Gross Amt
Item Balance
PT-I013802
I
PT-I013802
7/11/2025
9/9/2025
0000060
1,470.00
1,470.00
9/30/2025 11:22:09 PM
Page: 2
CLIENT ACCOUNTS RECEIVABLE DETAIL
As Of 9/30/2025
BURLINGTON MERCHANDISING CORPORATION ( 119432 )
ROF-I015535
I
133139607
9/2/2025
10/2/2025
Net 30
976.80
976.80
ROSS STORES INC ( 211832 )
ROF-I014115I
ROF-I014115
7/17/2025
8/16/2025
Net 30
6,510.00
6,510.00
ROF-I145139
I
ROF-I145139
1/22/2026
5/24/2026
Net 10+75 E
4,960.00
4,960.00
D D\`S DISCOUNT ( 133867 )
OAP0024700269
O
9/26/2025
-17,960.00
-17,960.00
SR-11484110
O
1/13/2026
-2,721.25
-2,721.25
pt-i147867
O
3/26/2026
-13,356.38
-13,356.38
PT-I147867
RI
PT-I147867
3/11/2026
5/10/2026
0000060
7,560.00
7,560.00
PTI015496
O
6/2/2026
-182.00
-182.00
--- TOTALS ---
TS Name:
RING OF FIRE CLOTHING
Client #/TS #: 11548 / 01
Currency Code: USD
Net OAR
Total OAR
Current
Past Due
1 to 15
16 to 30
31 to 60
61 to 90
Over 90
Credit Memo
OAP
-12,742.83
8,956.80
3,397,946.98
294,985.75
272,272.00
10,833.75
11,880.00
0.00
0.00
0.00
17,960.00
Total Discount
0.00
`;

describe("parseArDetail", () => {
  const parsed = parseArDetail(AR_FIXTURE);

  it("resolves the as-of date", () => {
    expect(parsed.as_of_date).toBe("2025-09-30");
  });

  it("parses rows under the right customers, skipping aging/header junk", () => {
    expect(parsed.items).toHaveLength(9);
    const [bealls, burlington, ross, ross2026, dds, srDeduction, lcDeduction, reInvoice, dashless] = parsed.items;
    // Dashless credit-memo ref (6/2026 vintage).
    expect(dashless).toMatchObject({ item_num: "PTI015496", item_type: "O", item_balance_cents: -18200 });
    expect(bealls).toMatchObject({
      factor_customer_no: "111987",
      customer_name: "BEALL`S INC.",
      item_num: "PT-I013802",
      item_type: "I",
      po_num: "PT-I013802",
      item_date: "2025-07-11",
      due_date: "2025-09-09",
      terms: "0000060",
      gross_amt_cents: 147000,
      item_balance_cents: 147000,
    });
    expect(burlington).toMatchObject({
      factor_customer_no: "119432",
      item_num: "ROF-I015535",
      po_num: "133139607",
      terms: "Net 30",
      item_balance_cents: 97680,
    });
    expect(dds.factor_customer_no).toBe("133867");
    expect(ross.factor_customer_no).toBe("211832");
    // 2026-vintage deduction ref: "SR-…" with explicit type O, no PO/due/terms.
    expect(srDeduction).toMatchObject({
      item_num: "SR-11484110",
      item_type: "O",
      po_num: null,
      item_date: "2026-01-13",
      due_date: null,
      terms: null,
      item_balance_cents: -272125,
    });
    // …and the lowercase variant seen 3/2026.
    expect(lcDeduction).toMatchObject({
      item_num: "pt-i147867",
      item_type: "O",
      item_balance_cents: -1335638,
    });
    // Type RI = re-invoiced deduction (4/2026 vintage).
    expect(reInvoice).toMatchObject({
      item_num: "PT-I147867",
      item_type: "RI",
      po_num: "PT-I147867",
      terms: "0000060",
      item_balance_cents: 756000,
    });
    // 2026-vintage terms token ("Net 10+75 E") fills the terms slot.
    expect(ross2026).toMatchObject({
      factor_customer_no: "211832",
      item_num: "ROF-I145139",
      terms: "Net 10+75 E",
      item_balance_cents: 496000,
    });
  });

  it("splits the glued type suffix (ROF-I014115I → item + type I)", () => {
    const ross = parsed.items.find((r) => r.factor_customer_no === "211832");
    expect(ross.item_num).toBe("ROF-I014115");
    expect(ross.item_type).toBe("I");
    expect(ross.po_num).toBe("ROF-I014115");
    expect(ross.item_balance_cents).toBe(651000);
  });

  it("parses the OAP deduction row (type O, no PO/due/terms, negative)", () => {
    const oap = parsed.items.find((r) => r.item_type === "O");
    expect(oap.item_num).toBe("OAP0024700269");
    expect(oap.po_num).toBeNull();
    expect(oap.item_date).toBe("2025-09-26");
    expect(oap.due_date).toBeNull();
    expect(oap.terms).toBeNull();
    expect(oap.gross_amt_cents).toBe(-1796000);
    expect(oap.item_balance_cents).toBe(-1796000);
  });

  it("parses the TOTALS footer (Net OAR first, Total OAR second)", () => {
    expect(parsed.totals.net_oar_cents).toBe(-1274283); // fixture Σ balances
    expect(parsed.totals.total_oar_cents).toBe(895680);
    expect(parsed.totals.oap_cents).toBe(1796000);
  });

  it("throws when Σ item_balance disagrees with the footer Net OAR", () => {
    expect(() => parseArDetail(AR_FIXTURE.replace("-12,742.83", "-12,742.84"))).toThrow(/Net OAR/);
  });
});

// ── Chargeback Report ───────────────────────────────────────────────────────
// Token-stream fixture: detail rows (with/without the Client Customer column,
// alnum batch, negative credit backs), a mid-stream page header, TradeStyle
// Total footer, CHARGEBACK/CREDITBACK SUMMARY rows with a date-group subtotal
// and a "111987" client-customer token, TS TOTAL, and the reason-code rollup.
const CB_FIXTURE = `
7/31/2025 11:27:14 PM
Page: 1
Rosenthal Capital Group
Charge Back Analysis
ChaAnaR.Batch
Accounting Period:  Jul 2025
[ USD - USA Dollars ]
11548 / 01
RING OF FIRE CLOTHING
Customer #
Client Customer #
Customer Name
Item #
Item Date
Amount
Batch
C/B Date
111987
Greg
BEALL\`S INC.
ROF-I007539
2/28/2025
165.36
0707250144
7/7/2025
111987
Greg
BEALL\`S INC.
ROF1004149_1402541
7/25/2025
-5,650.68
0728250070
7/29/2025
7/31/2025 11:27:14 PM
Page: 2
Charge Back Analysis
Accounting Period:  Jul 2025
211832
ROSS DC
ROSS STORES INC
CBRSR-11223666
6/10/2025
-878.50
Z1172547559
7/30/2025
119432
BURLINGTON COAT FACT
BURLINGTON MERCHANDISING CORPORATION
DMQROFI010416
7/11/2025
1,573.00
0711250030
7/11/2025
111987
BEALLS INC- DISTRIBU
BEALL\`S INC.
407267_1447867
3/30/2026
-190.85
4/16/2026
11548 / 01 - RING OF FIRE CLOTHING
TradeStyle Total:
-4,981.67
[End of Report]
CLIENT STATEMENT
CHARGEBACK/CREDITBACK SUMMARY
FOR THE MONTH OF JULY, 2025
Client's
Date
Customer #
Customer Name
Item Type
Reason
Reference
Amount
7/7/2025
Bealls Outlet Stores
BEALL\`S INC.
Charge Back
Short Pay (Inv/Ck Difference)
165.36
165.36
7/29/2025
111987
BEALL\`S INC.
Credit Back
Non-Factored Invoice (credit) - NC
GLOBAL
-5,650.68
-5,650.68
7/30/2025
ROSS STORES INC
Credit Back
Miscellaneous credit / chargeback
GLOBAL
-878.50
7/11/2025
BURLINGTON MERCHANDISING CORPORATION
Charge Back
Miscellaneous
GLOBAL
1,573.00
4/16/2026
BEALL\`S INC.
Credit Back
Short Pay (Inv/Ck Difference)
-190.85
TS TOTAL
-4,981.67
Summary by Customer and Reason Code
BEALL\`S INC. (111987)
Short Pay (Inv/Ck Difference)(597)
165.36
Non-Factored Invoice (credit) - NC(204)
-5,650.68
-5,485.32
Summary by Reason Code
Miscellaneous (602)
1,573.00
`;

describe("parseChargebackReport", () => {
  const parsed = parseChargebackReport(CB_FIXTURE);

  it("resolves the accounting period", () => {
    expect(parsed.report_month).toBe("2025-07-01");
  });

  it("parses detail rows (client customer, alnum batch, signed amounts)", () => {
    expect(parsed.details).toHaveLength(5);
    // Batchless row (4/2026 vintage): amount followed directly by the C/B date.
    expect(parsed.details[4]).toMatchObject({
      factor_customer_no: "111987",
      client_customer: "BEALLS INC- DISTRIBU",
      item_num: "407267_1447867",
      item_date: "2026-03-30",
      amount_cents: -19085,
      batch: "",
      cb_date: "2026-04-16",
    });
    expect(parsed.details[0]).toMatchObject({
      factor_customer_no: "111987",
      client_customer: "Greg",
      customer_name: "BEALL`S INC.",
      item_num: "ROF-I007539",
      item_date: "2025-02-28",
      amount_cents: 16536,
      batch: "0707250144",
      cb_date: "2025-07-07",
    });
    expect(parsed.details[2]).toMatchObject({
      factor_customer_no: "211832",
      client_customer: "ROSS DC",
      item_num: "CBRSR-11223666",
      amount_cents: -87850,
      batch: "Z1172547559",
    });
    expect(parsed.tradestyle_total_cents).toBe(-498167);
  });

  it("parses summary rows with reasons, skipping group subtotals", () => {
    expect(parsed.summary).toHaveLength(5);
    expect(parsed.summary[0]).toMatchObject({
      date: "2025-07-07",
      customer_name: "BEALL`S INC.",
      item_type: "Charge Back",
      reason: "Short Pay (Inv/Ck Difference)",
      reference: null,
      amount_cents: 16536,
    });
    expect(parsed.summary[1]).toMatchObject({
      client_customer: "111987",
      item_type: "Credit Back",
      reason: "Non-Factored Invoice (credit) - NC",
      reference: "GLOBAL",
      amount_cents: -565068,
    });
    expect(parsed.ts_total_cents).toBe(-498167);
  });

  it("extracts the reason-code map (3-digit codes only — never customer numbers)", () => {
    expect(parsed.reason_codes).toMatchObject({
      "Short Pay (Inv/Ck Difference)": "597",
      "Non-Factored Invoice (credit) - NC": "204",
      "Miscellaneous": "602",
    });
    expect(Object.values(parsed.reason_codes)).not.toContain("111987");
  });

  it("attaches reasons to detail rows (single-reason group + amount match)", () => {
    const n = attachChargebackReasons(parsed.details, parsed.summary, parsed.reason_codes);
    expect(n).toBe(5);
    expect(parsed.details[4].reason).toBe("Short Pay (Inv/Ck Difference)"); // batchless row
    expect(parsed.details[0].reason).toBe("Short Pay (Inv/Ck Difference)");
    expect(parsed.details[0].reason_code).toBe("597");
    expect(parsed.details[1].reason).toBe("Non-Factored Invoice (credit) - NC");
    expect(parsed.details[2].reason).toBe("Miscellaneous credit / chargeback");
    expect(parsed.details[3].reason_code).toBe("602");
  });

  it("throws when the detail sum breaks vs TradeStyle Total", () => {
    expect(() => parseChargebackReport(CB_FIXTURE.replace("1,573.00\n0711250030", "1,573.01\n0711250030"))).toThrow(/TradeStyle/);
  });
});

// ── attachChargebackReasons: reference-number disambiguation ─────────────────
// When a (customer, C/B date) group is ambiguous by BOTH reason and amount, a
// summary row whose reference number names a detail row's item/batch key
// uniquely attaches its reason. Exact single-reason groups and exact-amount
// matches keep working identically (covered above).
describe("attachChargebackReasons — reference-number fallback", () => {
  it("attaches reasons via the summary reference when reason AND amount are ambiguous", () => {
    const details = [
      { customer_name: "ACME", cb_date: "2025-07-07", item_num: "ROF-I100", batch: "0707250144", amount_cents: 10000 },
      { customer_name: "ACME", cb_date: "2025-07-07", item_num: "ROF-I200", batch: "0707250145", amount_cents: 10000 },
    ];
    const summary = [
      // Same customer+date+amount → not separable by amount; references disambiguate.
      { customer_name: "ACME", date: "2025-07-07", reason: "Freight", reference: "ROF-I100", amount_cents: 10000 },
      { customer_name: "ACME", date: "2025-07-07", reason: "Packing Violation", reference: "ROF-I200", amount_cents: 10000 },
    ];
    const n = attachChargebackReasons(details, summary, { Freight: "080", "Packing Violation": "070" });
    expect(n).toBe(2);
    expect(details[0]).toMatchObject({ reason: "Freight", reason_code: "080" });
    expect(details[1]).toMatchObject({ reason: "Packing Violation", reason_code: "070" });
  });

  it("matches a reference against the detail BATCH / chargeback number too", () => {
    const details = [
      { customer_name: "ACME", cb_date: "2025-07-07", item_num: "X1", batch: "Z1172547559", amount_cents: 5000 },
      { customer_name: "ACME", cb_date: "2025-07-07", item_num: "X2", batch: "Z9990001111", amount_cents: 5000 },
    ];
    const summary = [
      { customer_name: "ACME", date: "2025-07-07", reason: "Freight", reference: "GLOBAL Z1172547559", amount_cents: 5000 },
      { customer_name: "ACME", date: "2025-07-07", reason: "Miscellaneous", reference: "Z9990001111", amount_cents: 5000 },
    ];
    const n = attachChargebackReasons(details, summary, {});
    expect(n).toBe(2);
    expect(details[0].reason).toBe("Freight");
    expect(details[1].reason).toBe("Miscellaneous");
  });

  it("ignores GLOBAL references and leaves genuinely ambiguous rows null", () => {
    const details = [
      { customer_name: "ACME", cb_date: "2025-07-07", item_num: "ROF-I100", batch: "B1", amount_cents: 10000 },
    ];
    const summary = [
      { customer_name: "ACME", date: "2025-07-07", reason: "Freight", reference: "GLOBAL", amount_cents: 5000 },
      { customer_name: "ACME", date: "2025-07-07", reason: "Packing Violation", reference: "GLOBAL", amount_cents: 5000 },
    ];
    const n = attachChargebackReasons(details, summary, {});
    expect(n).toBe(0);
    expect(details[0].reason).toBeUndefined();
  });

  it("stays null when reference-matched summaries disagree on the reason", () => {
    const details = [
      { customer_name: "ACME", cb_date: "2025-07-07", item_num: "ROF-I100", batch: "ROF-I100", amount_cents: 10000 },
    ];
    const summary = [
      { customer_name: "ACME", date: "2025-07-07", reason: "Freight", reference: "ROF-I100", amount_cents: 4000 },
      { customer_name: "ACME", date: "2025-07-07", reason: "Packing Violation", reference: "ROF-I100", amount_cents: 6000 },
    ];
    const n = attachChargebackReasons(details, summary, {});
    expect(n).toBe(0);
    expect(details[0].reason).toBeUndefined();
  });
});

describe("detectReportType", () => {
  it("sniffs all three report types", () => {
    expect(detectReportType(AR_FIXTURE)).toBe("ar_detail");
    expect(detectReportType(RECAP_FIXTURE)).toBe("client_recap");
    expect(detectReportType(CB_FIXTURE)).toBe("chargeback_report");
    expect(detectReportType("random")).toBeNull();
  });
});

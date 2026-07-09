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
TRADESTYLE TOTAL
4,184,084.51
ADVANCES
1,828,000.00
TOTAL INTEREST
34,096.60
INVOICES
2,600,036.92
NET SALES
2,600,036.92
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
        .replace("ENDING NET OAR\n3,765,796.32", "ENDING NET OAR\n3,564,025.81"),
    );
    expect(neg.chargebacks_net_cents).toBe(-1360556);
    expect(neg.fees_other_cents).toBe(-15430402);
    expect(neg.ending_net_oar_cents).toBe(356402581);
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
D D\`S DISCOUNT ( 133867 )
OAP0024700269
O
9/26/2025
-17,960.00
-17,960.00
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
-9,003.20
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
    expect(parsed.items).toHaveLength(4);
    const [bealls, burlington, ross, dds] = parsed.items;
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
    expect(parsed.totals.net_oar_cents).toBe(-900320); // fixture Σ balances
    expect(parsed.totals.total_oar_cents).toBe(895680);
    expect(parsed.totals.oap_cents).toBe(1796000);
  });

  it("throws when Σ item_balance disagrees with the footer Net OAR", () => {
    expect(() => parseArDetail(AR_FIXTURE.replace("-9,003.20", "-9,003.21"))).toThrow(/Net OAR/);
  });
});

describe("detectReportType", () => {
  it("sniffs both report types", () => {
    expect(detectReportType(AR_FIXTURE)).toBe("ar_detail");
    expect(detectReportType(RECAP_FIXTURE)).toBe("client_recap");
    expect(detectReportType("random")).toBeNull();
  });
});

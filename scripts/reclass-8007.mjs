#!/usr/bin/env node
// 8007 "Uncategorized Expense" cleanup driver (vendor default expense accounts).
//
// Background: the per-bill AP GL engine (#1662/#1666/#1668) routes a bill's
// non-item/tax slice to the vendor's default expense account
// (vendors.default_gl_expense_account_id) and falls back to 8007
// Uncategorized Expense when the vendor has none. Historically ~$8.9M landed
// in 8007, so the P&L showed one lump instead of real expense categories.
//
// This driver:
//   report        read-only — 8007 activity by vendor x month, mapping
//                 coverage, and writes the CEO review CSV for vendors we do
//                 NOT auto-map (docs/tangerine/ap-8007-review.csv)
//   set-defaults  set vendors.default_gl_expense_account_id for the
//                 HIGH-confidence name mappings below (only when NULL —
//                 an operator-set default is never overwritten)
//   reclass       post one JE per (vendor, month): DR the vendor's default
//                 expense account / CR 8007 for that month's 8007 activity.
//                 Runs for EVERY vendor with a validated default expense
//                 account (so operator mappings added later are picked up by
//                 a re-run), except the EXCLUDE list.
//   verify        8007 + 2000 balances, trial-balance imbalance, 8007 by
//                 month after reclass
//   xoro-verify   (#xoro-account-truth) re-verify every (vendor, month)
//                 bucket against the Xoro GL account carried on the bill
//                 lines (invoice_line_items.xoro_expense_account_name /
//                 xoro_item_type); posts correction JEs for DIFFs, reports
//                 MATCH/UNMAPPED/NO-SIGNAL; writes
//                 docs/tangerine/ap-xoro-verify.csv + the unmatched-name
//                 mapping table docs/tangerine/xoro-account-name-map.csv
//
// Non-negotiables honored:
//   - JEs are dated to the SOURCE months (month-end; current month uses the
//     latest source line date), never today.
//   - T11: audit_reason on every post. T10: journal_type
//     'vendor_expense_reclass', source_module 'ap',
//     source_table 'vendor_expense_reclass', source_id '<vendor_id>:<YYYY-MM>'
//     (the uq_je_source_basis index makes reruns idempotent).
//   - 2000 is never touched (verify counts reclass lines on 2000 — must be 0).
//   - CEO-confirmed INVENTORY vendors (e.g. Factory 1, 2026-07-10) reclass
//     DR 1201 Inventory instead of an expense account, with journal_type
//     'vendor_inventory_reclass' (a balance-sheet repair: their goods' sales
//     already relieved 1201 via AR COGS legs, so the missing purchase-side DR
//     understated inventory). Inventory-SUSPECT vendors are listed for the
//     CEO and never auto-posted.
//
// Usage: node scripts/reclass-8007.mjs <report|set-defaults|reclass|verify|xoro-verify> [--dry-run] [--limit=N]

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import { buildXoroAccountResolver } from "../api/_lib/accounting/xoroAccountMap.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function loadEnv(file) {
  try {
    const text = readFileSync(resolve(ROOT, file), "utf8");
    return Object.fromEntries(text.split("\n")
      .filter((l) => l.includes("=") && !l.startsWith("#"))
      .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));
  } catch { return {}; }
}
const env = { ...loadEnv(".env"), ...loadEnv(".env.local") };
const SB_URL = env.VITE_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SERVICE_KEY) { console.error("Missing VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

const $ = (c) => ((c || 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dollars = (cents) => {
  const neg = cents < 0; const abs = Math.abs(cents);
  return `${neg ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
};

// ── HIGH-confidence vendor -> expense account mapping ────────────────────────
// Unambiguous name matches only (several accounts are tailor-made for the
// vendor, e.g. 6378 Xoro Subscription, 6713 Website Advertising Google).
// Anything debatable stays in 8007 and goes to the review CSV instead.
const HIGH = [
  // freight / shipping / customs
  ["GPA Logistics Group Inc.", "6348", "3PL/logistics provider — Logistics Warehouse Expense"],
  ["UPS", "5405", "parcel carrier — Shipping Expense"],
  ["FedEx", "5405", "parcel carrier — Shipping Expense"],
  ["USPS", "6356", "postal service — Postage Expense"],
  ["Master Int'l Air, Inc.", "5402", "air freight forwarder — Freight In"],
  ["City Logistics-ACH", "5401", "trucking/drayage — Freight Expense"],
  ["CSL Express Line", "5401", "freight carrier — Freight Expense"],
  ["Worldwide Express", "5401", "freight carrier — Freight Expense"],
  ["Flexport", "5402", "freight forwarder — Freight In"],
  // insurance
  ["Kaiser Permanente", "6338", "health insurer — Medical Insurance"],
  ["Blue Shield CA", "6338", "health insurer — Medical Insurance"],
  ["Health First New York", "6338", "health insurer — Medical Insurance"],
  ["Amtrust", "6339", "workers' comp carrier"],
  ["Republic Indemnity", "6339", "workers' comp carrier"],
  ["Mercury Insurance Company", "6335", "auto insurer — Auto Insurance"],
  // rent
  ["5200 White Oak", "6360", "landlord (property address) — Rent Expense"],
  // professional fees
  ["RKE Certified Public Accountants", "6301", "CPA firm — Accounting Service"],
  ["Sandi Ordonez Accounting Services", "6301", "accounting services"],
  ["Elevate Accounting Department", "6301", "accounting services"],
  ["Cypress LLP", "6344", "law firm — Legal & Professional"],
  ["Power Del Valle LLP", "6344", "law firm — Legal & Professional"],
  // software / subscriptions / IT
  ["Xorosoft", "6378", "ERP vendor — Xoro Subscription (tailor-made account)"],
  ["Shopify", "6718", "Website Hosting Shopfiy (tailor-made account)"],
  ["Orderful Inc.", "6326", "EDI platform — EDI Processing"],
  ["DI Central", "6326", "EDI platform — EDI Processing"],
  ["EDI Partners", "6326", "EDI services — EDI Processing"],
  ["Intuit", "6302", "QuickBooks — Accounting Software"],
  ["GS1 US, INC.", "6371", "UPC registry — UPC Codes Expense (tailor-made)"],
  ["ComputerCare, Inc.", "6313", "IT maintenance — Computer Maintenance"],
  // advertising
  ["Google LLC - Ads", "6713", "Website Advertising Google (tailor-made)"],
  ["Meta Platforms, Inc. - Ads", "6614", "Meta Platforms Advertising (tailor-made)"],
  // payroll / commissions
  ["Paycor Inc", "6132", "payroll provider — Payroll processing fees"],
  ["Meredith Levitt", "6127", "Sales Commissions - Meredith Le (tailor-made)"],
  ["Patricia Thornton", "5105", "Commissions Expense - Patrica T (tailor-made)"],
  ["Righton Surf LLC", "6133", "Sales Commission - Right On Surf (tailor-made)"],
  // telecom
  ["AT&T Mobility-Auto", "6352", "Mobile Phone Expense"],
  ["Spectrum", "6382", "Internet Service Provider"],
  // automobiles
  ["Porsche", "6304", "auto financing — Auto Expense"],
  ["Tesla Finance LLC", "6304", "auto financing — Auto Expense"],
  ["Mercedes Benz Financial Services", "6304", "auto financing — Auto Expense"],
  ["Bentley Financial Services", "6304", "auto financing — Auto Expense"],
  ["Whitney Auto Service", "6304", "auto repair — Auto Expense"],
  ["DMV", "6346", "vehicle registration — Licenses & Fees"],
  // travel / meals
  ["Delta Airlines", "6303", "airline — Air Fare"],
  ["Jet Blue", "6303", "airline — Air Fare"],
  ["American Airlines", "6303", "airline — Air Fare"],
  ["Westin Hotels and Resorts", "6332", "hotel — Hotel Expense"],
  ["Hilton Hotels & Resorts Orlando", "6332", "hotel — Hotel Expense"],
  ["Hilton Hotels", "6332", "hotel — Hotel Expense"],
  ["AC Hotels by Marriott", "6332", "hotel — Hotel Expense"],
  ["Booking.com", "6332", "lodging bookings — Hotel Expense"],
  ["Uber", "6370", "rides — Travel"],
  ["Shamshiri Restaurant", "6349", "restaurant — Meals & Entertainment"],
  ["Rosies Kitchen", "6349", "restaurant — Meals & Entertainment"],
  ["Western Bagel", "6349", "food — Meals & Entertainment"],
  ["The Stand", "6349", "restaurant — Meals & Entertainment"],
  ["Mercato", "6349", "restaurant — Meals & Entertainment"],
  ["Doordash", "6349", "food delivery — Meals & Entertainment"],
  ["BevMo!", "6349", "beverages — Meals & Entertainment"],
  // trade shows / storage / charity
  ["SURF EXPO", "6608", "Trade Show Booth - Surf Expo (tailor-made)"],
  ["Southwest Mobile Storage", "6368", "Storage Container Expense (tailor-made)"],
  ["Chabad of Woodland Hills", "6309", "Charitable Contributions"],

  // ── 2026-07-10 CEO-authorized auto-set expansion ("auto set the vendor
  // expense accounts for the vendors you have bills for") — promoted MEDIUM
  // suggestions + name-classified tail. ⚠️ Codes must be ROF-entity postable:
  // 5110/5120/5130/5140/6510/6520/6524 belong to entity SAG and are unusable.
  // waste / facilities
  ["Action Carting Environmental Services, Inc.", "6310", "waste removal — Cleaning & Maintenance"],
  ["Filco carting", "6310", "waste removal — Cleaning & Maintenance"],
  ["Waste Management", "6310", "waste removal — Cleaning & Maintenance"],
  ["Coast to Coast Installations, LLC.", "6364", "installations — Repairs & Maintenance"],
  ["Millennium Steel", "6364", "materials/repairs — Repairs & Maintenance"],
  ["Coway USA", "6327", "water purifier rental — Equipment Rental"],
  ["Marlin Business Bank -Peac Solutions", "6327", "equipment lease financing (Peac) — Equipment Rental"],
  ["JSHU Investments", "6360", "landlord — Rent Expense"],
  ["Solomar Fixtures Inc.", "6353", "fixtures — Office Equipment"],
  ["LA DWP", "6350", "water & power — no utilities account in ROF COA; Miscellaneous"],
  // supplies
  ["Amazon", "6354", "mixed retail — Office Supplies"],
  ["Staples", "6354", "office supplies"],
  ["Dollar Tree", "6354", "misc supplies"],
  ["Target", "6354", "misc supplies"],
  ["Avery Dennison", "6374", "tags/labels/trims — Warehouse Supplies"],
  ["California Supply, Inc.", "6374", "supplies — Warehouse Supplies"],
  ["Packaging & More", "6374", "packaging — Warehouse Supplies"],
  ["Fineline Technologies", "6374", "price tickets/RFID tags — Warehouse Supplies"],
  ["Uline Shipping Supplies", "6374", "shipping supplies — Warehouse Supplies"],
  ["Uniforms Depot", "6374", "warehouse uniforms — Warehouse Supplies"],
  ["Costco Warehouse", "6381", "bulk food/supplies — Break Room Supplies"],
  ["Ralphs", "6381", "groceries — Break Room Supplies"],
  ["Vons", "6381", "groceries — Break Room Supplies"],
  ["Whole Foods", "6381", "groceries — Break Room Supplies"],
  ["Smart & Final", "6381", "groceries — Break Room Supplies"],
  ["Vallarta Supermarket", "6381", "groceries — Break Room Supplies"],
  ["7 Eleven", "6381", "snacks — Break Room Supplies"],
  ["CVS Pharmacy", "6350", "pharmacy/misc — Miscellaneous"],
  // insurance (promoted)
  ["The Hartford", "6337", "business insurer — General Liability Insurance"],
  ["Capital Premium for Travelers EPLI", "6336", "EPLI premium financing — E&O"],
  ["Banner Health", "6338", "medical — Medical Insurance"],
  // taxes / licenses / government
  ["California Department of Tax and Fee Admin", "6386", "state taxes & fees — Taxes & Licenses"],
  ["City of LA Business Tax", "6307", "LA business tax — Business License"],
  ["City of Los Angeles-Office of Finance", "6307", "LA business tax — Business License"],
  ["Los Angeles County Tax Collector", "6359", "property tax"],
  ["Utah Department of Agriculture and Food", "6346", "licenses & fees"],
  ["U.S. Customs and Border Protection", "6386", "customs duty — ROF has no Customs Duty account (5110/5120/5130 are entity SAG); Taxes & Licenses"],
  // software / web / processing
  ["Remote Techs, Inc.", "6311", "IT services — Computer Consulting"],
  ["Microsoft", "6314", "software — Computer Software"],
  ["Ship Station", "6314", "shipping software — Computer Software"],
  ["Saasant", "6302", "QuickBooks import tool — Accounting Software"],
  ["GoDaddy", "6709", "domains — Web Hosting"],
  ["Stamps.com", "6720", "Website Shipping stamps.com (tailor-made)"],
  ["Shutter Stock", "6325", "stock imagery — Dues and Subscriptions"],
  ["Route App, Inc dba Safe Order Solutions", "6325", "package protection — Dues and Subscriptions"],
  ["Pantone", "6321", "color standards — Design Supplies"],
  ["Intuit Payments", "6318", "Credit Card Processing Fees QB (tailor-made)"],
  ["Paypal", "6384", "payment processing — Merchant deposit fees"],
  ["eBay", "6384", "marketplace fees — 6520 is entity SAG; Merchant deposit fees"],
  ["Etsy, Inc.", "6384", "marketplace fees — 6520 is entity SAG; Merchant deposit fees"],
  ["Walmart", "6384", "marketplace fees — 6520 is entity SAG; Merchant deposit fees"],
  ["Attentive Mobile Inc.", "6601", "SMS marketing SaaS — Advertising & Marketing"],
  // freight tail
  ["DHL", "5405", "parcel carrier — Shipping Expense"],
  ["DHL Service", "5405", "parcel carrier — Shipping Expense"],
  // design / production / marketing services
  ["Trade Aider", "5204", "QC/inspection platform — Inspections Expense"],
  ["Ideal Fit Models", "5203", "Fit Model Expense (tailor-made)"],
  ["E.L.K Design Corp", "5202", "design services — Design Expense Freelance"],
  ["Nikki Benham Designs & Alterations", "5202", "design/alterations — Design Expense Freelance"],
  ["Photo Editor Company", "6704", "photo services"],
  ["BH Photo", "6603", "camera store — Photo Equipment"],
  ["Brand Model & Talent Agency, Inc", "6719", "models for shoots — Website Model Expense"],
  ["Expo Solutions", "6604", "trade show services — 5140 is entity SAG; Promotional Events"],
  ["Hello! Freeman", "6604", "trade show contractor (Freeman) — Promotional Events"],
  ["Orange County Covention Center Exhibitor", "6604", "trade show venue — Promotional Events"],
  ["Rosen Music Studio", "6604", "event services — Promotional Events"],
  // comp shopping (apparel retail purchases = design research/samples)
  ["Abercrombie & Fitch", "5206", "competitor comp shopping — Samples Expense"],
  ["Uniqlo", "5206", "competitor comp shopping — Samples Expense"],
  ["TJ Maxx", "5206", "competitor comp shopping — Samples Expense"],
  ["Ross Dress for Less", "5206", "competitor comp shopping — Samples Expense"],
  ["Nordstrom rack", "5206", "competitor comp shopping — Samples Expense"],
  ["The Levis Store", "5206", "competitor comp shopping — Samples Expense"],
  // contractors / staffing / commissions
  ["Freelancer", "6130", "freelance platform — Contractors"],
  ["Sourcefit", "6130", "offshore staffing/BPO — Contractors"],
  ["24 Seven LLC", "6130", "fashion staffing agency — Contractors"],
  ["Irene Navarro", "6130", "individual — Contractors"],
  ["Josue Gonzalez.", "6130", "individual — Contractors"],
  ["Ana V Salcedo", "6130", "individual — Contractors"],
  ["Aaron S. Yun", "6130", "individual — Contractors"],
  ["Roxy Sanchez", "6130", "individual — Contractors"],
  ["Robert Prather", "6130", "individual — Contractors"],
  ["Meghan Tudor", "6130", "individual — Contractors"],
  ["Henry Chan", "6130", "individual — Contractors"],
  ["Damian Valencia", "6130", "individual — Contractors"],
  ["June Macabanti", "6130", "individual — Contractors"],
  ["Same Bellosillo", "6130", "individual — Contractors"],
  ["Josefina Higuera", "6130", "individual — Contractors"],
  ["Raul Ruiz", "6130", "individual — Contractors"],
  ["Armando J Carlos", "6130", "individual — Contractors"],
  ["Armando Carlos", "6130", "individual — Contractors"],
  ["Analia Escalada", "6130", "individual — Contractors"],
  ["Ron Yoshida", "6130", "individual — Contractors"],
  ["Robert Halfon", "6130", "individual — Contractors"],
  ["Rick Garcia", "6130", "individual — Contractors"],
  ["Reggie B. Pooley", "6130", "individual — Contractors"],
  ["Marissa Morin", "6130", "individual — Contractors"],
  ["Dahna Tal", "6130", "individual — Contractors"],
  ["Efren X Zuniga", "6130", "individual — Contractors"],
  ["Emilio. Moncada", "6130", "individual — Contractors"],
  ["Nicole Benham", "6130", "individual — Contractors"],
  ["Spencer Lem", "6134", "Sales Commission - Spencer Lem (tailor-made)"],
  // professional / collections
  ["Caine & Weiner", "6344", "collections agency — Legal & Professional"],
  ["USCB America", "6344", "collections agency — Legal & Professional"],
  ["Perpl Fashion Consulting LLC", "6130", "fashion consulting — Contractors"],
  // misc
  ["Lehosheet Yad L.A", "6309", "charity — Charitable Contributions"],
  ["Apple.com", "6312", "hardware — Computer Hardware"],
  // travel / autos / meals tail
  ["E360 Travelers", "6370", "travel agency — Travel"],
  ["Expedia", "6370", "travel bookings — Travel"],
  ["Alamo", "6370", "car rental — Travel"],
  ["Lyft Ride", "6370", "rides — Travel"],
  ["Curb Taxi Las Vegas", "6370", "taxi — Travel"],
  ["Sidecar", "6370", "rides — Travel"],
  ["Ace Parking", "6370", "parking — Travel"],
  ["California Market Center Parking", "6370", "parking — Travel"],
  ["Hudson", "6351", "airport shop — Misc Travel"],
  ["SSP America", "6351", "airport food — Misc Travel"],
  ["The Line LA", "6332", "hotel — Hotel Expense"],
  ["Chevron Stations Inc.", "6304", "fuel — Auto Expense"],
  ["West Hills Towing", "6304", "towing — Auto Expense"],
  ["Ford", "6304", "auto — Auto Expense"],
  ["Alessa Cucina & Bar", "6349", "restaurant — Meals & Entertainment"],
  ["Celon Lounge", "6349", "restaurant — Meals & Entertainment"],
  ["Crumble Cookie", "6349", "food — Meals & Entertainment"],
  ["Diddy Riese", "6349", "food — Meals & Entertainment"],
  ["Goop Kitchen", "6349", "food — Meals & Entertainment"],
  ["Guidos Pizza & Pasta", "6349", "restaurant — Meals & Entertainment"],
  ["Mama's Donuts", "6349", "food — Meals & Entertainment"],
  ["Morton's The Steakhouse", "6349", "restaurant — Meals & Entertainment"],
  ["Mr. Broadway", "6349", "restaurant — Meals & Entertainment"],
  ["Paoli's Italian Kitchen", "6349", "restaurant — Meals & Entertainment"],
  ["Pascal Patisserie & Cafe", "6349", "restaurant — Meals & Entertainment"],
  ["Pogo's", "6349", "restaurant — Meals & Entertainment"],
  ["Rib Ranch BBQ", "6349", "restaurant — Meals & Entertainment"],
  ["Stella 34 Trattoria", "6349", "restaurant — Meals & Entertainment"],
  ["Sushi Gen", "6349", "restaurant — Meals & Entertainment"],
  ["Susie Cakes", "6349", "food — Meals & Entertainment"],
  ["Tel Aviv Grill Encino", "6349", "restaurant — Meals & Entertainment"],
  ["Toloache Restaurant", "6349", "restaurant — Meals & Entertainment"],
  ["Topanga Social", "6349", "food hall — Meals & Entertainment"],
  ["Uber Eats", "6349", "food delivery — Meals & Entertainment"],
  ["Villon Coffee FL", "6349", "coffee — Meals & Entertainment"],
  ["Wetzel's Pretzels", "6349", "food — Meals & Entertainment"],
  ["Wokcano Topanga", "6349", "restaurant — Meals & Entertainment"],
  ["Firefly Studio City", "6349", "restaurant — Meals & Entertainment"],
  ["Top Golf", "6349", "entertainment — Meals & Entertainment"],
];

// Vendors NEVER auto-reclassed even if a default account is set.
// 2026-07-10 CEO decision: Rosenthal exclusion LIFTED — the controller-reconciled
// Xoro AP bills are the factoring-cost source of truth; the 12 statement-derived
// #1670 factor_cost JEs ($515,690.72) were deleted, so the bill reclass to 6802
// no longer double-counts.
const EXCLUDE = new Map([]);

// CEO-CONFIRMED inventory vendors: their 8007 balance reclasses DR 1201
// Inventory / CR 8007 (journal_type 'vendor_inventory_reclass'). Rationale:
// these goods' sales already relieved 1201 via the AR COGS legs at average
// cost, so the missing purchase-side DR understated inventory — the reclass
// repairs it. Their default is also set to 1201 so the go-forward sweep
// routes future non-item lines to inventory. Add names here ONLY on an
// explicit CEO confirmation.
const INVENTORY_CONFIRMED = new Map([
  ["Factory 1", "CEO decision 2026-07-10: Factory 1 bills are inventory purchases"],
]);

// Inventory-SUSPECT vendors awaiting the CEO's confirm list (never auto-set;
// once confirmed, move the name into INVENTORY_CONFIRMED and re-run reclass).
// 2026-07-10 prepayment probe: register evidence (bill numbers, paid/relief
// columns) reviewed for every vendor here — see PREPAYMENT_OPEN / NET_ZERO
// below for the ones that turned out not to be plain goods invoices.
const INVENTORY_SUSPECT = new Map([
  ["CNX America Corp.", "goods invoices, NOT deposits: B005513 $209,690.17 (vendor bill BD/ROHM251109B, $25,000 deposit APPLIED) + B005662 $136,913.72 (R-045/2025-26, fully deposit-settled). Relief JEs already CR'd 1308 for the applied deposits, so cost stands ONCE — no double-count. Big two look like merchandise (verify); 4 small LAX-AR bills look like freight (6348)"],
  ["Interland Clothing", "garment vendor — real invoices (9163 $220,190.76 cash-paid 2024-09, CI-2025-0002 $2,800)"],
  ["2253 Apparel, Inc.", "apparel vendor — 5 spread bills, all still OPEN/due, normal invoice pattern"],
  ["Bien Roulee Fashion", "apparel vendor — 2 real paid invoices"],
  ["NEXT ELEVATION", "mixed: $79,083.30 of it (2 opening-backfill bills 2024-08-31) was settled by vendor credits — nets to zero vs 5005 (see NET_ZERO); the real cost is B006148 $23,544.00 paid 2026-04"],
  ["Lanny K.W. Inc.", "real invoices Am751A/787A/788A, paid"],
  ["iWin Group Corp.", "5 real invoices IWOI-#####, paid"],
  ["Aztlan Trading Inc.", "real invoice 10280, paid"],
]);

// OPEN vendor deposits (CEO 2026-07-10: "some of these look like prepayments
// prior to receiving the invoice"). Evidence: round amount, cash-paid in
// full, vendor bill number is just the payment date (no real invoice #), and
// NO subsequent absorbing invoice exists in the register or the live feed.
// Treatment: DR 1308 Vendor Prepayments & Deposits (asset) / CR 8007,
// journal_type 'vendor_prepayment_reclass'. The deposit sits in 1308 until
// the merchandise invoice arrives and the controller applies it. Do NOT set
// these vendors' defaults to 1308 — their future real invoices must not
// auto-route to the asset account (deposit routing stays a manual call).
const PREPAYMENT_OPEN = new Map([
  ["United Aryan (EPZ) Limited", "ROF-B005300 $80,000.00 paid 2025-12-05 (vendor bill ref '12052025' = the date), Kenyan garment manufacturer — deposit for a merchandise order; no absorbing invoice through 2026-07-10"],
  ["The Luxury Collection", "ROF-B005744 $25,000.00 paid 2026-02-25 (ref '022026' = the date) — deposit; no absorbing invoice through 2026-07-10"],
]);

// NET-ZERO rows: the bill's 8007 DR is exactly offset by the SAME bill's
// #1668 relief JE credit to 5005 (register said the bill was fully settled
// by vendor credits/discounts). Net P&L effect is already zero. Whether the
// "vendor credit" was a true credit (cost never happened) or a deposit
// application Xoro recorded as a credit (cost real, relief should have hit
// 1308) is NOT determinable from the data — controller decides; never
// auto-posted.
const NET_ZERO = new Map([
  ["Dynamic Full Ltd.", "PBPT-B005240 $40,000.00 (2025-11-28) settled 100% by vendor credit — relief CR 5005 $40,000 offsets the 8007 DR exactly"],
  ["Anhui Taihe Jiarun Garment Co Ltd", "ROF-B001818 $14,012.64 (opening backfill 2024-08-31) settled 100% by discount — relief CR 5005 offsets exactly"],
  ["Mass Apparel International", "ROF-B001815 $0.70 settled by vendor credit — offsets exactly"],
]);

// Related-party / financing rows: booked amounts may be distributions or loan
// principal, NOT P&L expense — flagged for the CEO/controller, never auto-set.
const FLAG = new Map([
  ["Bitton & Associates", "related-party name (Bitton) — may be distributions, not P&L"],
  ["Isaac Bitton", "related party — guaranteed payments / distributions? CEO classify"],
  ["Tao Rodriguez / Maria Villarreal (MOM's bank info for pymt)", "related-party payment routing — CEO classify"],
  ["Franchise Tax Board", "income/franchise tax — expense vs equity treatment is a CPA call"],
  ["State of California Franchise Tax Board", "income/franchise tax — expense vs equity treatment is a CPA call"],
  ["U.S. Small Business Administration", "SBA loan payments — principal is a liability, interest → 6342; controller split"],
  ["Venbrook Group LLC", "insurance broker — cannot split policy lines (GL/WC/property) from bill data; CEO/broker statement needed"],
  ["Valley Bank", "bank — fees vs loan principal unverifiable from bill data"],
  ["Accordia Life and Annuity Company", "life insurance — possibly officer life / non-deductible"],
  ["American General Life Insurance Company", "life insurance — possibly officer life / non-deductible"],
  ["Banner Life Insurance Company", "life insurance — possibly officer life / non-deductible"],
]);

// MEDIUM/LOW suggestions for the review CSV — NOT auto-posted. (Emptied
// 2026-07-10: the CEO authorized auto-setting defaults, so every actionable
// suggestion above was promoted into the auto-set mapping; the remaining
// unmapped vendors are INVENTORY_SUSPECT / FLAG / zero-signal LOW.)
const SUGGEST = new Map([]);

async function fetchAll(table, select, mod = (q) => q) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = admin.from(table).select(select).range(from, from + 999);
    q = mod(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table} read failed: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function loadContext() {
  const { data: entity, error: eErr } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  if (eErr || !entity) throw new Error("ROF entity not found");
  const accts = await fetchAll("gl_accounts", "id, code, name, is_postable, is_control, status",
    (q) => q.eq("entity_id", entity.id));
  const acctById = new Map(accts.map((a) => [a.id, a]));
  const postableByCode = new Map();
  for (const a of accts) {
    if (a.is_postable && !a.is_control && a.status === "active") {
      if (postableByCode.has(a.code)) throw new Error(`GL code ${a.code} is ambiguous (duplicate postable accounts) — refuse to map by code`);
      postableByCode.set(a.code, a);
    }
  }
  const a8007 = postableByCode.get("8007");
  const a2000 = accts.find((a) => a.code === "2000");
  const a1201 = postableByCode.get("1201"); // Inventory - ROF (postable, non-control)
  const a1308 = postableByCode.get("1308"); // Vendor Prepayments & Deposits (asset)
  if (!a8007 || !a2000) throw new Error("GL accounts 8007/2000 missing");
  if (!a1201) throw new Error("GL account 1201 (Inventory) missing/not postable — required for the inventory tier");
  if (!a1308) throw new Error("GL account 1308 (Vendor Prepayments & Deposits) missing/not postable — required for the prepayment tier");
  return { entity_id: entity.id, a8007, a2000, a1201, a1308, acctById, postableByCode };
}

// All posted 8007 lines from the per-bill AP engine, resolved to
// (vendor_id, YYYY-MM) buckets. Reclass JEs themselves (journal_type
// 'vendor_expense_reclass') are excluded by the journal_type filter, so the
// computation is stable across re-runs.
async function load8007Activity(ctx) {
  const lines = await fetchAll(
    "journal_entry_lines",
    "debit, credit, journal_entries!inner(posting_date, status, journal_type, source_table, source_id)",
    (q) => q.eq("account_id", ctx.a8007.id)
      .eq("journal_entries.status", "posted")
      .eq("journal_entries.journal_type", "ap_invoice_historical")
      .eq("journal_entries.source_table", "invoices")
      .order("id", { ascending: true }),
  );
  const invoiceIds = [...new Set(lines.map((l) => l.journal_entries.source_id))];
  const vendorByInvoice = new Map();
  for (let i = 0; i < invoiceIds.length; i += 200) {
    const { data, error } = await admin.from("invoices").select("id, vendor_id").in("id", invoiceIds.slice(i, i + 200));
    if (error) throw new Error(`invoices read failed: ${error.message}`);
    for (const r of data || []) vendorByInvoice.set(r.id, r.vendor_id);
  }
  // buckets: vendor_id -> ym -> { cents, n, maxDate }
  // perInvoice: invoice_id -> that bill's net 8007 accrual cents (used by
  //             xoro-verify to size each bill's "8007 slice" exactly)
  const buckets = new Map();
  const perInvoice = new Map();
  let unattributed = 0;
  for (const l of lines) {
    const je = l.journal_entries;
    const vendor_id = vendorByInvoice.get(je.source_id);
    if (!vendor_id) { unattributed += 1; continue; }
    const ym = String(je.posting_date).slice(0, 7);
    const cents = Math.round(Number(l.debit || 0) * 100) - Math.round(Number(l.credit || 0) * 100);
    perInvoice.set(je.source_id, (perInvoice.get(je.source_id) || 0) + cents);
    let byYm = buckets.get(vendor_id);
    if (!byYm) { byYm = new Map(); buckets.set(vendor_id, byYm); }
    const b = byYm.get(ym) || { cents: 0, n: 0, maxDate: "" };
    b.cents += cents; b.n += 1;
    if (String(je.posting_date) > b.maxDate) b.maxDate = String(je.posting_date);
    byYm.set(ym, b);
  }
  if (unattributed) console.log(`⚠️ ${unattributed} 8007 lines could not be attributed to a vendor (invoice row missing)`);
  return { buckets, lineCount: lines.length, perInvoice, vendorByInvoice };
}

async function loadVendors() {
  const rows = await fetchAll("vendors", "id, name, default_gl_expense_account_id", (q) => q.order("id", { ascending: true }));
  return new Map(rows.map((v) => [v.id, v]));
}

// Validated default expense account per vendor (same rules as the #1666 sweep:
// postable, non-control, active, this entity).
function validDefault(ctx, vendor) {
  const aid = vendor.default_gl_expense_account_id;
  if (!aid) return null;
  const a = ctx.acctById.get(aid);
  if (!a || !a.is_postable || a.is_control || a.status !== "active") return null;
  return a;
}

function monthEnd(ym) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 0)); // day 0 of next month = last day of ym
  return d.toISOString().slice(0, 10);
}

async function postJe(payload, healQuery) {
  const { data: jeId, error } = await admin.rpc("gl_post_journal_entry", { payload });
  if (!error) return { jeId };
  if (/duplicate key|uq_je_source/i.test(error.message || "")) {
    const { data: existing } = await healQuery();
    if (existing) return { jeId: existing.id, healed: true };
  }
  return { error: error.message };
}

// ── phases ───────────────────────────────────────────────────────────────────

async function phaseReport() {
  const ctx = await loadContext();
  const { buckets, lineCount } = await load8007Activity(ctx);
  const vendors = await loadVendors();
  const highByName = new Map(HIGH.map(([n, code, why]) => [n, { code, why }]));

  const rows = [];
  let total = 0;
  for (const [vendor_id, byYm] of buckets) {
    const v = vendors.get(vendor_id) || { name: `(unknown ${vendor_id})` };
    const cents = [...byYm.values()].reduce((s, b) => s + b.cents, 0);
    total += cents;
    const def = vendors.get(vendor_id) ? validDefault(ctx, vendors.get(vendor_id)) : null;
    const high = highByName.get(v.name);
    let tier, target, why;
    if (EXCLUDE.has(v.name)) { tier = "EXCLUDED"; target = ""; why = EXCLUDE.get(v.name); }
    else if (INVENTORY_CONFIRMED.has(v.name)) { tier = "INVENTORY"; target = "1201"; why = INVENTORY_CONFIRMED.get(v.name); }
    else if (PREPAYMENT_OPEN.has(v.name)) { tier = "PREPAYMENT"; target = "1308"; why = PREPAYMENT_OPEN.get(v.name); }
    else if (high) { tier = "HIGH"; target = high.code; why = high.why; }
    else if (def) { tier = "DEFAULT"; target = def.code; why = "vendor already has an operator-set default expense account"; }
    else if (INVENTORY_SUSPECT.has(v.name)) { tier = "INVENTORY?"; target = ""; why = `inventory-suspect, awaiting CEO confirmation — ${INVENTORY_SUSPECT.get(v.name)}`; }
    else if (NET_ZERO.has(v.name)) { tier = "NET-ZERO"; target = ""; why = NET_ZERO.get(v.name); }
    else if (FLAG.has(v.name)) { tier = "FLAG"; target = ""; why = FLAG.get(v.name); }
    else if (SUGGEST.has(v.name)) { const [code, t, r] = SUGGEST.get(v.name); tier = t; target = code; why = r; }
    else { tier = "LOW"; target = ""; why = "no confident name match — CEO classify"; }
    rows.push({ vendor_id, name: v.name, cents, months: byYm.size, tier, target, why, byYm });
  }
  rows.sort((a, b) => b.cents - a.cents);

  const sumTier = (t) => rows.filter((r) => r.tier === t).reduce((s, r) => s + r.cents, 0);
  console.log(`8007 activity: ${lineCount} lines, ${rows.length} vendors, $${$(total)}`);
  for (const t of ["INVENTORY", "PREPAYMENT", "HIGH", "DEFAULT", "INVENTORY?", "NET-ZERO", "FLAG", "MEDIUM", "LOW", "EXCLUDED"]) {
    console.log(`  ${t}: ${rows.filter((r) => r.tier === t).length} vendors  $${$(sumTier(t))}`);
  }
  console.log("\nauto-reclass set (INVENTORY + PREPAYMENT + HIGH + DEFAULT), top 25:");
  for (const r of rows.filter((r) => ["INVENTORY", "PREPAYMENT", "HIGH", "DEFAULT"].includes(r.tier)).slice(0, 25)) {
    console.log(`  ${r.name} -> ${r.target}: $${$(r.cents)} over ${r.months} mo (${r.tier})`);
  }

  // review CSV: everything NOT auto-reclassed
  const esc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const csvRows = [["vendor", "total", "months_active", "monthly_totals", "suggested_account", "confidence", "reason"].join(",")];
  for (const r of rows.filter((x) => ["INVENTORY?", "NET-ZERO", "FLAG", "MEDIUM", "LOW", "EXCLUDED"].includes(x.tier))) {
    const monthly = [...r.byYm.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([ym, b]) => `${ym}: $${$(b.cents)}`).join("; ");
    const sug = r.target ? `${r.target} — ${(ctx.postableByCode.get(r.target) || {}).name || ""}` : "";
    csvRows.push([esc(r.name), esc(`$${$(r.cents)}`), r.months, esc(monthly), esc(sug), r.tier === "EXCLUDED" ? "FLAG" : r.tier, esc(r.why)].join(","));
  }
  const csvPath = resolve(ROOT, "docs/tangerine/ap-8007-review.csv");
  mkdirSync(dirname(csvPath), { recursive: true });
  writeFileSync(csvPath, csvRows.join("\n") + "\n");
  console.log(`\nreview CSV (${csvRows.length - 1} vendors) -> ${csvPath}`);

  // Open Vendor Deposits schedule for the controller (apply/clear worklist).
  const depRows = [["vendor", "date_paid", "amount", "age_days", "reference", "evidence", "status"].join(",")];
  const today = new Date();
  for (const r of rows.filter((x) => x.tier === "PREPAYMENT")) {
    for (const [ym, b] of [...r.byYm.entries()].sort()) {
      const paid = b.maxDate || `${ym}-01`;
      const age = Math.round((today - new Date(paid)) / 86400000);
      depRows.push([esc(r.name), paid, esc(`$${$(b.cents)}`), age, esc(""), esc(r.why), "OPEN — in 1308, awaiting invoice application"].join(","));
    }
  }
  const depPath = resolve(ROOT, "docs/tangerine/ap-vendor-deposits.csv");
  writeFileSync(depPath, depRows.join("\n") + "\n");
  console.log(`open vendor deposits schedule (${depRows.length - 1} rows) -> ${depPath}`);
  return rows;
}

async function phaseSetDefaults({ dryRun }) {
  const ctx = await loadContext();
  const vendors = await loadVendors();
  const byName = new Map([...vendors.values()].map((v) => [v.name, v]));
  let set = 0, kept = 0, missing = 0;
  // CEO-confirmed inventory vendors get default 1201 so the go-forward sweep
  // routes their future non-item lines to inventory (1201 is postable +
  // non-control, so it passes the #1666 sweep validation).
  const mappings = [...INVENTORY_CONFIRMED.keys()].map((n) => [n, "1201", INVENTORY_CONFIRMED.get(n)]).concat(HIGH);
  for (const [name, code, why] of mappings) {
    const v = byName.get(name);
    if (!v) { missing += 1; console.log(`  vendor not found: ${name}`); continue; }
    const acct = ctx.postableByCode.get(code);
    if (!acct) throw new Error(`mapping account ${code} not postable/active — fix mapping`);
    if (v.default_gl_expense_account_id) {
      kept += 1;
      const cur = ctx.acctById.get(v.default_gl_expense_account_id);
      if (v.default_gl_expense_account_id !== acct.id) {
        console.log(`  KEEPING operator default on ${name}: ${cur ? cur.code : v.default_gl_expense_account_id} (mapping suggested ${code})`);
      }
      continue;
    }
    if (dryRun) { set += 1; console.log(`  would set ${name} -> ${code} ${acct.name} (${why})`); continue; }
    const { error } = await admin.from("vendors").update({ default_gl_expense_account_id: acct.id }).eq("id", v.id);
    if (error) throw new Error(`set default failed for ${name}: ${error.message}`);
    set += 1;
    console.log(`  set ${name} -> ${code} ${acct.name}`);
  }
  console.log(`set-defaults${dryRun ? " (dry-run)" : ""}: ${set} set, ${kept} already had one (kept), ${missing} vendor names not found`);
}

async function phaseReclass({ dryRun, limit }) {
  const ctx = await loadContext();
  const { buckets } = await load8007Activity(ctx);
  const vendors = await loadVendors();
  const today = new Date().toISOString().slice(0, 10);

  let posted = 0, postedCents = 0, healed = 0, skippedNoDefault = 0, excluded = 0, errors = 0, done = 0;
  const work = [...buckets.entries()].map(([vendor_id, byYm]) => ({ vendor_id, byYm, v: vendors.get(vendor_id) }))
    .filter((w) => w.v)
    .sort((a, b) => (a.v.name < b.v.name ? -1 : 1));

  for (const w of work) {
    if (EXCLUDE.has(w.v.name)) {
      excluded += 1;
      console.log(`  EXCLUDED ${w.v.name}: $${$([...w.byYm.values()].reduce((s, b) => s + b.cents, 0))} left in 8007 — ${EXCLUDE.get(w.v.name)}`);
      continue;
    }
    // CEO-confirmed inventory vendors reclass to 1201 Inventory; open vendor
    // deposits reclass to 1308 Vendor Prepayments & Deposits — both with
    // distinct journal_types (BS moves, not P&L category moves).
    const isInventory = INVENTORY_CONFIRMED.has(w.v.name);
    const isPrepayment = !isInventory && PREPAYMENT_OPEN.has(w.v.name);
    const target = isInventory ? ctx.a1201 : isPrepayment ? ctx.a1308 : validDefault(ctx, w.v);
    if (!target) { skippedNoDefault += 1; continue; }
    if (target.id === ctx.a8007.id) { skippedNoDefault += 1; continue; } // default IS 8007 — nothing to move

    for (const [ym, b] of [...w.byYm.entries()].sort((a, x) => (a[0] < x[0] ? -1 : 1))) {
      if (b.cents === 0) continue;
      if (limit && done >= limit) break;
      done += 1;
      // SOURCE-month dating: month-end; for the in-flight current month use
      // the latest 8007 line date so we never post a future-dated JE.
      const me = monthEnd(ym);
      const posting_date = me > today ? b.maxDate : me;
      const lines = [
        {
          line_number: 1,
          account_id: target.id,
          debit: b.cents > 0 ? dollars(b.cents) : "0",
          credit: b.cents < 0 ? dollars(-b.cents) : "0",
          memo: `Reclass from 8007 — ${w.v.name} — ${ym} (${b.n} bill line${b.n === 1 ? "" : "s"})`,
        },
        {
          line_number: 2,
          account_id: ctx.a8007.id,
          debit: b.cents < 0 ? dollars(-b.cents) : "0",
          credit: b.cents > 0 ? dollars(b.cents) : "0",
          memo: `Reclass to ${target.code} ${target.name} — ${w.v.name} — ${ym}`,
        },
      ];
      if (dryRun) { posted += 1; postedCents += b.cents; continue; }
      const payload = {
        entity_id: ctx.entity_id,
        basis: "ACCRUAL",
        journal_type: isInventory ? "vendor_inventory_reclass" : isPrepayment ? "vendor_prepayment_reclass" : "vendor_expense_reclass",
        posting_date,
        source_module: "ap",
        source_table: "vendor_expense_reclass",
        source_id: `${w.vendor_id}:${ym}`,
        description: `8007 reclass — ${w.v.name} — ${ym} -> ${target.code} ${target.name}`,
        audit_reason: isInventory
          ? `AP 8007 cleanup — ${INVENTORY_CONFIRMED.get(w.v.name)}: move $${$(b.cents)} of ${ym} charges from ${w.v.name} to 1201 Inventory. The goods' sales already relieved 1201 via the AR COGS legs at average cost, so the missing purchase-side DR understated inventory; this repairs it. Per-vendor-per-month reclass dated to the source month — AP 2000 untouched.`
          : isPrepayment
            ? `AP 8007 cleanup — open vendor deposit (CEO 2026-07-10 prepayment guidance): move $${$(b.cents)} of ${ym} charges from ${w.v.name} to 1308 Vendor Prepayments & Deposits. Evidence: ${PREPAYMENT_OPEN.get(w.v.name)}. Not an expense — it is a deposit asset awaiting application to the merchandise invoice (controller clears via 1308). Dated to the source month — AP 2000 untouched.`
            : `AP 8007 Uncategorized Expense cleanup: move $${$(b.cents)} of ${ym} charges from vendor ${w.v.name} to its default expense account ${target.code} ${target.name} (vendor default expense mapping; per-vendor-per-month reclass dated to the source month). Expense-to-expense only — AP 2000 untouched.`,
        lines,
      };
      const r = await postJe(payload, () => admin.from("journal_entries").select("id")
        .eq("source_table", "vendor_expense_reclass").eq("source_id", `${w.vendor_id}:${ym}`)
        .eq("basis", "ACCRUAL").maybeSingle());
      if (r.error) { errors += 1; console.error(`  ${w.v.name} ${ym}: ${r.error}`); continue; }
      if (r.healed) healed += 1;
      posted += 1; postedCents += b.cents;
      if (posted % 100 === 0) console.log(`  … ${posted} reclass JEs ($${$(postedCents)})`);
    }
    if (limit && done >= limit) break;
  }
  console.log(`reclass${dryRun ? " (dry-run)" : ""}: ${posted} (vendor, month) JEs moving $${$(postedCents)} out of 8007 (${healed} pre-existing/healed), ${skippedNoDefault} vendors left (no default account), ${excluded} excluded, ${errors} errors`);
  if (errors) process.exit(1);
}

async function phaseVerify() {
  const ctx = await loadContext();
  // trial balance: 8007, 2000, and whole-ledger imbalance
  const tb = await fetchAll("v_trial_balance", "code, name, debit_cents, credit_cents",
    (q) => q.eq("entity_id", ctx.entity_id).eq("basis", "ACCRUAL"));
  const toC = (v) => Math.round(Number(v || 0));
  let imbalance = 0;
  for (const r of tb) imbalance += toC(r.debit_cents) - toC(r.credit_cents);
  const row8007 = tb.find((r) => r.code === "8007");
  const row2000 = tb.find((r) => r.code === "2000");
  const net8007 = row8007 ? toC(row8007.debit_cents) - toC(row8007.credit_cents) : 0;
  const net2000 = row2000 ? toC(row2000.debit_cents) - toC(row2000.credit_cents) : 0;
  console.log(`GL 8007 net DR: $${$(net8007)}`);
  // The 2000 invariant is "unchanged by the reclass" (nightly AP sweeps move
  // it legitimately) — proven structurally below by counting reclass lines on
  // 2000, which must be zero. The balance is printed for the operator's
  // before/after snapshot.
  console.log(`GL 2000 net CR: $${$(-net2000)}  (reclass must not move it — see reclass-lines-on-2000 check)`);
  console.log(`trial-balance imbalance: $${$(imbalance)} (must be 0.00)`);

  // structural 2000 guard: no reclass JE line may touch the AP control account
  const { count: n2000, error: g2000Err } = await admin
    .from("journal_entry_lines")
    .select("id, journal_entries!inner(journal_type)", { count: "exact", head: true })
    .eq("account_id", ctx.a2000.id)
    .in("journal_entries.journal_type", ["vendor_expense_reclass", "vendor_inventory_reclass", "vendor_prepayment_reclass"]);
  if (g2000Err) throw new Error(g2000Err.message);
  console.log(`reclass lines on 2000: ${n2000 ?? 0} (must be 0)`);

  // 8007 by month AFTER (all journal types)
  const lines = await fetchAll(
    "journal_entry_lines",
    "debit, credit, journal_entries!inner(posting_date, status)",
    (q) => q.eq("account_id", ctx.a8007.id).eq("journal_entries.status", "posted").order("id", { ascending: true }),
  );
  const byYm = new Map();
  for (const l of lines) {
    const ym = String(l.journal_entries.posting_date).slice(0, 7);
    byYm.set(ym, (byYm.get(ym) || 0) + Math.round(Number(l.debit || 0) * 100) - Math.round(Number(l.credit || 0) * 100));
  }
  console.log("\n8007 by month after reclass:");
  for (const [ym, c] of [...byYm.entries()].sort()) console.log(`  ${ym}: $${$(c)}`);

  // every reclass JE balanced? (both expense and inventory reclass types)
  const reclassJes = await fetchAll("journal_entries", "id, posting_date, description",
    (q) => q.in("journal_type", ["vendor_expense_reclass", "vendor_inventory_reclass", "vendor_prepayment_reclass"]).eq("status", "posted"));
  const jeIds = reclassJes.map((j) => j.id);
  let jeImbalance = 0, checked = 0;
  for (let i = 0; i < jeIds.length; i += 100) {
    const { data, error } = await admin.from("journal_entry_lines")
      .select("journal_entry_id, debit, credit").in("journal_entry_id", jeIds.slice(i, i + 100)).range(0, 9999);
    if (error) throw new Error(error.message);
    const per = new Map();
    for (const l of data || []) {
      per.set(l.journal_entry_id, (per.get(l.journal_entry_id) || 0) + Math.round(Number(l.debit || 0) * 100) - Math.round(Number(l.credit || 0) * 100));
    }
    for (const [, c] of per) { checked += 1; if (c !== 0) jeImbalance += 1; }
  }
  console.log(`\nreclass JEs posted: ${reclassJes.length}; balanced: ${checked - jeImbalance}/${checked} (unbalanced: ${jeImbalance})`);
}

// ── xoro-verify (#xoro-account-truth 2026-07-11) ─────────────────────────────
// CEO directive (NON-NEG): Xoro's GL is the 100% source of truth for
// classifications. The bill feed now persists each line's Xoro expense
// account (invoice_line_items.xoro_expense_account_name / expense_account_id,
// resolved by api/_lib/accounting/xoroAccountMap.js) plus xoro_item_type
// ('Inventory' = Xoro posts the line to the inventory asset).
//
// This phase re-verifies every (vendor, month) 8007-origin bucket against
// that evidence:
//   MATCH     Xoro agrees with where the money currently sits (original
//             reclass target, or prior corrections).
//   DIFF      Xoro says a different, resolvable ROF account — a correction
//             JE (DR correct / CR current holder) posts unless --dry-run,
//             dated to the source month, source_id
//             '<vendor_id>:<YYYY-MM>:xoro-correction' (idempotent; reruns
//             after mapping additions get a -2/-3 suffix and converge
//             because placements already net prior corrections).
//   UNMAPPED  Xoro names with no ROF COA equivalent — reported to
//             docs/tangerine/xoro-account-name-map.csv for the CEO mapping
//             table; NEVER posted.
//   NO-SIGNAL bill/getbill exposes no line for the money (Xoro "expense
//             bills" return header-only via REST) — stays put, reported.
// FLAG (related-party/financing) and NET-ZERO vendors are ALWAYS
// report-only: their Xoro evidence is printed but nothing posts (equity/
// loan/credit-pairing questions are the controller's).
//
// Bill slice sizing: each bill's exact 8007 accrual cents come from its own
// accrual JE (load8007Activity.perInvoice). If the slice equals the bill
// total (register header-grain accruals), ALL lines are evidence — including
// Inventory-typed goods lines (that IS Xoro's inventory confirmation). If
// the accrual already split goods to 1201 (#1662 sweep bills), item-linked
// lines are excluded and only the non-goods slice is verified.

const XV_CUTOVER = "2024-08-31"; // opening cutover — accruals clamp here
const xvClamp = (d) => (d && d < XV_CUTOVER ? XV_CUTOVER : d);

// Proportionally scale an integer-cents map so its sum equals `target`
// (largest-remainder rounding; mutates + returns the map).
function scaleCentsMap(map, target) {
  const sum = [...map.values()].reduce((s, c) => s + c, 0);
  if (sum <= 0 || sum <= target) return map;
  let allocated = 0;
  const entries = [...map.entries()];
  for (const [k, c] of entries) {
    const scaled = Math.floor((c * target) / sum);
    map.set(k, scaled); allocated += scaled;
  }
  // distribute the rounding remainder to the largest buckets
  const rest = target - allocated;
  const order = entries.sort((a, b) => b[1] - a[1]);
  for (let i = 0; i < rest && order.length; i += 1) {
    const k = order[i % order.length][0];
    map.set(k, map.get(k) + 1);
  }
  return map;
}

async function phaseXoroVerify({ dryRun, limit }) {
  const ctx = await loadContext();
  const vendors = await loadVendors();
  const { buckets, perInvoice } = await load8007Activity(ctx);
  const resolveAccount = buildXoroAccountResolver([...ctx.acctById.values()]);
  const today = new Date().toISOString().slice(0, 10);

  // ── current placement per bucket: reclass-family JEs (incl. prior
  // corrections) keyed '<vendor>:<ym>' move cents out of 8007 ──────────────
  const reclassJes = await fetchAll("journal_entries", "id, source_id, journal_type",
    (q) => q.eq("source_table", "vendor_expense_reclass").eq("status", "posted"));
  const jeById = new Map(reclassJes.map((j) => [j.id, j]));
  const movedByBucket = new Map(); // key -> Map(account_id -> net DR cents)
  const correctionCountByBucket = new Map(); // key -> # of prior xoro-correction JEs
  for (const j of reclassJes) {
    const parts = String(j.source_id).split(":");
    if (parts.length >= 3 && parts[2].startsWith("xoro-")) {
      const key = `${parts[0]}:${parts[1]}`;
      correctionCountByBucket.set(key, (correctionCountByBucket.get(key) || 0) + 1);
    }
  }
  const jeIds = reclassJes.map((j) => j.id);
  for (let i = 0; i < jeIds.length; i += 100) {
    const { data, error } = await admin.from("journal_entry_lines")
      .select("journal_entry_id, account_id, debit, credit")
      .in("journal_entry_id", jeIds.slice(i, i + 100)).range(0, 9999);
    if (error) throw new Error(error.message);
    for (const l of data || []) {
      const je = jeById.get(l.journal_entry_id);
      if (!je) continue;
      const key = String(je.source_id).split(":").slice(0, 2).join(":");
      const cents = Math.round(Number(l.debit || 0) * 100) - Math.round(Number(l.credit || 0) * 100);
      let m = movedByBucket.get(key);
      if (!m) { m = new Map(); movedByBucket.set(key, m); }
      m.set(l.account_id, (m.get(l.account_id) || 0) + cents);
    }
  }

  // ── evidence: bills → buckets, evidence rollup rows per bill ─────────────
  const invRows = await fetchAll("invoices",
    "id, vendor_id, invoice_number, invoice_date, posting_date, total_amount_cents, source",
    (q) => q.eq("invoice_kind", "vendor_bill"));
  const invById = new Map(invRows.map((r) => [r.id, r]));
  const evRows = await fetchAll("v_ap_bill_xoro_evidence", "*");
  const evByInvoice = new Map();
  for (const r of evRows) {
    let a = evByInvoice.get(r.invoice_id);
    if (!a) { a = []; evByInvoice.set(r.invoice_id, a); }
    a.push(r);
  }

  // Coverage stats (bills reachable via the REST walk carry line evidence)
  let covBills = 0, covBillsWithEvidence = 0, covLines = 0, covLinesWithAcct = 0;
  for (const inv of invRows) {
    covBills += 1;
    const rows = evByInvoice.get(inv.id) || [];
    if (rows.some((r) => r.xoro_expense_account_name || String(r.xoro_item_type || "").toLowerCase() === "inventory")) covBillsWithEvidence += 1;
    for (const r of rows) {
      covLines += Number(r.n_lines || 0);
      if (r.xoro_expense_account_name) covLinesWithAcct += Number(r.n_lines || 0);
    }
  }

  // Per-bucket evidence: resolved account cents / unmapped names / no-signal
  const evidenceByBucket = new Map(); // key -> {resolved: Map(acctId->cents), unmapped: Map(name->cents), nosignal, bills, evBills}
  const globalUnmapped = new Map();   // name -> {cents, n}
  for (const [invoiceId, slice] of perInvoice) {
    if (slice <= 0) continue; // credit-memo/negative slices stay manual
    const inv = invById.get(invoiceId);
    if (!inv) continue;
    const byYm = buckets.get(inv.vendor_id);
    if (!byYm) continue;
    const pd = xvClamp(inv.posting_date || inv.invoice_date);
    if (!pd) continue;
    const ym = String(pd).slice(0, 7);
    if (!byYm.has(ym)) continue;
    const key = `${inv.vendor_id}:${ym}`;
    let agg = evidenceByBucket.get(key);
    if (!agg) { agg = { resolved: new Map(), unmapped: new Map(), nosignal: 0, bills: 0, evBills: 0 }; evidenceByBucket.set(key, agg); }
    agg.bills += 1;

    const fullBill = slice === Math.round(Number(inv.total_amount_cents) || 0);
    const rows = (evByInvoice.get(invoiceId) || [])
      .filter((r) => fullBill || !r.item_linked);

    // classify this bill's evidence
    const resolved = new Map(); const unmapped = new Map(); let nosignal = 0; let any = false;
    for (const r of rows) {
      const cents = Number(r.cents || 0);
      if (cents === 0) continue;
      const name = String(r.xoro_expense_account_name || "").trim();
      if (name) {
        any = true;
        const hit = resolveAccount(name);
        if (hit) resolved.set(hit.account.id, (resolved.get(hit.account.id) || 0) + cents);
        else unmapped.set(name, (unmapped.get(name) || 0) + cents);
      } else if (String(r.xoro_item_type || "").toLowerCase() === "inventory") {
        any = true;
        resolved.set(ctx.a1201.id, (resolved.get(ctx.a1201.id) || 0) + cents);
      } else {
        nosignal += cents;
      }
    }
    if (any) agg.evBills += 1;
    // scale the bill's evidence down to its exact 8007 slice if it overshoots
    const combined = new Map();
    for (const [k, c] of resolved) combined.set(`A:${k}`, c);
    for (const [k, c] of unmapped) combined.set(`U:${k}`, c);
    if (nosignal > 0) combined.set("N:", nosignal);
    scaleCentsMap(combined, slice);
    let counted = 0;
    for (const [k, c] of combined) {
      counted += c;
      if (k.startsWith("A:")) agg.resolved.set(k.slice(2), (agg.resolved.get(k.slice(2)) || 0) + c);
      else if (k.startsWith("U:")) {
        const nm = k.slice(2);
        agg.unmapped.set(nm, (agg.unmapped.get(nm) || 0) + c);
        const g = globalUnmapped.get(nm) || { cents: 0, n: 0 };
        g.cents += c; g.n += 1; globalUnmapped.set(nm, g);
      } else agg.nosignal += c;
    }
    if (counted < slice) agg.nosignal += slice - counted; // header-only remainder
  }

  // ── compare, bucket by bucket ────────────────────────────────────────────
  const esc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const acctLabel = (id) => { const a = ctx.acctById.get(id); return a ? `${a.code} ${a.name}` : id; };
  const reportRows = [["vendor", "month", "bucket_total", "current_placement", "xoro_says", "match", "diff_moves", "unmapped", "no_signal", "action"].join(",")];
  let tMatch = 0, tDiff = 0, tUnmapped = 0, tNosignal = 0;
  let posted = 0, healed = 0, errors = 0, flaggedOnly = 0, done = 0;
  const diffList = [];

  const work = [...buckets.entries()]
    .flatMap(([vendor_id, byYm]) => [...byYm.entries()].map(([ym, b]) => ({ vendor_id, ym, b, v: vendors.get(vendor_id) })))
    .filter((w) => w.v)
    .sort((a, x) => (a.v.name === x.v.name ? (a.ym < x.ym ? -1 : 1) : a.v.name < x.v.name ? -1 : 1));

  for (const w of work) {
    const key = `${w.vendor_id}:${w.ym}`;
    if (w.b.cents <= 0) continue; // negative/zero buckets stay manual

    // current placement: 8007 residual + net moves per account
    const placements = new Map(); // account_id -> cents currently holding
    let residual8007 = w.b.cents;
    const moved = movedByBucket.get(key);
    if (moved) {
      for (const [acctId, cents] of moved) {
        if (acctId === ctx.a8007.id) { residual8007 += cents; continue; }
        if (cents !== 0) placements.set(acctId, (placements.get(acctId) || 0) + cents);
      }
    }
    if (residual8007 !== 0) placements.set(ctx.a8007.id, residual8007);

    const agg = evidenceByBucket.get(key) || { resolved: new Map(), unmapped: new Map(), nosignal: w.b.cents, bills: 0, evBills: 0 };

    // greedy netting: satisfy Xoro's desired accounts from current placements
    const need = new Map(agg.resolved);
    const have = new Map(placements);
    let match = 0;
    for (const [acctId, cents] of [...need.entries()]) {
      const h = have.get(acctId) || 0;
      const sat = Math.min(cents, h);
      if (sat > 0) {
        match += sat;
        need.set(acctId, cents - sat);
        have.set(acctId, h - sat);
      }
    }
    const moves = []; // { from, to, cents }
    const givers = [...have.entries()].filter(([, c]) => c > 0).sort((a, x) => x[1] - a[1]);
    for (const [toAcct, wanted] of [...need.entries()].sort((a, x) => x[1] - a[1])) {
      let remaining = wanted;
      for (const g of givers) {
        if (remaining <= 0) break;
        if (g[1] <= 0) continue;
        const take = Math.min(remaining, g[1]);
        if (toAcct !== g[0] && take > 0) moves.push({ from: g[0], to: toAcct, cents: take });
        g[1] -= take; remaining -= take;
      }
    }
    const diffCents = moves.reduce((s, m) => s + m.cents, 0);
    const unmappedCents = [...agg.unmapped.values()].reduce((s, c) => s + c, 0);
    tMatch += match; tDiff += diffCents; tUnmapped += unmappedCents; tNosignal += agg.nosignal;

    const isFlagged = FLAG.has(w.v.name) || NET_ZERO.has(w.v.name) || EXCLUDE.has(w.v.name);
    let action = "none";
    if (moves.length) {
      action = isFlagged ? "FLAG — report only (related-party/financing/net-zero: controller decides)" : "correction JE";
      diffList.push({ vendor: w.v.name, ym: w.ym, moves, flagged: isFlagged });
    }

    reportRows.push([
      esc(w.v.name), w.ym, esc(`$${$(w.b.cents)}`),
      esc([...placements.entries()].map(([a, c]) => `${acctLabel(a)}: $${$(c)}`).join("; ")),
      esc([...agg.resolved.entries()].map(([a, c]) => `${acctLabel(a)}: $${$(c)}`).join("; ")),
      esc(`$${$(match)}`),
      esc(moves.map((m) => `${acctLabel(m.from)} -> ${acctLabel(m.to)}: $${$(m.cents)}`).join("; ")),
      esc([...agg.unmapped.entries()].map(([n, c]) => `${n}: $${$(c)}`).join("; ")),
      esc(`$${$(agg.nosignal)}`),
      esc(action),
    ].join(","));

    if (!moves.length || isFlagged) { if (moves.length) flaggedOnly += 1; continue; }
    if (limit && done >= limit) continue;
    done += 1;
    if (dryRun) { posted += 1; continue; }

    // correction JE: net per account across the moves, dated to source month
    const net = new Map();
    for (const m of moves) {
      net.set(m.to, (net.get(m.to) || 0) + m.cents);
      net.set(m.from, (net.get(m.from) || 0) - m.cents);
    }
    const me = monthEnd(w.ym);
    const posting_date = me > today ? (w.b.maxDate || today) : me;
    const lines = [];
    for (const [acctId, cents] of [...net.entries()].sort((a, x) => x[1] - a[1])) {
      if (cents === 0) continue;
      lines.push({
        line_number: lines.length + 1,
        account_id: acctId,
        debit: cents > 0 ? dollars(cents) : "0",
        credit: cents < 0 ? dollars(-cents) : "0",
        memo: `Xoro-truth correction — ${w.v.name} — ${w.ym}`,
      });
    }
    const priorCorrections = correctionCountByBucket.get(key) || 0;
    const source_id = `${key}:xoro-correction${priorCorrections ? `-${priorCorrections + 1}` : ""}`;
    const evidenceDesc = moves.map((m) => `$${$(m.cents)} ${acctLabel(m.from)} -> ${acctLabel(m.to)}`).join("; ");
    const payload = {
      entity_id: ctx.entity_id,
      basis: "ACCRUAL",
      journal_type: "vendor_expense_reclass",
      posting_date,
      source_module: "ap",
      source_table: "vendor_expense_reclass",
      source_id,
      description: `Xoro-truth correction — ${w.v.name} — ${w.ym}: ${evidenceDesc}`,
      audit_reason: `#xoro-account-truth correction (CEO directive: Xoro GL is the 100% source of truth for classifications). Bill-line evidence from Xoro bill/getbill (invoice_line_items.xoro_expense_account_name / xoro_item_type over ${agg.evBills}/${agg.bills} bills in this vendor-month) says the money belongs at: ${evidenceDesc}. Prior placement came from the name-heuristic 8007 reclass (#1675/#1680/#1681); this re-points it to Xoro's own account. Dated to the source month — AP 2000 untouched.`,
      lines,
    };
    const r = await postJe(payload, () => admin.from("journal_entries").select("id")
      .eq("source_table", "vendor_expense_reclass").eq("source_id", source_id)
      .eq("basis", "ACCRUAL").maybeSingle());
    if (r.error) { errors += 1; console.error(`  ${w.v.name} ${w.ym}: ${r.error}`); continue; }
    if (r.healed) healed += 1;
    posted += 1;
  }

  // ── output ───────────────────────────────────────────────────────────────
  console.log("coverage (all vendor_bill invoices):");
  console.log(`  bills: ${covBills}; with Xoro line evidence: ${covBillsWithEvidence} (${(covBillsWithEvidence / Math.max(1, covBills) * 100).toFixed(1)}%)`);
  console.log(`  lines: ${covLines}; with a Xoro expense account name: ${covLinesWithAcct} (${(covLinesWithAcct / Math.max(1, covLines) * 100).toFixed(1)}%)`);
  console.log("\n8007-origin verification vs Xoro accounts:");
  console.log(`  MATCH     $${$(tMatch)} (Xoro agrees with current placement)`);
  console.log(`  DIFF      $${$(tDiff)} (Xoro says a different account — corrections)`);
  console.log(`  UNMAPPED  $${$(tUnmapped)} (Xoro name has no ROF COA equivalent — CEO mapping table)`);
  console.log(`  NO-SIGNAL $${$(tNosignal)} (REST exposes no line/account for the money — stays put)`);
  if (diffList.length) {
    console.log(`\nDIFF list (${diffList.length} vendor-months):`);
    for (const d of diffList) {
      for (const m of d.moves) console.log(`  ${d.flagged ? "[FLAG] " : ""}${d.vendor} ${d.ym}: ${acctLabel(m.from)} -> ${acctLabel(m.to)} $${$(m.cents)}`);
    }
  }
  console.log(`\ncorrections${dryRun ? " (dry-run)" : ""}: ${posted} JEs (${healed} healed/pre-existing), ${flaggedOnly} FLAG/NET-ZERO report-only, ${errors} errors`);

  const csvPath = resolve(ROOT, "docs/tangerine/ap-xoro-verify.csv");
  mkdirSync(dirname(csvPath), { recursive: true });
  writeFileSync(csvPath, reportRows.join("\n") + "\n");
  console.log(`bucket-grain report -> ${csvPath}`);

  // unmatched-name mapping table for the CEO/controller
  const mapRows = [["xoro_account_name", "occurrences", "dollars", "suggested_rof_account", "notes"].join(",")];
  for (const [name, g] of [...globalUnmapped.entries()].sort((a, x) => x[1].cents - a[1].cents)) {
    mapRows.push([esc(name), g.n, esc(`$${$(g.cents)}`), "", ""].join(","));
  }
  const mapPath = resolve(ROOT, "docs/tangerine/xoro-account-name-map.csv");
  writeFileSync(mapPath, mapRows.join("\n") + "\n");
  console.log(`unmatched Xoro account names (${mapRows.length - 1}) -> ${mapPath} (add entries to XORO_TO_ROF_CODE in api/_lib/accounting/xoroAccountMap.js and re-run)`);
  if (errors) process.exit(1);
}

// ── entry ────────────────────────────────────────────────────────────────────
const phase = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : 0;

const phases = {
  report: phaseReport,
  "set-defaults": phaseSetDefaults,
  reclass: phaseReclass,
  verify: phaseVerify,
  "xoro-verify": phaseXoroVerify,
};
if (!phases[phase]) {
  console.error(`usage: node scripts/reclass-8007.mjs <${Object.keys(phases).join("|")}> [--dry-run] [--limit=N]`);
  process.exit(1);
}
phases[phase]({ dryRun, limit }).catch((e) => { console.error(e); process.exit(1); });

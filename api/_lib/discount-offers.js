// api/_lib/discount-offers.js
//
// Pure math + orchestration for dynamic discount offers.
//
//   computeAnnualizedReturn(discountPct, daysEarly) → number
//   computeDiscountPct(daysEarly, targetAnnualizedPct) → number
//   buildOfferCandidate(invoice, opts) → { ...payload } or null (if ineligible)
//   generateOffersForEntity(admin, opts) → { created, skipped, expired, results }
//   expireStaleOffers(admin, { now }) → number expired
//   computeAnalytics(admin, { entityId, periodStart, periodEnd, now }) → rollup row
//
// Eligibility (per spec, with one deviation noted below):
//   • invoice.status = 'approved'
//   • due_date > today + 5 days
//   • no existing non-terminal offer on the invoice
//
// DEVIATION: the spec also asks for match_status ∈ {matched, approved_with_exception}.
// `invoices` has no match_status column in the current schema (only the
// three_way_match_view tracks match state per PO line). We rely on
// status='approved' as the quality gate — internal review is what flips
// invoice.status to approved in the first place, so this is a reasonable
// proxy. Wire in line-level match once invoices carry a rolled-up flag.

const DEFAULT_TARGET_ANNUALIZED_PCT   = 10;  // 8–12% policy; pick midpoint
const DEFAULT_EARLY_PAYMENT_OFFSET_D  = 3;   // early_payment_date = today + 3
const DEFAULT_EXPIRY_OFFSET_DAYS      = 1;   // expires 1 day before early_payment_date
const MIN_DAYS_LEAD_TIME              = 5;   // invoice due_date must be > today + 5
const MIN_ANNUALIZED_RETURN_PCT       = 6;   // refuse offers below this (sanity)

export const CONSTANTS = {
  DEFAULT_TARGET_ANNUALIZED_PCT, DEFAULT_EARLY_PAYMENT_OFFSET_D,
  DEFAULT_EXPIRY_OFFSET_DAYS, MIN_DAYS_LEAD_TIME, MIN_ANNUALIZED_RETURN_PCT,
};

const MS_PER_DAY = 86400000;
function parseDate(d) { return d instanceof Date ? d : new Date(`${d}T00:00:00Z`); }
function addDays(d, n) { return new Date(d.getTime() + n * MS_PER_DAY); }
function daysBetween(a, b) { return Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / MS_PER_DAY); }
function toDateOnly(d) { return parseDate(d).toISOString().slice(0, 10); }
function round2(n) { return Math.round(n * 100) / 100; }

export function computeAnnualizedReturn(discountPct, daysEarly) {
  if (!daysEarly || daysEarly <= 0) return 0;
  return (discountPct / 100) * (365 / daysEarly) * 100;
}

export function computeDiscountPct(daysEarly, targetAnnualizedPct = DEFAULT_TARGET_ANNUALIZED_PCT) {
  if (!daysEarly || daysEarly <= 0) return 0;
  // targetAnnualized = (pct/100) * (365/days) * 100 = pct * 365 / days
  // → pct = targetAnnualized * days / 365
  return (targetAnnualizedPct * daysEarly) / 365;
}

export function buildOfferCandidate(invoice, {
  now = new Date(),
  targetAnnualizedPct = DEFAULT_TARGET_ANNUALIZED_PCT,
  earlyPaymentOffsetDays = DEFAULT_EARLY_PAYMENT_OFFSET_D,
  expiryOffsetDays = DEFAULT_EXPIRY_OFFSET_DAYS,
  discountPctOverride = null,
} = {}) {
  if (!invoice?.due_date) return null;
  const total = Number(invoice?.total);
  if (!Number.isFinite(total) || total <= 0) return null;

  const dueDate = parseDate(invoice.due_date);
  const earlyDate = addDays(parseDate(toDateOnly(now)), earlyPaymentOffsetDays);
  const daysEarly = daysBetween(earlyDate, dueDate);
  if (daysEarly < MIN_DAYS_LEAD_TIME) return null;

  const discountPct = discountPctOverride != null
    ? Number(discountPctOverride)
    : computeDiscountPct(daysEarly, targetAnnualizedPct);
  if (!Number.isFinite(discountPct) || discountPct <= 0) return null;

  const annualizedReturn = computeAnnualizedReturn(discountPct, daysEarly);
  if (discountPctOverride == null && annualizedReturn < MIN_ANNUALIZED_RETURN_PCT) return null;

  const discountAmount = round2((total * discountPct) / 100);
  const netPaymentAmount = round2(total - discountAmount);

  return {
    entity_id: invoice.entity_id,
    invoice_id: invoice.id,
    vendor_id: invoice.vendor_id,
    original_due_date: toDateOnly(dueDate),
    early_payment_date: toDateOnly(earlyDate),
    discount_pct: round2(discountPct),
    discount_amount: discountAmount,
    net_payment_amount: netPaymentAmount,
    expires_at: addDays(earlyDate, -expiryOffsetDays).toISOString(),
    _computed: { days_early: daysEarly, annualized_return_pct: round2(annualizedReturn) },
  };
}

async function activeOfferInvoiceIds(admin, invoiceIds) {
  if (!invoiceIds?.length) return new Set();
  const { data } = await admin
    .from("dynamic_discount_offers")
    .select("invoice_id, status")
    .in("invoice_id", invoiceIds)
    .in("status", ["offered", "accepted"]);
  return new Set((data || []).map((r) => r.invoice_id));
}

export async function generateOffersForEntity(admin, {
  entityId,
  now = new Date(),
  targetAnnualizedPct = DEFAULT_TARGET_ANNUALIZED_PCT,
  earlyPaymentOffsetDays = DEFAULT_EARLY_PAYMENT_OFFSET_D,
  expiryOffsetDays = DEFAULT_EXPIRY_OFFSET_DAYS,
  invoiceIds = null,
  discountPctOverride = null,
} = {}) {
  const cutoff = toDateOnly(addDays(now, MIN_DAYS_LEAD_TIME));

  let q = admin.from("invoices")
    .select("id, entity_id, vendor_id, total, due_date, status")
    .eq("status", "approved")
    .gt("due_date", cutoff);
  if (entityId) q = q.eq("entity_id", entityId);
  if (invoiceIds?.length) q = q.in("id", invoiceIds);
  const { data: invoices } = await q;

  const existingActive = await activeOfferInvoiceIds(admin, (invoices || []).map((i) => i.id));

  const toInsert = [];
  const skipped = [];
  for (const inv of invoices || []) {
    if (existingActive.has(inv.id)) { skipped.push({ invoice_id: inv.id, reason: "active_offer_exists" }); continue; }
    const candidate = buildOfferCandidate(inv, { now, targetAnnualizedPct, earlyPaymentOffsetDays, expiryOffsetDays, discountPctOverride });
    if (!candidate) { skipped.push({ invoice_id: inv.id, reason: "ineligible" }); continue; }
    toInsert.push(candidate);
  }

  let inserted = [];
  if (toInsert.length) {
    const rows = toInsert.map(({ _computed, ...r }) => r); // eslint-disable-line no-unused-vars
    const { data, error } = await admin.from("dynamic_discount_offers").insert(rows).select("id, invoice_id, vendor_id, entity_id, early_payment_date, original_due_date, discount_pct, discount_amount");
    if (error) throw error;
    inserted = data || [];
  }

  return { created: inserted, skipped };
}

export async function expireStaleOffers(admin, { now = new Date() } = {}) {
  const { data } = await admin
    .from("dynamic_discount_offers")
    .update({ status: "expired", updated_at: now.toISOString() })
    .eq("status", "offered")
    .lt("expires_at", now.toISOString())
    .select("id, invoice_id, vendor_id");
  return data || [];
}

export async function computeAnalytics(admin, { entityId, periodStart, periodEnd, now = new Date() }) {
  const { data: offers } = await admin
    .from("dynamic_discount_offers")
    .select("status, discount_pct, discount_amount, net_payment_amount, original_due_date, early_payment_date, paid_at")
    .eq("entity_id", entityId)
    .gte("offered_at", new Date(periodStart + "T00:00:00Z").toISOString())
    .lte("offered_at", new Date(periodEnd + "T23:59:59.999Z").toISOString());

  const total_offers_made = (offers || []).length;
  const accepted = (offers || []).filter((o) => o.status === "accepted" || o.status === "paid");
  const total_offers_accepted = accepted.length;
  const total_discount_captured = accepted.reduce((s, o) => s + Number(o.discount_amount || 0), 0);
  const total_early_payment_amount = accepted.reduce((s, o) => s + Number(o.net_payment_amount || 0), 0);
  const discountPcts = accepted.map((o) => Number(o.discount_pct || 0)).filter((n) => Number.isFinite(n));
  const avg_discount_pct = discountPcts.length ? discountPcts.reduce((s, n) => s + n, 0) / discountPcts.length : 0;

  // Annualized return on the accepted set
  const returns = accepted.map((o) => {
    const days = daysBetween(o.early_payment_date, o.original_due_date);
    return days > 0 ? computeAnnualizedReturn(Number(o.discount_pct || 0), days) : 0;
  }).filter((n) => Number.isFinite(n));
  const annualized_return_pct = returns.length ? returns.reduce((s, n) => s + n, 0) / returns.length : 0;

  const acceptance_rate_pct = total_offers_made > 0 ? (total_offers_accepted / total_offers_made) * 100 : 0;

  return {
    entity_id: entityId,
    period_start: periodStart,
    period_end: periodEnd,
    total_offers_made,
    total_offers_accepted,
    total_discount_captured: round2(total_discount_captured),
    total_early_payment_amount: round2(total_early_payment_amount),
    avg_discount_pct: round2(avg_discount_pct),
    annualized_return_pct: round2(annualized_return_pct),
    acceptance_rate_pct: round2(acceptance_rate_pct),
    generated_at: now.toISOString(),
  };
}

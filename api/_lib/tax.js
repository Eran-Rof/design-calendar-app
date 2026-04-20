// api/_lib/tax.js
//
// Pure helpers for tax rule selection + calculation.
//
//   selectApplicableRules(rules, { jurisdiction, appliesTo, effectiveDate })
//     → rules that match jurisdiction + applies_to + effective window
//   filterByThreshold(rules, amount)
//     → rules whose threshold_amount is null or ≤ amount
//   filterByVendorExemptions(rules, vendorBusinessTypes)
//     → rules where the vendor does NOT qualify for exemption
//   calculateTaxForInvoice({ invoice, rules, vendorBusinessTypes, appliesTo, effectiveDate })
//     → { calculations: [...], total_tax, rules_applied }
//   aggregateRemittance(calculations)
//     → { total_taxable, total_tax, by_jurisdiction: [...], by_tax_type: [...] }

export const TAX_TYPES = ["vat", "gst", "sales_tax", "withholding"];

function parseDate(d) { return d instanceof Date ? d : new Date(`${d}T00:00:00Z`); }
function round2(n) { return Math.round(n * 100) / 100; }

export function selectApplicableRules(rules, { jurisdiction, appliesTo = "all", effectiveDate = new Date() } = {}) {
  const when = parseDate(effectiveDate);
  return (rules || []).filter((r) => {
    if (!r.is_active) return false;
    if (r.jurisdiction !== jurisdiction) return false;
    if (r.applies_to !== "all" && r.applies_to !== appliesTo) return false;
    const from = parseDate(r.effective_from);
    if (when < from) return false;
    if (r.effective_to) {
      const to = parseDate(r.effective_to);
      if (when > to) return false;
    }
    return true;
  });
}

export function filterByThreshold(rules, amount) {
  return (rules || []).filter((r) => {
    const thr = r.threshold_amount;
    if (thr == null) return true;
    return Number(amount) >= Number(thr);
  });
}

export function filterByVendorExemptions(rules, vendorBusinessTypes = []) {
  const have = new Set(vendorBusinessTypes || []);
  return (rules || []).filter((r) => {
    const exemptions = r.vendor_type_exemptions || [];
    return !exemptions.some((t) => have.has(t));
  });
}

export function calculateTaxForInvoice({
  invoice, rules,
  vendorBusinessTypes = [],
  appliesTo = "all",
  effectiveDate = new Date(),
}) {
  if (!invoice) return { calculations: [], total_tax: 0, rules_applied: [] };
  const taxable = Number(invoice.total) || 0;
  const applicable = filterByVendorExemptions(
    filterByThreshold(
      selectApplicableRules(rules, { jurisdiction: invoice.__jurisdiction, appliesTo, effectiveDate }),
      taxable,
    ),
    vendorBusinessTypes,
  );

  const calculations = [];
  let total_tax = 0;
  for (const r of applicable) {
    const rate = Number(r.rate_pct) || 0;
    const tax = round2((taxable * rate) / 100);
    calculations.push({
      invoice_id: invoice.id,
      jurisdiction: r.jurisdiction,
      tax_type: r.tax_type,
      taxable_amount: round2(taxable),
      tax_rate_pct: rate,
      tax_amount: tax,
      rule_id: r.id,
    });
    total_tax += tax;
  }
  return { calculations, total_tax: round2(total_tax), rules_applied: applicable.map((r) => r.id) };
}

// Roll up a set of tax_calculations rows into a remittance-style summary.
export function aggregateRemittance(calculations) {
  const byJ = {}; const byT = {};
  let total_taxable = 0, total_tax = 0;
  for (const c of calculations || []) {
    total_taxable += Number(c.taxable_amount) || 0;
    total_tax += Number(c.tax_amount) || 0;
    const jKey = `${c.jurisdiction}|${c.tax_type}`;
    const jb = (byJ[jKey] ||= { jurisdiction: c.jurisdiction, tax_type: c.tax_type, taxable: 0, tax: 0, count: 0 });
    jb.taxable += Number(c.taxable_amount) || 0; jb.tax += Number(c.tax_amount) || 0; jb.count += 1;
    const tb = (byT[c.tax_type] ||= { tax_type: c.tax_type, taxable: 0, tax: 0, count: 0 });
    tb.taxable += Number(c.taxable_amount) || 0; tb.tax += Number(c.tax_amount) || 0; tb.count += 1;
  }
  return {
    total_taxable: round2(total_taxable),
    total_tax: round2(total_tax),
    by_jurisdiction: Object.values(byJ).map((r) => ({ ...r, taxable: round2(r.taxable), tax: round2(r.tax) })),
    by_tax_type: Object.values(byT).map((r) => ({ ...r, taxable: round2(r.taxable), tax: round2(r.tax) })),
  };
}

// Run the full calc + persist against the DB. Called from invoice-approval
// hooks or the on-demand recalc endpoint.
export async function runTaxForInvoice(admin, invoice, { appliesTo = "all", effectiveDate = new Date() } = {}) {
  if (!invoice?.entity_id) return { calculations: [], total_tax: 0 };

  // Resolve jurisdictions. Priority: invoice metadata override → vendor country →
  // entity default → env fallback.
  const entityJurisdiction = process.env.DEFAULT_ENTITY_JURISDICTION || "US";
  const { data: vendor } = await admin.from("vendors")
    .select("id, country, business_types").eq("id", invoice.vendor_id).maybeSingle();
  const jurisdiction = invoice?.metadata?.tax_jurisdiction
    || vendor?.country
    || entityJurisdiction;
  const vendorBusinessTypes = vendor?.business_types || [];

  // Diversity-verified vendors: pull their business_type into the exemption check
  const { data: diversity } = await admin.from("diversity_profiles")
    .select("business_type, verified").eq("vendor_id", invoice.vendor_id).maybeSingle();
  if (diversity?.verified && Array.isArray(diversity.business_type)) {
    for (const t of diversity.business_type) if (!vendorBusinessTypes.includes(t)) vendorBusinessTypes.push(t);
  }

  const { data: rules } = await admin.from("tax_rules")
    .select("*").eq("entity_id", invoice.entity_id).eq("is_active", true);

  const scoped = { ...invoice, __jurisdiction: jurisdiction };
  const { calculations, total_tax, rules_applied } = calculateTaxForInvoice({
    invoice: scoped, rules: rules || [],
    vendorBusinessTypes, appliesTo, effectiveDate,
  });

  // Replace prior calculations for this invoice (idempotent)
  await admin.from("tax_calculations").delete().eq("invoice_id", invoice.id);
  if (calculations.length) {
    const { error } = await admin.from("tax_calculations").insert(calculations);
    if (error) throw new Error(`tax_calculations insert: ${error.message}`);
  }

  return { calculations, total_tax, rules_applied, jurisdiction };
}

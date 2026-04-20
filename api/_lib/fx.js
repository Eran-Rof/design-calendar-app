// api/_lib/fx.js
//
// Pure FX helpers + provider abstraction.
//
//   computePaymentFx({ invoiceAmount, entityCurrency, vendorCurrency, rate, feePct, fxHandling })
//     → { from_amount, to_amount, fx_rate, fx_fee_amount, vendor_receives, entity_cost, needs_international_row }
//
//   fetchRates(base, symbols) → [{ from, to, rate, source }]
//
// Fee modes (the `fx_handling` field on VendorPaymentPreference):
//   pay_in_vendor_currency     — convert to vendor currency; vendor_receives = to_amount - fee (in vendor currency)
//   pay_in_usd_we_absorb       — no conversion on the wire; vendor_receives = invoice_amount in entity currency;
//                                 entity_cost = invoice_amount + fx_fee_amount (buyer eats bank-side spread)
//   pay_in_usd_vendor_absorbs  — no conversion on the wire; vendor_receives = invoice_amount - fx_fee_amount
//                                 (vendor eats the conversion on their side)

export const DEFAULT_FEE_PCT = 1.0; // Wise-ish default; override with env FX_FEE_PCT

function round2(n) { return Math.round(n * 100) / 100; }
function round6(n) { return Math.round(n * 1e6) / 1e6; }

export function computePaymentFx({
  invoiceAmount,
  entityCurrency = "USD",
  vendorCurrency = "USD",
  rate = 1,
  feePct = DEFAULT_FEE_PCT,
  fxHandling = "pay_in_usd_vendor_absorbs",
}) {
  const amt = Number(invoiceAmount) || 0;
  const r = Number(rate) || 1;
  const fPct = Number(feePct) || 0;

  if (entityCurrency === vendorCurrency) {
    return {
      from_amount: amt, to_amount: amt, fx_rate: 1,
      fx_fee_amount: 0, vendor_receives: amt, entity_cost: amt,
      needs_international_row: false,
      vendor_currency: vendorCurrency, entity_currency: entityCurrency,
    };
  }

  // entity → vendor conversion
  const converted = round2(amt * r);
  const feeConvertedCurrency = round2((converted * fPct) / 100);
  const feeEntityCurrency = round2((amt * fPct) / 100);

  if (fxHandling === "pay_in_vendor_currency") {
    return {
      from_amount: amt,
      to_amount: converted,
      fx_rate: round6(r),
      fx_fee_amount: feeConvertedCurrency,
      vendor_receives: round2(converted - feeConvertedCurrency),
      entity_cost: amt,
      needs_international_row: true,
      vendor_currency: vendorCurrency, entity_currency: entityCurrency,
    };
  }

  if (fxHandling === "pay_in_usd_we_absorb") {
    // No conversion on wire. Vendor receives full invoice in entity currency.
    // Entity absorbs the fee internally (bank/provider spread).
    return {
      from_amount: amt,
      to_amount: amt,
      fx_rate: 1,
      fx_fee_amount: feeEntityCurrency,
      vendor_receives: amt,
      entity_cost: round2(amt + feeEntityCurrency),
      needs_international_row: true,
      vendor_currency: entityCurrency, entity_currency: entityCurrency,
    };
  }

  // pay_in_usd_vendor_absorbs (default)
  return {
    from_amount: amt,
    to_amount: round2(amt - feeEntityCurrency),
    fx_rate: 1,
    fx_fee_amount: feeEntityCurrency,
    vendor_receives: round2(amt - feeEntityCurrency),
    entity_cost: amt,
    needs_international_row: true,
    vendor_currency: entityCurrency, entity_currency: entityCurrency,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Provider abstraction
// ──────────────────────────────────────────────────────────────────────────

// Fetches rates from OpenExchangeRates given a free or paid app_id.
// For free plan, `base` must be USD. We handle cross-pair math downstream.
async function fetchFromOXR(base, symbols, appId) {
  const url = `https://openexchangerates.org/api/latest.json?app_id=${appId}&base=${base}&symbols=${symbols.join(",")}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`OXR ${r.status}: ${await r.text().catch(() => "")}`);
  const data = await r.json();
  const out = [];
  for (const sym of symbols) {
    if (sym === base) continue;
    if (data?.rates?.[sym] != null) {
      out.push({ from: base, to: sym, rate: Number(data.rates[sym]), source: "openexchangerates" });
    }
  }
  return out;
}

// ECB publishes Euro-base daily XML; we keep the raw XML path but parse a few pairs.
async function fetchFromEcb(base, symbols) {
  const url = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
  const r = await fetch(url);
  if (!r.ok) throw new Error(`ECB ${r.status}`);
  const text = await r.text();
  // Parse currency='XXX' rate='Y.YYY' — regex is fine for this well-formed feed
  const pairs = [...text.matchAll(/currency=['"](\w{3})['"]\s+rate=['"]([\d.]+)['"]/g)];
  const ecb = new Map(pairs.map(([, c, v]) => [c, Number(v)])); // EUR → c
  ecb.set("EUR", 1);
  const out = [];
  for (const sym of symbols) {
    if (sym === base) continue;
    // Cross-rate via EUR: rate(base→sym) = rate(EUR→sym) / rate(EUR→base)
    const eToBase = ecb.get(base);
    const eToSym = ecb.get(sym);
    if (!eToBase || !eToSym) continue;
    out.push({ from: base, to: sym, rate: round6(eToSym / eToBase), source: "ecb" });
  }
  return out;
}

export async function fetchRates(base, symbols) {
  const appId = process.env.OXR_APP_ID;
  const provider = process.env.FX_PROVIDER || (appId ? "openexchangerates" : "ecb");

  if (provider === "openexchangerates") {
    if (!appId) throw new Error("OXR_APP_ID not configured");
    return await fetchFromOXR(base, symbols, appId);
  }
  if (provider === "ecb") return await fetchFromEcb(base, symbols);
  if (provider === "manual") return []; // Caller writes rates directly via SQL
  throw new Error(`Unknown FX_PROVIDER: ${provider}`);
}

// Look up the latest CurrencyRate for a pair in a DB. Returns null if missing.
export async function latestRate(admin, from, to) {
  if (from === to) return { from, to, rate: 1, snapshotted_at: new Date().toISOString(), source: "identity" };
  const { data } = await admin.from("currency_rates")
    .select("*").eq("from_currency", from).eq("to_currency", to)
    .order("snapshotted_at", { ascending: false }).limit(1);
  if (data?.[0]) return data[0];
  // Try inverse
  const { data: inv } = await admin.from("currency_rates")
    .select("*").eq("from_currency", to).eq("to_currency", from)
    .order("snapshotted_at", { ascending: false }).limit(1);
  if (inv?.[0]) {
    return { from, to, rate: round6(1 / Number(inv[0].rate)), snapshotted_at: inv[0].snapshotted_at, source: inv[0].source + "-inverse" };
  }
  return null;
}

// api/_lib/analytics.js
//
// Shared helpers for analytics endpoints: keyword-based category
// classification of PO line items, linear-regression forecasting, and
// health-score composition.

// ─── Category keyword groups ──────────────────────────────────────────
// Order matters — first matching regex wins. Everything else → "Other".
export const CATEGORIES = [
  { name: "Apparel",             regex: /\b(shirt|jacket|pants|hoodie|apparel|garment|tshirt|t-shirt|polo|tee|hat|cap|sock|glove|beanie)\b/i },
  { name: "Fabric & Textiles",   regex: /\b(fabric|textile|cotton|polyester|denim|fleece|knit|woven|yarn|thread|trim|embroider)\b/i },
  { name: "Cables & Connectors", regex: /\b(cable|connector|wire|cord|plug|socket|jack|adapter|harness|pigtail)\b/i },
  { name: "Electronics",         regex: /\b(circuit|pcb|chip|sensor|module|capacitor|resistor|led|transistor|mcu|mosfet|diode)\b/i },
  { name: "Packaging",           regex: /\b(box|carton|packag|wrap|pallet|crate|label|sticker|tag|tape|bubble)\b/i },
  { name: "Hardware",            regex: /\b(screw|bolt|nut|washer|hinge|bracket|clamp|rivet|fastener|pin)\b/i },
  { name: "Chemicals & Adhesives", regex: /\b(adhesive|glue|epoxy|resin|coating|paint|ink|solder|lubricant|cleaner)\b/i },
  { name: "Raw Materials",       regex: /\b(steel|aluminum|plastic|copper|brass|rubber|foam|pvc|abs)\b/i },
];

export function categorize(description) {
  if (!description) return "Other";
  const s = String(description);
  for (const c of CATEGORIES) {
    if (c.regex.test(s)) return c.name;
  }
  return "Other";
}

// ─── Month helpers ────────────────────────────────────────────────────
export function monthKey(d) {
  const x = new Date(d);
  if (isNaN(x.getTime())) return null;
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function monthsBack(n) {
  const out = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push({ key: monthKey(d), start: d });
  }
  return out;
}

// ─── Linear regression forecast ───────────────────────────────────────
// y values indexed 0..n-1 (oldest to newest). Returns the best-fit
// slope/intercept and a per-step forecast plus a rough confidence
// heuristic based on coefficient of variation.
export function linearForecast(series, stepsAhead = 3) {
  const n = series.length;
  if (n < 2) {
    const last = n === 1 ? series[0] : 0;
    return {
      slope: 0, intercept: last,
      forecast: Array.from({ length: stepsAhead }, () => last),
      confidence_pct: n === 0 ? 0 : 40,
    };
  }
  const xMean = (n - 1) / 2;
  const yMean = series.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (series[i] - yMean);
    den += (i - xMean) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const intercept = yMean - slope * xMean;
  const forecast = [];
  for (let k = 1; k <= stepsAhead; k++) forecast.push(Math.max(0, intercept + slope * (n - 1 + k)));

  const variance = series.reduce((a, v) => a + (v - yMean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);
  const cv = yMean > 0 ? stddev / yMean : 1;
  const confidence_pct = Math.round(Math.max(20, Math.min(95, 100 - cv * 100)));
  return { slope, intercept, forecast, confidence_pct };
}

// ─── Health score composition ─────────────────────────────────────────
// Follows the agreed formula:
//   delivery       = on_time_delivery_pct (0-100)
//   quality        = 100 - (discrepancy_count / invoice_count) * 100
//   compliance     = (approved_docs / required_docs) * 100
//   financial      = 100 - overdue_invoices * 10 (floor 0)
//   responsiveness = step on avg_acknowledgment_hours
//                      ≤4h → 100, ≤24h → 80, ≤48h → 60, >48h → 40
//   overall        = 0.30·delivery + 0.25·quality + 0.20·compliance
//                  + 0.15·financial + 0.10·responsiveness
//
// Dimensions default to a neutral "100" when the underlying signal is
// unavailable (e.g. a vendor with no invoices gets quality=100 rather
// than penalising them for having nothing to measure yet).
//
// Returns { overall, delivery, quality, compliance, financial,
//           responsiveness, breakdown: {...raw signals} }.
export function composeHealth({
  on_time_delivery_pct,
  invoice_count,
  discrepancy_count,
  approved_docs,
  required_docs,
  overdue_invoices,
  avg_acknowledgment_hours,
}) {
  const delivery = on_time_delivery_pct == null
    ? 100
    : clamp01(Number(on_time_delivery_pct));

  const quality = invoice_count == null || Number(invoice_count) === 0
    ? 100
    : clamp01(100 - (Number(discrepancy_count) || 0) / Number(invoice_count) * 100);

  const compliance = required_docs == null || Number(required_docs) === 0
    ? 100
    : clamp01((Number(approved_docs) || 0) / Number(required_docs) * 100);

  const financial = overdue_invoices == null
    ? 100
    : clamp01(100 - Number(overdue_invoices) * 10);

  const responsiveness = avg_acknowledgment_hours == null
    ? 80
    : (() => {
        const h = Number(avg_acknowledgment_hours);
        if (h <= 4)  return 100;
        if (h <= 24) return 80;
        if (h <= 48) return 60;
        return 40;
      })();

  const overall = Math.round(
    delivery * 0.30 + quality * 0.25 + compliance * 0.20 +
    financial * 0.15 + responsiveness * 0.10
  );

  return {
    overall,
    delivery: Math.round(delivery),
    quality: Math.round(quality),
    compliance: Math.round(compliance),
    financial: Math.round(financial),
    responsiveness: Math.round(responsiveness),
    breakdown: {
      on_time_delivery_pct: on_time_delivery_pct ?? null,
      invoice_count: invoice_count ?? null,
      discrepancy_count: discrepancy_count ?? null,
      approved_docs: approved_docs ?? null,
      required_docs: required_docs ?? null,
      overdue_invoices: overdue_invoices ?? null,
      avg_acknowledgment_hours: avg_acknowledgment_hours ?? null,
    },
  };
}

function clamp01(v) { return Math.max(0, Math.min(100, v)); }

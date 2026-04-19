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
// Weighted mix of the signals we have available. Returns overall + per-
// dimension sub-scores in 0-100.
export function composeHealth({
  on_time_delivery_pct,
  invoice_accuracy_pct,
  avg_acknowledgment_hours,
  compliance_complete_ratio,       // 0..1 — share of required docs approved + not expiring
  open_flags_count,                // vendor_flags.status='open'
  paid_on_time_ratio,              // 0..1 — invoices paid by due_date
}) {
  const delivery    = clamp01(num(on_time_delivery_pct));
  const quality     = clamp01(num(invoice_accuracy_pct));
  const compliance  = clamp01(num(compliance_complete_ratio) * 100);
  const responsiveness = clamp01(
    avg_acknowledgment_hours == null ? 50 :
    Math.max(0, Math.min(100, 100 - (Number(avg_acknowledgment_hours) - 24) * 100 / 48))
  );
  const financial = clamp01(num(paid_on_time_ratio) * 100);

  // Flag penalty: up to −20 pts based on open flags
  const flagPenalty = Math.min(20, (Number(open_flags_count) || 0) * 5);

  const overall = Math.max(0, Math.round(
    (delivery * 0.30 + quality * 0.20 + compliance * 0.20 +
     financial * 0.15 + responsiveness * 0.15) - flagPenalty
  ));

  return {
    overall,
    delivery:       Math.round(delivery),
    quality:        Math.round(quality),
    compliance:     Math.round(compliance),
    financial:      Math.round(financial),
    responsiveness: Math.round(responsiveness),
    flag_penalty:   flagPenalty,
  };
}

function num(v) { return v == null || isNaN(Number(v)) ? 0 : Number(v); }
function clamp01(v) { return Math.max(0, Math.min(100, v)); }

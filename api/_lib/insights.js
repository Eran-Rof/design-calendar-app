// api/_lib/insights.js
//
// AI insights detection engine. Six deterministic rule-based detectors;
// orchestrator inserts new ai_insights rows (dedupes against existing
// unread rows for the same type+vendor_id), and expires stale rows
// (status='new' AND expires_at < now()).
//
// No LLM calls here — that hook is documented below and can be added
// later without changing the downstream API/UI contract.
//
// All detectors take:
//   { admin, entityId, vendorIds, now } where `admin` is a service-role
//   Supabase client, `vendorIds` is the list of active vendors for the
//   entity, and `now` is an injectable Date for testing.
//
// Each detector returns an array of insight candidates:
//   { type, vendor_id|null, title, summary, recommendation, confidence_pct, data_snapshot }

const MS_PER_DAY = 86400000;

function addDays(d, n) { return new Date(d.getTime() + n * MS_PER_DAY); }
function daysBetween(a, b) { return Math.round((b.getTime() - a.getTime()) / MS_PER_DAY); }
function toISO(d) { return d.toISOString(); }
function toDateOnly(d) { return d.toISOString().slice(0, 10); }
function pct(delta, base) { return base === 0 ? 0 : (delta / base) * 100; }

// ──────────────────────────────────────────────────────────────────────────
// Detectors
// ──────────────────────────────────────────────────────────────────────────

export async function detectCostSaving({ admin, vendorIds }) {
  if (!vendorIds.length) return [];
  const [{ data: items }, { data: benchmarks }, { data: preferred }] = await Promise.all([
    admin.from("catalog_items").select("id, vendor_id, sku, name, category, unit_price")
      .in("vendor_id", vendorIds).eq("status", "active"),
    admin.from("benchmark_data").select("category, metric, percentile_50, percentile_75, period_end")
      .eq("metric", "unit_price"),
    admin.from("preferred_vendors").select("vendor_id, category, rank"),
  ]);

  // Index benchmarks by category → latest row
  const bmByCategory = {};
  for (const b of benchmarks || []) {
    const existing = bmByCategory[b.category];
    if (!existing || new Date(b.period_end) > new Date(existing.period_end)) {
      bmByCategory[b.category] = b;
    }
  }

  // Preferred vendor index: category → vendor_id list sorted by rank
  const preferredByCategory = {};
  for (const p of preferred || []) {
    (preferredByCategory[p.category] ||= []).push(p);
  }
  for (const k of Object.keys(preferredByCategory)) {
    preferredByCategory[k].sort((a, b) => a.rank - b.rank);
  }

  const out = [];
  const seenVendorItem = new Set();

  for (const it of items || []) {
    if (!it.category || !it.unit_price) continue;
    const bm = bmByCategory[it.category];
    if (!bm?.percentile_50) continue;
    const overagePct = pct(Number(it.unit_price) - Number(bm.percentile_50), Number(bm.percentile_50));
    if (overagePct < 15) continue;

    const key = `${it.vendor_id}|${it.sku}`;
    if (seenVendorItem.has(key)) continue;
    seenVendorItem.add(key);

    // Preferred-vendor alternative with lower price for same category
    const preferredAlternatives = (preferredByCategory[it.category] || [])
      .filter((p) => p.vendor_id !== it.vendor_id);
    let altVendorId = null;
    let altPrice = null;
    if (preferredAlternatives.length) {
      const altPrices = (items || []).filter((x) =>
        x.vendor_id !== it.vendor_id
        && x.category === it.category
        && preferredAlternatives.some((p) => p.vendor_id === x.vendor_id)
        && Number(x.unit_price) < Number(it.unit_price)
      );
      if (altPrices.length) {
        altPrices.sort((a, b) => Number(a.unit_price) - Number(b.unit_price));
        altVendorId = altPrices[0].vendor_id;
        altPrice    = Number(altPrices[0].unit_price);
      }
    }

    out.push({
      type: "cost_saving",
      vendor_id: it.vendor_id,
      title: `${it.name} priced ${overagePct.toFixed(0)}% above market median`,
      summary: `Catalog unit price $${Number(it.unit_price).toFixed(2)} vs benchmark median $${Number(bm.percentile_50).toFixed(2)} for category '${it.category}'.`,
      recommendation: altVendorId
        ? `Consider renegotiating unit price with this vendor, or sourcing '${it.name}' from a preferred vendor at ~$${altPrice.toFixed(2)}.`
        : `Consider renegotiating unit price for '${it.name}' — currently ${overagePct.toFixed(0)}% above market median.`,
      confidence_pct: Math.min(95, 60 + Math.min(35, overagePct)),
      data_snapshot: {
        sku: it.sku, category: it.category, unit_price: Number(it.unit_price),
        benchmark_p50: Number(bm.percentile_50), overage_pct: Number(overagePct.toFixed(2)),
        alt_vendor_id: altVendorId, alt_unit_price: altPrice,
      },
    });
  }

  return out;
}

export async function detectRiskAlerts({ admin, vendorIds, now }) {
  if (!vendorIds.length) return [];
  const out = [];

  const [{ data: scores }, { data: flags }, { data: contracts }, { data: docs }] = await Promise.all([
    admin.from("vendor_health_scores").select("vendor_id, overall_score, period_start, period_end, generated_at")
      .in("vendor_id", vendorIds).order("period_end", { ascending: false }),
    admin.from("anomaly_flags").select("id, vendor_id, type, severity, status, detected_at, description")
      .in("vendor_id", vendorIds).eq("status", "open").eq("severity", "critical"),
    admin.from("contracts").select("id, vendor_id, title, status, end_date")
      .in("vendor_id", vendorIds),
    admin.from("compliance_documents").select("id, vendor_id, document_type_id, expiry_date, status")
      .in("vendor_id", vendorIds).eq("status", "approved").not("expiry_date", "is", null),
  ]);

  // A) Health score drop >15 points between last 2 periods
  const scoresByVendor = {};
  for (const s of scores || []) (scoresByVendor[s.vendor_id] ||= []).push(s);
  for (const vId of Object.keys(scoresByVendor)) {
    const arr = scoresByVendor[vId];
    if (arr.length < 2) continue;
    const [latest, prior] = arr;
    const drop = Number(prior.overall_score) - Number(latest.overall_score);
    if (drop > 15) {
      out.push({
        type: "risk_alert", vendor_id: vId,
        title: `Vendor health score dropped ${drop.toFixed(0)} points`,
        summary: `Overall score fell from ${Number(prior.overall_score).toFixed(0)} (period ending ${prior.period_end}) to ${Number(latest.overall_score).toFixed(0)} (period ending ${latest.period_end}).`,
        recommendation: "Open the vendor health-score page to investigate which dimension regressed (delivery, quality, compliance, financial, responsiveness) and follow up with the vendor.",
        confidence_pct: Math.min(95, 60 + drop),
        data_snapshot: {
          reason: "health_score_drop", drop_points: Number(drop.toFixed(2)),
          latest: { score: Number(latest.overall_score), period_end: latest.period_end },
          prior:  { score: Number(prior.overall_score),  period_end: prior.period_end },
        },
      });
    }
  }

  // B) Critical anomaly unreviewed >7 days
  for (const f of flags || []) {
    const age = daysBetween(new Date(f.detected_at), now);
    if (age <= 7) continue;
    out.push({
      type: "risk_alert", vendor_id: f.vendor_id,
      title: `Critical anomaly unreviewed for ${age} days`,
      summary: `${f.type.replace(/_/g, " ")} — ${f.description}`,
      recommendation: "Review this anomaly on the Anomalies page and either escalate or dismiss.",
      confidence_pct: 90,
      data_snapshot: { reason: "stale_critical_anomaly", anomaly_id: f.id, age_days: age },
    });
  }

  // C) Contract expiring within 45 days with no renewal (no draft/sent for same vendor)
  const renewalsByVendor = {};
  for (const c of contracts || []) {
    if (c.status === "draft" || c.status === "sent") {
      (renewalsByVendor[c.vendor_id] ||= []).push(c.id);
    }
  }
  for (const c of contracts || []) {
    if (c.status !== "signed") continue;
    if (!c.end_date) continue;
    const days = daysBetween(now, new Date(c.end_date));
    if (days < 0 || days > 45) continue;
    if ((renewalsByVendor[c.vendor_id] || []).length > 0) continue;
    out.push({
      type: "risk_alert", vendor_id: c.vendor_id,
      title: `Contract '${c.title}' expires in ${days} days — no renewal started`,
      summary: `Signed contract ends ${c.end_date}. No draft or sent renewal exists for this vendor.`,
      recommendation: `Start the renewal process for '${c.title}' now to avoid a coverage gap.`,
      confidence_pct: 88,
      data_snapshot: { reason: "contract_expiring_no_renewal", contract_id: c.id, days_until_expiry: days, end_date: c.end_date },
    });
  }

  // D) Compliance doc expiring within 30 days
  for (const d of docs || []) {
    if (!d.expiry_date) continue;
    const days = daysBetween(now, new Date(d.expiry_date));
    if (days < 0 || days > 30) continue;
    out.push({
      type: "risk_alert", vendor_id: d.vendor_id,
      title: `Compliance document expiring in ${days} days`,
      summary: `An approved compliance document expires on ${d.expiry_date}.`,
      recommendation: `Request a renewed document from the vendor before ${d.expiry_date}.`,
      confidence_pct: 85,
      data_snapshot: { reason: "compliance_doc_expiring", document_id: d.id, document_type_id: d.document_type_id, days_until_expiry: days, expiry_date: d.expiry_date },
    });
  }

  return out;
}

export async function detectConsolidation({ admin, vendorIds, now }) {
  if (!vendorIds.length) return [];

  // Map vendor → dominant catalog category (most items) to attribute spend
  const { data: items } = await admin
    .from("catalog_items").select("vendor_id, category")
    .in("vendor_id", vendorIds).eq("status", "active");

  const categoriesByVendor = {};
  for (const it of items || []) {
    if (!it.category) continue;
    const m = (categoriesByVendor[it.vendor_id] ||= {});
    m[it.category] = (m[it.category] || 0) + 1;
  }
  const dominant = {};
  for (const vId of Object.keys(categoriesByVendor)) {
    const entries = Object.entries(categoriesByVendor[vId]);
    entries.sort((a, b) => b[1] - a[1]);
    dominant[vId] = entries[0][0];
  }

  // Sum vendor spend from approved+paid invoices in the last 12 months
  const since = toISO(addDays(now, -365));
  const { data: invoices } = await admin
    .from("invoices").select("vendor_id, total, status, invoice_date")
    .in("vendor_id", vendorIds).in("status", ["approved", "paid"]).gte("invoice_date", since);

  const spendByVendor = {};
  for (const inv of invoices || []) {
    spendByVendor[inv.vendor_id] = (spendByVendor[inv.vendor_id] || 0) + Number(inv.total || 0);
  }

  const byCategory = {};
  for (const vId of Object.keys(dominant)) {
    const cat = dominant[vId];
    const bucket = (byCategory[cat] ||= { vendor_ids: [], combined_spend: 0 });
    bucket.vendor_ids.push(vId);
    bucket.combined_spend += spendByVendor[vId] || 0;
  }

  const out = [];
  for (const [cat, b] of Object.entries(byCategory)) {
    if (b.vendor_ids.length < 3) continue;
    if (b.combined_spend >= 100000) continue;
    out.push({
      type: "consolidation",
      vendor_id: null,
      title: `${b.vendor_ids.length} vendors in ${cat} with combined spend under $100k`,
      summary: `Last 12 months: $${Math.round(b.combined_spend).toLocaleString()} across ${b.vendor_ids.length} vendors whose dominant catalog category is '${cat}'.`,
      recommendation: `You have ${b.vendor_ids.length} vendors in ${cat} totaling $${Math.round(b.combined_spend / 1000)}k — consolidating could yield 10–15% savings.`,
      confidence_pct: 70,
      data_snapshot: { category: cat, vendor_ids: b.vendor_ids, combined_spend: Math.round(b.combined_spend) },
    });
  }
  return out;
}

export async function detectContractRenewal({ admin, vendorIds, now }) {
  if (!vendorIds.length) return [];
  const { data: contracts } = await admin
    .from("contracts").select("id, vendor_id, title, status, end_date")
    .in("vendor_id", vendorIds).eq("status", "signed").not("end_date", "is", null);

  // Any draft/sent contracts count as a renewal in-progress
  const { data: pipeline } = await admin
    .from("contracts").select("vendor_id, status")
    .in("vendor_id", vendorIds).in("status", ["draft", "sent"]);
  const renewalVendors = new Set((pipeline || []).map((r) => r.vendor_id));

  const out = [];
  for (const c of contracts || []) {
    const days = daysBetween(now, new Date(c.end_date));
    if (days < 0 || days > 60) continue;
    if (renewalVendors.has(c.vendor_id)) continue;
    out.push({
      type: "contract_renewal", vendor_id: c.vendor_id,
      title: `Contract '${c.title}' expires in ${days} days`,
      summary: `Signed contract end date: ${c.end_date}. No draft or sent renewal found for this vendor.`,
      recommendation: `Contract with this vendor expires in ${days} days — start renewal process.`,
      confidence_pct: 85,
      data_snapshot: { contract_id: c.id, end_date: c.end_date, days_until_expiry: days },
    });
  }
  return out;
}

export async function detectPerformanceTrend({ admin, vendorIds }) {
  if (!vendorIds.length) return [];
  const { data: cards } = await admin
    .from("vendor_scorecards").select("vendor_id, on_time_delivery_pct, period_start, period_end")
    .in("vendor_id", vendorIds).not("on_time_delivery_pct", "is", null)
    .order("period_end", { ascending: false });

  const byVendor = {};
  for (const c of cards || []) (byVendor[c.vendor_id] ||= []).push(c);

  const out = [];
  for (const vId of Object.keys(byVendor)) {
    const arr = byVendor[vId];
    if (arr.length < 3) continue;
    const [latest, , oldest] = arr;
    const delta = Number(latest.on_time_delivery_pct) - Number(oldest.on_time_delivery_pct);
    if (Math.abs(delta) <= 10) continue;
    const improved = delta > 0;
    out.push({
      type: "performance_trend", vendor_id: vId,
      title: `On-time delivery ${improved ? "improved" : "declined"} ${Math.abs(delta).toFixed(0)} points over 3 periods`,
      summary: `${Number(oldest.on_time_delivery_pct).toFixed(0)}% (period ending ${oldest.period_end}) → ${Number(latest.on_time_delivery_pct).toFixed(0)}% (period ending ${latest.period_end}).`,
      recommendation: improved
        ? `Acknowledge the improvement — consider a positive feedback touchpoint.`
        : `Flag declining on-time performance with the vendor and schedule a review.`,
      confidence_pct: Math.min(95, 60 + Math.abs(delta)),
      data_snapshot: {
        delta_points: Number(delta.toFixed(2)), direction: improved ? "improved" : "declined",
        latest: { value: Number(latest.on_time_delivery_pct), period_end: latest.period_end },
        oldest: { value: Number(oldest.on_time_delivery_pct), period_end: oldest.period_end },
      },
    });
  }
  return out;
}

export async function detectMarketBenchmark({ admin, vendorIds }) {
  if (!vendorIds.length) return [];
  const [{ data: items }, { data: benchmarks }] = await Promise.all([
    admin.from("catalog_items").select("vendor_id, category, unit_price")
      .in("vendor_id", vendorIds).eq("status", "active").not("unit_price", "is", null),
    admin.from("benchmark_data").select("category, metric, percentile_50, percentile_75, period_end")
      .eq("metric", "unit_price"),
  ]);
  const bmByCategory = {};
  for (const b of benchmarks || []) {
    const existing = bmByCategory[b.category];
    if (!existing || new Date(b.period_end) > new Date(existing.period_end)) {
      bmByCategory[b.category] = b;
    }
  }

  // Average unit price per category across this entity's vendors
  const agg = {};
  for (const it of items || []) {
    if (!it.category || !it.unit_price) continue;
    const a = (agg[it.category] ||= { sum: 0, n: 0 });
    a.sum += Number(it.unit_price); a.n += 1;
  }

  const out = [];
  for (const [cat, a] of Object.entries(agg)) {
    const bm = bmByCategory[cat];
    if (!bm?.percentile_75) continue;
    const avg = a.sum / a.n;
    if (avg <= Number(bm.percentile_75)) continue;
    const overagePct = pct(avg - Number(bm.percentile_75), Number(bm.percentile_75));
    out.push({
      type: "market_benchmark",
      vendor_id: null,
      title: `${cat} unit prices above market 75th percentile`,
      summary: `Entity's average ${cat} unit price $${avg.toFixed(2)} vs benchmark P75 $${Number(bm.percentile_75).toFixed(2)} (${overagePct.toFixed(0)}% higher).`,
      recommendation: `Review sourcing strategy for ${cat} — entity-wide pricing is in the top quartile of market data.`,
      confidence_pct: 75,
      data_snapshot: { category: cat, entity_avg: Number(avg.toFixed(2)), benchmark_p75: Number(bm.percentile_75), overage_pct: Number(overagePct.toFixed(2)) },
    });
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Orchestrator
// ──────────────────────────────────────────────────────────────────────────

async function getActiveVendorIdsForEntity(admin, entityId) {
  const { data } = await admin
    .from("entity_vendors").select("vendor_id")
    .eq("entity_id", entityId).eq("relationship_status", "active");
  return (data || []).map((r) => r.vendor_id);
}

export async function runInsightsForEntity({ admin, entityId, now = new Date() }) {
  const vendorIds = await getActiveVendorIdsForEntity(admin, entityId);
  const detectors = [
    detectCostSaving, detectRiskAlerts, detectConsolidation,
    detectContractRenewal, detectPerformanceTrend, detectMarketBenchmark,
  ];

  const candidates = [];
  for (const fn of detectors) {
    try {
      const rows = await fn({ admin, entityId, vendorIds, now });
      for (const r of rows) candidates.push(r);
    } catch (err) {
      // Non-fatal: log and continue
      // eslint-disable-next-line no-console
      console.error(`Insight detector ${fn.name} failed:`, err?.message || err);
    }
  }

  // Dedup against existing unread insights for same (entity, type, vendor_id)
  const { data: existing } = await admin
    .from("ai_insights").select("id, type, vendor_id, status, expires_at")
    .eq("entity_id", entityId).in("status", ["new", "read"]);
  const seen = new Set((existing || []).map((r) => `${r.type}|${r.vendor_id ?? "null"}`));

  const fresh = candidates.filter((c) => !seen.has(`${c.type}|${c.vendor_id ?? "null"}`));

  let inserted = 0;
  if (fresh.length) {
    const rows = fresh.map((c) => ({
      entity_id: entityId,
      vendor_id: c.vendor_id,
      type: c.type,
      title: c.title,
      summary: c.summary || null,
      recommendation: c.recommendation || null,
      confidence_pct: c.confidence_pct ?? null,
      data_snapshot: c.data_snapshot || {},
      generated_at: toISO(now),
      expires_at: toISO(addDays(now, 30)),
    }));
    const { error } = await admin.from("ai_insights").insert(rows);
    if (error) throw error;
    inserted = rows.length;
  }

  // Expire stale rows: still 'new' AND past expires_at → dismissed
  const { data: expired } = await admin
    .from("ai_insights").update({ status: "dismissed", updated_at: toISO(now) })
    .eq("entity_id", entityId).eq("status", "new").lt("expires_at", toISO(now))
    .select("id");

  return { inserted, candidates: candidates.length, deduped: candidates.length - inserted, expired: (expired || []).length };
}

export async function runInsightsForAllActiveEntities({ admin, now = new Date() }) {
  const { data: entities } = await admin.from("entities").select("id").eq("status", "active");
  const results = [];
  for (const e of entities || []) {
    try {
      const r = await runInsightsForEntity({ admin, entityId: e.id, now });
      results.push({ entity_id: e.id, ...r });
    } catch (err) {
      results.push({ entity_id: e.id, error: err?.message || String(err) });
    }
  }
  return results;
}

// Helper exposed for tests + summary endpoint
export const __test__ = { addDays, daysBetween, pct, toDateOnly };

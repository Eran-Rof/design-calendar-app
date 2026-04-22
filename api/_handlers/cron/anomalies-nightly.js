// api/cron/anomalies-nightly
//
// Nightly anomaly detection. Scheduled via vercel.json cron at 03:00 ET
// (08:00 UTC). Runs 5 checks per active vendor:
//
//   duplicate_invoice  same amount + same po_id within 30 days
//                      (DB unique index already prevents same invoice_number)
//   price_variance     invoice vs PO total off by >10%
//                      OR catalog unit_price changed >15% in 30 days
//   unusual_volume     this month's total spend > 12-month mean + 2σ
//   late_pattern       on_time_delivery_pct dropped >20 pts vs prior
//                      3-month avg from vendor_scorecards
//   compliance_gap     any required document expired or expiring ≤14 days
//                      with no newer replacement
//
// Idempotency: for each detected condition we look for an existing
// open anomaly_flags row (same vendor + type + entity). If one exists,
// we leave it alone. If the condition no longer holds for an open
// flag, we mark it dismissed with reviewed_by='cron.anomaly'.
//
// High/critical severities fire an anomaly_detected notification to
// INTERNAL_VENDOR_ALERT_EMAILS (falls back to INTERNAL_COMPLIANCE_EMAILS).

import { createClient } from "@supabase/supabase-js";
import { fireWorkflowEvent } from "../../_lib/workflow.js";

export const config = { maxDuration: 60 };

function stddev(nums) {
  if (!nums || nums.length < 2) return 0;
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  const variance = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / (nums.length - 1);
  return Math.sqrt(variance);
}

function startOfMonth(d) { const x = new Date(d); x.setUTCDate(1); x.setUTCHours(0, 0, 0, 0); return x; }
function monthKey(d) { const x = new Date(d); return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, "0")}`; }

async function fireHighSeverityAlert(admin, origin, vendor, flag) {
  try {
    // Procurement + finance team — procurement sees vendor issues,
    // finance sees the ones that touch payment/invoice risk.
    const pool = new Set();
    for (const raw of [
      process.env.INTERNAL_PROCUREMENT_EMAILS,
      process.env.INTERNAL_FINANCE_EMAILS,
      process.env.INTERNAL_VENDOR_ALERT_EMAILS,
      process.env.INTERNAL_COMPLIANCE_EMAILS,
    ]) {
      if (!raw) continue;
      for (const e of raw.split(",")) {
        const v = e.trim();
        if (v) pool.add(v);
      }
      if (pool.size > 0) break; // first source with any entries wins
    }
    if (pool.size === 0) return;
    const emails = [...pool];
    await Promise.all(emails.map((email) =>
      fetch(`${origin}/api/send-notification`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_type: "anomaly_detected",
          title: `[${flag.severity}] Anomaly detected: ${flag.type} for ${vendor.name}`,
          body: flag.description,
          link: "/",
          metadata: { anomaly_id: flag.id, vendor_id: vendor.id, type: flag.type, severity: flag.severity },
          recipient: { internal_id: "vendor_ops", email },
          dedupe_key: `anomaly_detected_${flag.id}_${email}`,
          email: true,
        }),
      }).catch(() => {})
    ));
  } catch { /* non-blocking */ }
}

async function runForVendor(admin, vendor, globals) {
  const detected = []; // { type, severity, description, entity_type, entity_id }

  const now = new Date();
  const soonMs = now.getTime() + 14 * 86_400_000;
  const monthAgo = new Date(now.getTime() - 30 * 86_400_000);

  // ── duplicate_invoice ───────────────────────────────────────────────
  const vinvoices = globals.invoicesByVendor.get(vendor.id) || [];
  const byPoAmount = new Map();
  for (const inv of vinvoices) {
    if (!inv.po_id) continue;
    const key = `${inv.po_id}|${Number(inv.total).toFixed(2)}`;
    const prev = byPoAmount.get(key) || [];
    prev.push(inv);
    byPoAmount.set(key, prev);
  }
  for (const [key, rows] of byPoAmount.entries()) {
    if (rows.length < 2) continue;
    rows.sort((a, b) => new Date(a.submitted_at || a.invoice_date).getTime() - new Date(b.submitted_at || b.invoice_date).getTime());
    for (let i = 1; i < rows.length; i++) {
      const earlier = rows[i - 1], later = rows[i];
      const dt = new Date(later.submitted_at || later.invoice_date).getTime() - new Date(earlier.submitted_at || earlier.invoice_date).getTime();
      if (dt > 0 && dt <= 30 * 86_400_000) {
        detected.push({
          type: "duplicate_invoice",
          severity: "high",
          description: `Invoice ${later.invoice_number} has the same amount ($${Number(later.total).toFixed(2)}) and PO as invoice ${earlier.invoice_number} submitted ${Math.round(dt / 86_400_000)} days earlier`,
          entity_type: "invoice",
          entity_id: later.id,
        });
      }
    }
  }

  // ── price_variance ──────────────────────────────────────────────────
  for (const inv of vinvoices) {
    if (!inv.po_id || inv.total == null) continue;
    const po = globals.posByUuid.get(inv.po_id);
    if (!po) continue;
    const poTotal = Number(po.data?.TotalAmount) || 0;
    if (poTotal <= 0) continue;
    const pct = Math.abs(Number(inv.total) - poTotal) / poTotal * 100;
    if (pct > 10) {
      const severity = pct > 25 ? "high" : "medium";
      detected.push({
        type: "price_variance",
        severity,
        description: `Invoice ${inv.invoice_number} total ($${Number(inv.total).toFixed(2)}) deviates ${pct.toFixed(1)}% from PO ${po.po_number} total ($${poTotal.toFixed(2)})`,
        entity_type: "invoice",
        entity_id: inv.id,
      });
    }
  }

  const vHistory = (globals.priceHistoryByVendor.get(vendor.id) || []).filter((h) => new Date(h.created_at) >= monthAgo);
  for (const h of vHistory) {
    const oldP = Number(h.old_price), newP = Number(h.new_price);
    if (!Number.isFinite(oldP) || oldP <= 0 || !Number.isFinite(newP)) continue;
    const pct = Math.abs(newP - oldP) / oldP * 100;
    if (pct > 15) {
      const severity = pct > 30 ? "high" : "medium";
      detected.push({
        type: "price_variance",
        severity,
        description: `Catalog price changed ${pct.toFixed(1)}% (was $${oldP.toFixed(2)}, now $${newP.toFixed(2)}) within 30 days`,
        entity_type: "vendor",
        entity_id: vendor.id,
      });
    }
  }

  // ── unusual_volume ──────────────────────────────────────────────────
  const vposs = (globals.posByVendor.get(vendor.id) || []);
  const monthlyTotals = new Map(); // month → total
  for (const po of vposs) {
    const dateStr = po.data?.DateOrder;
    if (!dateStr) continue;
    const mk = monthKey(dateStr);
    const amt = Number(po.data?.TotalAmount) || 0;
    monthlyTotals.set(mk, (monthlyTotals.get(mk) || 0) + amt);
  }
  const last12 = [];
  const thisMonthKey = monthKey(now);
  for (let i = 1; i <= 12; i++) {
    const d = new Date(now); d.setUTCMonth(d.getUTCMonth() - i);
    last12.push(monthlyTotals.get(monthKey(d)) || 0);
  }
  const thisMonth = monthlyTotals.get(thisMonthKey) || 0;
  const sigma = stddev(last12);
  const mean = last12.reduce((a, b) => a + b, 0) / Math.max(last12.length, 1);
  if (sigma > 0 && thisMonth > mean + 2 * sigma && thisMonth > 0) {
    detected.push({
      type: "unusual_volume",
      severity: "medium",
      description: `PO spend this month ($${thisMonth.toFixed(0)}) is more than 2σ above 12-month average ($${mean.toFixed(0)}, σ=$${sigma.toFixed(0)})`,
      entity_type: "vendor",
      entity_id: vendor.id,
    });
  }

  // ── late_pattern ────────────────────────────────────────────────────
  const kpi = globals.kpiByVendor.get(vendor.id);
  const scorecards = (globals.scorecardsByVendor.get(vendor.id) || []).slice(0, 3);
  if (kpi && typeof kpi.on_time_delivery_pct === "number" && scorecards.length >= 2) {
    const priorAvg = scorecards.reduce((a, s) => a + (Number(s.on_time_delivery_pct) || 0), 0) / scorecards.length;
    const current = Number(kpi.on_time_delivery_pct) || 0;
    const drop = priorAvg - current;
    if (drop > 20) {
      detected.push({
        type: "late_pattern",
        severity: "medium",
        description: `On-time delivery dropped ${drop.toFixed(1)} pts vs prior 3-month avg (was ${priorAvg.toFixed(1)}%, now ${current.toFixed(1)}%)`,
        entity_type: "vendor",
        entity_id: vendor.id,
      });
    }
  }

  // ── compliance_gap ──────────────────────────────────────────────────
  const requiredTypes = globals.requiredDocTypes;
  const vdocs = (globals.docsByVendor.get(vendor.id) || []);
  const latestByType = new Map();
  for (const d of vdocs) {
    const p = latestByType.get(d.document_type_id);
    if (!p || new Date(d.uploaded_at) > new Date(p.uploaded_at)) latestByType.set(d.document_type_id, d);
  }
  for (const t of requiredTypes) {
    const d = latestByType.get(t.id);
    if (!d) {
      detected.push({
        type: "compliance_gap", severity: "high",
        description: `Required document "${t.name}" has never been uploaded`,
        entity_type: "vendor", entity_id: vendor.id,
      });
      continue;
    }
    if (d.status === "rejected") {
      detected.push({
        type: "compliance_gap", severity: "high",
        description: `Required document "${t.name}" was rejected and not re-submitted`,
        entity_type: "vendor", entity_id: vendor.id,
      });
      continue;
    }
    if (d.expiry_date) {
      const exp = new Date(d.expiry_date).getTime();
      if (exp < now.getTime()) {
        detected.push({
          type: "compliance_gap", severity: "high",
          description: `Required document "${t.name}" expired on ${d.expiry_date}`,
          entity_type: "vendor", entity_id: vendor.id,
        });
      } else if (exp < soonMs) {
        detected.push({
          type: "compliance_gap", severity: "high",
          description: `Required document "${t.name}" expires on ${d.expiry_date} (within 14 days)`,
          entity_type: "vendor", entity_id: vendor.id,
        });
      }
    }
  }

  return detected;
}

export default async function handler(req, res) {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const origin = `https://${req.headers.host}`;

  // ── Batch-fetch shared data ────────────────────────────────────────
  const [vRes, invRes, posRes, phRes, kpiRes, scorecardsRes, docTypesRes, docsRes, existingFlagsRes] = await Promise.all([
    admin.from("vendors").select("id, name, status, deleted_at"),
    admin.from("invoices").select("id, vendor_id, po_id, invoice_number, total, invoice_date, submitted_at, status"),
    admin.from("tanda_pos").select("uuid_id, vendor_id, po_number, data"),
    admin.from("catalog_price_history").select("catalog_item_id, old_price, new_price, created_at, catalog_items!inner(vendor_id)").order("created_at", { ascending: false }),
    admin.from("vendor_kpi_live").select("vendor_id, on_time_delivery_pct"),
    admin.from("vendor_scorecards").select("vendor_id, period_start, on_time_delivery_pct").order("period_start", { ascending: false }),
    admin.from("compliance_document_types").select("id, name, required, expiry_required").eq("active", true).eq("required", true),
    admin.from("compliance_documents").select("vendor_id, document_type_id, status, expiry_date, uploaded_at"),
    admin.from("anomaly_flags").select("*").eq("status", "open"),
  ]);

  const errs = [vRes, invRes, posRes, kpiRes, scorecardsRes, docTypesRes, docsRes, existingFlagsRes].filter((r) => r.error);
  if (errs.length) return res.status(500).json({ error: errs[0].error.message });

  const activeVendors = (vRes.data || []).filter((v) => !v.deleted_at && (v.status || "active") === "active");
  const invoicesByVendor = groupBy(invRes.data || [], "vendor_id");
  const posByVendor = groupBy(posRes.data || [], "vendor_id");
  const posByUuid = new Map((posRes.data || []).map((p) => [p.uuid_id, p]));
  const kpiByVendor = new Map((kpiRes.data || []).map((k) => [k.vendor_id, k]));
  const scorecardsByVendor = groupBy(scorecardsRes.data || [], "vendor_id");
  const priceHistoryByVendor = new Map();
  for (const h of phRes.data || []) {
    const vid = h.catalog_items?.vendor_id;
    if (!vid) continue;
    const arr = priceHistoryByVendor.get(vid) || [];
    arr.push({ old_price: h.old_price, new_price: h.new_price, created_at: h.created_at });
    priceHistoryByVendor.set(vid, arr);
  }
  const docsByVendor = groupBy(docsRes.data || [], "vendor_id");
  const requiredDocTypes = docTypesRes.data || [];

  const globals = {
    invoicesByVendor, posByVendor, posByUuid, kpiByVendor, scorecardsByVendor,
    priceHistoryByVendor, docsByVendor, requiredDocTypes,
  };

  // index existing open flags by (vendor_id, type, entity_type, entity_id)
  const openFlags = existingFlagsRes.data || [];
  const openKey = (f) => `${f.vendor_id}|${f.type}|${f.entity_type}|${f.entity_id || ""}`;
  const openByKey = new Map();
  for (const f of openFlags) openByKey.set(openKey(f), f);

  let created = 0, dismissed = 0, alerted = 0;
  const detectedKeys = new Set();

  for (const vendor of activeVendors) {
    const detections = await runForVendor(admin, vendor, globals);
    for (const d of detections) {
      const key = `${vendor.id}|${d.type}|${d.entity_type}|${d.entity_id || ""}`;
      detectedKeys.add(key);
      if (openByKey.has(key)) continue;
      const { data: flag, error } = await admin.from("anomaly_flags").insert({
        vendor_id: vendor.id,
        type: d.type,
        severity: d.severity,
        description: d.description,
        status: "open",
        entity_type: d.entity_type,
        entity_id: d.entity_id || null,
        source: "cron.anomaly",
      }).select("*").single();
      if (error || !flag) continue;
      created++;
      if (flag.severity === "high" || flag.severity === "critical") {
        await fireHighSeverityAlert(admin, origin, vendor, flag);
        alerted++;
      }
      // Fire workflow event (enables webhook to Slack etc. per the spec
      // "critical anomaly → webhook" example)
      try {
        await fireWorkflowEvent({
          admin, origin,
          event: "anomaly_detected",
          entity_id: null, // falls back to default entity in helper
          context: {
            entity_type: "anomaly",
            entity_id: flag.id,
            vendor_id: vendor.id,
            anomaly_severity: flag.severity,
            anomaly_type: flag.type,
            description: flag.description,
          },
        });
      } catch { /* non-blocking */ }
    }
  }

  // Dismiss stale open flags
  for (const f of openFlags) {
    if (detectedKeys.has(openKey(f))) continue;
    // Only auto-dismiss cron-sourced flags to avoid touching manual ones
    if (f.source !== "cron.anomaly") continue;
    await admin.from("anomaly_flags").update({
      status: "dismissed",
      reviewed_at: new Date().toISOString(),
      reviewed_by: "cron.anomaly",
      updated_at: new Date().toISOString(),
    }).eq("id", f.id);
    dismissed++;
  }

  return res.status(200).json({
    vendors_scanned: activeVendors.length,
    anomalies_created: created,
    anomalies_dismissed: dismissed,
    high_severity_alerts_fired: alerted,
  });
}

function groupBy(rows, key) {
  const m = new Map();
  for (const r of rows) {
    const k = r[key];
    if (!k) continue;
    const arr = m.get(k) || [];
    arr.push(r);
    m.set(k, arr);
  }
  return m;
}

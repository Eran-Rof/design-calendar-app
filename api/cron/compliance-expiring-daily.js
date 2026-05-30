// api/cron/compliance-expiring-daily
//
// Tangerine P13-6 — M48 daily compliance-cert expiration scanner.
//
// Runs daily at 09:00 UTC per vercel.json. For each entity:
//   1. Find every vendor_compliance_certifications row WHERE status='active'
//      AND expires_at BETWEEN today AND today + 60 days.
//   2. Group by vendor_id; count the certs.
//   3. Enqueue one M28 notification per vendor group to roles
//      ['admin','compliance']: "X vendor certifications expire within 60
//      days for {vendor_name}".
//   4. Dedup is intrinsic via the notifications_overdue_log-style approach:
//      we record a daily dedup row in cron_expiring_cert_log per
//      (entity_id, vendor_id, scan_date). Same-day re-runs skip notify.
//      The dedup table is best-effort — if it doesn't exist, we still
//      enqueue (idempotency falls to the cron schedule itself).
//
// Auth: Vercel cron injects `Authorization: Bearer ${CRON_SECRET}` when
// CRON_SECRET is set in the environment. Manual dry-runs are allowed when
// CRON_SECRET is unset (useful in staging).
//
// Exported `runExpiringCertScan(supabase, opts?)` returns a summary
// {entities_scanned, vendors_notified, certs_in_window, duplicates_skipped,
//  errors} for testing.

import { createClient } from "@supabase/supabase-js";
import { enqueue as enqueueNotification } from "../_lib/notifications/index.js";

export const config = { maxDuration: 60 };

export const DEFAULT_WINDOW_DAYS = 60;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const expectedSecret = process.env.CRON_SECRET;
  if (expectedSecret) {
    const got = req.headers.authorization || "";
    if (got !== `Bearer ${expectedSecret}`) return res.status(401).json({ error: "Unauthorized" });
  }

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  try {
    const out = await runExpiringCertScan(admin);
    return res.status(200).json({ ok: true, ...out });
  } catch (err) {
    return res.status(500).json({ error: err.message || String(err) });
  }
}

/**
 * @param {Object} supabase  service-role client
 * @param {Object} [opts]
 * @param {number} [opts.windowDays=60]
 * @param {(s:Object,ctx:Object)=>Promise<void>} [opts.enqueueFn]  Override for testing
 * @param {string} [opts.today]   YYYY-MM-DD — override for tests
 * @returns {Promise<{entities_scanned:number, vendors_notified:number, certs_in_window:number, duplicates_skipped:number, errors:string[]}>}
 */
export async function runExpiringCertScan(supabase, opts = {}) {
  const windowDays = Number.isFinite(opts.windowDays) ? opts.windowDays : DEFAULT_WINDOW_DAYS;
  const enqueueFn = opts.enqueueFn || enqueueNotification;
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const future = addDays(today, windowDays);

  const summary = {
    entities_scanned: 0,
    vendors_notified: 0,
    certs_in_window: 0,
    duplicates_skipped: 0,
    errors: [],
  };

  const { data: entities, error: eErr } = await supabase
    .from("entities")
    .select("id, code, name");
  if (eErr) throw new Error(`entities query failed: ${eErr.message}`);

  for (const entity of entities || []) {
    summary.entities_scanned += 1;

    const { data: certs, error: cErr } = await supabase
      .from("vendor_compliance_certifications")
      .select("id, vendor_id, certification_type, cert_number, expires_at")
      .eq("entity_id", entity.id)
      .eq("status", "active")
      .gte("expires_at", today)
      .lte("expires_at", future);
    if (cErr) {
      summary.errors.push(`entity ${entity.code}: certs query failed: ${cErr.message}`);
      continue;
    }
    summary.certs_in_window += (certs || []).length;

    const byVendor = groupByVendor(certs || []);

    for (const [vendorId, vendorCerts] of byVendor.entries()) {
      // Dedup row (best-effort; the table may not exist in older schemas).
      try {
        const { error: dedupErr } = await supabase
          .from("cron_expiring_cert_log")
          .insert({
            entity_id: entity.id,
            vendor_id: vendorId,
            scan_date: today,
            cert_count: vendorCerts.length,
          });
        if (dedupErr) {
          if (dedupErr.code === "23505") {
            summary.duplicates_skipped += 1;
            continue;
          }
          // 42P01 (undefined_table) or other — ignore dedup; continue notify.
        }
      } catch {
        // Swallow — dedup is non-critical for correctness.
      }

      // Resolve vendor name for subject + body.
      let vendorName = vendorId;
      try {
        const { data: vendor } = await supabase
          .from("vendors")
          .select("name")
          .eq("id", vendorId)
          .maybeSingle();
        if (vendor?.name) vendorName = vendor.name;
      } catch { /* fall through with the uuid */ }

      const nCerts = vendorCerts.length;
      const earliest = vendorCerts
        .map((c) => c.expires_at)
        .filter(Boolean)
        .sort()[0];

      try {
        await enqueueFn(supabase, {
          entity_id: entity.id,
          kind: "compliance_cert_expiring",
          severity: "warn",
          subject: `${nCerts} vendor cert${nCerts === 1 ? "" : "s"} expiring within ${windowDays}d — ${vendorName}`,
          body:
            `${vendorName} has ${nCerts} active compliance certification${nCerts === 1 ? "" : "s"} ` +
            `expiring on or before ${future} ` +
            `(earliest: ${earliest || "?"}). Review and request renewal documents. ` +
            `Cert types: ${vendorCerts.map((c) => c.certification_type).join(", ")}.`,
          context_table: "vendor_compliance_certifications",
          context_id: vendorCerts[0].id,
          recipient_roles: ["admin", "compliance"],
          payload: {
            vendor_id: vendorId,
            vendor_name: vendorName,
            cert_count: nCerts,
            earliest_expiry: earliest || null,
            window_end: future,
          },
        });
        summary.vendors_notified += 1;
      } catch (enqErr) {
        summary.errors.push(
          `entity ${entity.code} vendor ${vendorId}: enqueue failed: ${enqErr.message || enqErr}`,
        );
      }
    }
  }

  return summary;
}

/** Group certs by vendor_id. Pure helper — exported for tests. */
export function groupByVendor(certs) {
  const m = new Map();
  for (const c of certs || []) {
    if (!c || !c.vendor_id) continue;
    if (!m.has(c.vendor_id)) m.set(c.vendor_id, []);
    m.get(c.vendor_id).push(c);
  }
  return m;
}

/** Add `days` to a YYYY-MM-DD string. Pure — exported for tests. */
export function addDays(yyyyMmDd, days) {
  const d = new Date(yyyyMmDd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

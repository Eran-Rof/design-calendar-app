// api/cron/ar-aging-overdue-email
//
// Tangerine P4-6 — daily AR overdue notification cron.
//
// Per entity:
//   1. Fetch current AR aging via v_ar_aging.
//   2. For each customer with non-zero bucket_30 / 60 / 90 / 120plus_cents,
//      enqueue a notification (kind = customer_overdue_30d / 60d / 90d /
//      120d_plus) to recipient_roles=['admin','accountant'].
//   3. Dedup by inserting into notifications_overdue_log
//      (entity, customer, bucket, sent_on=current_date) BEFORE enqueueing.
//      ON CONFLICT DO NOTHING → if a row already exists for today, skip.
//
// Runs daily at 14:30 UTC per vercel.json (~6:30 PT / 09:30 ET).
//
// Exported `runOverdueScan(supabase, opts?)` returns the per-entity summary
// (entities_scanned, customers_scanned, notifications_enqueued,
// duplicates_skipped, errors) for testing.

import { createClient } from "@supabase/supabase-js";
import { enqueue as enqueueNotification } from "../_lib/notifications/index.js";

export const config = { maxDuration: 120 };

const BUCKET_FIELDS = [
  { field: "bucket_30_cents",     bucket: "30d",        kind: "customer_overdue_30d",   severity: "info" },
  { field: "bucket_60_cents",     bucket: "60d",        kind: "customer_overdue_60d",   severity: "warn" },
  { field: "bucket_90_cents",     bucket: "90d",        kind: "customer_overdue_90d",   severity: "warn" },
  { field: "bucket_120plus_cents",bucket: "120d_plus",  kind: "customer_overdue_90d",   severity: "alert" },
  // 120+ rolls up under the 90d kind for severity escalation; the dedup
  // bucket label distinguishes them so a customer overdue in BOTH 90d AND
  // 120+ gets two notifications on day 1 (one per bucket).
];

export default async function handler(req, res) {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: "Server not configured" });
  }
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  try {
    const out = await runOverdueScan(admin);
    return res.status(200).json({ ok: true, ...out });
  } catch (err) {
    return res.status(500).json({ error: err.message || String(err) });
  }
}

/**
 * Walk every entity, fetch aging, enqueue overdue notifications with dedup.
 * @param {Object} supabase  service-role client
 * @param {Object} [opts]
 * @param {(s:Object,ctx:Object)=>Promise<void>} [opts.enqueueFn]  Override for testing
 * @returns {Promise<{entities_scanned:number, customers_scanned:number, notifications_enqueued:number, duplicates_skipped:number, errors:string[]}>}
 */
export async function runOverdueScan(supabase, opts = {}) {
  const enqueueFn = opts.enqueueFn || enqueueNotification;

  const { data: entities, error: eErr } = await supabase
    .from("entities")
    .select("id, code, name");
  if (eErr) throw new Error(`entities query failed: ${eErr.message}`);

  const summary = {
    entities_scanned: 0,
    customers_scanned: 0,
    notifications_enqueued: 0,
    duplicates_skipped: 0,
    errors: [],
  };

  for (const entity of entities || []) {
    summary.entities_scanned += 1;

    const { data: rows, error: agErr } = await supabase
      .from("v_ar_aging")
      .select("*")
      .eq("entity_id", entity.id);
    if (agErr) {
      summary.errors.push(`entity ${entity.code}: aging query failed: ${agErr.message}`);
      continue;
    }

    for (const row of rows || []) {
      summary.customers_scanned += 1;

      for (const { field, bucket, kind, severity } of BUCKET_FIELDS) {
        const cents = Number(row[field] || 0);
        if (cents <= 0) continue;

        // Dedup: try to insert; if the unique (entity, customer, bucket, day)
        // already exists, skip the enqueue.
        const { data: dedupRow, error: dErr } = await supabase
          .from("notifications_overdue_log")
          .insert({
            entity_id: entity.id,
            customer_id: row.customer_id,
            bucket,
            open_cents: cents,
          })
          .select("id")
          .maybeSingle();

        if (dErr) {
          // 23505 = unique_violation — expected on same-day re-runs.
          if (dErr.code === "23505") {
            summary.duplicates_skipped += 1;
            continue;
          }
          summary.errors.push(
            `entity ${entity.code} customer ${row.customer_id} bucket ${bucket}: dedup insert failed: ${dErr.message}`,
          );
          continue;
        }
        if (!dedupRow) {
          summary.duplicates_skipped += 1;
          continue;
        }

        try {
          await enqueueFn(supabase, {
            entity_id: entity.id,
            kind,
            severity,
            subject: `AR overdue ${bucket}: ${row.customer_name || row.customer_code || row.customer_id}`,
            body:
              `${row.customer_name || row.customer_code || row.customer_id} ` +
              `has ${formatCents(cents)} overdue in the ${bucket} bucket as of ${todayISO()}.`,
            context_table: "customers",
            context_id: row.customer_id,
            recipient_roles: ["admin", "accountant"],
          });
          summary.notifications_enqueued += 1;
        } catch (enqErr) {
          summary.errors.push(
            `entity ${entity.code} customer ${row.customer_id} bucket ${bucket}: enqueue failed: ${enqErr.message || enqErr}`,
          );
        }
      }
    }
  }

  return summary;
}

function formatCents(c) {
  const n = Number(c || 0);
  const neg = n < 0;
  const abs = Math.abs(n);
  const whole = Math.trunc(abs / 100);
  const frac = abs - whole * 100;
  return `${neg ? "-" : ""}$${whole.toLocaleString()}.${String(frac).padStart(2, "0")}`;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export { BUCKET_FIELDS };

// api/internal/bulk/process
//
// Background processor for bulk_operations rows. Called fire-and-forget
// from POST /api/vendor/bulk/upload with body { bulk_operation_id }.
//
// Steps:
//   1) Mark operation status='processing', started_at=now
//   2) Download input CSV from Storage (bulk-operations bucket)
//   3) Parse rows and run per-type logic:
//        - po_acknowledge  → upsert po_acknowledgments for matching POs
//        - catalog_update  → update catalog_items fields; price history
//                            is inserted automatically by DB trigger
//   4) Build result CSV with added status + error columns
//   5) Upload result CSV to {vendor_id}/{op_id}/result.csv
//   6) Update bulk_operations: status='complete', counts, result_file_url
//   7) Fire bulk_operation_complete notification to vendor primary user

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 60 };

// ─── CSV helpers ──────────────────────────────────────────────────────────
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const s = text.replace(/^\uFEFF/, ""); // strip BOM
  while (i < s.length) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

function encodeCsvField(v) {
  if (v == null) return "";
  const s = String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows) {
  return rows.map((r) => r.map(encodeCsvField).join(",")).join("\n") + "\n";
}

function rowToObject(headers, row) {
  const out = {};
  for (let i = 0; i < headers.length; i++) out[headers[i]] = row[i] != null ? String(row[i]).trim() : "";
  return out;
}

// ─── Per-type row processors ──────────────────────────────────────────────
async function processPoAckRow(admin, op, rowObj) {
  const poNumber = (rowObj.po_number || "").trim();
  if (!poNumber) return { ok: false, error: "po_number is required" };

  const { data: po } = await admin
    .from("tanda_pos")
    .select("uuid_id, po_number, data")
    .eq("po_number", poNumber)
    .eq("vendor_id", op.vendor_id)
    .maybeSingle();
  if (!po) return { ok: false, error: `PO ${poNumber} not found for this vendor` };

  const statusName = String(po.data?.StatusName || "").toLowerCase();
  if (statusName.includes("closed") || statusName.includes("cancel") || statusName.includes("void"))
    return { ok: false, error: `PO status is ${po.data?.StatusName || "not issued"}` };
  if (statusName.includes("received") || statusName.includes("fulfilled") || statusName.includes("partial"))
    return { ok: false, error: `PO already ${po.data?.StatusName}` };

  if (!op.created_by) return { ok: false, error: "Bulk operation has no created_by vendor user" };

  const { error: upErr } = await admin
    .from("po_acknowledgments")
    .upsert(
      { po_number: poNumber, vendor_user_id: op.created_by },
      { onConflict: "po_number,vendor_user_id" },
    );
  if (upErr) return { ok: false, error: upErr.message };
  return { ok: true };
}

async function processCatalogUpdateRow(admin, op, rowObj) {
  const sku = (rowObj.sku || "").trim();
  if (!sku) return { ok: false, error: "sku is required" };

  const { data: item } = await admin
    .from("catalog_items")
    .select("id, unit_price")
    .eq("sku", sku)
    .eq("vendor_id", op.vendor_id)
    .maybeSingle();
  if (!item) return { ok: false, error: `SKU ${sku} not found in your catalog` };

  const updates = {};
  if (rowObj.name)               updates.name = rowObj.name;
  if (rowObj.unit_price !== "" && rowObj.unit_price != null) {
    const n = Number(rowObj.unit_price);
    if (!Number.isFinite(n)) return { ok: false, error: `unit_price "${rowObj.unit_price}" is not a number` };
    updates.unit_price = n;
  }
  if (rowObj.lead_time_days !== "" && rowObj.lead_time_days != null) {
    const n = Number(rowObj.lead_time_days);
    if (!Number.isInteger(n)) return { ok: false, error: `lead_time_days "${rowObj.lead_time_days}" must be integer` };
    updates.lead_time_days = n;
  }
  if (rowObj.min_order_quantity !== "" && rowObj.min_order_quantity != null) {
    const n = Number(rowObj.min_order_quantity);
    if (!Number.isInteger(n)) return { ok: false, error: `min_order_quantity "${rowObj.min_order_quantity}" must be integer` };
    updates.min_order_quantity = n;
  }
  if (rowObj.status) {
    if (!["active", "inactive", "discontinued"].includes(rowObj.status))
      return { ok: false, error: `status must be active, inactive, or discontinued` };
    updates.status = rowObj.status;
  }
  if (rowObj.category) updates.category = rowObj.category;

  if (Object.keys(updates).length === 0) return { ok: false, error: "No updatable columns provided" };

  const { error: uErr } = await admin.from("catalog_items").update(updates).eq("id", item.id);
  if (uErr) return { ok: false, error: uErr.message };
  return { ok: true };
}

// ─── Main handler ─────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const bulkId = body?.bulk_operation_id;
  if (!bulkId) return res.status(400).json({ error: "bulk_operation_id is required" });

  // Respond quickly and run the rest asynchronously — the fire-and-forget
  // caller will have timed out by the time this finishes. We still await
  // inside the handler to keep the Vercel instance alive long enough.
  res.status(202).json({ ok: true, bulk_operation_id: bulkId });

  try {
    await runProcessor(admin, bulkId);
  } catch (e) {
    try {
      await admin.from("bulk_operations").update({
        status: "failed",
        error_summary: { error: e instanceof Error ? e.message : String(e) },
        completed_at: new Date().toISOString(),
      }).eq("id", bulkId);
    } catch { /* swallow */ }
  }
}

async function runProcessor(admin, bulkId) {
  const { data: op } = await admin.from("bulk_operations").select("*").eq("id", bulkId).maybeSingle();
  if (!op) throw new Error(`bulk_operation ${bulkId} not found`);
  if (op.status !== "queued") return; // guard against double-processing

  await admin.from("bulk_operations").update({
    status: "processing",
    started_at: new Date().toISOString(),
  }).eq("id", bulkId);

  // 1) Download input CSV
  const { data: blob, error: dlErr } = await admin.storage.from("bulk-operations").download(op.input_file_url);
  if (dlErr) throw new Error(`download failed: ${dlErr.message}`);
  const csvText = await blob.text();
  const grid = parseCsv(csvText);
  if (grid.length === 0) throw new Error("CSV is empty");

  const headers = grid[0].map((h) => h.trim().toLowerCase());
  const dataRows = grid.slice(1);

  // 2) Process each row
  const resultHeader = [...headers, "status", "error"];
  const resultRows = [resultHeader];
  let successCount = 0;
  let failureCount = 0;
  const errorSamples = [];

  for (const raw of dataRows) {
    const obj = rowToObject(headers, raw);
    let result;
    try {
      if (op.type === "po_acknowledge")      result = await processPoAckRow(admin, op, obj);
      else if (op.type === "catalog_update") result = await processCatalogUpdateRow(admin, op, obj);
      else                                   result = { ok: false, error: `Unsupported type: ${op.type}` };
    } catch (e) {
      result = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (result.ok) { successCount++; resultRows.push([...raw, "success", ""]); }
    else {
      failureCount++;
      resultRows.push([...raw, "failed", result.error || ""]);
      if (errorSamples.length < 10) errorSamples.push({ row: raw, error: result.error });
    }
  }

  // 3) Upload result CSV
  const resultCsv = toCsv(resultRows);
  const resultPath = `${op.vendor_id}/${op.id}/result.csv`;
  const { error: upErr } = await admin.storage.from("bulk-operations").upload(
    resultPath,
    new Blob([resultCsv], { type: "text/csv" }),
    { upsert: true, contentType: "text/csv" },
  );
  if (upErr) throw new Error(`upload result failed: ${upErr.message}`);

  // 4) Finalize record
  await admin.from("bulk_operations").update({
    status: "complete",
    result_file_url: resultPath,
    total_rows: dataRows.length,
    success_count: successCount,
    failure_count: failureCount,
    error_summary: failureCount > 0 ? { samples: errorSamples } : null,
    completed_at: new Date().toISOString(),
  }).eq("id", bulkId);

  // 5) Notify vendor primary user
  try {
    const { data: primary } = await admin
      .from("vendor_users").select("auth_id").eq("vendor_id", op.vendor_id).eq("role", "primary").maybeSingle();
    if (primary?.auth_id) {
      const { data: vendor } = await admin.from("vendors").select("name").eq("id", op.vendor_id).maybeSingle();
      const origin = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://vendor.ringoffire.com";
      const typeLabel = op.type === "po_acknowledge" ? "PO acknowledgments"
                      : op.type === "catalog_update"  ? "Catalog update"
                      : op.type;
      await fetch(`${origin}/api/send-notification`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_type: "bulk_operation_complete",
          title: `${typeLabel} — ${successCount} succeeded, ${failureCount} failed`,
          body: `Your bulk upload finished. ${successCount} of ${dataRows.length} rows succeeded. Download the result CSV to review errors.`,
          link: "/vendor/bulk",
          metadata: { bulk_operation_id: bulkId, vendor_id: op.vendor_id, vendor_name: vendor?.name || null, type: op.type },
          recipient: { vendor_id: op.vendor_id },
          dedupe_key: `bulk_complete_${bulkId}`,
          email: true,
        }),
      }).catch(() => {});
    }
  } catch { /* non-blocking */ }
}

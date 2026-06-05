// api/internal/costing/lines/:line_id/select-quote
//
// POST { quote_id }
//
// Selects a vendor quote as the winning one for a costing line:
//   1. Demote any currently-selected quote on this line back to 'received'
//      (so the partial unique index allows the swap).
//   2. Promote the new quote to status='selected'.
//   3. Write quote.quoted_cost into ip_item_avg_cost.standard_unit_price for
//      every SKU under the line's style_code (Chunk 8). UPSERT; only the
//      standard_unit_price column is touched — avg_cost stays Xoro-authoritative.
//   4. Stamp costing_lines.selected_vendor_quote_id (the line back-pointer).
//
// Ordering rationale (atomicity): Supabase JS has no multi-statement
// transactions outside RPC, so we do the cost-write AFTER the quote
// promotion and BEFORE the line back-pointer stamp. If the cost-write
// fails we still stamp the back-pointer (or skip it) and surface the
// error in the response — the operator can re-select the same quote to
// retry the cost-write because the upsert is idempotent.
//
// Currency: non-USD quotes skip the cost-write (cost_write_reason:
// 'non_usd_currency'). FX conversion is deferred until a currency_rates
// resolver lands.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../../_lib/auth.js";
import { markLinesAwardedAndSiblingsLost } from "../../../../../_lib/costingLineStatus.js";

export const config = { maxDuration: 15 };

function getLineId(req) {
  if (req.query && req.query.line_id) return req.query.line_id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("lines");
  return idx >= 0 ? parts[idx + 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const __internalAuth = authenticateInternalCaller(req);
  if (!__internalAuth.ok) return res.status(__internalAuth.status).json({ error: __internalAuth.error });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const lineId = getLineId(req);
  if (!lineId) return res.status(400).json({ error: "Missing line id" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const { quote_id } = body || {};
  if (!quote_id) return res.status(400).json({ error: "quote_id is required" });

  // Verify quote belongs to this line.
  const { data: quote } = await admin.from("costing_line_vendors")
    .select("id, costing_line_id, quoted_cost, currency")
    .eq("id", quote_id).maybeSingle();
  if (!quote) return res.status(404).json({ error: "Quote not found" });
  if (quote.costing_line_id !== lineId) {
    return res.status(409).json({ error: "Quote does not belong to this line" });
  }

  // 1. Demote any currently-selected quote (other than this one) on this line.
  await admin.from("costing_line_vendors")
    .update({ status: "received" })
    .eq("costing_line_id", lineId)
    .eq("status", "selected")
    .neq("id", quote_id);

  // 2. Promote the new quote.
  const { error: promoteErr } = await admin.from("costing_line_vendors")
    .update({ status: "selected" }).eq("id", quote_id);
  if (promoteErr) return res.status(500).json({ error: promoteErr.message });

  // 3. Write standard_unit_price into ip_item_avg_cost for every SKU under
  //    the line's style_code. This happens BEFORE the back-pointer stamp so
  //    operators don't see a "selected" line with stale costs. Failures here
  //    don't roll back the quote promotion — they're surfaced in the response
  //    and the operator can re-select the same quote (upsert is idempotent).
  let costWriteCount = 0;
  let costWriteReason = null;
  let costWriteError = null;
  let costWriteMissingCount = 0;

  try {
    const { data: lineForStyle, error: lineLookupErr } = await admin.from("costing_lines")
      .select("style_code").eq("id", lineId).maybeSingle();
    if (lineLookupErr) throw new Error(`line lookup failed: ${lineLookupErr.message}`);

    const styleCode = lineForStyle && lineForStyle.style_code;
    const currency = (quote.currency || "USD").toUpperCase();

    if (!styleCode) {
      costWriteReason = "no_style_code";
    } else if (currency !== "USD") {
      // MVP: skip non-USD. TODO: convert via currency_rates once available.
      costWriteReason = "non_usd_currency";
    } else {
      const { data: skus, error: skuErr } = await admin.from("ip_item_master")
        .select("sku_code").eq("style_code", styleCode);
      if (skuErr) throw new Error(`sku lookup failed: ${skuErr.message}`);

      const skuList = (skus || []).filter((s) => s && s.sku_code);
      if (skuList.length === 0) {
        costWriteReason = "no_skus_for_style";
      } else {
        const priceUsd = Number(quote.quoted_cost);
        const sourceRef = `costing_module:line:${lineId}:quote:${quote_id}`;
        const rows = skuList.map((s) => ({
          sku_code: s.sku_code,
          standard_unit_price: priceUsd,
          source: "manual",
          source_ref: sourceRef,
        }));

        // Capture before-values for the audit trail (or console fallback).
        const skuCodes = skuList.map((s) => s.sku_code);
        const { data: beforeRows } = await admin.from("ip_item_avg_cost")
          .select("sku_code, standard_unit_price")
          .in("sku_code", skuCodes);
        const beforeBySku = Object.fromEntries(
          (beforeRows || []).map((r) => [r.sku_code, r.standard_unit_price])
        );

        // NOTE: ip_item_avg_cost has avg_cost NOT NULL with no default. For
        // SKUs that don't have an existing row, an upsert would fail because
        // we're not supplying avg_cost. Detect missing rows and limit the
        // upsert to SKUs that already exist; missing SKUs are reported via
        // cost_write_missing_skus. This keeps avg_cost Xoro-authoritative.
        const existingSkus = new Set(Object.keys(beforeBySku));
        const upsertRows = rows.filter((r) => existingSkus.has(r.sku_code));
        const missingSkus = rows
          .filter((r) => !existingSkus.has(r.sku_code))
          .map((r) => r.sku_code);

        if (upsertRows.length > 0) {
          const { error: upsertErr } = await admin.from("ip_item_avg_cost")
            .upsert(upsertRows, { onConflict: "sku_code" });
          if (upsertErr) throw new Error(`upsert failed: ${upsertErr.message}`);
          costWriteCount = upsertRows.length;
        }
        if (missingSkus.length > 0) {
          costWriteMissingCount = missingSkus.length;
          // Surface missing SKUs but don't fail — those rows can be seeded
          // when Xoro nightly populates avg_cost, then re-selecting the quote
          // will stamp the standard_unit_price.
          // eslint-disable-next-line no-console
          console.log(
            `[costing-module] line=${lineId} quote=${quote_id} missing ip_item_avg_cost rows for ${missingSkus.length} sku(s): ${missingSkus.slice(0, 10).join(",")}${missingSkus.length > 10 ? "..." : ""}`
          );
        }

        // Audit trail — try ip_item_avg_cost_audit; fall back to console.
        if (upsertRows.length > 0) {
          const auditRows = upsertRows.map((r) => ({
            sku_code: r.sku_code,
            before_standard_unit_price: beforeBySku[r.sku_code] ?? null,
            after_standard_unit_price: r.standard_unit_price,
            source: "manual",
            source_ref: sourceRef,
            changed_by: "costing_module",
          }));
          const { error: auditErr } = await admin.from("ip_item_avg_cost_audit").insert(auditRows);
          if (auditErr) {
            // Table likely doesn't exist yet — log to console instead.
            // eslint-disable-next-line no-console
            console.log(
              `[costing-module] audit-table-fallback line=${lineId} quote=${quote_id} price=${priceUsd} sku_count=${upsertRows.length} reason=${auditErr.message}`
            );
          }
        }
      }
    }
  } catch (e) {
    costWriteError = e && e.message ? e.message : String(e);
    // eslint-disable-next-line no-console
    console.error(`[costing-module] cost-write failed line=${lineId} quote=${quote_id}: ${costWriteError}`);
  }

  // 4. Stamp the back-pointer. We do this even if the cost-write failed so
  //    the UI reflects the operator's selection; they can re-select to retry.
  const { data: line, error: lineErr } = await admin.from("costing_lines")
    .update({ selected_vendor_quote_id: quote_id })
    .eq("id", lineId).select("*").maybeSingle();
  if (lineErr) return res.status(500).json({ error: lineErr.message });

  // Picking a vendor directly on the line = the line is awarded. Set the stored
  // status (and mark same-style siblings 'lost'), the same as the RFQ award flow
  // — direct selection bypasses that handler, so without this the line would
  // stay 'draft'. Best-effort; reflect it on the returned line for the UI.
  try {
    await markLinesAwardedAndSiblingsLost(
      admin,
      [{ id: lineId, project_id: line?.project_id, style_code: line?.style_code }],
      { note: "vendor_selected" },
    );
    if (line) line.status = "awarded";
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[costing-status] select-quote award status failed: ${e && e.message ? e.message : String(e)}`);
  }

  const response = {
    line,
    selected_quote_id: quote_id,
    cost_write_count: costWriteCount,
    cost_write_missing_count: costWriteMissingCount,
  };
  if (costWriteReason) response.cost_write_reason = costWriteReason;
  if (costWriteError) response.cost_write_error = costWriteError;

  // The quote promotion + back-pointer stamp BOTH succeeded by the time we
  // get here. Return 200 even when the cost-write threw, with cost_write_error
  // in the body — so the UI can update its "awarded" state and surface a
  // partial-success toast. The previous 500 caused the client to roll back
  // the awarded state visually even though the DB was correctly updated.
  return res.status(200).json(response);
}

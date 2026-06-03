// api/internal/rfqs/:id/award/:vendor_id
//
// POST — award the RFQ to a vendor.
// Effects (all in order):
//   1. RFQ.status = 'awarded', awarded_to_vendor_id = vendor_id, awarded_at = now
//   2. Winning quote status = 'awarded'
//   3. All other quotes status = 'rejected'
//   4. rfq_awarded notification to winner
//   5. rfq_not_awarded notification to every other quoter
//   6. Fire workflow event rfq_awarded with context

import { createClient } from "@supabase/supabase-js";
import { fireWorkflowEvent } from "../../../../../_lib/workflow.js";
import { authenticateInternalCaller } from "../../../../../_lib/auth.js";
import { resolveProductionManager } from "../../../../../_lib/internal-recipients.js";

export const config = { maxDuration: 30 };

function getIds(req) {
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const rfqIdx = parts.lastIndexOf("rfqs");
  const awardIdx = parts.lastIndexOf("award");
  return {
    rfq_id:    rfqIdx >= 0 ? parts[rfqIdx + 1] : (req.query?.id || null),
    vendor_id: awardIdx >= 0 ? parts[awardIdx + 1] : (req.query?.vendor_id || null),
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Internal-API gate. See api/_lib/auth.js. Open until INTERNAL_API_TOKEN
  // is set (logs a warn on first call); 401 once configured.
  const __internalAuth = authenticateInternalCaller(req);
  if (!__internalAuth.ok) return res.status(__internalAuth.status).json({ error: __internalAuth.error });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const { rfq_id, vendor_id } = getIds(req);
  if (!rfq_id || !vendor_id) return res.status(400).json({ error: "Missing rfq or vendor id" });

  const [{ data: rfq }, { data: vendor }] = await Promise.all([
    admin.from("rfqs").select("*").eq("id", rfq_id).maybeSingle(),
    admin.from("vendors").select("id, name").eq("id", vendor_id).maybeSingle(),
  ]);
  if (!rfq) return res.status(404).json({ error: "RFQ not found" });
  if (!vendor) return res.status(404).json({ error: "Vendor not found" });
  if (rfq.status === "awarded") return res.status(409).json({ error: "RFQ is already awarded" });

  // Fetch all quotes UP FRONT so we can gate the award on the winning vendor
  // having actually submitted one. Awarding to a vendor who never quoted would
  // leave the costing write-back + winner notification meaningless.
  const { data: allQuotes } = await admin
    .from("rfq_quotes")
    .select("id, vendor_id, status, total_price")
    .eq("rfq_id", rfq_id);
  const winning = (allQuotes || []).find((q) => q.vendor_id === vendor_id);

  // Gate: the awarded vendor must have a SUBMITTED (or under-review / already
  // awarded) quote. Draft / declined / missing quotes can't win — return a
  // descriptive 409 the UI surfaces verbatim.
  const SUBMITTED_STATES = ["submitted", "under_review", "awarded"];
  if (!winning || !SUBMITTED_STATES.includes(winning.status)) {
    return res.status(409).json({
      error: winning
        ? `Cannot award: ${vendor.name || "this vendor"}'s quote is "${winning.status}", not submitted yet.`
        : `Cannot award: ${vendor.name || "this vendor"} has not submitted a quote for this RFQ.`,
    });
  }

  const nowIso = new Date().toISOString();

  // 1. Set RFQ to awarded
  await admin.from("rfqs").update({
    status: "awarded",
    awarded_to_vendor_id: vendor_id,
    awarded_at: nowIso,
    updated_at: nowIso,
  }).eq("id", rfq_id);

  // 2 & 3. Update quotes
  if (winning) {
    await admin.from("rfq_quotes").update({ status: "awarded", updated_at: nowIso }).eq("id", winning.id);
  }
  const losingIds = (allQuotes || []).filter((q) => q.vendor_id !== vendor_id).map((q) => q.id);
  if (losingIds.length > 0) {
    await admin.from("rfq_quotes").update({ status: "rejected", updated_at: nowIso }).in("id", losingIds);
  }

  // 3b. Costing write-back. If this RFQ originated from a costing project
  //     (rfqs.source_costing_project_id set) AND its line items carry the
  //     costing_line_id back-pointer (migration 20260719000000), flow the
  //     winning vendor's quoted unit_price back into each source costing line:
  //       • upsert a costing_line_vendors row (vendor_id = awarded vendor,
  //         quoted_cost = quote line unit_price, status='selected'),
  //       • demote any other previously-selected quote on that line to
  //         'received' (the partial unique index allows only one 'selected'),
  //       • stamp costing_lines.selected_vendor_quote_id at the new row.
  //     Fully idempotent (re-award reuses the existing (line,vendor) row).
  //     Legacy / non-costing RFQs (no source project, or NULL costing_line_id,
  //     or no winning quote) skip this block silently. All failures are caught
  //     + surfaced in costing_write_errors; they never break the award flow.
  const costingWriteback = { written: 0, skipped_reason: null, errors: [] };
  try {
    if (!rfq.source_costing_project_id) {
      costingWriteback.skipped_reason = "rfq_not_from_costing";
    } else if (!winning) {
      costingWriteback.skipped_reason = "no_winning_quote";
    } else {
      // Quote lines for the winning quote, joined to their rfq_line_item so we
      // can read the costing_line_id back-pointer. unit_price is the quoted
      // per-unit cost we write into costing.
      const { data: qLines, error: qLinesErr } = await admin
        .from("rfq_quote_lines")
        .select("id, unit_price, rfq_line_item_id, rfq_line_items!inner(id, costing_line_id)")
        .eq("quote_id", winning.id);
      if (qLinesErr) throw new Error(`quote-line lookup failed: ${qLinesErr.message}`);

      // Map costing_line_id → unit_price (first non-null wins; one line item
      // per costing line by construction in generate-rfqs).
      const byCostingLine = new Map();
      for (const ql of qLines || []) {
        const cli = ql.rfq_line_items?.costing_line_id;
        if (!cli) continue; // legacy / non-costing line item
        if (!byCostingLine.has(cli)) byCostingLine.set(cli, ql);
      }

      if (byCostingLine.size === 0) {
        costingWriteback.skipped_reason = "no_costing_line_ids";
      } else {
        const costingLineIds = Array.from(byCostingLine.keys());
        // Pull entity_id for the costing_line_vendors insert (service-role
        // bypasses the current_entity_id() default → supply it explicitly).
        const { data: clRows, error: clErr } = await admin
          .from("costing_lines")
          .select("id, entity_id")
          .in("id", costingLineIds);
        if (clErr) throw new Error(`costing_lines lookup failed: ${clErr.message}`);
        const entityByLine = Object.fromEntries((clRows || []).map((r) => [r.id, r.entity_id]));
        // Only act on costing lines that still exist.
        const liveLineIds = new Set((clRows || []).map((r) => r.id));

        // Existing (line, awarded-vendor) quote rows — for idempotent upsert.
        const { data: existingCLV, error: existingErr } = await admin
          .from("costing_line_vendors")
          .select("id, costing_line_id")
          .in("costing_line_id", costingLineIds)
          .eq("vendor_id", vendor_id);
        if (existingErr) throw new Error(`costing_line_vendors lookup failed: ${existingErr.message}`);
        const clvByLine = Object.fromEntries((existingCLV || []).map((r) => [r.costing_line_id, r.id]));

        for (const lineId of costingLineIds) {
          if (!liveLineIds.has(lineId)) {
            costingWriteback.errors.push({ costing_line_id: lineId, error: "costing line not found" });
            continue;
          }
          const ql = byCostingLine.get(lineId);
          const unitPrice = Number(ql.unit_price);
          if (!Number.isFinite(unitPrice) || unitPrice < 0) {
            // quoted_cost is NOT NULL CHECK >= 0; skip un-priced quote lines.
            costingWriteback.errors.push({ costing_line_id: lineId, error: `invalid unit_price (${ql.unit_price})` });
            continue;
          }

          // 1. Demote any other currently-selected quote on this line so the
          //    partial unique index (one 'selected' per line) allows the swap.
          const existingId = clvByLine[lineId] || null;
          {
            let demote = admin.from("costing_line_vendors")
              .update({ status: "received", updated_at: nowIso })
              .eq("costing_line_id", lineId)
              .eq("status", "selected");
            if (existingId) demote = demote.neq("id", existingId);
            await demote;
          }

          // 2. Upsert the awarded vendor's quote row for this line.
          let clvId = existingId;
          if (existingId) {
            const { error: updErr } = await admin.from("costing_line_vendors")
              .update({
                quoted_cost: unitPrice,
                status: "selected",
                updated_at: nowIso,
              })
              .eq("id", existingId);
            if (updErr) { costingWriteback.errors.push({ costing_line_id: lineId, error: updErr.message }); continue; }
          } else {
            const insertRow = {
              costing_line_id: lineId,
              vendor_id,
              quoted_cost: unitPrice,
              currency: "USD",
              status: "selected",
              notes: `Awarded via RFQ ${rfq_id}`,
            };
            if (entityByLine[lineId]) insertRow.entity_id = entityByLine[lineId];
            const { data: ins, error: insErr } = await admin.from("costing_line_vendors")
              .insert(insertRow).select("id").maybeSingle();
            if (insErr || !ins) { costingWriteback.errors.push({ costing_line_id: lineId, error: insErr?.message || "insert returned no row" }); continue; }
            clvId = ins.id;
          }

          // 3. Stamp the line back-pointer at the selected quote.
          const { error: stampErr } = await admin.from("costing_lines")
            .update({ selected_vendor_quote_id: clvId, updated_at: nowIso })
            .eq("id", lineId);
          if (stampErr) { costingWriteback.errors.push({ costing_line_id: lineId, error: stampErr.message }); continue; }

          costingWriteback.written += 1;
        }
      }
    }
  } catch (e) {
    // Pre-migration DBs (costing_line_id column absent) land here via the
    // join error — treat as legacy and skip without failing the award.
    const msg = e && e.message ? e.message : String(e);
    if (/costing_line_id|column .* does not exist/i.test(msg)) {
      costingWriteback.skipped_reason = "costing_line_id_unavailable";
    } else {
      costingWriteback.errors.push({ error: msg });
    }
    // eslint-disable-next-line no-console
    console.warn(`[rfq-award] costing write-back issue rfq=${rfq_id} vendor=${vendor_id}: ${msg}`);
  }

  // 4. Winner notification
  const origin = `https://${req.headers.host}`;
  try {
    await fetch(`${origin}/api/send-notification`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_type: "rfq_awarded",
        title: `You've been awarded the contract for ${rfq.title}`,
        body: `Congratulations — your quote on "${rfq.title}" has been awarded. We'll follow up with the next steps shortly.`,
        link: "/vendor/rfqs",
        metadata: { rfq_id, vendor_id, rfq_title: rfq.title, won: true },
        recipient: { vendor_id },
        dedupe_key: `rfq_awarded_${rfq_id}_${vendor_id}`,
        email: true,
      }),
    }).catch(() => {});
  } catch { /* swallow */ }

  // 5. Loser notifications — only to vendors who actually submitted a
  // quote (not declined / still-draft), per spec.
  const losingVendors = [...new Set(
    (allQuotes || [])
      .filter((q) => q.vendor_id !== vendor_id && ["submitted", "under_review", "rejected"].includes(q.status))
      .map((q) => q.vendor_id)
  )];
  for (const vid of losingVendors) {
    try {
      await fetch(`${origin}/api/send-notification`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_type: "rfq_not_awarded",
          title: `Quote outcome: ${rfq.title}`,
          body: `Thank you for quoting on "${rfq.title}". The award went to another vendor this time — we appreciate your participation.`,
          link: "/vendor/rfqs",
          metadata: { rfq_id, vendor_id: vid, rfq_title: rfq.title, won: false },
          recipient: { vendor_id: vid },
          dedupe_key: `rfq_not_awarded_${rfq_id}_${vid}`,
          email: true,
        }),
      }).catch(() => {});
    } catch { /* swallow */ }
  }

  // 5b. Production Manager notification + email (additive — must never break
  // the award). The PM is resolved data-first (an active employee titled
  // "Production Manager") with an env/subscription fallback to the procurement
  // recipients. Fires one in-app notification + email per resolved recipient,
  // deduped server-side by (rfq_id, recipient).
  const awardedTotal = Number.isFinite(Number(winning?.total_price)) ? Number(winning.total_price) : null;
  const totalLabel = awardedTotal != null
    ? awardedTotal.toLocaleString(undefined, { style: "currency", currency: rfq.currency || "USD" })
    : "—";
  // Prefer linking to the source costing project; fall back to the RFQ list.
  const pmLink = rfq.source_costing_project_id
    ? `/costing?view=project-edit&id=${rfq.source_costing_project_id}`
    : "/costing?view=rfq-list";
  const pmNotify = { sent: false, resolved_via: "none", recipients: 0, in_app_delivered: 0, email_only: 0 };
  try {
    const pm = await resolveProductionManager(admin, { event: "rfq_awarded" });
    pmNotify.resolved_via = pm.resolved_via;
    if (pm.employees.length > 0) {
      await Promise.all(pm.employees.map((recipient) => {
        // In-app delivery only works when the PM employee is linked to a PLM
        // login (employees.metadata.plm_user_id): the internal NotificationsShell
        // matches the logged-in user by recipient_internal_id == app_data['users'].id.
        // Without that link we can't address the bell — fall back to email-only
        // by writing the row under a sentinel internal_id (carries the email; the
        // in-app row is intentionally undeliverable + logged below).
        const hasInAppTarget = typeof recipient.plm_user_id === "string" && recipient.plm_user_id;
        const internalId = hasInAppTarget ? recipient.plm_user_id : "production_manager";
        // Mirror the employee's app selection onto the row so the bell only
        // shows it in their chosen apps. null apps → omit (= all apps).
        const targetApps = Array.isArray(recipient.apps) && recipient.apps.length > 0 ? recipient.apps : null;
        if (hasInAppTarget) pmNotify.in_app_delivered += 1; else pmNotify.email_only += 1;
        return fetch(`${origin}/api/send-notification`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event_type: "rfq_awarded_internal",
            title: `RFQ awarded: ${rfq.title} → ${vendor.name}`,
            body: `"${rfq.title}" has been awarded to ${vendor.name} at ${totalLabel}. The price has flowed into the costing project.`,
            link: pmLink,
            metadata: {
              rfq_id, vendor_id, rfq_title: rfq.title,
              vendor_name: vendor.name, awarded_total: awardedTotal,
              source_costing_project_id: rfq.source_costing_project_id || null,
              ...(targetApps ? { target_apps: targetApps } : {}),
            },
            recipient: { internal_id: internalId, email: recipient.email },
            dedupe_key: `rfq_awarded_internal_${rfq_id}_${recipient.email}`,
            email: true,
          }),
        }).catch(() => {});
      }));
      pmNotify.sent = true;
      pmNotify.recipients = pm.employees.length;
      if (pmNotify.email_only > 0) {
        // eslint-disable-next-line no-console
        console.warn(`[rfq-award] ${pmNotify.email_only} Production Manager recipient(s) have no linked PLM login (employees.metadata.plm_user_id) — they got the EMAIL only, not the in-app bell. Link them to a PLM login in the Employees panel to enable in-app delivery. rfq=${rfq_id}`);
      }
    } else {
      // eslint-disable-next-line no-console
      console.warn(`[rfq-award] no Production Manager recipient resolved rfq=${rfq_id}. Tag an active employee with a "Production Manager" title, or set INTERNAL_PROCUREMENT_EMAILS.`);
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[rfq-award] production-manager notification issue rfq=${rfq_id}: ${e && e.message ? e.message : String(e)}`);
  }

  // 6. Workflow event
  try {
    await fireWorkflowEvent({
      admin, origin,
      event: "rfq_awarded",
      entity_id: rfq.entity_id,
      context: {
        entity_type: "rfq",
        entity_id: rfq_id,
        vendor_id,
        vendor_name: vendor.name,
        rfq_title: rfq.title,
        category: rfq.category,
        amount: awardedTotal,
      },
    });
  } catch { /* non-blocking */ }

  return res.status(200).json({
    ok: true,
    rfq_id,
    awarded_to: vendor_id,
    losers_notified: losingVendors.length,
    pm_notify: pmNotify,
    costing_writeback: costingWriteback,
  });
}

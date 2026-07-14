// api/cron/edi-3pl-transport
//
// The transport engine for 3PL EDI. Two passes each run:
//
//   OUTBOUND: pick up sendable outbound edi_messages (queued/generated, or
//             failed-and-past-backoff under MAX_ATTEMPTS) that target a 3PL
//             provider, transmit each over SFTP, and advance the outbox state
//             machine (sent | failed-with-backoff). Sets ack_status=pending so
//             an inbound 997 can reconcile it.
//
//   INBOUND:  for each active provider with polling enabled + an inbound dir,
//             SFTP-poll the dir, de-dupe each transaction by (transaction_set,
//             ISA control number), record it, then APPLY conservatively
//             (997 auto-reconciled; 944/945/846 STAGED for operator review —
//             see api/_lib/edi/apply3pl.js). Processed files are archived.
//
// Nothing here posts to the GL or silently mutates shipments/inventory.
// Scheduled via vercel.json (every 15 min). Errors → app_errors (source 'cron').

import { createClient } from "@supabase/supabase-js";
import { transmitEdi, pollInbound, archiveInboundFile } from "../../_lib/edi/transport.js";
import { applyInbound } from "../../_lib/edi/apply3pl.js";
import { parseEnvelope, interchangeControl, groupControl, transactionControl } from "../../_lib/edi/parser.js";
import { nextOutboundState, isSendable, MAX_ATTEMPTS } from "../../_lib/edi/outbox.js";
import { captureError } from "../../_lib/errorCapture.js";

export const config = { maxDuration: 120 };

const ROUTE = "/api/cron/edi-3pl-transport";
const ALLOWED_SETS = new Set(["850", "855", "856", "810", "820", "997", "940", "945", "846", "944"]);

function client() {
  return createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

const PROVIDER_COLS =
  "id, name, entity_id, is_active, edi_protocol, edi_endpoint, edi_port, edi_username, edi_credential_ref, edi_secret_ciphertext, edi_outbound_dir, edi_inbound_dir, edi_archive_dir, enabled_doc_types, edi_poll_enabled";
// Retail customer partners carry the SAME edi_* transport columns as a 3PL row,
// so transport.js resolves either shape identically. enabled_docs is the retail
// twin of enabled_doc_types.
const RETAIL_PARTNER_COLS =
  "id, customer_id, entity_id, is_active, edi_protocol, edi_endpoint, edi_port, edi_username, edi_credential_ref, edi_secret_ciphertext, edi_outbound_dir, edi_inbound_dir, edi_archive_dir, enabled_docs, edi_poll_enabled, usage_indicator";

// ─── OUTBOUND ────────────────────────────────────────────────────────────────
async function runOutbound(admin) {
  const nowIso = new Date().toISOString();
  // Candidate rows: outbound, in a sendable status, gate open, bound to EITHER a
  // 3PL provider (940 etc.) OR a retail customer partner (856/810). We over-select
  // then filter with the shared isSendable() so the state machine has one home.
  const { data: rows } = await admin
    .from("edi_messages")
    .select("id, direction, status, attempts, next_attempt_at, raw_content, file_name, interchange_id, group_control_number, tpl_provider_id, edi_customer_partner_id, transaction_set")
    .eq("direction", "outbound")
    .in("status", ["queued", "generated", "failed"])
    .or("tpl_provider_id.not.is.null,edi_customer_partner_id.not.is.null")
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${nowIso}`)
    .order("created_at", { ascending: true })
    .limit(100);

  const providerCache = new Map();
  async function loadProvider(id) {
    const key = `tpl:${id}`;
    if (providerCache.has(key)) return providerCache.get(key);
    const { data } = await admin.from("tpl_providers").select(PROVIDER_COLS).eq("id", id).maybeSingle();
    providerCache.set(key, data || null);
    return data || null;
  }
  async function loadRetailPartner(id) {
    const key = `retail:${id}`;
    if (providerCache.has(key)) return providerCache.get(key);
    const { data } = await admin.from("edi_customer_partners").select(RETAIL_PARTNER_COLS).eq("id", id).maybeSingle();
    providerCache.set(key, data || null);
    return data || null;
  }

  const results = [];
  for (const row of rows || []) {
    if (!isSendable(row)) continue;
    const isRetail = !!row.edi_customer_partner_id;
    const provider = isRetail ? await loadRetailPartner(row.edi_customer_partner_id) : await loadProvider(row.tpl_provider_id);
    if (!provider || provider.is_active === false) {
      results.push({ id: row.id, sent: false, detail: `${isRetail ? "retail partner" : "provider"} missing/inactive` });
      continue;
    }
    const docTypes = provider.enabled_doc_types || provider.enabled_docs || [];
    if (docTypes.length && !docTypes.includes(row.transaction_set)) {
      results.push({ id: row.id, sent: false, detail: `doc type ${row.transaction_set} not enabled for ${isRetail ? "partner" : "provider"}` });
      continue;
    }

    const filename = row.file_name || `${row.transaction_set}_${row.interchange_id || row.id}.edi`;
    const { transmitted, detail } = await transmitEdi({ payload: row.raw_content, provider, filename });
    const next = nextOutboundState({ attempts: row.attempts, transmitted, detail });
    await admin.from("edi_messages").update({
      status: next.status,
      attempts: next.attempts,
      transmitted: next.transmitted,
      transport_detail: next.transport_detail,
      last_error: next.last_error,
      next_attempt_at: next.next_attempt_at,
      ack_status: next.ack_status,
      file_name: filename,
      // Ensure a control number is captured for later 997 reconciliation.
      group_control_number: row.group_control_number || row.interchange_id || null,
      updated_at: new Date().toISOString(),
    }).eq("id", row.id);
    results.push({ id: row.id, sent: transmitted, status: next.status, attempts: next.attempts, detail });
  }
  return results;
}

// ─── INBOUND ─────────────────────────────────────────────────────────────────
async function ingestFile(admin, provider, file) {
  // Non-X12 or unparseable → record for audit, don't crash the run.
  let envelope;
  try {
    envelope = parseEnvelope(file.content);
  } catch (e) {
    return { file: file.name, ok: false, detail: `parse error: ${e?.message || e}`, archive: false };
  }
  const isaCtl = interchangeControl(envelope.isa);
  const perTxn = [];
  const docTypes = provider.enabled_doc_types || [];

  for (const group of envelope.groups || []) {
    const gsCtl = groupControl(group.gs);
    for (const txn of group.transactions || []) {
      const stCtl = transactionControl(txn.st);
      const set = stCtl.transactionSet;

      // Dedupe by (transaction_set, ISA control number) for this provider.
      const { data: existing } = await admin
        .from("edi_messages")
        .select("id")
        .eq("direction", "inbound")
        .eq("transaction_set", set)
        .eq("interchange_id", isaCtl.controlNumber)
        .eq("tpl_provider_id", provider.id)
        .limit(1);
      if (existing?.length) { perTxn.push({ set, skipped: "duplicate" }); continue; }

      if (!ALLOWED_SETS.has(set)) { perTxn.push({ set, skipped: "unsupported-set" }); continue; }
      if (docTypes.length && !docTypes.includes(set)) {
        // Record (for audit) but don't apply a non-enabled doc type.
        await admin.from("edi_messages").insert({
          direction: "inbound", transaction_set: set, status: "received",
          interchange_id: isaCtl.controlNumber, group_control_number: gsCtl.controlNumber,
          raw_content: file.content, tpl_provider_id: provider.id, file_name: file.name,
          last_error: `doc type ${set} not enabled for provider`,
        }).select("id");
        perTxn.push({ set, skipped: "not-enabled" });
        continue;
      }

      const parsedContent = {
        interchange: isaCtl, group: gsCtl, transaction: stCtl,
        segments: txn.segments.map((s) => ({ tag: (s[0] || "").toUpperCase(), elements: s.slice(1) })),
      };
      const { data: msg, error: insErr } = await admin.from("edi_messages").insert({
        direction: "inbound",
        transaction_set: set,
        status: "received",
        interchange_id: isaCtl.controlNumber,
        group_control_number: gsCtl.controlNumber,
        raw_content: file.content,
        parsed_content: parsedContent,
        tpl_provider_id: provider.id,
        file_name: file.name,
      }).select("id").single();
      if (insErr) { perTxn.push({ set, error: insErr.message }); continue; }

      let outcome;
      try {
        outcome = await applyInbound(admin, { transactionSet: set, segments: txn.segments, provider });
      } catch (e) {
        outcome = { ok: false, staged: false, status: "error", error: e?.message || String(e) };
      }
      await admin.from("edi_messages").update({
        status: outcome.status || (outcome.ok ? (outcome.staged ? "staged" : "processed") : "error"),
        parsed_content: outcome.parsed ? { ...parsedContent, applied: outcome.parsed } : parsedContent,
        tpl_shipment_id: outcome.tpl_shipment_id || null,
        error_message: outcome.ok ? null : (outcome.error || null),
        last_error: outcome.ok ? null : (outcome.error || null),
        updated_at: new Date().toISOString(),
      }).eq("id", msg.id);
      perTxn.push({ set, status: outcome.status, staged: !!outcome.staged, summary: outcome.summary, error: outcome.error });
    }
  }
  // Archive when every transaction was handled without a hard error.
  const hadError = perTxn.some((t) => t.error);
  return { file: file.name, ok: !hadError, transactions: perTxn, archive: !hadError };
}

async function runInbound(admin) {
  const { data: providers } = await admin
    .from("tpl_providers")
    .select(PROVIDER_COLS)
    .eq("is_active", true)
    .eq("edi_poll_enabled", true)
    .not("edi_inbound_dir", "is", null);

  const results = [];
  for (const p of providers || []) {
    try {
      // Filenames already ingested for this provider (dedupe belt-and-braces).
      const { data: seen } = await admin
        .from("edi_messages")
        .select("file_name")
        .eq("tpl_provider_id", p.id)
        .eq("direction", "inbound")
        .not("file_name", "is", null)
        .order("created_at", { ascending: false })
        .limit(500);
      const seenNames = new Set((seen || []).map((r) => r.file_name));

      const poll = await pollInbound(p, { alreadyIngested: (name) => seenNames.has(name) });
      if (!poll.ok) { results.push({ provider: p.name, ok: false, detail: poll.detail }); continue; }

      const fileResults = [];
      for (const f of poll.files) {
        if (f.error || f.content == null) { fileResults.push({ file: f.name, ok: false, detail: f.error || "empty" }); continue; }
        const r = await ingestFile(admin, p, f);
        if (r.archive) {
          const arch = await archiveInboundFile(p, f.name);
          r.archived = arch.ok ? arch.detail : `archive failed: ${arch.detail}`;
        }
        fileResults.push(r);
      }
      await admin.from("tpl_providers").update({ edi_last_polled_at: new Date().toISOString() }).eq("id", p.id);
      results.push({ provider: p.name, ok: true, files: fileResults });
    } catch (e) {
      results.push({ provider: p.name, ok: false, detail: String(e?.message || e) });
    }
  }
  return results;
}

// ─── RETAIL INBOUND (997 acks from retail customers) ─────────────────────────
// Poll each active retail partner's inbound dir for 997s and reconcile them
// against our outbound 856/810 (reuses applyInbound → reconcileAck, which matches
// by group_control_number regardless of partner type). Only 997 is applied; any
// other inbound doc is recorded for audit, not acted on.
async function runRetailInbound(admin) {
  const { data: partners } = await admin
    .from("edi_customer_partners")
    .select(RETAIL_PARTNER_COLS + ", customers(name)")
    .eq("is_active", true)
    .eq("edi_poll_enabled", true)
    .not("edi_inbound_dir", "is", null);

  const results = [];
  for (const p of partners || []) {
    const label = p.customers?.name || p.id;
    try {
      const { data: seen } = await admin
        .from("edi_messages")
        .select("file_name")
        .eq("edi_customer_partner_id", p.id)
        .eq("direction", "inbound")
        .not("file_name", "is", null)
        .order("created_at", { ascending: false })
        .limit(500);
      const seenNames = new Set((seen || []).map((r) => r.file_name));

      const poll = await pollInbound(p, { alreadyIngested: (name) => seenNames.has(name) });
      if (!poll.ok) { results.push({ partner: label, ok: false, detail: poll.detail }); continue; }

      const fileResults = [];
      for (const f of poll.files) {
        if (f.error || f.content == null) { fileResults.push({ file: f.name, ok: false, detail: f.error || "empty" }); continue; }
        let envelope;
        try { envelope = parseEnvelope(f.content); }
        catch (e) { fileResults.push({ file: f.name, ok: false, detail: `parse error: ${e?.message || e}` }); continue; }
        const isaCtl = interchangeControl(envelope.isa);
        const perTxn = [];
        for (const group of envelope.groups || []) {
          const gsCtl = groupControl(group.gs);
          for (const txn of group.transactions || []) {
            const set = transactionControl(txn.st).transactionSet;
            const { data: existing } = await admin.from("edi_messages").select("id")
              .eq("direction", "inbound").eq("transaction_set", set)
              .eq("interchange_id", isaCtl.controlNumber).eq("edi_customer_partner_id", p.id).limit(1);
            if (existing?.length) { perTxn.push({ set, skipped: "duplicate" }); continue; }

            const { data: msg } = await admin.from("edi_messages").insert({
              direction: "inbound", transaction_set: set, status: "received",
              interchange_id: isaCtl.controlNumber, group_control_number: gsCtl.controlNumber,
              raw_content: f.content, edi_customer_partner_id: p.id, file_name: f.name,
            }).select("id").single();

            if (set !== "997") { perTxn.push({ set, skipped: "not-997" }); continue; }
            let outcome;
            try { outcome = await applyInbound(admin, { transactionSet: "997", segments: txn.segments, provider: p }); }
            catch (e) { outcome = { ok: false, status: "error", error: e?.message || String(e) }; }
            if (msg?.id) await admin.from("edi_messages").update({
              status: outcome.status || (outcome.ok ? "processed" : "error"),
              error_message: outcome.ok ? null : (outcome.error || null),
              updated_at: new Date().toISOString(),
            }).eq("id", msg.id);
            perTxn.push({ set, status: outcome.status, summary: outcome.summary, error: outcome.error });
          }
        }
        const hadError = perTxn.some((t) => t.error);
        if (!hadError) { const arch = await archiveInboundFile(p, f.name); fileResults.push({ file: f.name, ok: true, transactions: perTxn, archived: arch.ok ? arch.detail : `archive failed: ${arch.detail}` }); }
        else fileResults.push({ file: f.name, ok: false, transactions: perTxn });
      }
      await admin.from("edi_customer_partners").update({ edi_last_polled_at: new Date().toISOString() }).eq("id", p.id);
      results.push({ partner: label, ok: true, files: fileResults });
    } catch (e) {
      results.push({ partner: label, ok: false, detail: String(e?.message || e) });
    }
  }
  return results;
}

export default async function handler(req, res) {
  // Vercel cron auth: when CRON_SECRET is set, require it (Bearer or x-vercel-cron).
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.authorization || "";
    const isVercel = !!req.headers["x-vercel-cron"];
    if (!isVercel && auth !== `Bearer ${secret}`) return res.status(401).json({ error: "unauthorized" });
  }

  const admin = client();
  const out = { ok: true, max_attempts: MAX_ATTEMPTS };
  try {
    out.outbound = await runOutbound(admin);
    out.inbound = await runInbound(admin);
    out.retail_inbound = await runRetailInbound(admin);

    const failedOut = (out.outbound || []).filter((r) => r.status === "failed");
    if (failedOut.length) {
      await captureError({
        source: "cron", route: ROUTE,
        message: `EDI 3PL transport: ${failedOut.length} outbound message(s) failed to send`,
        context: { kind: "edi_3pl_transport", failed: failedOut },
      });
    }
    return res.status(200).json(out);
  } catch (e) {
    await captureError({ source: "cron", route: ROUTE, message: e?.message || String(e), stack: e?.stack, context: { kind: "edi_3pl_transport" } });
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}

// api/internal/consolidation/eliminations
//
// Intercompany elimination-rule admin for a consolidation group. Rules are
// reporting adjustments (account pairs) — NEVER GL postings.
//
// GET    — list rules for a group, with each leg's entity + account code/name
//          resolved (no raw UUIDs surfaced). ?group=<id|code>.
// POST    — create a rule. Body:
//            { group, rule_code, rule_name, reason,
//              debit_entity_id?, debit_account_id?, debit_account_code?,
//              credit_entity_id?, credit_account_id?, credit_account_code?,
//              amount_method? (matched_min|debit_leg|credit_leg|fixed),
//              fixed_amount_cents? }
//          A leg may be left empty (counterpart not yet booked).
// PATCH   — toggle/update a rule. Body: { id, is_active?, reason?, amount_method?,
//            fixed_amount_cents?, debit_account_id?, credit_account_id? }.
// DELETE  — remove a rule. ?id=<uuid>.
//
// See 20261050000000_consolidation.sql.

import { corsHeaders, client, resolveGroup } from "./_common.js";

export const config = { maxDuration: 15 };

const AMOUNT_METHODS = ["matched_min", "debit_leg", "credit_leg", "fixed"];

function parseBody(req) {
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return null; }
  }
  return body || {};
}

async function resolveAccountId(admin, entityId, accountCode) {
  if (!entityId || !accountCode) return null;
  const { data } = await admin
    .from("gl_accounts")
    .select("id")
    .eq("entity_id", entityId)
    .eq("code", accountCode)
    .maybeSingle();
  return data?.id || null;
}

export default async function handler(req, res) {
  corsHeaders(res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const url = new URL(req.url, `https://${req.headers.host}`);

  // ── LIST ───────────────────────────────────────────────────────────────────
  if (req.method === "GET") {
    try {
      const group = await resolveGroup(admin, url.searchParams.get("group"));
      if (!group) return res.status(404).json({ error: "Consolidation group not found" });

      const { data, error } = await admin
        .from("intercompany_elimination_rules")
        .select("*")
        .eq("group_id", group.id)
        .order("rule_code", { ascending: true });
      if (error) return res.status(500).json({ error: error.message });

      // Resolve leg entity + account labels (no raw UUIDs in the response).
      const acctIds = [...new Set((data || []).flatMap((r) => [r.debit_account_id, r.credit_account_id]).filter(Boolean))];
      const entIds = [...new Set((data || []).flatMap((r) => [r.debit_entity_id, r.credit_entity_id]).filter(Boolean))];
      const acctMap = {};
      const entMap = {};
      if (acctIds.length) {
        const { data: accts } = await admin.from("gl_accounts").select("id, code, name").in("id", acctIds);
        for (const a of accts || []) acctMap[a.id] = { code: a.code, name: a.name };
      }
      if (entIds.length) {
        const { data: ents } = await admin.from("entities").select("id, code, name").in("id", entIds);
        for (const e of ents || []) entMap[e.id] = { code: e.code, name: e.name };
      }

      const rules = (data || []).map((r) => ({
        id: r.id,
        rule_code: r.rule_code,
        rule_name: r.rule_name,
        reason: r.reason,
        amount_method: r.amount_method,
        fixed_amount_cents: r.fixed_amount_cents,
        is_active: r.is_active,
        debit_entity: entMap[r.debit_entity_id]?.code || null,
        debit_account: r.debit_account_id ? acctMap[r.debit_account_id] || null : null,
        credit_entity: entMap[r.credit_entity_id]?.code || null,
        credit_account: r.credit_account_id ? acctMap[r.credit_account_id] || null : null,
      }));
      return res.status(200).json({ group: { id: group.id, code: group.code, name: group.name }, rules });
    } catch (e) {
      return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  }

  // ── CREATE ───────────────────────────────────────────────────────────────────
  if (req.method === "POST") {
    const body = parseBody(req);
    if (!body) return res.status(400).json({ error: "Invalid JSON" });
    const ruleCode = (body.rule_code || "").toString().trim();
    const ruleName = (body.rule_name || "").toString().trim();
    const reason = (body.reason || "").toString().trim();
    if (!ruleCode) return res.status(400).json({ error: "rule_code is required" });
    if (!ruleName) return res.status(400).json({ error: "rule_name is required" });
    if (!reason) return res.status(400).json({ error: "reason is required" });
    const amountMethod = (body.amount_method || "matched_min").toString();
    if (!AMOUNT_METHODS.includes(amountMethod)) return res.status(400).json({ error: `amount_method must be one of ${AMOUNT_METHODS.join(", ")}` });

    try {
      const group = await resolveGroup(admin, body.group);
      if (!group) return res.status(404).json({ error: "Consolidation group not found" });

      const debitAccountId = body.debit_account_id || (await resolveAccountId(admin, body.debit_entity_id, body.debit_account_code));
      const creditAccountId = body.credit_account_id || (await resolveAccountId(admin, body.credit_entity_id, body.credit_account_code));

      const { data, error } = await admin
        .from("intercompany_elimination_rules")
        .insert({
          group_id: group.id,
          rule_code: ruleCode,
          rule_name: ruleName,
          reason,
          debit_entity_id: body.debit_entity_id || null,
          debit_account_id: debitAccountId || null,
          credit_entity_id: body.credit_entity_id || null,
          credit_account_id: creditAccountId || null,
          amount_method: amountMethod,
          fixed_amount_cents: amountMethod === "fixed" ? (Number(body.fixed_amount_cents) || 0) : null,
          is_active: body.is_active === false ? false : true,
        })
        .select("id")
        .single();
      if (error) {
        if (error.code === "23505") return res.status(409).json({ error: "A rule with that rule_code already exists in this group" });
        return res.status(500).json({ error: error.message });
      }
      return res.status(201).json({ id: data.id });
    } catch (e) {
      return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  }

  // ── UPDATE / TOGGLE ──────────────────────────────────────────────────────────
  if (req.method === "PATCH") {
    const body = parseBody(req);
    if (!body || !body.id) return res.status(400).json({ error: "id is required" });
    const patch = { updated_at: new Date().toISOString() };
    if (typeof body.is_active === "boolean") patch.is_active = body.is_active;
    if (typeof body.reason === "string") patch.reason = body.reason.trim();
    if (typeof body.amount_method === "string") {
      if (!AMOUNT_METHODS.includes(body.amount_method)) return res.status(400).json({ error: "invalid amount_method" });
      patch.amount_method = body.amount_method;
    }
    if (body.fixed_amount_cents != null) patch.fixed_amount_cents = Number(body.fixed_amount_cents) || 0;
    if ("debit_account_id" in body) patch.debit_account_id = body.debit_account_id || null;
    if ("credit_account_id" in body) patch.credit_account_id = body.credit_account_id || null;
    try {
      const { error } = await admin.from("intercompany_elimination_rules").update(patch).eq("id", body.id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  }

  // ── DELETE ───────────────────────────────────────────────────────────────────
  if (req.method === "DELETE") {
    const id = (url.searchParams.get("id") || "").trim();
    if (!id) return res.status(400).json({ error: "id is required" });
    try {
      const { error } = await admin.from("intercompany_elimination_rules").delete().eq("id", id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  }

  res.setHeader("Allow", "GET, POST, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

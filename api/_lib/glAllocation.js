// api/_lib/glAllocation.js
//
// M50 GL Brand Allocation — Chunk C: the posting-split engine.
//
// When a journal line (manual JE or AP-invoice expense) targets a brand-rollup
// account, expand it into one line per brand using the account's allocation %,
// each on the brand's child account + tagged brand_id. Penny-rounding residual
// goes to the largest-share brand so the split foots EXACTLY to the input.
//
// GATED: expansion only runs when brandScopeMode() === "enforce" (see callers).
// AR revenue is NOT split here — it uses the invoice's own brand directly.
//
// splitLineByAllocation is pure (unit-tested); resolveAccountAllocation reads
// the rule + child-account map; expandJournalLines stitches them for a posting.

import { brandScopeMode } from "./brandContext.js";

/**
 * Split an integer cent amount across brands by an allocation rule.
 * @param {number} amountCents  integer cents (sign preserved)
 * @param {Array<{brand_id:string, pct:number}>} allocations  pct totals ~100
 * @param {Record<string,string>} childByBrand  brand_id → child account_id
 * @returns {Array<{brand_id, account_id, amount_cents}>} sums EXACTLY to amountCents
 */
export function splitLineByAllocation(amountCents, allocations, childByBrand) {
  const amt = Math.round(Number(amountCents) || 0);
  const rows = allocations.map((a) => ({
    brand_id: a.brand_id,
    account_id: childByBrand[a.brand_id],
    pct: Number(a.pct) || 0,
    // round half-away-from-zero toward the signed magnitude
    amount_cents: Math.sign(amt) * Math.round((Math.abs(amt) * (Number(a.pct) || 0)) / 100),
  }));
  const allocated = rows.reduce((s, r) => s + r.amount_cents, 0);
  const residual = amt - allocated;
  if (residual !== 0 && rows.length) {
    let idx = 0;
    for (let i = 1; i < rows.length; i++) if (rows[i].pct > rows[idx].pct) idx = i;
    rows[idx].amount_cents += residual; // largest share absorbs the rounding penny
  }
  return rows.map(({ brand_id, account_id, amount_cents }) => ({ brand_id, account_id, amount_cents }));
}

/**
 * Resolve an account's split rule + brand→child-account map. Returns null when
 * the account is NOT a multi-brand rollup (i.e. nothing to split — caller posts
 * the line unchanged). Returns null defensively if any allocated brand lacks an
 * active child account (so we never post to a missing account).
 */
export async function resolveAccountAllocation(admin, accountId) {
  const { data: acct } = await admin
    .from("gl_accounts").select("id, brand_rollup").eq("id", accountId).maybeSingle();
  if (!acct || !acct.brand_rollup) return null;

  const { data: allocs } = await admin
    .from("brand_account_allocations").select("brand_id, pct").eq("account_id", accountId);
  if (!allocs || allocs.length < 2) return null;

  const { data: children } = await admin
    .from("gl_accounts").select("id, brand_id").eq("parent_account_id", accountId).eq("status", "active");
  const childByBrand = Object.fromEntries((children || []).filter((c) => c.brand_id).map((c) => [c.brand_id, c.id]));
  for (const a of allocs) if (!childByBrand[a.brand_id]) return null;

  return { allocations: allocs, childByBrand };
}

/**
 * Expand journal-entry lines (shape: { line_number, account_id, debit, credit
 * (decimal strings), memo, … }) — splitting any line whose account is a
 * brand-rollup into one child line per brand by the allocation %. NO-OP unless
 * BRAND_SCOPE_MODE=enforce. The split is taken on whichever side (debit/credit)
 * is non-zero and foots EXACTLY to the original (so the JE stays balanced); the
 * child account encodes the brand (and brand_id is tagged too). Lines are
 * renumbered sequentially after expansion. Posts to brand-CHILD accounts — no
 * change to the gl_post_journal_entry RPC needed.
 *
 * Posting to a brand-rollup account when its rule can't be resolved (missing
 * child) is NOT split — the line passes through to the parent (caller may want
 * to warn, but we never drop or mis-post money).
 */
export async function expandJeLines(admin, lines) {
  if (brandScopeMode() !== "enforce" || !Array.isArray(lines)) return lines;
  const out = [];
  for (const line of lines) {
    const rule = line.account_id ? await resolveAccountAllocation(admin, line.account_id) : null;
    if (!rule) { out.push(line); continue; }
    const isDebit = Number(line.debit || 0) > 0;
    const valueCents = Math.round(Number((isDebit ? line.debit : line.credit) || 0) * 100);
    const parts = splitLineByAllocation(valueCents, rule.allocations, rule.childByBrand);
    for (const p of parts) {
      const dec = (Math.abs(p.amount_cents) / 100).toFixed(2);
      out.push({
        ...line,
        account_id: p.account_id,
        brand_id: p.brand_id,
        debit:  isDebit ? dec : "0",
        credit: isDebit ? "0" : dec,
      });
    }
  }
  return out.map((l, i) => ({ ...l, line_number: i + 1 }));
}

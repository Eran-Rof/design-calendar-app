// api/internal/consolidation/balance-sheet
//
// GET — consolidated balance sheet (as-of) = Σ member entities − intercompany
//       BS eliminations, as LONG rows (bucket ENTITY|ELIM, entity_code). Panel
//       pivots to ROF | SAG | Elim | Consolidated.
//
// Query: group (default ROF_CONSOLIDATED), basis (ACCRUAL|CASH), as_of.

import { corsHeaders, client, resolveGroup, groupMemberEntities, BASIS_VALUES, isISODate } from "./_common.js";

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  corsHeaders(res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const basis = (url.searchParams.get("basis") || "").trim().toUpperCase();
  const asOf = (url.searchParams.get("as_of") || "").trim();

  if (!BASIS_VALUES.includes(basis)) return res.status(400).json({ error: `basis must be one of ${BASIS_VALUES.join(", ")}` });
  if (!asOf || !isISODate(asOf)) return res.status(400).json({ error: "as_of is required (YYYY-MM-DD)" });

  try {
    const group = await resolveGroup(admin, url.searchParams.get("group"));
    if (!group) return res.status(404).json({ error: "Consolidation group not found" });

    const entities = await groupMemberEntities(admin, group.id);
    const { data, error } = await admin.rpc("consolidated_balance_sheet", {
      p_group_id: group.id,
      p_basis: basis,
      p_as_of: asOf,
    });
    if (error) return res.status(500).json({ error: error.message });

    const rows = (data || []).sort((a, b) => (String(a.code) < String(b.code) ? -1 : String(a.code) > String(b.code) ? 1 : 0));
    return res.status(200).json({
      group: { id: group.id, code: group.code, name: group.name },
      basis, as_of: asOf,
      entities,
      rows,
    });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}

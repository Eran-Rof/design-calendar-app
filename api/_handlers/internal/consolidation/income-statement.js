// api/internal/consolidation/income-statement
//
// GET — consolidated income statement = Σ member entities − intercompany P&L
//       eliminations, as LONG rows (bucket ENTITY|ELIM, entity_code). Panel
//       pivots to ROF | SAG | Elim | Consolidated.
//
// Query: group (default ROF_CONSOLIDATED), basis (ACCRUAL|CASH), from, to.

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
  const from = (url.searchParams.get("from") || "").trim();
  const to = (url.searchParams.get("to") || "").trim();

  if (!BASIS_VALUES.includes(basis)) return res.status(400).json({ error: `basis must be one of ${BASIS_VALUES.join(", ")}` });
  if (!from || !to) return res.status(400).json({ error: "from and to are both required (YYYY-MM-DD)" });
  if (!isISODate(from) || !isISODate(to)) return res.status(400).json({ error: "from/to must be YYYY-MM-DD" });
  if (from > to) return res.status(400).json({ error: "from must be on or before to" });

  try {
    const group = await resolveGroup(admin, url.searchParams.get("group"));
    if (!group) return res.status(404).json({ error: "Consolidation group not found" });

    const entities = await groupMemberEntities(admin, group.id);
    const { data, error } = await admin.rpc("consolidated_income_statement", {
      p_group_id: group.id,
      p_basis: basis,
      p_from: from,
      p_to: to,
    });
    if (error) return res.status(500).json({ error: error.message });

    const rows = (data || []).sort((a, b) => (String(a.code) < String(b.code) ? -1 : String(a.code) > String(b.code) ? 1 : 0));
    return res.status(200).json({
      group: { id: group.id, code: group.code, name: group.name },
      basis, from, to,
      entities,
      rows,
    });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}

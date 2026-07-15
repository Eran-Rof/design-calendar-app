// api/internal/consolidation/groups
//
// GET — list consolidation groups, each with its member entities (code, name,
//       include flag, order) and active-elimination-rule count. The panel uses
//       this to populate the group selector and by-entity column headers.
//
// Consolidation is a READ layer over the per-entity GLs (Xoro mirrors); this
// endpoint only reads config. See 20261050000000_consolidation.sql.

import { corsHeaders, client, resolveGroup, groupMemberEntities } from "./_common.js";

export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  corsHeaders(res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  try {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const groupParam = url.searchParams.get("group");

    // Optionally scope to one group; otherwise list all active groups.
    let groups;
    if (groupParam) {
      const g = await resolveGroup(admin, groupParam);
      if (!g) return res.status(404).json({ error: "Consolidation group not found" });
      groups = [g];
    } else {
      const { data, error } = await admin
        .from("consolidation_groups")
        .select("*")
        .order("code", { ascending: true });
      if (error) return res.status(500).json({ error: error.message });
      groups = data || [];
    }

    const out = [];
    for (const g of groups) {
      const members = await groupMemberEntities(admin, g.id);
      const { count } = await admin
        .from("intercompany_elimination_rules")
        .select("id", { count: "exact", head: true })
        .eq("group_id", g.id)
        .eq("is_active", true);
      out.push({
        id: g.id,
        code: g.code,
        name: g.name,
        description: g.description,
        base_currency: g.base_currency,
        is_active: g.is_active,
        members,
        active_rule_count: count || 0,
      });
    }

    return res.status(200).json({ groups: out });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}

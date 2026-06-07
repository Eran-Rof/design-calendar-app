// api/internal/journal-entries/[id]
//
// GET — full JE + lines + sibling info.
// PATCH and DELETE are not supported (posted JEs are immutable per Chunk 2
// trigger; reversal is the only way to undo a posted JE — and lives at
// /api/internal/journal-entries/:id/reverse).
//
// Tangerine P1 Chunk 8c.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export default async function handler(req, res, params) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const id = params?.id || req.query?.id;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const { data: je, error } = await admin
      .from("journal_entries")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!je) return res.status(404).json({ error: "Journal entry not found" });

    const { data: lines, error: lErr } = await admin
      .from("journal_entry_lines")
      .select("*")
      .eq("journal_entry_id", id)
      .order("line_number", { ascending: true });
    if (lErr) return res.status(500).json({ error: lErr.message });

    // Resolve who posted / created this JE to a display name (v_audit_user_resolved
    // maps auth.users → employees.display_name, email fallback). Best-effort.
    let posted_by_name = null;
    let created_by_name = null;
    const userIds = [je.posted_by_user_id, je.created_by_user_id].filter(Boolean);
    if (userIds.length > 0) {
      try {
        const { data: users } = await admin
          .from("v_audit_user_resolved")
          .select("user_id, display_name, email")
          .in("user_id", Array.from(new Set(userIds)));
        const nameById = Object.fromEntries(
          (users || []).map((u) => [u.user_id, u.display_name || u.email || null]),
        );
        posted_by_name = je.posted_by_user_id ? (nameById[je.posted_by_user_id] || null) : null;
        created_by_name = je.created_by_user_id ? (nameById[je.created_by_user_id] || null) : null;
      } catch { /* non-fatal — omit names */ }
    }

    // Resolve linked JE uuids (sibling / reverses / reversed-by) to their
    // human-readable je_number so the modal shows numbers, not uuids.
    let sibling_je_number = null, reverses_je_number = null, reversed_by_je_number = null;
    const linkedIds = [je.sibling_je_id, je.reverses_je_id, je.reversed_by_je_id].filter(Boolean);
    if (linkedIds.length > 0) {
      try {
        const { data: linked } = await admin
          .from("journal_entries")
          .select("id, je_number")
          .in("id", Array.from(new Set(linkedIds)));
        const numById = Object.fromEntries((linked || []).map((r) => [r.id, r.je_number]));
        sibling_je_number     = je.sibling_je_id     ? (numById[je.sibling_je_id]     || null) : null;
        reverses_je_number    = je.reverses_je_id    ? (numById[je.reverses_je_id]    || null) : null;
        reversed_by_je_number = je.reversed_by_je_id ? (numById[je.reversed_by_je_id] || null) : null;
      } catch { /* non-fatal — fall back to uuids */ }
    }

    return res.status(200).json({
      ...je, lines: lines || [], posted_by_name, created_by_name,
      sibling_je_number, reverses_je_number, reversed_by_je_number,
    });
  }

  if (req.method === "PATCH" || req.method === "DELETE") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({
      error: "Posted journal entries are immutable. Use POST /api/internal/journal-entries/:id/reverse to undo.",
    });
  }

  res.setHeader("Allow", "GET");
  return res.status(405).json({ error: "Method not allowed" });
}

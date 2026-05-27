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

    return res.status(200).json({ ...je, lines: lines || [] });
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

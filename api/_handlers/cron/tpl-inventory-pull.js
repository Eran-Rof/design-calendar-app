// api/cron/tpl-inventory-pull
//
// Nightly: for each active 3PL provider with an inventory_sftp_path, SFTP-pull
// the newest un-ingested inventory file (846 or CSV), reconcile it vs Tangerine
// on-hand (shared reconcileSnapshot), and stamp last_inventory_file so the same
// file isn't ingested twice. Scheduled via vercel.json (02:30 UTC).
//
// Push-ingest (the manual panel) still works; this is the hands-off pull.

import { createClient } from "@supabase/supabase-js";
import { pullLatestInventoryFile } from "../../_lib/edi/sftpPull.js";
import { reconcileSnapshot, parseInventoryCsv } from "../../_lib/tplInventoryRecon.js";
import { parse846 } from "../../_lib/edi/builder.js";
import { parseEnvelope } from "../../_lib/edi/parser.js";

export const config = { maxDuration: 120 };

function linesFromContent(content) {
  const text = String(content || "");
  if (/\bISA\b|\bLIN\b/.test(text) && text.includes("~")) {
    const env = parseEnvelope(text);
    const txn = env.groups?.[0]?.transactions?.[0];
    const parsed = parse846((txn?.segments || []).map((s) => s));
    return { source: "edi846", lines: (parsed.lines || []).filter((l) => l.sku).map((l) => ({ sku: l.sku, qty_on_hand: Number(l.qty_on_hand) || 0 })) };
  }
  return { source: "csv", lines: parseInventoryCsv(text) };
}

export default async function handler(req, res) {
  // Vercel cron auth: when CRON_SECRET is set, require it (Bearer or x-vercel-cron header presence).
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.authorization || "";
    const isVercel = !!req.headers["x-vercel-cron"];
    if (!isVercel && auth !== `Bearer ${secret}`) return res.status(401).json({ error: "unauthorized" });
  }

  const admin = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data: providers } = await admin
    .from("tpl_providers")
    .select("id, name, entity_id, location_id, edi_protocol, edi_endpoint, edi_username, edi_credential_ref, inventory_sftp_path, last_inventory_file")
    .eq("is_active", true)
    .not("inventory_sftp_path", "is", null);

  const results = [];
  for (const p of providers || []) {
    try {
      const pull = await pullLatestInventoryFile(p);
      if (!pull.ok) { results.push({ provider: p.name, ok: false, detail: pull.detail }); continue; }
      const { source, lines } = linesFromContent(pull.file.content);
      if (!lines.length) { results.push({ provider: p.name, ok: false, detail: `pulled ${pull.file.name} but parsed 0 lines` }); continue; }
      const recon = await reconcileSnapshot(admin, p, lines, { source, raw: pull.file.content });
      await admin.from("tpl_providers").update({ last_inventory_file: pull.file.name, last_inventory_pulled_at: new Date().toISOString() }).eq("id", p.id);
      results.push({ provider: p.name, ok: recon.ok, file: pull.file.name, lines: recon.lines, matched: recon.matched_skus, mismatch_vs_total: recon.mismatch_vs_total });
    } catch (e) {
      results.push({ provider: p.name, ok: false, detail: String(e?.message || e) });
    }
  }

  return res.status(200).json({ ok: true, providers_checked: (providers || []).length, results });
}

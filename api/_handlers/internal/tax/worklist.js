// api/internal/tax/worklist
//
// M19 — the filing worklist: what is due, per jurisdiction × filing period. For
// each active non-clearing jurisdiction it enumerates the filing periods (aligned
// to the jurisdiction's frequency) from first tax activity through the current
// period, sums the collected/remitted tax the GL booked in each period, subtracts
// any recorded filing, and computes a statutory due date (period end + grace) and
// an effective status (upcoming | due | overdue | filed | paid).
//
//   GET /api/internal/tax/worklist  → { today, rows[] }
//   rows: { jurisdiction_code, jurisdiction_label, flag, filing_frequency,
//           period_start, period_end, period_label, collected_cents,
//           remitted_cents, net_due_cents, due_date, status, reference }

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}

// ── pure period helpers (mirror src/lib/taxLiability.ts, kept server-local) ──
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const iso = (y, m0, d) => new Date(Date.UTC(y, m0, d)).toISOString().slice(0, 10);
const monthEnd = (y, m0) => new Date(Date.UTC(y, m0 + 1, 0)).toISOString().slice(0, 10);
function parse(s) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ""); return m ? { y: +m[1], m0: +m[2] - 1, d: +m[3] } : null; }
function addDays(dateISO, days) { const p = parse(dateISO); return p ? new Date(Date.UTC(p.y, p.m0, p.d + days)).toISOString().slice(0, 10) : dateISO; }
function periodBounds(freq, refISO) {
  const p = parse(refISO) || { y: new Date().getUTCFullYear(), m0: 0 };
  if (freq === "annual") return { start: iso(p.y, 0, 1), end: iso(p.y, 11, 31), label: String(p.y) };
  if (freq === "quarterly") { const q = Math.floor(p.m0 / 3), sm = q * 3; return { start: iso(p.y, sm, 1), end: monthEnd(p.y, sm + 2), label: `Q${q + 1} ${p.y}` }; }
  return { start: iso(p.y, p.m0, 1), end: monthEnd(p.y, p.m0), label: `${MONTHS[p.m0]} ${p.y}` };
}
function enumeratePeriods(freq, fromISO, toISO) {
  if (!parse(fromISO) || !parse(toISO)) return [];
  const out = []; let cur = periodBounds(freq, fromISO); let guard = 0;
  while (cur.start <= toISO && guard < 2000) { out.push(cur); cur = periodBounds(freq, addDays(cur.end, 1)); guard++; }
  return out;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed" }); }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });
  const { data: entity } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  if (!entity) return res.status(500).json({ error: "Default entity (ROF) not found" });

  const [{ data: jurisdictions }, { data: monthly }, { data: filings }] = await Promise.all([
    admin.from("tax_jurisdictions").select("id, code, label, flag, filing_frequency, grace_days, is_clearing")
      .eq("entity_id", entity.id).eq("status", "active").eq("is_clearing", false).order("sort_order"),
    admin.from("v_tax_liability_by_jurisdiction").select("jurisdiction_code, period_month, collected_cents, remitted_cents")
      .eq("entity_id", entity.id).limit(5000),
    admin.from("tax_filings").select("jurisdiction_id, period_start, period_end, status, reference").eq("entity_id", entity.id).limit(2000),
  ]);

  const today = new Date().toISOString().slice(0, 10);
  const monthlyByJur = new Map();
  for (const r of monthly || []) {
    const arr = monthlyByJur.get(r.jurisdiction_code) || [];
    arr.push({ month: String(r.period_month).slice(0, 10), collected: Number(r.collected_cents || 0), remitted: Number(r.remitted_cents || 0) });
    monthlyByJur.set(r.jurisdiction_code, arr);
  }
  const filingByKey = new Map();
  for (const f of filings || []) filingByKey.set(`${f.jurisdiction_id}|${String(f.period_start).slice(0, 10)}|${String(f.period_end).slice(0, 10)}`, f);

  const rows = [];
  for (const j of jurisdictions || []) {
    const months = monthlyByJur.get(j.code) || [];
    if (months.length === 0) continue; // no activity → nothing due
    const first = months.reduce((a, b) => (b.month < a ? b.month : a), months[0].month);
    const periods = enumeratePeriods(j.filing_frequency, first, today);
    for (const p of periods) {
      let collected = 0, remitted = 0;
      for (const m of months) if (m.month >= p.start && m.month <= p.end) { collected += m.collected; remitted += m.remitted; }
      const filing = filingByKey.get(`${j.id}|${p.start}|${p.end}`);
      // Skip periods with no obligation and no recorded filing (reduce noise).
      if (collected === 0 && remitted === 0 && !filing) continue;
      const dueDate = addDays(p.end, Number(j.grace_days || 0));
      let status;
      const rec = String(filing?.status || "").toLowerCase();
      if (rec === "filed") status = "filed";
      else if (rec === "paid") status = "paid";
      else if (today <= p.end) status = "upcoming";
      else if (today <= dueDate) status = "due";
      else status = "overdue";
      rows.push({
        jurisdiction_code: j.code, jurisdiction_label: j.label, flag: j.flag, filing_frequency: j.filing_frequency,
        period_start: p.start, period_end: p.end, period_label: p.label,
        collected_cents: collected, remitted_cents: remitted, net_due_cents: collected - remitted,
        due_date: dueDate, status, reference: filing?.reference || null,
      });
    }
  }
  // Overdue first, then due, then upcoming/filed/paid; within a bucket by due date.
  const order = { overdue: 0, due: 1, upcoming: 2, filed: 3, paid: 4 };
  rows.sort((a, b) => (order[a.status] - order[b.status]) || (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0));

  return res.status(200).json({ today, rows });
}

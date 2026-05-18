// api/internal/ai/ops-summary
//
// Read-only aggregates for the /ai-ops operator dashboard. Reads
// ip_ai_call_log + ip_ai_answer_cache, returns a JSON snapshot
// shaped for the React component to render with no further math.
//
// GET ?days=30 → {
//   window: { days, from, to },
//   totals: { calls, errors, input_tokens, output_tokens, cost_usd },
//   per_handler: [{ handler, calls, cost_usd, error_count }],
//   per_day:     [{ date, calls, cost_usd }],
//   per_model:   [{ model, calls, cost_usd }],
//   cache: { entries, total_hits, top_questions: [...] },
//   recent_errors: [{ handler, error, called_at }],
// }
//
// Auth: bearer token via authenticateInternalCaller (same as the
// other internal AI endpoints).

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../_lib/auth.js";

export const config = { maxDuration: 30 };

// Cap window so an operator can't ask for "give me 10 years of stats"
// and trigger a multi-million-row scan.
const MAX_WINDOW_DAYS = 90;
// Cap the raw scan size to keep aggregates fast. With ~1k calls/day
// expected at peak, 90 days ≈ 90k rows — well under this cap.
const MAX_ROWS_SCANNED = 200000;

function isoDate(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const auth = authenticateInternalCaller(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const SB_URL      = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Supabase not configured" });
  const db = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const days = Math.min(Math.max(1, Number(req.query?.days) || 30), MAX_WINDOW_DAYS);
  const now  = new Date();
  const from = new Date(now.getTime() - days * 86400000);

  // Pull the raw call log for the window. We aggregate in JS because
  // PostgREST doesn't expose GROUP BY directly — for the volumes we
  // expect (~1k/day) the round-trip + JS work stays under a second.
  const { data: callRows, error: callErr } = await db
    .from("ip_ai_call_log")
    .select("handler_name, model, input_tokens, output_tokens, cost_usd, called_at, error")
    .gte("called_at", from.toISOString())
    .order("called_at", { ascending: false })
    .limit(MAX_ROWS_SCANNED);
  if (callErr) return res.status(500).json({ error: `call log read failed: ${callErr.message}` });

  // Totals
  const totals = (callRows || []).reduce((acc, r) => {
    acc.calls += 1;
    if (r.error) acc.errors += 1;
    acc.input_tokens  += Number(r.input_tokens  || 0);
    acc.output_tokens += Number(r.output_tokens || 0);
    acc.cost_usd      += Number(r.cost_usd      || 0);
    return acc;
  }, { calls: 0, errors: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 });

  // Per-handler breakdown (sorted by cost descending — most expensive surfaces first)
  const byHandler = new Map();
  for (const r of (callRows || [])) {
    const key = r.handler_name || "(unknown)";
    if (!byHandler.has(key)) byHandler.set(key, { handler: key, calls: 0, cost_usd: 0, error_count: 0 });
    const acc = byHandler.get(key);
    acc.calls += 1;
    acc.cost_usd += Number(r.cost_usd || 0);
    if (r.error) acc.error_count += 1;
  }
  const per_handler = Array.from(byHandler.values())
    .sort((a, b) => b.cost_usd - a.cost_usd);

  // Per-day cost trend (every day in the window, including zero days,
  // so the chart doesn't have invisible gaps).
  const byDay = new Map();
  for (let i = 0; i < days; i++) {
    const d = new Date(now.getTime() - i * 86400000);
    byDay.set(isoDate(d), { date: isoDate(d), calls: 0, cost_usd: 0 });
  }
  for (const r of (callRows || [])) {
    const d = isoDate(new Date(r.called_at));
    if (!byDay.has(d)) continue;
    const acc = byDay.get(d);
    acc.calls += 1;
    acc.cost_usd += Number(r.cost_usd || 0);
  }
  const per_day = Array.from(byDay.values()).sort((a, b) => a.date.localeCompare(b.date));

  // Per-model breakdown — helps decide if a Haiku → Sonnet escalation
  // is justified by the cost mix.
  const byModel = new Map();
  for (const r of (callRows || [])) {
    const key = r.model || "(unknown)";
    if (!byModel.has(key)) byModel.set(key, { model: key, calls: 0, cost_usd: 0 });
    const acc = byModel.get(key);
    acc.calls += 1;
    acc.cost_usd += Number(r.cost_usd || 0);
  }
  const per_model = Array.from(byModel.values()).sort((a, b) => b.cost_usd - a.cost_usd);

  // Recent errors — most-recent first, 20 rows max for the table.
  const recent_errors = (callRows || [])
    .filter(r => r.error)
    .slice(0, 20)
    .map(r => ({ handler: r.handler_name, error: r.error, called_at: r.called_at }));

  // Answer cache — total entry count + sum of hits + top 10 questions
  // by hit_count. Gives the operator a sense of the cache's value.
  const { data: cacheRows, error: cacheErr } = await db
    .from("ip_ai_answer_cache")
    .select("question, hit_count, last_hit_at")
    .order("hit_count", { ascending: false })
    .limit(500);
  let cache = { entries: 0, total_hits: 0, top_questions: [] };
  if (!cacheErr && cacheRows) {
    cache.entries = cacheRows.length;
    cache.total_hits = cacheRows.reduce((s, r) => s + Number(r.hit_count || 0), 0);
    cache.top_questions = cacheRows
      .filter(r => Number(r.hit_count || 0) > 0)
      .slice(0, 10)
      .map(r => ({ question: r.question, hit_count: r.hit_count, last_hit_at: r.last_hit_at }));
  }

  return res.status(200).json({
    window: { days, from: from.toISOString(), to: now.toISOString() },
    totals,
    per_handler,
    per_day,
    per_model,
    cache,
    recent_errors,
    generated_at: new Date().toISOString(),
  });
}

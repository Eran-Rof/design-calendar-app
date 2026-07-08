// src/tanda/InternalSyncHealth.tsx
//
// Tangerine — Xoro bridge Sync Health (Admin). One row per Xoro→Tangerine feed
// from v_xoro_feed_health: last sync, threshold, ok/stale/never. The panel twin
// of the daily xoro-feed-health-alert cron (bell + email on any non-ok) and the
// `npm run sync-health` CLI. Exists because the bridge's failure mode is
// SILENCE (2026-07-07: tanda_sos stale 19 days, accounting mirror skipped
// 37/40 nights, nobody saw it).

import { useCallback, useEffect, useState } from "react";
import { supabaseClient } from "../utils/supabase";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";

type FeedRow = {
  feed: string; label: string; last_at: string | null;
  threshold_hours: number; status: "ok" | "stale" | "never"; hours_since: number | null;
};

const C = {
  card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8",
  success: "#10B981", danger: "#EF4444",
};
const th: React.CSSProperties = { background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600, textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, textTransform: "uppercase", letterSpacing: 0.5 };
const td: React.CSSProperties = { padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13 };

const fmtWhen = (iso: string | null, hours: number | null) => {
  if (!iso) return "never";
  const d = new Date(iso);
  const stamp = `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return hours == null ? stamp : `${stamp} (${hours}h ago)`;
};

const EXPORT_COLS: ExportColumn[] = [
  { key: "feed", header: "Feed" },
  { key: "status", header: "Status" },
  { key: "last_at", header: "Last sync", format: "datetime" },
  { key: "hours_since", header: "Hours since", format: "number", digits: 1 },
  { key: "threshold_hours", header: "Threshold (h)", format: "number" },
  { key: "label", header: "What it is" },
];

export default function InternalSyncHealth() {
  const [rows, setRows] = useState<FeedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    const { data, error } = await supabaseClient.from("v_xoro_feed_health").select("*").order("feed");
    if (error) setErr(error.message);
    else setRows(((data || []) as FeedRow[]).sort((a, b) => (a.status === "ok" ? 1 : 0) - (b.status === "ok" ? 1 : 0) || a.feed.localeCompare(b.feed)));
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const bad = rows.filter((r) => r.status !== "ok").length;

  return (
    <div style={{ padding: 20, maxWidth: 1100 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
        <h2 style={{ color: C.text, margin: 0, fontSize: 18 }}>Sync Health — Xoro bridge</h2>
        <button type="button" onClick={() => void load()} style={{ background: C.card, color: C.text, border: `1px solid ${C.cardBdr}`, borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 12 }}>Refresh</button>
        <ExportButton rows={rows as unknown as Record<string, unknown>[]} columns={EXPORT_COLS} filename="sync-health" />
      </div>
      <div style={{ color: C.textMuted, fontSize: 13, marginBottom: 14 }}>
        Xoro is the operational source of record until go-live — every feed below must flow nightly.
        A red row means Tangerine is showing stale numbers for that domain. The same check emails admins daily at ~09:00 ET when anything is red.
      </div>
      {err && <div style={{ color: C.danger, marginBottom: 10 }}>Failed to load: {err}</div>}
      {loading ? (
        <div style={{ color: C.textMuted }}>Loading…</div>
      ) : (
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflow: "hidden" }}>
          <div style={{ padding: "10px 12px", color: bad ? C.danger : C.success, fontWeight: 700, fontSize: 13, borderBottom: `1px solid ${C.cardBdr}` }}>
            {bad ? `${bad} of ${rows.length} feeds NOT flowing` : `All ${rows.length} feeds flowing`}
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead><tr>
                <th style={th}>Status</th><th style={th}>Feed</th><th style={th}>Last sync</th><th style={th}>Threshold</th><th style={th}>What it is</th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.feed}>
                    <td style={{ ...td, whiteSpace: "nowrap" }}>
                      <span style={{ color: r.status === "ok" ? C.success : C.danger, fontWeight: 700 }}>
                        {r.status === "ok" ? "● OK" : r.status === "never" ? "● NEVER" : "● STALE"}
                      </span>
                    </td>
                    <td style={{ ...td, fontFamily: "Consolas, monospace", whiteSpace: "nowrap" }}>{r.feed}</td>
                    <td style={{ ...td, whiteSpace: "nowrap", color: r.status === "ok" ? C.text : C.danger }}>{fmtWhen(r.last_at, r.hours_since)}</td>
                    <td style={td}>{r.threshold_hours}h</td>
                    <td style={{ ...td, color: C.textMuted }}>{r.label}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

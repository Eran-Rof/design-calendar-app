import { useEffect, useState } from "react";
import { TH } from "../utils/theme";
import { supabaseVendor } from "./supabaseVendor";
import StatusBadge from "./StatusBadge";

interface EdiRow {
  id: string;
  direction: "inbound" | "outbound";
  transaction_set: string;
  status: string;
  interchange_id: string | null;
  error_message: string | null;
  created_at: string;
}

interface EdiResponse {
  counts: { inbound: number; outbound: number; error: number; pending: number };
  rows: EdiRow[];
}

async function token() {
  const { data: { session } } = await supabaseVendor.auth.getSession();
  return session?.access_token || "";
}

const SET_LABELS: Record<string, string> = {
  "850": "Purchase Order (850)",
  "855": "PO Acknowledgment (855)",
  "856": "Advance Ship Notice (856)",
  "810": "Invoice (810)",
  "820": "Payment (820)",
  "997": "Functional Ack (997)",
};

function statusTone(s: string) {
  if (s === "error") return "danger" as const;
  if (s === "processed" || s === "acknowledged") return "ok" as const;
  if (s === "received") return "info" as const;
  return "muted" as const;
}

export default function VendorEdi() {
  const [data, setData] = useState<EdiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [parsedCache, setParsedCache] = useState<Record<string, unknown>>({});

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const t = await token();
      const r = await fetch("/api/vendor/edi/status", { headers: { Authorization: `Bearer ${t}` } });
      if (!r.ok) throw new Error(await r.text());
      setData(await r.json() as EdiResponse);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []);

  async function toggleExpand(id: string) {
    const next = new Set(expanded);
    if (next.has(id)) { next.delete(id); setExpanded(next); return; }
    next.add(id);
    setExpanded(next);
    if (!parsedCache[id]) {
      const { data: row } = await supabaseVendor.from("edi_messages").select("parsed_content, error_message").eq("id", id).maybeSingle();
      setParsedCache((prev) => ({ ...prev, [id]: row }));
    }
  }

  if (loading) return <div style={{ color: "rgba(255,255,255,0.85)" }}>Loading…</div>;
  if (err) return <div style={{ color: TH.primary, padding: 12, background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6 }}>Error: {err}</div>;
  if (!data) return null;

  return (
    <div>
      <h2 style={{ color: "#FFFFFF", fontSize: 20, marginTop: 0, marginBottom: 16 }}>EDI message history</h2>

      {/* Counts */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 16 }}>
        <Stat label="Inbound (30d)"  value={data.counts.inbound} />
        <Stat label="Outbound (30d)" value={data.counts.outbound} />
        <Stat label="Errors"         value={data.counts.error} tone={data.counts.error > 0 ? "danger" : "muted"} />
        <Stat label="Pending"        value={data.counts.pending} tone={data.counts.pending > 0 ? "info" : "muted"} />
      </div>

      <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "100px 230px 140px 170px 160px 1fr", padding: "10px 14px", background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase" }}>
          <div>Dir</div>
          <div>Transaction</div>
          <div>Status</div>
          <div>Interchange</div>
          <div>Date</div>
          <div></div>
        </div>
        {data.rows.length === 0 ? (
          <div style={{ padding: 30, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>No EDI messages in the last 30 days.</div>
        ) : data.rows.map((r) => (
          <div key={r.id}>
            <div
              onClick={() => void toggleExpand(r.id)}
              style={{ display: "grid", gridTemplateColumns: "100px 230px 140px 170px 160px 1fr", padding: "12px 14px", borderBottom: `1px solid ${TH.border}`, fontSize: 13, alignItems: "center", cursor: "pointer" }}
            >
              <div style={{ color: r.direction === "inbound" ? "#2B6CB0" : "#C05621", fontWeight: 600, fontSize: 12, textTransform: "uppercase" }}>
                {r.direction === "inbound" ? "← IN" : "OUT →"}
              </div>
              <div style={{ color: TH.text, fontWeight: 500 }}>{SET_LABELS[r.transaction_set] || r.transaction_set}</div>
              <div><StatusBadge label={r.status[0].toUpperCase() + r.status.slice(1)} tone={statusTone(r.status)} /></div>
              <div style={{ color: TH.textMuted, fontFamily: "SFMono-Regular, Menlo, monospace", fontSize: 12 }}>{r.interchange_id || "—"}</div>
              <div style={{ color: TH.textSub2 }}>{new Date(r.created_at).toLocaleString()}</div>
              <div style={{ textAlign: "right", color: TH.textMuted, fontSize: 12 }}>{expanded.has(r.id) ? "▲" : "▼"}</div>
            </div>
            {expanded.has(r.id) && (
              <div style={{ padding: "12px 14px", background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}` }}>
                {r.error_message && (
                  <div style={{ padding: "8px 10px", background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6, color: TH.primary, fontSize: 12, marginBottom: 10 }}>
                    <b>Error:</b> {r.error_message}
                  </div>
                )}
                {parsedCache[r.id] ? (
                  <pre style={{ fontSize: 11, background: "#1A202C", color: "#CBD5E0", padding: 12, borderRadius: 6, overflow: "auto", maxHeight: 400, fontFamily: "SFMono-Regular, Menlo, monospace" }}>
{JSON.stringify((parsedCache[r.id] as { parsed_content?: unknown })?.parsed_content ?? parsedCache[r.id], null, 2)}
                  </pre>
                ) : (
                  <div style={{ color: TH.textMuted, fontSize: 12 }}>Loading…</div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, tone = "muted" }: { label: string; value: number; tone?: "danger" | "info" | "muted" }) {
  const color = tone === "danger" ? TH.primary : tone === "info" ? "#2B6CB0" : TH.text;
  return (
    <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, padding: "12px 14px", boxShadow: `0 1px 2px ${TH.shadow}` }}>
      <div style={{ fontSize: 11, color: TH.textMuted, textTransform: "uppercase", letterSpacing: 0.05, fontWeight: 600, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}

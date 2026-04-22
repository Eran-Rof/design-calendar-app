import { useEffect, useState } from "react";

interface Inquiry {
  id: string;
  listing_id: string;
  entity_id: string;
  inquired_by: string;
  message: string;
  status: "sent" | "responded" | "converted_to_rfq";
  response: string | null;
  responded_at: string | null;
  rfq_id: string | null;
  created_at: string;
  listing?: { id: string; title: string; vendor_id: string } | null;
}

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

export default function InternalMarketplaceInquiries() {
  const [rows, setRows] = useState<Inquiry[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setLoading(true); setErr(null);
    try {
      // Reuse the listings endpoint to pull entity context not strictly needed
      // here; call the inquiry list endpoint directly.
      const r = await fetch("/api/internal/marketplace/inquiries");
      if (!r.ok) throw new Error(await r.text());
      const d = await r.json() as { rows: Inquiry[] };
      setRows(d.rows || []);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  async function convert(inquiry: Inquiry) {
    if (!confirm(`Convert inquiry on "${inquiry.listing?.title}" to a draft RFQ?`)) return;
    const reviewer = prompt("Your name (for audit, becomes RFQ creator):") || "Internal";
    const r = await fetch("/api/internal/marketplace/convert-to-rfq", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inquiry_id: inquiry.id, created_by: reviewer }),
    });
    if (!r.ok) { alert(await r.text()); return; }
    const d = await r.json() as { rfq: { id: string } };
    alert(`Draft RFQ created: ${d.rfq.id}`);
    await load();
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Marketplace inquiries</h2>
        <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>Inquiries you've sent, vendor responses, and RFQ conversions.</div>
      </div>

      {loading ? <div style={{ color: C.textMuted }}>Loading…</div>
      : err ? <div style={{ color: C.danger }}>Error: {err}</div>
      : rows.length === 0 ? (
        <div style={{ padding: 30, textAlign: "center", color: C.textMuted, fontSize: 13, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8 }}>No inquiries sent yet.</div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {rows.map((q) => (
            <div key={q.id} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                <div style={{ fontWeight: 700 }}>{q.listing?.title || q.listing_id}</div>
                <StatusChip status={q.status} />
              </div>
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{new Date(q.created_at).toLocaleString()} · by {q.inquired_by}</div>
              <div style={{ fontSize: 12, color: C.textSub, marginTop: 8, padding: 8, background: C.bg, border: `1px solid ${C.cardBdr}`, borderRadius: 6 }}>{q.message}</div>
              {q.response && (
                <div style={{ fontSize: 12, color: C.text, marginTop: 8, padding: 8, background: "rgba(16,185,129,0.08)", border: `1px solid ${C.success}`, borderRadius: 6 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: C.success, marginBottom: 4, textTransform: "uppercase" }}>Vendor response · {q.responded_at ? new Date(q.responded_at).toLocaleDateString() : ""}</div>
                  {q.response}
                </div>
              )}
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
                {q.status !== "converted_to_rfq"
                  ? <button onClick={() => void convert(q)} style={btnPrimary}>Convert to RFQ</button>
                  : <span style={{ fontSize: 11, color: C.success }}>→ RFQ {q.rfq_id?.slice(0, 8)}…</span>
                }
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const color = status === "converted_to_rfq" ? C.success : status === "responded" ? C.primary : C.textSub;
  return <span style={{ fontSize: 10, color: "#fff", background: color, padding: "2px 8px", borderRadius: 10, fontWeight: 700, textTransform: "uppercase" }}>{status.replace(/_/g, " ")}</span>;
}

const btnPrimary = { padding: "8px 14px", borderRadius: 6, border: "none", background: C.primary, color: "#FFFFFF", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;

import { useEffect, useMemo, useState } from "react";

type Req = {
  id: string;
  vendor_id: string;
  vendor_name: string;
  po_id: string;
  po_number: string;
  phase_name: string;
  field_name: string;
  old_value: string | null;
  new_value: string | null;
  status: "pending" | "approved" | "rejected";
  requested_at: string;
  reviewed_at: string | null;
  reviewed_by_internal_id: string | null;
  review_note: string | null;
  po_line_key: string | null;
  requested_by_display_name: string | null;
};

type Note = {
  id: string;
  vendor_id: string;
  po_id: string;
  phase_name: string;
  po_line_key: string | null;
  body: string;
  author_name: string | null;
  created_at: string;
  updated_at: string;
};

const C = {
  bg: "#F8FAFC",
  surface: "#FFFFFF",
  surfaceAlt: "#F1F5F9",
  border: "#E2E8F0",
  text: "#0F172A",
  textMuted: "#64748B",
  primary: "#3B82F6",
  success: "#10B981",
  danger: "#EF4444",
  warn: "#F59E0B",
};

function statusColor(s: Req["status"]) {
  if (s === "approved") return C.success;
  if (s === "rejected") return C.danger;
  return C.warn;
}

function loadReviewer(): string {
  try {
    const raw = sessionStorage.getItem("plm_session_v2");
    if (raw) {
      const u = JSON.parse(raw);
      return u?.name || u?.username || "Ring of Fire";
    }
  } catch { /* noop */ }
  return "Ring of Fire";
}

export default function PhaseReviews() {
  const [rows, setRows] = useState<Req[]>([]);
  const [notesByPoPhase, setNotesByPoPhase] = useState<Record<string, Note[]>>({});
  const [statusFilter, setStatusFilter] = useState<"pending" | "all" | "approved" | "rejected">("pending");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const reviewer = useMemo(() => loadReviewer(), []);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const r = await fetch(`/api/internal/phase-change-requests?status=${statusFilter}&limit=200`);
      if (!r.ok) throw new Error(await r.text());
      const body = (await r.json()) as { rows: Req[] };
      setRows(body.rows || []);

      const poIds = Array.from(new Set((body.rows || []).map((x) => x.po_id)));
      const notes: Record<string, Note[]> = {};
      await Promise.all(poIds.map(async (poId) => {
        const nr = await fetch(`/api/internal/phase-notes?po_id=${poId}`);
        if (!nr.ok) return;
        const nbody = (await nr.json()) as { rows: Note[] };
        for (const n of nbody.rows || []) {
          const key = `${n.po_id}::${n.phase_name}`;
          if (!notes[key]) notes[key] = [];
          notes[key].push(n);
        }
      }));
      setNotesByPoPhase(notes);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [statusFilter]);

  async function act(id: string, kind: "approve" | "reject") {
    const note = kind === "reject"
      ? prompt("Reason for rejecting this change (required):")?.trim() || ""
      : prompt("Optional note to send with approval (leave blank to skip):")?.trim() || "";
    if (kind === "reject" && !note) return;
    const r = await fetch(`/api/internal/phase-change-requests/${id}/${kind}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewer_name: reviewer, note }),
    });
    if (!r.ok) { alert(`Failed: ${await r.text()}`); return; }
    await load();
  }

  const counts = useMemo(() => {
    const out = { pending: 0, approved: 0, rejected: 0 };
    for (const r of rows) out[r.status] += 1;
    return out;
  }, [rows]);

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, padding: 24, fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
      <div style={{ maxWidth: 1400, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700 }}>Vendor phase reviews</h1>
            <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4 }}>
              Reviewer: <strong>{reviewer}</strong> · Approve or reject vendor-proposed phase updates. Approvals and rejections auto-post to the PO message thread.
            </div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {(["pending", "approved", "rejected", "all"] as const).map((f) => (
              <button key={f} onClick={() => setStatusFilter(f)}
                style={{
                  padding: "6px 12px", borderRadius: 6, border: `1px solid ${C.border}`,
                  background: statusFilter === f ? C.primary : C.surface,
                  color: statusFilter === f ? "#fff" : C.text,
                  cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 600,
                  textTransform: "capitalize",
                }}>
                {f}{statusFilter === "all" && f !== "all" ? "" : statusFilter === f && f !== "all" ? ` (${counts[f]})` : ""}
              </button>
            ))}
            <button onClick={() => void load()} style={{
              padding: "6px 12px", borderRadius: 6, border: `1px solid ${C.border}`,
              background: C.surface, color: C.text, cursor: "pointer", fontFamily: "inherit", fontSize: 12,
            }}>↻</button>
          </div>
        </div>

        {err && <div style={{ background: "#FEF2F2", color: C.danger, border: `1px solid ${C.danger}`, padding: 10, borderRadius: 6, marginBottom: 14, fontSize: 13 }}>{err}</div>}

        {loading ? (
          <div style={{ color: C.textMuted, padding: 40, textAlign: "center" }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, padding: 40, borderRadius: 8, textAlign: "center", color: C.textMuted }}>
            No {statusFilter === "all" ? "" : statusFilter} requests.
          </div>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {rows.map((r) => {
              const notes = notesByPoPhase[`${r.po_id}::${r.phase_name}`] || [];
              return (
                <div key={r.id} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
                        <span style={{ background: C.surfaceAlt, padding: "2px 8px", borderRadius: 4, fontFamily: "Menlo, monospace", fontSize: 12, fontWeight: 600 }}>{r.po_number}</span>
                        <span style={{ fontSize: 13, color: C.textMuted }}>·</span>
                        <span style={{ fontWeight: 600, fontSize: 14 }}>{r.phase_name}</span>
                        {r.po_line_key && <span style={{ fontSize: 11, background: "#EDE9FE", color: "#6D28D9", padding: "1px 6px", borderRadius: 3, fontWeight: 600 }}>line {r.po_line_key}</span>}
                        <span style={{ fontSize: 10, color: "#fff", background: statusColor(r.status), padding: "2px 8px", borderRadius: 10, fontWeight: 700, textTransform: "uppercase" }}>{r.status}</span>
                      </div>
                      <div style={{ fontSize: 12, color: C.textMuted }}>
                        <strong>{r.vendor_name}</strong>
                        {r.requested_by_display_name && ` · ${r.requested_by_display_name}`}
                        {" · requested "}{new Date(r.requested_at).toLocaleString()}
                      </div>
                    </div>
                    {r.status === "pending" && (
                      <div style={{ display: "flex", gap: 6 }}>
                        <button onClick={() => void act(r.id, "approve")} style={{ padding: "6px 14px", borderRadius: 6, border: "none", background: C.success, color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" }}>Approve</button>
                        <button onClick={() => void act(r.id, "reject")} style={{ padding: "6px 14px", borderRadius: 6, border: "none", background: C.danger, color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" }}>Reject</button>
                      </div>
                    )}
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "140px 1fr 1fr", gap: 10, marginTop: 10, alignItems: "start" }}>
                    <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: C.textMuted, letterSpacing: 0.4 }}>{r.field_name}</div>
                    <div style={{ background: C.surfaceAlt, padding: 8, borderRadius: 6, fontSize: 13 }}>
                      <div style={{ fontSize: 10, textTransform: "uppercase", color: C.textMuted, fontWeight: 700 }}>From</div>
                      <div style={{ color: C.text, marginTop: 2 }}>{r.old_value ?? <span style={{ color: C.textMuted, fontStyle: "italic" }}>(empty)</span>}</div>
                    </div>
                    <div style={{ background: "#ECFDF5", padding: 8, borderRadius: 6, fontSize: 13 }}>
                      <div style={{ fontSize: 10, textTransform: "uppercase", color: C.textMuted, fontWeight: 700 }}>To</div>
                      <div style={{ color: C.text, marginTop: 2 }}>{r.new_value ?? <span style={{ color: C.textMuted, fontStyle: "italic" }}>(cleared)</span>}</div>
                    </div>
                  </div>

                  {r.status !== "pending" && r.review_note && (
                    <div style={{ marginTop: 10, padding: 8, background: C.surfaceAlt, borderRadius: 6, fontSize: 12 }}>
                      <strong>{r.reviewed_by_internal_id || "Reviewer"}:</strong> {r.review_note}
                      {r.reviewed_at && <span style={{ color: C.textMuted }}> · {new Date(r.reviewed_at).toLocaleString()}</span>}
                    </div>
                  )}

                  {notes.length > 0 && (
                    <div style={{ marginTop: 10, borderTop: `1px solid ${C.border}`, paddingTop: 8 }}>
                      <div style={{ fontSize: 10, textTransform: "uppercase", color: C.textMuted, fontWeight: 700, letterSpacing: 0.4, marginBottom: 6 }}>
                        Vendor notes on this phase ({notes.length})
                      </div>
                      <div style={{ display: "grid", gap: 6 }}>
                        {notes.slice(0, 5).map((n) => (
                          <div key={n.id} style={{ fontSize: 12, padding: 6, background: "#FFFBEB", border: `1px solid #FDE68A`, borderRadius: 4 }}>
                            <div style={{ color: C.textMuted, fontSize: 11 }}>
                              {n.author_name || "Vendor"}{n.po_line_key ? ` · line ${n.po_line_key}` : ""} · {new Date(n.created_at).toLocaleString()}
                            </div>
                            <div style={{ marginTop: 2, whiteSpace: "pre-wrap" }}>{n.body}</div>
                          </div>
                        ))}
                        {notes.length > 5 && <div style={{ fontSize: 11, color: C.textMuted }}>+ {notes.length - 5} more</div>}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";

interface Preferred {
  pref_id: string;
  rank: number;
  notes: string | null;
  vendor: { id: string; name: string };
  health: { overall: number; delivery: number; quality: number; compliance: number };
  kpi: { on_time_delivery_pct: number | null; invoice_accuracy_pct: number | null } | null;
}

interface PrefResponse {
  categories: { category: string; vendors: Preferred[] }[];
}

interface Suggestion {
  rank: number;
  vendor_id: string;
  name: string;
  preferred: { rank: number } | null;
  health_score: number;
  on_time_delivery_pct: number | null;
  avg_unit_price: number | null;
  price_competitiveness_pct: number | null;
  why: string[];
}

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

function scoreColor(s: number) {
  if (s >= 80) return C.success;
  if (s >= 60) return C.warn;
  return C.danger;
}

export default function InternalPreferred() {
  const [data, setData] = useState<PrefResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [suggestOpen, setSuggestOpen] = useState(false);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch("/api/internal/preferred-vendors");
      if (!r.ok) throw new Error(await r.text());
      setData(await r.json() as PrefResponse);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []);

  async function remove(vendorId: string, prefId: string) {
    if (!confirm("Remove this preferred entry?")) return;
    const r = await fetch(`/api/internal/vendors/${vendorId}/preferred/${prefId}`, { method: "DELETE" });
    if (!r.ok) { alert(await r.text()); return; }
    await load();
  }

  async function changeRank(vendorId: string, category: string, newRank: number) {
    const r = await fetch(`/api/internal/vendors/${vendorId}/preferred`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category, rank: newRank, set_by: "internal" }),
    });
    if (!r.ok) { alert(await r.text()); return; }
    await load();
  }

  if (loading) return <div style={{ color: C.textMuted }}>Loading…</div>;
  if (err) return <div style={{ color: C.danger }}>Error: {err}</div>;

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Preferred vendors</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => setSuggestOpen(true)} style={btnSecondary}>🔎 Suggest</button>
          <button onClick={() => setAddOpen(true)} style={btnPrimary}>+ Add</button>
        </div>
      </div>

      {(data?.categories || []).length === 0 ? (
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 30, textAlign: "center", color: C.textMuted }}>
          No preferred vendors yet. Use <b>+ Add</b> to register the first entry.
        </div>
      ) : (
        (data?.categories || []).map((group) => (
          <div key={group.category} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: "14px 16px", marginBottom: 14 }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10, textTransform: "capitalize" }}>{group.category}</div>
            <div style={{ display: "grid", gridTemplateColumns: "60px 1.5fr 140px 1fr 140px 130px", padding: "6px 0", fontSize: 10, color: C.textMuted, fontWeight: 700, textTransform: "uppercase", borderBottom: `1px solid ${C.cardBdr}`, marginBottom: 4 }}>
              <div>Rank</div>
              <div>Vendor</div>
              <div style={{ textAlign: "right" }}>Health</div>
              <div>KPIs</div>
              <div>Notes</div>
              <div style={{ textAlign: "right" }}></div>
            </div>
            {group.vendors.map((p) => (
              <div key={p.pref_id} style={{ display: "grid", gridTemplateColumns: "60px 1.5fr 140px 1fr 140px 130px", padding: "8px 0", fontSize: 13, alignItems: "center", borderBottom: `1px solid ${C.cardBdr}` }}>
                <div>
                  <select value={p.rank} onChange={(e) => void changeRank(p.vendor.id, group.category, Number(e.target.value))} style={rankSelect}>
                    {[1, 2, 3, 4, 5].map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
                <div style={{ fontWeight: 600 }}>{p.vendor.name}</div>
                <div style={{ textAlign: "right", color: scoreColor(p.health.overall), fontWeight: 700 }}>{p.health.overall} / 100</div>
                <div style={{ color: C.textSub, fontSize: 11 }}>
                  On-time: {p.kpi?.on_time_delivery_pct ?? "—"}% · Acc: {p.kpi?.invoice_accuracy_pct ?? "—"}%
                </div>
                <div style={{ color: C.textMuted, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.notes || "—"}</div>
                <div style={{ textAlign: "right" }}>
                  <button onClick={() => void remove(p.vendor.id, p.pref_id)} style={{ ...btnSecondary, color: C.danger, padding: "3px 8px", fontSize: 11 }}>Remove</button>
                </div>
              </div>
            ))}
          </div>
        ))
      )}

      {addOpen && <AddModal onClose={() => setAddOpen(false)} onSaved={() => { setAddOpen(false); void load(); }} />}
      {suggestOpen && <SuggestModal onClose={() => setSuggestOpen(false)} />}
    </div>
  );
}

function AddModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [vendorId, setVendorId] = useState("");
  const [category, setCategory] = useState("");
  const [rank, setRank] = useState("1");
  const [notes, setNotes] = useState("");
  const [setBy, setSetBy] = useState("");
  const [saving, setSaving] = useState(false);
  const [vendors, setVendors] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    fetch("/api/internal/vendors").then((r) => r.ok ? r.json() : []).then(setVendors).catch(() => {});
  }, []);

  async function submit() {
    if (!vendorId || !category.trim()) { alert("Vendor and category required."); return; }
    setSaving(true);
    try {
      const r = await fetch(`/api/internal/vendors/${vendorId}/preferred`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: category.trim(), rank: Number(rank), notes: notes.trim() || undefined, set_by: setBy.trim() || undefined }),
      });
      if (!r.ok) throw new Error(await r.text());
      onSaved();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : String(e));
    } finally { setSaving(false); }
  }

  return (
    <Modal title="Add preferred vendor" onClose={onClose}>
      <Row label="Vendor">
        <select value={vendorId} onChange={(e) => setVendorId(e.target.value)} style={inp}>
          <option value="">Select…</option>
          {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
      </Row>
      <Row label="Category">
        <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Apparel" style={inp} />
      </Row>
      <Row label="Rank">
        <select value={rank} onChange={(e) => setRank(e.target.value)} style={inp}>
          {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} {n === 1 ? "(primary)" : ""}</option>)}
        </select>
      </Row>
      <Row label="Notes (optional)"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} style={{ ...inp, resize: "vertical" }} /></Row>
      <Row label="Set by"><input value={setBy} onChange={(e) => setSetBy(e.target.value)} placeholder="your name" style={inp} /></Row>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button onClick={onClose} style={btnSecondary}>Cancel</button>
        <button onClick={() => void submit()} disabled={saving} style={btnPrimary}>{saving ? "Saving…" : "Save"}</button>
      </div>
    </Modal>
  );
}

function SuggestModal({ onClose }: { onClose: () => void }) {
  const [category, setCategory] = useState("");
  const [amount, setAmount] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [loading, setLoading] = useState(false);

  async function run() {
    if (!category.trim()) { alert("Category required."); return; }
    setLoading(true);
    try {
      const params = new URLSearchParams({ category: category.trim() });
      if (amount) params.set("amount", amount);
      const r = await fetch(`/api/internal/vendors/suggest?${params.toString()}`);
      if (!r.ok) throw new Error(await r.text());
      const data = await r.json() as { suggestions: Suggestion[] };
      setSuggestions(data.suggestions);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }

  return (
    <Modal title="Vendor suggestion tool" onClose={onClose}>
      <Row label="Category"><input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Apparel" style={inp} /></Row>
      <Row label="Expected amount (optional)"><input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} style={inp} /></Row>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 14 }}>
        <button onClick={() => void run()} disabled={loading} style={btnPrimary}>{loading ? "Running…" : "Suggest top 3"}</button>
      </div>
      {suggestions && (
        <div>
          {suggestions.length === 0 ? (
            <div style={{ color: C.textMuted, fontSize: 13 }}>No candidates found.</div>
          ) : suggestions.map((s) => (
            <div key={s.vendor_id} style={{ padding: "12px 14px", background: C.bg, border: `1px solid ${C.cardBdr}`, borderRadius: 8, marginBottom: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <div style={{ fontWeight: 700 }}>#{s.rank} {s.name}</div>
                <div style={{ color: scoreColor(s.health_score), fontWeight: 700 }}>{s.health_score}/100</div>
              </div>
              <div style={{ fontSize: 11, color: C.textMuted, lineHeight: 1.6 }}>
                {s.why.map((w, i) => <div key={i}>• {w}</div>)}
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 22, width: 560, maxWidth: "92vw", maxHeight: "90vh", overflowY: "auto", color: C.text }}>
        <h3 style={{ margin: "0 0 14px", fontSize: 16 }}>{title}</h3>
        {children}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", fontWeight: 700, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

const inp = { width: "100%", padding: "8px 10px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.bg, color: C.text, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" } as const;
const rankSelect = { padding: "4px 8px", background: C.bg, border: `1px solid ${C.cardBdr}`, color: C.text, borderRadius: 4, fontSize: 13 } as const;
const btnPrimary = { padding: "8px 16px", borderRadius: 6, border: "none", background: C.primary, color: "#FFFFFF", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;
const btnSecondary = { padding: "8px 14px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.card, color: C.text, cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;

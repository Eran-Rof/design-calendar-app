// Admin UI for ip_ai_user_facts (Tier 2H — operator-authored Ask AI notes).
//
// Mounted at /ai-facts (see src/main.tsx). Internal staff only.
// Each operator can add, edit, and remove facts that the Ask AI panel
// surfaces via the `lookup_user_facts` tool. Facts are scoped:
//   - self:   visible only to this operator (default)
//   - global: visible to all operators (use sparingly)
//
// API: /api/internal/ai/user-facts (GET / POST / PATCH / DELETE).
// Authorization header injected automatically by installInternalApiAuth.

import { useEffect, useMemo, useState } from "react";
import SearchableSelect from "../../tanda/components/SearchableSelect";

const PAL = {
  bg: "#0F172A",
  panel: "#1E293B",
  border: "#334155",
  text: "#F1F5F9",
  textDim: "#94A3B8",
  textMuted: "#6B7280",
  accent: "#3B82F6",
  green: "#10B981",
  red: "#EF4444",
} as const;

interface Fact {
  id: string;
  user_id: string | null;
  app: string | null;
  topic: string;
  fact: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

type Scope = "self" | "global";

const APP_OPTIONS = [
  { value: "",         label: "All apps" },
  { value: "ats",      label: "ATS" },
  { value: "po_wip",   label: "PO WIP" },
  { value: "dc",       label: "Design Calendar" },
  { value: "planning", label: "Planning" },
];

function readPlmUserId(): string | null {
  try {
    const raw = sessionStorage.getItem("plm_user");
    if (!raw) return null;
    const u = JSON.parse(raw) as { id?: string } | null;
    return u?.id || null;
  } catch { return null; }
}

export default function UserFactsAdmin() {
  const userId = useMemo(() => readPlmUserId(), []);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterApp, setFilterApp] = useState<string>("");
  const [search, setSearch] = useState("");

  // Edit/create form state. `editingId === "new"` means showing the
  // create form; an actual id means editing an existing row.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTopic, setDraftTopic] = useState("");
  const [draftFact, setDraftFact] = useState("");
  const [draftScope, setDraftScope] = useState<Scope>("self");
  const [draftApp, setDraftApp] = useState<string>("");
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filterApp) params.set("app", filterApp);
      if (search.trim()) params.set("q", search.trim());
      const r = await fetch(`/api/internal/ai/user-facts?${params.toString()}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setFacts(Array.isArray(j.facts) ? j.facts : []);
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [filterApp]);

  function startCreate() {
    setEditingId("new");
    setDraftTopic("");
    setDraftFact("");
    setDraftScope("self");
    setDraftApp("");
  }

  function startEdit(f: Fact) {
    setEditingId(f.id);
    setDraftTopic(f.topic);
    setDraftFact(f.fact);
    setDraftScope(f.user_id == null ? "global" : "self");
    setDraftApp(f.app || "");
  }

  function cancelEdit() {
    setEditingId(null);
    setDraftTopic("");
    setDraftFact("");
  }

  async function save() {
    if (!draftTopic.trim() || !draftFact.trim()) {
      setError("Topic and fact are both required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body = {
        topic: draftTopic.trim(),
        fact:  draftFact.trim(),
        scope: draftScope,
        app:   draftApp || null,
        user_id: userId,
      };
      if (editingId === "new") {
        const r = await fetch("/api/internal/ai/user-facts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      } else if (editingId) {
        const r = await fetch(`/api/internal/ai/user-facts?id=${encodeURIComponent(editingId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      }
      cancelEdit();
      await load();
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("Delete this fact?")) return;
    setError(null);
    try {
      const r = await fetch(`/api/internal/ai/user-facts?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!r.ok && r.status !== 204) {
        throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      }
      await load();
    } catch (e) {
      setError(String((e as Error).message || e));
    }
  }

  // Client-side search filter (the API also supports `q=`, but doing
  // it locally too keeps the typing experience snappy without round-trips).
  const visible = facts.filter(f => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return f.topic.toLowerCase().includes(q) || f.fact.toLowerCase().includes(q);
  });

  if (!userId) {
    return (
      <div style={{ ...wrap, color: PAL.text }}>
        <div style={{ padding: 40, textAlign: "center" }}>
          Sign in to PLM first — <a href="/" style={{ color: PAL.accent }}>go to launcher</a>.
        </div>
      </div>
    );
  }

  return (
    <div style={wrap}>
      <header style={header}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <a href="/" style={{ color: PAL.textMuted, textDecoration: "none", fontSize: 13 }}>← PLM</a>
          <span style={{ fontWeight: 700, fontSize: 16, color: PAL.text }}>Ask AI — Operator Facts</span>
          <span style={{ fontSize: 11, color: PAL.textMuted }}>(notes the AI consults when you ask about a topic)</span>
        </div>
        <button onClick={startCreate} style={btnPrimary} disabled={editingId === "new"}>+ Add fact</button>
      </header>

      <div style={{ ...filters }}>
        <input
          placeholder="Search topic or fact…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={input}
        />
        <SearchableSelect
          value={filterApp || null}
          onChange={v => setFilterApp(v)}
          options={APP_OPTIONS.map(o => ({ value: o.value, label: o.label }))}
          inputStyle={select}
        />
        <button onClick={load} style={btnSecondary}>Refresh</button>
      </div>

      {error && (
        <div style={{ ...errorBox }}>{error}</div>
      )}

      {editingId && (
        <div style={editor}>
          <div style={{ fontSize: 13, fontWeight: 600, color: PAL.text, marginBottom: 10 }}>
            {editingId === "new" ? "New fact" : "Edit fact"}
          </div>
          <label style={label}>Topic <span style={{ color: PAL.textMuted, fontWeight: 400 }}>(substring-matched, e.g. style code or customer name)</span></label>
          <input
            placeholder='e.g. "RYB0412" or "Burlington"'
            value={draftTopic}
            onChange={e => setDraftTopic(e.target.value)}
            maxLength={80}
            style={{ ...input, marginBottom: 12, width: "100%" }}
          />
          <label style={label}>Fact <span style={{ color: PAL.textMuted, fontWeight: 400 }}>(free text — what should the AI know about this topic?)</span></label>
          <textarea
            placeholder='e.g. "RYB0412 is our top-selling jogger family. When asked about it, always surface the PPK24 variant alongside the unit SKUs."'
            value={draftFact}
            onChange={e => setDraftFact(e.target.value)}
            maxLength={4000}
            rows={5}
            style={{ ...input, marginBottom: 12, width: "100%", fontFamily: "inherit", resize: "vertical" }}
          />
          <div style={{ display: "flex", gap: 16, alignItems: "center", marginBottom: 14 }}>
            <label style={{ ...label, marginBottom: 0 }}>
              Scope:
              <SearchableSelect
                value={draftScope}
                onChange={v => setDraftScope(v as Scope)}
                options={[
                  { value: "self", label: "Just me" },
                  { value: "global", label: "Everyone" },
                ]}
                inputStyle={{ ...select, marginLeft: 6 }}
              />
            </label>
            <label style={{ ...label, marginBottom: 0 }}>
              App:
              <SearchableSelect
                value={draftApp || null}
                onChange={v => setDraftApp(v)}
                options={APP_OPTIONS.map(o => ({ value: o.value, label: o.label }))}
                inputStyle={{ ...select, marginLeft: 6 }}
              />
            </label>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={save} disabled={saving} style={btnPrimary}>{saving ? "Saving…" : "Save"}</button>
            <button onClick={cancelEdit} disabled={saving} style={btnSecondary}>Cancel</button>
          </div>
        </div>
      )}

      {loading ? (
        <div style={{ padding: 40, color: PAL.textDim, textAlign: "center" }}>Loading…</div>
      ) : visible.length === 0 ? (
        <div style={{ padding: 40, color: PAL.textDim, textAlign: "center" }}>
          No facts yet. Click <strong>+ Add fact</strong> to teach the AI something.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {visible.map(f => (
            <div key={f.id} style={card}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 6 }}>
                <span style={{ fontWeight: 700, color: PAL.text, fontSize: 14 }}>{f.topic}</span>
                <span style={scopeChip(f.user_id == null ? "global" : (f.user_id === userId ? "self" : "other"))}>
                  {f.user_id == null ? "everyone" : (f.user_id === userId ? "just me" : "other operator")}
                </span>
                {f.app && (
                  <span style={appChip}>{f.app}</span>
                )}
                <span style={{ marginLeft: "auto", color: PAL.textMuted, fontSize: 11 }}>
                  updated {new Date(f.updated_at).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" })}
                </span>
              </div>
              <div style={{ color: PAL.text, fontSize: 13, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{f.fact}</div>
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button onClick={() => startEdit(f)} style={btnSmall}>Edit</button>
                <button onClick={() => remove(f.id)} style={{ ...btnSmall, color: PAL.red, borderColor: PAL.red }}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── styles (inline; matches PAL of the other internal apps) ─────────────
const wrap: React.CSSProperties = {
  minHeight: "100vh",
  background: PAL.bg,
  color: PAL.text,
  fontFamily: "'DM Sans','Segoe UI',sans-serif",
  padding: "0 0 60px",
};
const header: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between",
  padding: "12px 24px", background: PAL.panel, borderBottom: `1px solid ${PAL.border}`,
};
const filters: React.CSSProperties = {
  display: "flex", gap: 10, padding: "16px 24px",
  borderBottom: `1px solid ${PAL.border}`, background: PAL.panel,
};
const input: React.CSSProperties = {
  background: PAL.bg, color: PAL.text, border: `1px solid ${PAL.border}`,
  borderRadius: 6, padding: "8px 12px", fontSize: 13, minWidth: 240, fontFamily: "inherit",
};
const select: React.CSSProperties = {
  background: PAL.bg, color: PAL.text, border: `1px solid ${PAL.border}`,
  borderRadius: 6, padding: "8px 10px", fontSize: 13, fontFamily: "inherit",
};
const btnPrimary: React.CSSProperties = {
  background: PAL.accent, color: "#fff", border: `1px solid ${PAL.accent}`,
  borderRadius: 6, padding: "8px 14px", fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: "inherit",
};
const btnSecondary: React.CSSProperties = {
  background: "transparent", color: PAL.textDim, border: `1px solid ${PAL.border}`,
  borderRadius: 6, padding: "8px 14px", fontSize: 13, cursor: "pointer", fontFamily: "inherit",
};
const btnSmall: React.CSSProperties = {
  background: "transparent", color: PAL.textDim, border: `1px solid ${PAL.border}`,
  borderRadius: 5, padding: "4px 10px", fontSize: 12, cursor: "pointer", fontFamily: "inherit",
};
const editor: React.CSSProperties = {
  margin: "16px 24px", padding: 16, background: PAL.panel,
  border: `1px solid ${PAL.border}`, borderRadius: 8,
};
const label: React.CSSProperties = {
  display: "block", fontSize: 12, fontWeight: 600, color: PAL.text, marginBottom: 6,
};
const card: React.CSSProperties = {
  margin: "0 24px", padding: 14, background: PAL.panel,
  border: `1px solid ${PAL.border}`, borderRadius: 8,
};
const errorBox: React.CSSProperties = {
  margin: "12px 24px", padding: "10px 14px",
  background: "#7F1D1D", color: "#FECACA", border: `1px solid ${PAL.red}`, borderRadius: 6, fontSize: 13,
};
const appChip: React.CSSProperties = {
  fontSize: 10, fontWeight: 600, color: PAL.textDim, background: PAL.bg,
  border: `1px solid ${PAL.border}`, borderRadius: 999, padding: "2px 8px",
};
function scopeChip(kind: "self" | "global" | "other"): React.CSSProperties {
  const bg = kind === "global" ? PAL.green : kind === "self" ? PAL.accent : PAL.textMuted;
  return {
    fontSize: 10, fontWeight: 700, color: "#fff", background: bg,
    borderRadius: 999, padding: "2px 8px", textTransform: "uppercase", letterSpacing: 0.3,
  };
}

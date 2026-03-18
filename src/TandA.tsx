import { useState, useRef, useEffect } from "react";

// ─── THEME (matches Design Calendar exactly) ─────────────────────────────────
const TH = {
  bg: "#4A5568",
  surface: "#FFFFFF",
  surfaceHi: "#F7F8FA",
  border: "#CBD5E0",
  header: "#2D3748",
  primary: "#C8210A",
  primaryLt: "#E02B10",
  text: "#1A202C",
  textSub: "#2D3748",
  textSub2: "#4A5568",
  textMuted: "#718096",
  accent: "#FFF5F5",
  accentBdr: "#FEB2B2",
  shadow: "rgba(0,0,0,0.12)",
  shadowMd: "rgba(0,0,0,0.18)",
};

const S = {
  inp: {
    width: "100%", background: TH.surface, border: `1px solid ${TH.border}`,
    borderRadius: 8, color: TH.text, padding: "9px 13px", fontSize: 13,
    boxSizing: "border-box" as const, outline: "none", fontFamily: "inherit", marginBottom: 14,
  },
  lbl: {
    fontSize: 10, letterSpacing: "0.12em", color: TH.textMuted,
    textTransform: "uppercase" as const, display: "block", marginBottom: 5, fontWeight: 600,
  },
  sec: {
    fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase" as const,
    color: TH.textMuted, marginBottom: 14, fontWeight: 600, display: "block",
  },
  card: {
    background: TH.surface, border: `1px solid ${TH.border}`,
    borderRadius: 12, padding: "18px 20px", boxShadow: `0 2px 8px ${TH.shadow}`,
  },
  btn: {
    padding: "9px 22px", borderRadius: 8, border: "none",
    background: `linear-gradient(135deg,${TH.primary},${TH.primaryLt})`,
    color: "#fff", fontWeight: 700, cursor: "pointer", fontFamily: "inherit", fontSize: 13,
  },
};

// ─── SUPABASE ─────────────────────────────────────────────────────────────────
const SB_URL = "https://qcvqvxxoperiurauoxmp.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFjdnF2eHhvcGVyaXVyYXVveG1wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2ODU4MjksImV4cCI6MjA4OTI2MTgyOX0.YoBmIdlqqPYt9roTsDPGSBegNnoupCYSsnyCHMo24Zw";

async function sbGet(key: string) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/app_data?key=eq.${encodeURIComponent(key)}&select=value`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d?.[0]?.value ? JSON.parse(d[0].value) : null;
  } catch { return null; }
}

async function sbSet(key: string, value: any) {
  try {
    await fetch(`${SB_URL}/rest/v1/app_data`, {
      method: "POST",
      headers: {
        apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
        "Content-Type": "application/json", Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify({ key, value: JSON.stringify(value) }),
    });
  } catch {}
}

async function sbGetRows(table: string) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/${table}?select=id,data`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }
    });
    if (!r.ok) return [];
    const d = await r.json();
    return (d || []).map((row: any) => ({ id: row.id, ...(typeof row.data === "object" ? row.data : JSON.parse(row.data || "{}")) }));
  } catch { return []; }
}

async function sbUpsertRow(table: string, id: string, data: any) {
  try {
    await fetch(`${SB_URL}/rest/v1/${table}`, {
      method: "POST",
      headers: {
        apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
        "Content-Type": "application/json", Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify({ id, data }),
    });
  } catch {}
}

async function sbDeleteRow(table: string, id: string) {
  try {
    await fetch(`${SB_URL}/rest/v1/${table}?id=eq.${id}`, {
      method: "DELETE",
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }
    });
  } catch {}
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
function parseLocal(ds: string) {
  if (!ds) return new Date();
  const [y, m, d] = ds.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function addDays(ds: string, n: number): string {
  const d = parseLocal(ds);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function diffDays(a: string, b: string) {
  return Math.round((parseLocal(a).getTime() - parseLocal(b).getTime()) / 86400000);
}
function fmtDate(ds: string) {
  if (!ds) return "—";
  const d = parseLocal(ds);
  return `${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}
function today() { return new Date().toISOString().split("T")[0]; }
function getDaysUntil(ds: string) {
  const t = new Date(); t.setHours(0,0,0,0);
  return Math.round((parseLocal(ds).getTime() - t.getTime()) / 86400000);
}

const STATUS_OPTIONS = ["Not Started", "In Progress", "Complete", "Delayed", "On Hold", "Approved", "Cancelled"];
const STATUS_COLORS: Record<string, { color: string; bg: string; dot: string }> = {
  "Not Started":  { color: "#6B7280", bg: "#F3F4F6", dot: "#9CA3AF" },
  "In Progress":  { color: "#B45309", bg: "#FFFBEB", dot: "#D97706" },
  "Complete":     { color: "#047857", bg: "#ECFDF5", dot: "#10B981" },
  "Delayed":      { color: "#B91C1C", bg: "#FEF2F2", dot: "#EF4444" },
  "On Hold":      { color: "#7C3AED", bg: "#F5F3FF", dot: "#8B5CF6" },
  "Approved":     { color: "#047857", bg: "#D1FAE5", dot: "#059669" },
  "Cancelled":    { color: "#6B7280", bg: "#F9FAFB", dot: "#9CA3AF" },
};
const PRIORITY_OPTIONS = ["Low", "Medium", "High", "Critical"];
const PRIORITY_COLORS: Record<string, string> = {
  Low: "#6B7280", Medium: "#B45309", High: "#C8210A", Critical: "#7C3AED"
};

// ─── TYPES ────────────────────────────────────────────────────────────────────
interface TandAProject {
  id: string;
  name: string;
  brand: string;
  season: string;
  year: number;
  category: string;
  vendor: string;
  customer: string;
  targetDate: string;  // key delivery date (e.g. in-store date)
  notes: string;
  color: string;
  createdAt: string;
}

interface TandAMilestone {
  id: string;
  projectId: string;
  name: string;
  dueDate: string;
  status: string;
  priority: string;
  owner: string;
  dependencies: string[]; // milestone IDs
  notes: string;
  completedAt: string;
  history: { at: string; field: string; from: string; to: string; by: string }[];
}

// ─── MODAL ────────────────────────────────────────────────────────────────────
function Modal({ title, onClose, children, wide = false }: any) {
  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
    >
      <div style={{ background: TH.surface, borderRadius: 16, width: "100%", maxWidth: wide ? 760 : 540, maxHeight: "90vh", display: "flex", flexDirection: "column", boxShadow: `0 24px 60px ${TH.shadowMd}` }}>
        <div style={{ padding: "18px 24px", borderBottom: `1px solid ${TH.border}`, display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
          <span style={{ fontSize: 16, fontWeight: 700, color: TH.text }}>{title}</span>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: TH.textMuted, padding: "0 4px" }}>✕</button>
        </div>
        <div style={{ padding: "20px 24px", overflowY: "auto", flex: 1 }}>{children}</div>
      </div>
    </div>
  );
}

// ─── COLOR PICKER ─────────────────────────────────────────────────────────────
const PROJECT_COLORS = ["#C8210A","#B45309","#047857","#1D4ED8","#7C3AED","#BE185D","#0E7490","#374151"];
function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {PROJECT_COLORS.map(c => (
        <button key={c} onClick={() => onChange(c)} style={{
          width: 28, height: 28, borderRadius: "50%", background: c, border: value === c ? `3px solid ${TH.text}` : "3px solid transparent",
          cursor: "pointer", outline: "none"
        }} />
      ))}
    </div>
  );
}

// ─── PROJECT FORM ─────────────────────────────────────────────────────────────
function ProjectForm({ project, onSave, onCancel }: { project?: TandAProject | null; onSave: (p: TandAProject) => void; onCancel: () => void }) {
  const [f, setF] = useState<TandAProject>(project || {
    id: uid(), name: "", brand: "", season: "Fall", year: new Date().getFullYear(),
    category: "", vendor: "", customer: "", targetDate: "", notes: "",
    color: PROJECT_COLORS[0], createdAt: new Date().toISOString(),
  });
  const set = (k: keyof TandAProject, v: any) => setF(x => ({ ...x, [k]: v }));
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <div style={{ gridColumn: "1 / -1" }}>
          <label style={S.lbl}>Project Name *</label>
          <input style={S.inp} value={f.name} onChange={e => set("name", e.target.value)} placeholder="e.g. Fall 2026 Denim Collection" />
        </div>
        <div>
          <label style={S.lbl}>Brand</label>
          <input style={{ ...S.inp, marginBottom: 0 }} value={f.brand} onChange={e => set("brand", e.target.value)} placeholder="Ring of Fire" />
        </div>
        <div>
          <label style={S.lbl}>Season / Year</label>
          <div style={{ display: "flex", gap: 8 }}>
            <select style={{ ...S.inp, marginBottom: 0, flex: 2 }} value={f.season} onChange={e => set("season", e.target.value)}>
              {["Spring","Summer","Fall","Holiday"].map(s => <option key={s}>{s}</option>)}
            </select>
            <input type="number" style={{ ...S.inp, marginBottom: 0, flex: 1 }} value={f.year} onChange={e => set("year", parseInt(e.target.value) || new Date().getFullYear())} />
          </div>
        </div>
        <div>
          <label style={S.lbl}>Category</label>
          <input style={{ ...S.inp, marginBottom: 0 }} value={f.category} onChange={e => set("category", e.target.value)} placeholder="Denim" />
        </div>
        <div>
          <label style={S.lbl}>Vendor / Factory</label>
          <input style={{ ...S.inp, marginBottom: 0 }} value={f.vendor} onChange={e => set("vendor", e.target.value)} placeholder="Vendor name" />
        </div>
        <div>
          <label style={S.lbl}>Customer</label>
          <input style={{ ...S.inp, marginBottom: 0 }} value={f.customer} onChange={e => set("customer", e.target.value)} placeholder="e.g. Ross" />
        </div>
        <div>
          <label style={S.lbl}>Target In-Store Date *</label>
          <input type="date" style={{ ...S.inp, marginBottom: 0 }} value={f.targetDate} onChange={e => set("targetDate", e.target.value)} />
        </div>
      </div>
      <div style={{ height: 14 }} />
      <label style={S.lbl}>Color Tag</label>
      <ColorPicker value={f.color} onChange={c => set("color", c)} />
      <div style={{ height: 14 }} />
      <label style={S.lbl}>Notes</label>
      <textarea style={{ ...S.inp, minHeight: 70, resize: "vertical" }} value={f.notes} onChange={e => set("notes", e.target.value)} placeholder="Project notes..." />
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
        <button onClick={onCancel} style={{ padding: "9px 18px", borderRadius: 8, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
        <button disabled={!f.name || !f.targetDate} onClick={() => onSave(f)} style={{ ...S.btn, opacity: f.name && f.targetDate ? 1 : 0.4 }}>Save Project</button>
      </div>
    </div>
  );
}

// ─── MILESTONE FORM ───────────────────────────────────────────────────────────
function MilestoneForm({ milestone, projectId, allMilestones, currentUser, onSave, onCancel }: any) {
  const [f, setF] = useState(milestone || {
    id: uid(), projectId, name: "", dueDate: "", status: "Not Started",
    priority: "Medium", owner: currentUser || "", dependencies: [], notes: "",
    completedAt: "", history: [],
  });
  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  const otherMilestones = allMilestones.filter((m: any) => m.id !== f.id && m.projectId === projectId);
  const toggleDep = (id: string) => set("dependencies", f.dependencies.includes(id)
    ? f.dependencies.filter((d: string) => d !== id)
    : [...f.dependencies, id]
  );
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <div style={{ gridColumn: "1 / -1" }}>
          <label style={S.lbl}>Milestone Name *</label>
          <input style={S.inp} value={f.name} onChange={e => set("name", e.target.value)} placeholder="e.g. Fabric Approval, Bulk Order Placed" />
        </div>
        <div>
          <label style={S.lbl}>Due Date *</label>
          <input type="date" style={{ ...S.inp, marginBottom: 0 }} value={f.dueDate} onChange={e => set("dueDate", e.target.value)} />
        </div>
        <div>
          <label style={S.lbl}>Status</label>
          <select style={{ ...S.inp, marginBottom: 0 }} value={f.status} onChange={e => set("status", e.target.value)}>
            {STATUS_OPTIONS.map(s => <option key={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label style={S.lbl}>Priority</label>
          <select style={{ ...S.inp, marginBottom: 0 }} value={f.priority} onChange={e => set("priority", e.target.value)}>
            {PRIORITY_OPTIONS.map(p => <option key={p}>{p}</option>)}
          </select>
        </div>
        <div>
          <label style={S.lbl}>Owner / Responsible</label>
          <input style={{ ...S.inp, marginBottom: 0 }} value={f.owner} onChange={e => set("owner", e.target.value)} placeholder="Name or team" />
        </div>
      </div>
      {otherMilestones.length > 0 && (
        <>
          <div style={{ height: 14 }} />
          <label style={S.lbl}>Depends On (must complete first)</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
            {otherMilestones.map((m: any) => (
              <button key={m.id} onClick={() => toggleDep(m.id)} style={{
                padding: "4px 12px", borderRadius: 16,
                border: `1px solid ${f.dependencies.includes(m.id) ? TH.primary : TH.border}`,
                background: f.dependencies.includes(m.id) ? TH.primary + "15" : "transparent",
                color: f.dependencies.includes(m.id) ? TH.primary : TH.textMuted,
                cursor: "pointer", fontFamily: "inherit", fontSize: 12,
              }}>{m.name}</button>
            ))}
          </div>
        </>
      )}
      <div style={{ height: 14 }} />
      <label style={S.lbl}>Notes</label>
      <textarea style={{ ...S.inp, minHeight: 70, resize: "vertical" }} value={f.notes} onChange={e => set("notes", e.target.value)} placeholder="Notes, blockers, context..." />
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
        <button onClick={onCancel} style={{ padding: "9px 18px", borderRadius: 8, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
        <button disabled={!f.name || !f.dueDate} onClick={() => onSave(f)} style={{ ...S.btn, opacity: f.name && f.dueDate ? 1 : 0.4 }}>Save Milestone</button>
      </div>
    </div>
  );
}

// ─── MILESTONE DETAIL MODAL ───────────────────────────────────────────────────
function MilestoneDetail({ milestone, project, allMilestones, currentUser, onSave, onDelete, onClose }: any) {
  const [editing, setEditing] = useState(false);
  const sc = STATUS_COLORS[milestone.status] || STATUS_COLORS["Not Started"];
  const pc = PRIORITY_COLORS[milestone.priority] || TH.textMuted;
  const daysUntil = getDaysUntil(milestone.dueDate);
  const isOverdue = daysUntil < 0 && milestone.status !== "Complete" && milestone.status !== "Cancelled";
  const deps = allMilestones.filter((m: any) => milestone.dependencies?.includes(m.id));

  if (editing) return (
    <Modal title="Edit Milestone" onClose={() => setEditing(false)} wide>
      <MilestoneForm
        milestone={milestone}
        projectId={milestone.projectId}
        allMilestones={allMilestones}
        currentUser={currentUser}
        onSave={(updated: any) => { onSave(updated); setEditing(false); }}
        onCancel={() => setEditing(false)}
      />
    </Modal>
  );

  return (
    <Modal title={milestone.name} onClose={onClose} wide>
      <div>
        {/* Status + Priority row */}
        <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
          <span style={{ padding: "4px 12px", borderRadius: 12, background: sc.bg, color: sc.color, fontSize: 12, fontWeight: 600 }}>{milestone.status}</span>
          <span style={{ padding: "4px 12px", borderRadius: 12, background: pc + "15", color: pc, fontSize: 12, fontWeight: 600, border: `1px solid ${pc}33` }}>⚡ {milestone.priority}</span>
          {isOverdue && <span style={{ padding: "4px 12px", borderRadius: 12, background: "#FEF2F2", color: "#B91C1C", fontSize: 12, fontWeight: 600 }}>⚠ {Math.abs(daysUntil)}d overdue</span>}
          {!isOverdue && daysUntil >= 0 && daysUntil <= 7 && <span style={{ padding: "4px 12px", borderRadius: 12, background: "#FFFBEB", color: "#B45309", fontSize: 12, fontWeight: 600 }}>⏰ Due in {daysUntil}d</span>}
        </div>
        {/* Info grid */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 16 }}>
          <div style={{ ...S.card, padding: "12px 16px" }}>
            <div style={S.lbl}>Due Date</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: isOverdue ? "#B91C1C" : TH.text }}>{fmtDate(milestone.dueDate)}</div>
          </div>
          <div style={{ ...S.card, padding: "12px 16px" }}>
            <div style={S.lbl}>Owner</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: TH.text }}>{milestone.owner || "—"}</div>
          </div>
          {milestone.completedAt && (
            <div style={{ ...S.card, padding: "12px 16px" }}>
              <div style={S.lbl}>Completed</div>
              <div style={{ fontSize: 13, color: "#047857", fontWeight: 600 }}>{fmtDate(milestone.completedAt.split("T")[0])}</div>
            </div>
          )}
          <div style={{ ...S.card, padding: "12px 16px" }}>
            <div style={S.lbl}>Project</div>
            <div style={{ fontSize: 13, color: TH.text }}>{project?.name || "—"}</div>
          </div>
        </div>
        {/* Dependencies */}
        {deps.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div style={S.lbl}>Depends On</div>
            <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
              {deps.map((d: any) => {
                const dsc = STATUS_COLORS[d.status] || STATUS_COLORS["Not Started"];
                return (
                  <span key={d.id} style={{ padding: "4px 12px", borderRadius: 12, background: dsc.bg, color: dsc.color, fontSize: 12, fontWeight: 600 }}>
                    {d.status === "Complete" ? "✓" : "○"} {d.name}
                  </span>
                );
              })}
            </div>
          </div>
        )}
        {/* Notes */}
        {milestone.notes && (
          <div style={{ marginBottom: 14 }}>
            <div style={S.lbl}>Notes</div>
            <div style={{ ...S.card, padding: "12px 16px", fontSize: 13, color: TH.text, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{milestone.notes}</div>
          </div>
        )}
        {/* History */}
        {milestone.history?.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div style={S.lbl}>History</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {[...milestone.history].reverse().map((h: any, i: number) => (
                <div key={i} style={{ ...S.card, padding: "8px 14px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: TH.primary }}>{h.by}</span>
                    <span style={{ fontSize: 11, color: TH.textMuted }}>{new Date(h.at).toLocaleString()}</span>
                  </div>
                  <div style={{ fontSize: 12, color: TH.textMuted }}>
                    Changed <strong style={{ color: TH.text }}>{h.field}</strong>: <span style={{ color: "#B91C1C" }}>{h.from || "—"}</span> → <span style={{ color: "#047857" }}>{h.to}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {/* Actions */}
        <div style={{ display: "flex", gap: 10, justifyContent: "space-between", flexWrap: "wrap" }}>
          <button onClick={() => onDelete(milestone.id)} style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #FCA5A5", background: "none", color: "#B91C1C", cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}>Delete</button>
          <div style={{ display: "flex", gap: 8 }}>
            {/* Quick status change */}
            {milestone.status !== "Complete" && (
              <button onClick={() => {
                const now = new Date().toISOString();
                const hist = [...(milestone.history || []), { at: now, field: "status", from: milestone.status, to: "Complete", by: currentUser || "User" }];
                onSave({ ...milestone, status: "Complete", completedAt: now, history: hist });
                onClose();
              }} style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #10B981", background: "#ECFDF5", color: "#047857", cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 600 }}>✓ Mark Complete</button>
            )}
            <button onClick={() => setEditing(true)} style={{ ...S.btn }}>Edit</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ─── GANTT CHART ──────────────────────────────────────────────────────────────
function GanttView({ project, milestones, onMilestoneClick }: any) {
  if (!project || milestones.length === 0) return (
    <div style={{ textAlign: "center", color: TH.textMuted, padding: 40, fontSize: 13 }}>No milestones yet. Add milestones to see the Gantt chart.</div>
  );
  const sorted = [...milestones].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const minDate = sorted[0].dueDate;
  const maxDate = sorted[sorted.length - 1].dueDate;
  const totalDays = Math.max(diffDays(maxDate, minDate) + 14, 60);
  const chartStart = addDays(minDate, -7);

  return (
    <div style={{ overflowX: "auto" }}>
      <div style={{ minWidth: Math.max(totalDays * 18, 600), position: "relative" }}>
        {/* Today line */}
        {(() => {
          const todayOffset = diffDays(today(), chartStart);
          if (todayOffset < 0 || todayOffset > totalDays + 14) return null;
          return (
            <div style={{ position: "absolute", top: 0, bottom: 0, left: todayOffset * 18 + 160, width: 2, background: TH.primary + "55", zIndex: 1, pointerEvents: "none" }}>
              <div style={{ position: "absolute", top: 0, left: -16, background: TH.primary, color: "#fff", fontSize: 9, padding: "2px 4px", borderRadius: 3, whiteSpace: "nowrap", fontWeight: 700 }}>TODAY</div>
            </div>
          );
        })()}
        {/* Month headers */}
        <div style={{ display: "flex", marginLeft: 160, marginBottom: 4 }}>
          {(() => {
            const months: { label: string; width: number }[] = [];
            let cur = parseLocal(chartStart);
            let pos = 0;
            while (pos < totalDays + 14) {
              const daysInMonth = new Date(cur.getFullYear(), cur.getMonth() + 1, 0).getDate() - cur.getDate() + 1;
              const w = Math.min(daysInMonth, totalDays + 14 - pos);
              months.push({ label: `${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][cur.getMonth()]} ${cur.getFullYear()}`, width: w * 18 });
              pos += daysInMonth;
              cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
            }
            return months.map((m, i) => (
              <div key={i} style={{ width: m.width, fontSize: 10, fontWeight: 700, color: TH.textMuted, borderRight: `1px solid ${TH.border}`, padding: "0 4px", overflow: "hidden", whiteSpace: "nowrap", flexShrink: 0 }}>{m.label}</div>
            ));
          })()}
        </div>
        {/* Milestone rows */}
        {sorted.map((m, idx) => {
          const offset = diffDays(m.dueDate, chartStart);
          const sc = STATUS_COLORS[m.status] || STATUS_COLORS["Not Started"];
          const pc = PRIORITY_COLORS[m.priority] || TH.textMuted;
          const isOverdue = getDaysUntil(m.dueDate) < 0 && m.status !== "Complete" && m.status !== "Cancelled";
          // Draw dependency lines
          const depOffsets = (m.dependencies || []).map((depId: string) => {
            const dep = milestones.find((x: any) => x.id === depId);
            if (!dep) return null;
            return diffDays(dep.dueDate, chartStart);
          }).filter(Boolean);

          return (
            <div key={m.id} style={{ display: "flex", alignItems: "center", height: 36, borderBottom: `1px solid ${TH.border}22`, position: "relative" }}>
              {/* Name column */}
              <div style={{ width: 160, fontSize: 12, fontWeight: 600, color: TH.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingRight: 8, flexShrink: 0, cursor: "pointer" }} onClick={() => onMilestoneClick(m)}>
                {m.name}
              </div>
              {/* Chart area */}
              <div style={{ flex: 1, position: "relative", height: "100%", overflow: "visible" }}>
                {/* Dependency arrows */}
                {depOffsets.map((depOff: number, di: number) => {
                  const depRowIdx = sorted.findIndex((x: any) => x.id === m.dependencies[di]);
                  if (depRowIdx < 0) return null;
                  return null; // simplified for now — arrows too complex for inline SVG
                })}
                {/* Milestone diamond */}
                <div
                  onClick={() => onMilestoneClick(m)}
                  title={`${m.name} — ${fmtDate(m.dueDate)}`}
                  style={{
                    position: "absolute",
                    left: offset * 18 - 9,
                    top: "50%",
                    transform: "translateY(-50%) rotate(45deg)",
                    width: 16, height: 16,
                    background: m.status === "Complete" ? "#047857" : isOverdue ? "#B91C1C" : m.color || sc.dot,
                    border: `2px solid ${m.status === "Complete" ? "#065F46" : isOverdue ? "#991B1B" : "rgba(0,0,0,0.1)"}`,
                    cursor: "pointer",
                    zIndex: 2,
                    boxShadow: "0 2px 4px rgba(0,0,0,0.2)",
                  }}
                />
                {/* Label */}
                <div style={{
                  position: "absolute", left: offset * 18 + 12, top: "50%", transform: "translateY(-50%)",
                  fontSize: 10, color: isOverdue ? "#B91C1C" : TH.textMuted, whiteSpace: "nowrap", pointerEvents: "none"
                }}>
                  {fmtDate(m.dueDate)}
                  {m.owner ? ` · ${m.owner}` : ""}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── PROJECT CARD ─────────────────────────────────────────────────────────────
function ProjectCard({ project, milestones, onClick }: any) {
  const ms = milestones.filter((m: any) => m.projectId === project.id);
  const total = ms.length;
  const done = ms.filter((m: any) => m.status === "Complete" || m.status === "Approved").length;
  const delayed = ms.filter((m: any) => m.status === "Delayed").length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const next = ms.filter((m: any) => m.status !== "Complete" && m.status !== "Approved" && m.status !== "Cancelled")
    .sort((a: any, b: any) => a.dueDate.localeCompare(b.dueDate))[0];
  const daysToTarget = getDaysUntil(project.targetDate);

  return (
    <div
      onClick={onClick}
      style={{
        ...S.card, cursor: "pointer", position: "relative", overflow: "hidden",
        transition: "transform 0.15s, box-shadow 0.15s",
        borderTop: `3px solid ${project.color || TH.primary}`,
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.transform = "translateY(-2px)"; (e.currentTarget as HTMLElement).style.boxShadow = `0 8px 24px ${TH.shadowMd}`; }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.transform = ""; (e.currentTarget as HTMLElement).style.boxShadow = `0 2px 8px ${TH.shadow}`; }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: project.color || TH.primary, marginBottom: 2 }}>{project.name}</div>
          <div style={{ fontSize: 11, color: TH.textMuted }}>
            {[project.brand, project.season + " " + project.year, project.category].filter(Boolean).join(" · ")}
          </div>
          {(project.vendor || project.customer) && (
            <div style={{ fontSize: 11, color: TH.textMuted, marginTop: 2 }}>
              {[project.vendor, project.customer].filter(Boolean).join(" · ")}
            </div>
          )}
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: pct === 100 ? "#047857" : TH.text, lineHeight: 1 }}>{pct}%</div>
          {delayed > 0 && <div style={{ fontSize: 10, color: "#B91C1C", fontWeight: 700 }}>⚠ {delayed} delayed</div>}
        </div>
      </div>
      {/* Progress bar */}
      <div style={{ height: 5, background: TH.surfaceHi, border: `1px solid ${TH.border}`, borderRadius: 3, overflow: "hidden", marginBottom: 10 }}>
        <div style={{ height: "100%", width: `${pct}%`, background: `linear-gradient(90deg,${project.color || TH.primary},${TH.primaryLt})`, borderRadius: 3, transition: "width 0.6s" }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: 11, color: TH.textMuted }}>
          {next ? <>Next: <strong style={{ color: TH.text }}>{next.name}</strong> — <span style={{ color: getDaysUntil(next.dueDate) < 0 ? "#B91C1C" : getDaysUntil(next.dueDate) < 7 ? "#B45309" : TH.primary, fontWeight: 600 }}>{fmtDate(next.dueDate)}</span></> : <span style={{ color: "#047857" }}>✓ All complete</span>}
        </div>
        <div style={{ fontSize: 11, color: TH.textMuted }}>{done}/{total} milestones</div>
      </div>
      {project.targetDate && (
        <div style={{ marginTop: 8, fontSize: 11, display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ color: TH.textMuted }}>Target:</span>
          <span style={{ fontWeight: 600, color: daysToTarget < 0 ? "#B91C1C" : daysToTarget < 14 ? "#B45309" : TH.textSub }}>{fmtDate(project.targetDate)}</span>
          {daysToTarget < 0 && <span style={{ color: "#B91C1C", fontSize: 10 }}>({Math.abs(daysToTarget)}d past)</span>}
          {daysToTarget >= 0 && daysToTarget <= 30 && <span style={{ color: "#B45309", fontSize: 10 }}>({daysToTarget}d away)</span>}
        </div>
      )}
    </div>
  );
}

// ─── PROJECT DETAIL VIEW ──────────────────────────────────────────────────────
function ProjectDetail({ project, milestones, allMilestones, currentUser, onEditProject, onDeleteProject, onAddMilestone, onEditMilestone, onDeleteMilestone, onBack }: any) {
  const [tab, setTab] = useState<"gantt"|"list"|"calendar">("gantt");
  const [selectedMilestone, setSelectedMilestone] = useState<any>(null);
  const [addingMilestone, setAddingMilestone] = useState(false);
  const ms = milestones.filter((m: any) => m.projectId === project.id);
  const total = ms.length;
  const done = ms.filter((m: any) => ["Complete","Approved"].includes(m.status)).length;
  const delayed = ms.filter((m: any) => m.status === "Delayed").length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const sorted = [...ms].sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <button onClick={onBack} style={{ padding: "6px 14px", borderRadius: 8, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>← Projects</button>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 12, height: 12, borderRadius: "50%", background: project.color || TH.primary, flexShrink: 0 }} />
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: TH.text }}>{project.name}</h2>
          </div>
          <div style={{ fontSize: 12, color: TH.textMuted, marginTop: 3 }}>
            {[project.brand, project.season + " " + project.year, project.category, project.vendor, project.customer].filter(Boolean).join(" · ")}
            {project.targetDate && <span style={{ marginLeft: 8, fontWeight: 600, color: TH.primary }}>· Target: {fmtDate(project.targetDate)}</span>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 20, fontWeight: 800, color: pct === 100 ? "#047857" : TH.text }}>{pct}%</div>
            {delayed > 0 && <div style={{ fontSize: 10, color: "#B91C1C", fontWeight: 700 }}>⚠ {delayed} delayed</div>}
          </div>
          <button onClick={onEditProject} style={{ padding: "7px 14px", borderRadius: 8, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>✏️ Edit</button>
          <button onClick={() => setAddingMilestone(true)} style={S.btn}>+ Milestone</button>
        </div>
      </div>
      {/* Progress bar */}
      <div style={{ height: 6, background: TH.surfaceHi, border: `1px solid ${TH.border}`, borderRadius: 3, overflow: "hidden", marginBottom: 20 }}>
        <div style={{ height: "100%", width: `${pct}%`, background: `linear-gradient(90deg,${project.color || TH.primary},${TH.primaryLt})`, transition: "width 0.6s" }} />
      </div>
      {/* Tabs */}
      <div style={{ display: "flex", gap: 4, marginBottom: 16, borderBottom: `1px solid ${TH.border}`, paddingBottom: 8 }}>
        {(["gantt","list","calendar"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: "6px 16px", borderRadius: 8, border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: tab === t ? 700 : 500,
            background: tab === t ? TH.primary + "15" : "none", color: tab === t ? TH.primary : TH.textMuted,
          }}>
            {t === "gantt" ? "📊 Gantt" : t === "list" ? "📋 List" : "📅 Calendar"}
          </button>
        ))}
        <div style={{ marginLeft: "auto", fontSize: 12, color: TH.textMuted, display: "flex", alignItems: "center" }}>{done}/{total} complete</div>
      </div>
      {/* Gantt */}
      {tab === "gantt" && <GanttView project={project} milestones={ms} onMilestoneClick={setSelectedMilestone} />}
      {/* List */}
      {tab === "list" && (
        <div style={{ display: "grid", gap: 8 }}>
          {sorted.length === 0 && <div style={{ textAlign: "center", color: TH.textMuted, padding: 32, fontSize: 13, border: `1px dashed ${TH.border}`, borderRadius: 10 }}>No milestones yet. Click "+ Milestone" to add.</div>}
          {sorted.map(m => {
            const sc = STATUS_COLORS[m.status] || STATUS_COLORS["Not Started"];
            const pc = PRIORITY_COLORS[m.priority] || TH.textMuted;
            const isOverdue = getDaysUntil(m.dueDate) < 0 && m.status !== "Complete" && m.status !== "Cancelled";
            const depNames = (m.dependencies || []).map((id: string) => ms.find((x: any) => x.id === id)?.name).filter(Boolean);
            return (
              <div key={m.id} onClick={() => setSelectedMilestone(m)} style={{
                ...S.card, cursor: "pointer", display: "flex", alignItems: "center", gap: 14, padding: "14px 18px",
                borderLeft: `4px solid ${m.status === "Complete" ? "#047857" : isOverdue ? "#B91C1C" : project.color || TH.primary}`,
              }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: TH.text }}>{m.name}</span>
                    <span style={{ padding: "2px 8px", borderRadius: 10, background: sc.bg, color: sc.color, fontSize: 10, fontWeight: 600 }}>{m.status}</span>
                    <span style={{ padding: "2px 8px", borderRadius: 10, background: pc + "15", color: pc, fontSize: 10, fontWeight: 600 }}>{m.priority}</span>
                  </div>
                  <div style={{ fontSize: 11, color: TH.textMuted, display: "flex", gap: 12 }}>
                    <span style={{ color: isOverdue ? "#B91C1C" : TH.textMuted, fontWeight: isOverdue ? 700 : 400 }}>📅 {fmtDate(m.dueDate)}</span>
                    {m.owner && <span>👤 {m.owner}</span>}
                    {depNames.length > 0 && <span>🔗 {depNames.join(", ")}</span>}
                  </div>
                  {m.notes && <div style={{ fontSize: 11, color: TH.textMuted, marginTop: 4, fontStyle: "italic" }}>{m.notes.substring(0, 80)}{m.notes.length > 80 ? "…" : ""}</div>}
                </div>
                {m.status === "Complete" && <span style={{ color: "#047857", fontSize: 20 }}>✓</span>}
                {isOverdue && <span style={{ color: "#B91C1C", fontSize: 11, fontWeight: 700 }}>⚠ {Math.abs(getDaysUntil(m.dueDate))}d</span>}
              </div>
            );
          })}
        </div>
      )}
      {/* Calendar view */}
      {tab === "calendar" && (
        <MilestoneCalendar milestones={ms} project={project} onMilestoneClick={setSelectedMilestone} />
      )}
      {/* Modals */}
      {addingMilestone && (
        <Modal title="Add Milestone" onClose={() => setAddingMilestone(false)} wide>
          <MilestoneForm
            projectId={project.id}
            allMilestones={allMilestones}
            currentUser={currentUser}
            onSave={(m: any) => { onAddMilestone(m); setAddingMilestone(false); }}
            onCancel={() => setAddingMilestone(false)}
          />
        </Modal>
      )}
      {selectedMilestone && (
        <MilestoneDetail
          milestone={selectedMilestone}
          project={project}
          allMilestones={allMilestones}
          currentUser={currentUser}
          onSave={(updated: any) => { onEditMilestone(updated); setSelectedMilestone(updated); }}
          onDelete={(id: string) => { onDeleteMilestone(id); setSelectedMilestone(null); }}
          onClose={() => setSelectedMilestone(null)}
        />
      )}
    </div>
  );
}

// ─── MILESTONE CALENDAR ───────────────────────────────────────────────────────
function MilestoneCalendar({ milestones, project, onMilestoneClick }: any) {
  const [month, setMonth] = useState(() => {
    const t = new Date(); return { year: t.getFullYear(), month: t.getMonth() };
  });
  const firstDay = new Date(month.year, month.month, 1);
  const lastDay = new Date(month.year, month.month + 1, 0);
  const startPad = firstDay.getDay();
  const cells: (Date|null)[] = [...Array(startPad).fill(null)];
  for (let d = 1; d <= lastDay.getDate(); d++) cells.push(new Date(month.year, month.month, d));
  const ds = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  const t = today();
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <button onClick={() => setMonth(m => { const d = new Date(m.year, m.month-1, 1); return { year: d.getFullYear(), month: d.getMonth() }; })} style={{ padding: "6px 14px", borderRadius: 8, border: `1px solid ${TH.border}`, background: "none", cursor: "pointer", fontFamily: "inherit" }}>←</button>
        <span style={{ fontWeight: 700, color: TH.text }}>
          {["January","February","March","April","May","June","July","August","September","October","November","December"][month.month]} {month.year}
        </span>
        <button onClick={() => setMonth(m => { const d = new Date(m.year, m.month+1, 1); return { year: d.getFullYear(), month: d.getMonth() }; })} style={{ padding: "6px 14px", borderRadius: 8, border: `1px solid ${TH.border}`, background: "none", cursor: "pointer", fontFamily: "inherit" }}>→</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 4 }}>
        {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(d => <div key={d} style={{ textAlign: "center", fontSize: 10, fontWeight: 700, color: TH.textMuted, padding: "4px 0" }}>{d}</div>)}
        {cells.map((d, i) => {
          if (!d) return <div key={`e${i}`} />;
          const dateStr = ds(d);
          const dayMs = milestones.filter((m: any) => m.dueDate === dateStr);
          const isToday = dateStr === t;
          return (
            <div key={dateStr} style={{ minHeight: 70, background: isToday ? TH.primary + "08" : TH.surface, border: `1px solid ${isToday ? TH.primary + "44" : TH.border}`, borderRadius: 8, padding: "4px 6px" }}>
              <div style={{ fontSize: 11, fontWeight: isToday ? 800 : 500, color: isToday ? TH.primary : TH.textMuted, marginBottom: 3 }}>{d.getDate()}</div>
              {dayMs.map((m: any) => {
                const sc = STATUS_COLORS[m.status] || STATUS_COLORS["Not Started"];
                return (
                  <div key={m.id} onClick={() => onMilestoneClick(m)} style={{
                    fontSize: 10, fontWeight: 600, padding: "2px 5px", borderRadius: 4,
                    background: m.status === "Complete" ? "#ECFDF5" : project?.color ? project.color + "20" : TH.primary + "15",
                    color: m.status === "Complete" ? "#047857" : project?.color || TH.primary,
                    cursor: "pointer", marginBottom: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>{m.name}</div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── ALL-PROJECTS CALENDAR ────────────────────────────────────────────────────
function AllMilestonesCalendar({ milestones, projects, onMilestoneClick }: any) {
  const [month, setMonth] = useState(() => {
    const t = new Date(); return { year: t.getFullYear(), month: t.getMonth() };
  });
  const firstDay = new Date(month.year, month.month, 1);
  const lastDay = new Date(month.year, month.month + 1, 0);
  const startPad = firstDay.getDay();
  const cells: (Date|null)[] = [...Array(startPad).fill(null)];
  for (let d = 1; d <= lastDay.getDate(); d++) cells.push(new Date(month.year, month.month, d));
  const ds = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  const t = today();
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <button onClick={() => setMonth(m => { const d = new Date(m.year, m.month-1, 1); return { year: d.getFullYear(), month: d.getMonth() }; })} style={{ padding: "6px 14px", borderRadius: 8, border: `1px solid ${TH.border}`, background: "none", cursor: "pointer", fontFamily: "inherit" }}>←</button>
        <span style={{ fontWeight: 700, fontSize: 15, color: TH.text }}>
          {["January","February","March","April","May","June","July","August","September","October","November","December"][month.month]} {month.year}
        </span>
        <button onClick={() => setMonth(m => { const d = new Date(m.year, m.month+1, 1); return { year: d.getFullYear(), month: d.getMonth() }; })} style={{ padding: "6px 14px", borderRadius: 8, border: `1px solid ${TH.border}`, background: "none", cursor: "pointer", fontFamily: "inherit" }}>→</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 4 }}>
        {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(d => <div key={d} style={{ textAlign: "center", fontSize: 10, fontWeight: 700, color: TH.textMuted, padding: "4px 0" }}>{d}</div>)}
        {cells.map((d, i) => {
          if (!d) return <div key={`e${i}`} />;
          const dateStr = ds(d);
          const dayMs = milestones.filter((m: any) => m.dueDate === dateStr);
          const isToday = dateStr === t;
          return (
            <div key={dateStr} style={{ minHeight: 80, background: isToday ? TH.primary + "08" : TH.surface, border: `1px solid ${isToday ? TH.primary + "44" : TH.border}`, borderRadius: 8, padding: "4px 6px" }}>
              <div style={{ fontSize: 11, fontWeight: isToday ? 800 : 500, color: isToday ? TH.primary : TH.textMuted, marginBottom: 3 }}>{d.getDate()}</div>
              {dayMs.slice(0, 4).map((m: any) => {
                const proj = projects.find((p: any) => p.id === m.projectId);
                const col = proj?.color || TH.primary;
                return (
                  <div key={m.id} onClick={() => onMilestoneClick(m)} style={{
                    fontSize: 10, fontWeight: 600, padding: "2px 5px", borderRadius: 4,
                    background: col + "20", color: col,
                    cursor: "pointer", marginBottom: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    borderLeft: `3px solid ${col}`,
                  }} title={`${proj?.name || ""} — ${m.name}`}>{m.name}</div>
                );
              })}
              {dayMs.length > 4 && <div style={{ fontSize: 10, color: TH.textMuted }}>+{dayMs.length - 4} more</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── LOGIN ────────────────────────────────────────────────────────────────────
const DEFAULT_USERS_TA = [{ id: "admin", name: "Admin", role: "admin", pin: "1234" }];
function Login({ onLogin }: { onLogin: (user: any) => void }) {
  const [name, setName] = useState(() => localStorage.getItem("tanda_lastuser") || "");
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  async function handleLogin() {
    const users = await sbGet("users") || DEFAULT_USERS_TA;
    const u = users.find((x: any) => x.name.toLowerCase() === name.toLowerCase() && String(x.pin) === pin);
    if (!u) { setErr("Invalid name or PIN"); return; }
    localStorage.setItem("tanda_lastuser", u.name);
    onLogin(u);
  }
  return (
    <div style={{ minHeight: "100vh", background: `linear-gradient(135deg,${TH.header},${TH.bg})`, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: TH.surface, borderRadius: 20, padding: 40, width: 340, boxShadow: `0 24px 60px ${TH.shadowMd}` }}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{ fontSize: 28, fontWeight: 900, color: TH.primary, letterSpacing: "-0.5px" }}>ROF</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: TH.text, marginTop: 4 }}>T&A Calendar</div>
          <div style={{ fontSize: 12, color: TH.textMuted, marginTop: 4 }}>Time & Action Tracker</div>
        </div>
        <label style={S.lbl}>Name</label>
        <input style={S.inp} value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === "Enter" && handleLogin()} />
        <label style={S.lbl}>PIN</label>
        <input type="password" style={S.inp} value={pin} onChange={e => setPin(e.target.value)} onKeyDown={e => e.key === "Enter" && handleLogin()} />
        {err && <div style={{ color: "#B91C1C", fontSize: 12, marginBottom: 12, textAlign: "center" }}>{err}</div>}
        <button onClick={handleLogin} style={{ ...S.btn, width: "100%" }}>Sign In</button>
      </div>
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function TandAApp() {
  const [user, setUser] = useState<any>(null);
  const [projects, setProjects] = useState<TandAProject[]>([]);
  const [milestones, setMilestones] = useState<TandAMilestone[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState<"dashboard"|"calendar">("dashboard");
  const [selectedProject, setSelectedProject] = useState<TandAProject | null>(null);
  const [editingProject, setEditingProject] = useState<TandAProject | null | "new">(null);
  const [filterBrand, setFilterBrand] = useState("all");
  const [filterSeason, setFilterSeason] = useState("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedMilestoneForCalendar, setSelectedMilestoneForCalendar] = useState<any>(null);

  // Load from Supabase
  useEffect(() => {
    async function loadAll() {
      const [projs, miles] = await Promise.all([
        sbGetRows("tanda_projects"),
        sbGetRows("tanda_milestones"),
      ]);
      if (projs?.length) setProjects(projs);
      if (miles?.length) setMilestones(miles);
      setLoaded(true);
    }
    loadAll();
  }, []);

  async function saveProject(p: TandAProject) {
    setProjects(ps => ps.find(x => x.id === p.id) ? ps.map(x => x.id === p.id ? p : x) : [...ps, p]);
    await sbUpsertRow("tanda_projects", p.id, p);
  }
  async function deleteProject(id: string) {
    setProjects(ps => ps.filter(p => p.id !== id));
    setMilestones(ms => ms.filter(m => m.projectId !== id));
    await sbDeleteRow("tanda_projects", id);
    const toDelete = milestones.filter(m => m.projectId === id);
    await Promise.all(toDelete.map(m => sbDeleteRow("tanda_milestones", m.id)));
  }
  async function saveMilestone(m: TandAMilestone) {
    setMilestones(ms => ms.find(x => x.id === m.id) ? ms.map(x => x.id === m.id ? m : x) : [...ms, m]);
    await sbUpsertRow("tanda_milestones", m.id, m);
  }
  async function deleteMilestone(id: string) {
    setMilestones(ms => ms.filter(m => m.id !== id));
    await sbDeleteRow("tanda_milestones", id);
  }

  if (!user) return <Login onLogin={setUser} />;
  if (!loaded) return (
    <div style={{ minHeight: "100vh", background: `linear-gradient(135deg,${TH.header},${TH.bg})`, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ color: "#fff", fontSize: 16, fontWeight: 600 }}>Loading T&A Calendar…</div>
    </div>
  );

  // Filtered projects
  const allBrands = [...new Set(projects.map(p => p.brand).filter(Boolean))];
  const allSeasons = [...new Set(projects.map(p => `${p.season} ${p.year}`).filter(Boolean))];
  const filteredProjects = projects.filter(p => {
    if (filterBrand !== "all" && p.brand !== filterBrand) return false;
    if (filterSeason !== "all" && `${p.season} ${p.year}` !== filterSeason) return false;
    if (searchTerm && !p.name.toLowerCase().includes(searchTerm.toLowerCase()) && !p.brand?.toLowerCase().includes(searchTerm.toLowerCase()) && !p.vendor?.toLowerCase().includes(searchTerm.toLowerCase())) return false;
    return true;
  });

  // Stats
  const totalProjects = projects.length;
  const totalMilestones = milestones.length;
  const delayedMilestones = milestones.filter(m => m.status === "Delayed" || (getDaysUntil(m.dueDate) < 0 && m.status !== "Complete" && m.status !== "Cancelled" && m.status !== "Approved")).length;
  const dueSoon = milestones.filter(m => { const d = getDaysUntil(m.dueDate); return d >= 0 && d <= 7 && m.status !== "Complete" && m.status !== "Cancelled" && m.status !== "Approved"; }).length;
  const isAdmin = user.role === "admin";

  return (
    <div style={{ minHeight: "100vh", background: TH.bg, fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
      {/* NAV */}
      <div style={{ background: TH.header, padding: "0 24px", height: 56, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, boxShadow: `0 2px 8px ${TH.shadowMd}`, position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontSize: 14, fontWeight: 900, color: TH.primary, letterSpacing: "-0.5px", lineHeight: 1 }}>ROF</span>
            <span style={{ fontSize: 9, color: "rgba(255,255,255,0.5)", letterSpacing: "0.1em", textTransform: "uppercase", lineHeight: 1 }}>T&A</span>
          </div>
          <div style={{ width: 1, height: 24, background: "rgba(255,255,255,0.2)" }} />
          <span style={{ fontSize: 13, fontWeight: 700, color: "rgba(255,255,255,0.85)" }}>Time & Action Calendar</span>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {([["dashboard","Dashboard"],["calendar","Calendar"]] as [string,string][]).map(([id, label]) => {
            const isActive = view === id && !selectedProject;
            return (
              <button key={id} onClick={() => { setView(id as any); setSelectedProject(null); }} style={{
                padding: "7px 12px", borderRadius: 8, border: `1px solid ${isActive ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.15)"}`,
                cursor: "pointer", background: isActive ? `linear-gradient(135deg,${TH.primary},${TH.primaryLt})` : "none",
                color: isActive ? "#fff" : "rgba(255,255,255,0.7)", fontWeight: isActive ? 700 : 600, fontFamily: "inherit", fontSize: 12,
              }}>{label}</button>
            );
          })}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 12, color: "rgba(255,255,255,0.6)" }}>{user.name}</span>
          <button onClick={() => { setUser(null); setSelectedProject(null); }} style={{ padding: "5px 12px", borderRadius: 7, border: "1px solid rgba(255,255,255,0.2)", background: "none", color: "rgba(255,255,255,0.6)", cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>Sign Out</button>
        </div>
      </div>

      {/* MAIN CONTENT */}
      <div style={{ padding: "24px", maxWidth: 1400, margin: "0 auto" }}>
        {/* Project Detail */}
        {selectedProject && (
          <ProjectDetail
            project={selectedProject}
            milestones={milestones}
            allMilestones={milestones}
            currentUser={user.name}
            onEditProject={() => setEditingProject(selectedProject)}
            onDeleteProject={() => { if (window.confirm("Delete this project and all its milestones?")) { deleteProject(selectedProject.id); setSelectedProject(null); } }}
            onAddMilestone={saveMilestone}
            onEditMilestone={saveMilestone}
            onDeleteMilestone={deleteMilestone}
            onBack={() => setSelectedProject(null)}
          />
        )}

        {/* Dashboard */}
        {!selectedProject && view === "dashboard" && (
          <div>
            {/* Stats row */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16, marginBottom: 24 }}>
              {[
                { label: "Projects", value: totalProjects, color: TH.primary, icon: "📁" },
                { label: "Milestones", value: totalMilestones, color: "#047857", icon: "🎯" },
                { label: "Overdue / Delayed", value: delayedMilestones, color: "#B91C1C", icon: "⚠️" },
                { label: "Due This Week", value: dueSoon, color: "#B45309", icon: "⏰" },
              ].map(stat => (
                <div key={stat.label} style={{ ...S.card, padding: "16px 20px" }}>
                  <div style={{ fontSize: 22, marginBottom: 4 }}>{stat.icon}</div>
                  <div style={{ fontSize: 26, fontWeight: 800, color: stat.color }}>{stat.value}</div>
                  <div style={{ fontSize: 11, color: TH.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em" }}>{stat.label}</div>
                </div>
              ))}
            </div>
            {/* Toolbar */}
            <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap", alignItems: "center" }}>
              <input style={{ ...S.inp, marginBottom: 0, width: 220 }} placeholder="Search projects…" value={searchTerm} onChange={e => setSearchTerm(e.target.value)} />
              {allBrands.length > 0 && (
                <select style={{ ...S.inp, marginBottom: 0, width: 160 }} value={filterBrand} onChange={e => setFilterBrand(e.target.value)}>
                  <option value="all">All Brands</option>
                  {allBrands.map(b => <option key={b} value={b}>{b}</option>)}
                </select>
              )}
              {allSeasons.length > 0 && (
                <select style={{ ...S.inp, marginBottom: 0, width: 160 }} value={filterSeason} onChange={e => setFilterSeason(e.target.value)}>
                  <option value="all">All Seasons</option>
                  {allSeasons.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              )}
              <div style={{ flex: 1 }} />
              <button onClick={() => setEditingProject("new")} style={S.btn}>+ New Project</button>
            </div>
            {/* Project grid */}
            {filteredProjects.length === 0 ? (
              <div style={{ ...S.card, textAlign: "center", padding: 60, color: TH.textMuted }}>
                <div style={{ fontSize: 40, marginBottom: 12 }}>📋</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: TH.text, marginBottom: 8 }}>No projects yet</div>
                <div style={{ fontSize: 13, marginBottom: 20 }}>Create your first T&A project to start tracking milestones.</div>
                <button onClick={() => setEditingProject("new")} style={S.btn}>+ New Project</button>
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: 20 }}>
                {filteredProjects.map(p => (
                  <ProjectCard key={p.id} project={p} milestones={milestones} onClick={() => setSelectedProject(p)} />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Calendar */}
        {!selectedProject && view === "calendar" && (
          <div>
            <AllMilestonesCalendar
              milestones={milestones}
              projects={projects}
              onMilestoneClick={(m: any) => setSelectedMilestoneForCalendar(m)}
            />
            {selectedMilestoneForCalendar && (
              <MilestoneDetail
                milestone={selectedMilestoneForCalendar}
                project={projects.find(p => p.id === selectedMilestoneForCalendar.projectId)}
                allMilestones={milestones}
                currentUser={user.name}
                onSave={(updated: any) => { saveMilestone(updated); setSelectedMilestoneForCalendar(updated); }}
                onDelete={(id: string) => { deleteMilestone(id); setSelectedMilestoneForCalendar(null); }}
                onClose={() => setSelectedMilestoneForCalendar(null)}
              />
            )}
          </div>
        )}
      </div>

      {/* Project Edit Modal */}
      {editingProject && (
        <Modal title={editingProject === "new" ? "New Project" : "Edit Project"} onClose={() => setEditingProject(null)} wide>
          <ProjectForm
            project={editingProject === "new" ? null : editingProject}
            onSave={(p) => { saveProject(p); setEditingProject(null); if (editingProject !== "new") setSelectedProject(p); }}
            onCancel={() => setEditingProject(null)}
          />
        </Modal>
      )}
    </div>
  );
}

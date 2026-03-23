import { useState, useEffect, useRef, useCallback } from "react";

// ── Supabase ─────────────────────────────────────────────────────────────────
const SB_URL = "https://qcvqvxxoperiurauoxmp.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFjdnF2eHhvcGVyaXVyYXVveG1wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2ODU4MjksImV4cCI6MjA4OTI2MTgyOX0.YoBmIdlqqPYt9roTsDPGSBegNnoupCYSsnyCHMo24Zw";
const SB_HEADERS: Record<string, string> = { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`, "Content-Type": "application/json", "Prefer": "return=representation" };

// ── Supabase helpers ──────────────────────────────────────────────────────────
const sb = {
  from: (table: string) => ({
    select: async (cols = "*", filter = "") => {
      const res = await fetch(`${SB_URL}/rest/v1/${table}?select=${cols}${filter ? "&" + filter : ""}`, { headers: SB_HEADERS });
      const data = await res.json();
      return { data, error: res.ok ? null : data };
    },
    upsert: async (rows: any) => {
      const body = Array.isArray(rows) ? rows : [rows];
      const res = await fetch(`${SB_URL}/rest/v1/${table}`, { method: "POST", headers: { ...SB_HEADERS, "Prefer": "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(body) });
      const data = await res.json();
      return { data, error: res.ok ? null : data };
    },
    delete: async (filter: string) => {
      const res = await fetch(`${SB_URL}/rest/v1/${table}?${filter}`, { method: "DELETE", headers: SB_HEADERS });
      return { error: res.ok ? null : await res.json() };
    },
  }),
};

// ── Types ─────────────────────────────────────────────────────────────────────
interface User { name?: string; username?: string; avatar?: string; color?: string; initials?: string; role?: string; }

interface Measurement { id: string; pointOfMeasure: string; tolerance: string; sizes: Record<string, string>; }
interface ConstructionDetail { id: string; area: string; detail: string; notes: string; }
interface BOMItem { id: string; material: string; supplier: string; color: string; placement: string; quantity: string; unitCost: number; totalCost: number; notes: string; }
interface Costing { fob: number; duty: number; dutyRate: number; freight: number; insurance: number; otherCosts: number; landedCost: number; wholesalePrice: number; retailPrice: number; margin: number; notes: string; }
interface Approval { id: string; stage: string; approver: string; status: "Pending" | "Approved" | "Rejected" | "Revision Required"; date: string | null; comments: string; }
interface Sample { id: string; type: "Proto" | "SMS" | "PP" | "TOP" | "Production"; status: "Requested" | "In Progress" | "Received" | "Approved" | "Rejected"; requestDate: string; receiveDate: string | null; vendor: string; comments: string; images: string[]; }
interface TPImage { id: string; url: string; name: string; type: string; }

interface TechPack {
  id: string; styleName: string; styleNumber: string; brand: string; season: string; category: string; description: string; designer: string;
  status: "Draft" | "In Review" | "Approved" | "Revised";
  createdAt: string; updatedAt: string; updatedBy: string;
  measurements: Measurement[]; construction: ConstructionDetail[]; bom: BOMItem[];
  costing: Costing; approvals: Approval[]; samples: Sample[]; images: TPImage[];
}

interface Material {
  id: string; name: string; type: string; composition: string; weight: string; width: string; color: string;
  supplier: string; unitPrice: number; moq: string; leadTime: string; certifications: string[]; notes: string; createdAt: string;
}

type View = "dashboard" | "list" | "detail" | "materials" | "samples";
type DetailTab = "spec" | "construction" | "bom" | "costing" | "approvals" | "samples" | "images";

// ── Helpers ───────────────────────────────────────────────────────────────────
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const today = () => new Date().toISOString().split("T")[0];
const fmtDate = (d: string | null) => { if (!d) return "—"; try { const dt = new Date(d); return dt.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" }); } catch { return d; } };
const fmtCurrency = (n: number) => "$" + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const STATUSES: TechPack["status"][] = ["Draft", "In Review", "Approved", "Revised"];
const STATUS_COLORS: Record<string, string> = { Draft: "#6B7280", "In Review": "#F59E0B", Approved: "#10B981", Revised: "#8B5CF6" };
const APPROVAL_STAGES = ["Design", "Merchandising", "Buying", "Production", "Quality"];
const APPROVAL_STATUS_COLORS: Record<string, string> = { Pending: "#6B7280", Approved: "#10B981", Rejected: "#EF4444", "Revision Required": "#F59E0B" };
const SAMPLE_TYPES: Sample["type"][] = ["Proto", "SMS", "PP", "TOP", "Production"];
const SAMPLE_STATUS_COLORS: Record<string, string> = { Requested: "#6B7280", "In Progress": "#3B82F6", Received: "#F59E0B", Approved: "#10B981", Rejected: "#EF4444" };
const MATERIAL_TYPES = ["Fabric", "Trim", "Label", "Thread", "Zipper", "Button", "Elastic", "Interlining", "Packaging", "Other"];
const CATEGORIES = ["Tops", "Bottoms", "Dresses", "Outerwear", "Activewear", "Swimwear", "Accessories", "Other"];
const SEASONS = ["Spring 2025", "Summer 2025", "Fall 2025", "Winter 2025", "Spring 2026", "Summer 2026", "Fall 2026", "Winter 2026", "Resort 2025", "Resort 2026"];
const DEFAULT_SIZES = ["XS", "S", "M", "L", "XL", "XXL"];

function emptyCosting(): Costing {
  return { fob: 0, duty: 0, dutyRate: 0, freight: 0, insurance: 0, otherCosts: 0, landedCost: 0, wholesalePrice: 0, retailPrice: 0, margin: 0, notes: "" };
}

function emptyApprovals(): Approval[] {
  return APPROVAL_STAGES.map(stage => ({ id: uid(), stage, approver: "", status: "Pending" as const, date: null, comments: "" }));
}

function emptyTechPack(user: User): TechPack {
  return {
    id: uid(), styleName: "", styleNumber: "", brand: "", season: "", category: "", description: "", designer: user.name || user.username || "",
    status: "Draft", createdAt: today(), updatedAt: today(), updatedBy: user.name || user.username || "",
    measurements: [], construction: [], bom: [], costing: emptyCosting(), approvals: emptyApprovals(), samples: [], images: [],
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ══════════════════════════════════════════════════════════════════════════════
export default function TechPackApp() {
  // ── User session ──────────────────────────────────────────────────────────
  const [user, setUser] = useState<User | null>(null);
  useEffect(() => {
    try { const saved = sessionStorage.getItem("plm_user"); if (saved) setUser(JSON.parse(saved)); } catch {}
  }, []);

  // ── State ─────────────────────────────────────────────────────────────────
  const [view, setView] = useState<View>("dashboard");
  const [techPacks, setTechPacks] = useState<TechPack[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [selected, setSelected] = useState<TechPack | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>("spec");
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [filterBrand, setFilterBrand] = useState("");
  const [filterSeason, setFilterSeason] = useState("");
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showMaterialModal, setShowMaterialModal] = useState(false);
  const [editingMaterial, setEditingMaterial] = useState<Material | null>(null);
  const [lightboxImg, setLightboxImg] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [matSearch, setMatSearch] = useState("");
  const [matTypeFilter, setMatTypeFilter] = useState("");
  const [newSize, setNewSize] = useState("");
  const [showAddSize, setShowAddSize] = useState(false);

  // ── Create form state ─────────────────────────────────────────────────────
  const [createForm, setCreateForm] = useState({ styleName: "", styleNumber: "", brand: "", season: "", category: "", description: "", designer: "" });

  // ── Material form state ───────────────────────────────────────────────────
  const [matForm, setMatForm] = useState({ name: "", type: "Fabric", composition: "", weight: "", width: "", color: "", supplier: "", unitPrice: 0, moq: "", leadTime: "", certifications: "", notes: "" });

  // ── Toast helper ──────────────────────────────────────────────────────────
  const showToast = useCallback((msg: string) => { setToast(msg); setTimeout(() => setToast(""), 3000); }, []);

  // ── Load data ─────────────────────────────────────────────────────────────
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [tpRes, matRes] = await Promise.all([
        sb.from("techpacks").select(),
        sb.from("app_data").select("*", "key=eq.techpack_materials"),
      ]);
      if (tpRes.data && Array.isArray(tpRes.data)) {
        const packs = tpRes.data.map((row: any) => {
          if (row.data && typeof row.data === "string") try { return JSON.parse(row.data); } catch { return row.data; }
          return row.data || row;
        }).filter(Boolean);
        setTechPacks(packs);
      }
      if (matRes.data && Array.isArray(matRes.data) && matRes.data.length > 0 && matRes.data[0].value) {
        try { setMaterials(JSON.parse(matRes.data[0].value)); } catch {}
      }
    } catch (e) { console.error("Load error:", e); }
    setLoading(false);
  }, []);

  useEffect(() => { if (user) loadData(); }, [user, loadData]);

  // ── Save tech pack ────────────────────────────────────────────────────────
  const saveTechPack = useCallback(async (tp: TechPack) => {
    tp.updatedAt = today();
    tp.updatedBy = user?.name || user?.username || "";
    const { error } = await sb.from("techpacks").upsert({ id: tp.id, data: tp });
    if (error) { console.error("Save error:", error); showToast("Save failed!"); }
    else { showToast("Saved"); }
    setTechPacks(prev => { const idx = prev.findIndex(p => p.id === tp.id); if (idx >= 0) { const n = [...prev]; n[idx] = tp; return n; } return [...prev, tp]; });
  }, [user, showToast]);

  // ── Debounced auto-save ───────────────────────────────────────────────────
  const autoSave = useCallback((tp: TechPack) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => saveTechPack(tp), 1500);
    setSelected({ ...tp });
    setTechPacks(prev => { const idx = prev.findIndex(p => p.id === tp.id); if (idx >= 0) { const n = [...prev]; n[idx] = tp; return n; } return [...prev, tp]; });
  }, [saveTechPack]);

  // ── Save materials ────────────────────────────────────────────────────────
  const saveMaterials = useCallback(async (mats: Material[]) => {
    setMaterials(mats);
    await sb.from("app_data").upsert({ key: "techpack_materials", value: JSON.stringify(mats) });
    showToast("Materials saved");
  }, [showToast]);

  // ── Delete tech pack ──────────────────────────────────────────────────────
  const deleteTechPack = useCallback(async (id: string) => {
    await sb.from("techpacks").delete(`id=eq.${id}`);
    setTechPacks(prev => prev.filter(p => p.id !== id));
    if (selected?.id === id) { setSelected(null); setView("list"); }
    showToast("Tech pack deleted");
  }, [selected, showToast]);

  // ── Create tech pack ──────────────────────────────────────────────────────
  const handleCreate = useCallback(async () => {
    if (!createForm.styleName || !createForm.styleNumber) return;
    const tp = emptyTechPack(user!);
    Object.assign(tp, createForm);
    tp.designer = createForm.designer || user?.name || user?.username || "";
    await saveTechPack(tp);
    setShowCreateModal(false);
    setCreateForm({ styleName: "", styleNumber: "", brand: "", season: "", category: "", description: "", designer: "" });
    setSelected(tp);
    setDetailTab("spec");
    setView("detail");
  }, [createForm, user, saveTechPack]);

  // ── Save / edit material ──────────────────────────────────────────────────
  const handleSaveMaterial = useCallback(async () => {
    if (!matForm.name) return;
    const mat: Material = {
      id: editingMaterial?.id || uid(),
      name: matForm.name, type: matForm.type, composition: matForm.composition, weight: matForm.weight,
      width: matForm.width, color: matForm.color, supplier: matForm.supplier, unitPrice: matForm.unitPrice,
      moq: matForm.moq, leadTime: matForm.leadTime, certifications: matForm.certifications.split(",").map(s => s.trim()).filter(Boolean),
      notes: matForm.notes, createdAt: editingMaterial?.createdAt || today(),
    };
    const updated = editingMaterial ? materials.map(m => m.id === mat.id ? mat : m) : [...materials, mat];
    await saveMaterials(updated);
    setShowMaterialModal(false);
    setEditingMaterial(null);
    setMatForm({ name: "", type: "Fabric", composition: "", weight: "", width: "", color: "", supplier: "", unitPrice: 0, moq: "", leadTime: "", certifications: "", notes: "" });
  }, [matForm, editingMaterial, materials, saveMaterials]);

  // ── Image upload via Dropbox proxy ────────────────────────────────────────
  const uploadImage = useCallback(async (file: File, path: string): Promise<string | null> => {
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("path", path);
      const res = await fetch("/api/dropbox-proxy", { method: "POST", body: formData });
      if (!res.ok) return null;
      const json = await res.json();
      return json.url || json.link || null;
    } catch { return null; }
  }, []);

  // ── Not logged in ─────────────────────────────────────────────────────────
  if (!user) {
    return (
      <div style={S.app}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", flexDirection: "column", gap: 16 }}>
          <div style={{ fontSize: 48 }}>📐</div>
          <p style={{ color: "#F1F5F9", fontSize: 18 }}>Please log in from the PLM launcher</p>
          <a href="/" style={{ color: "#3B82F6", fontSize: 14, textDecoration: "underline" }}>Go to PLM Launcher</a>
        </div>
      </div>
    );
  }

  // ── Filters ───────────────────────────────────────────────────────────────
  const brands = [...new Set(techPacks.map(t => t.brand).filter(Boolean))].sort();
  const seasons = [...new Set(techPacks.map(t => t.season).filter(Boolean))].sort();

  const filtered = techPacks.filter(tp => {
    if (filterStatus && tp.status !== filterStatus) return false;
    if (filterBrand && tp.brand !== filterBrand) return false;
    if (filterSeason && tp.season !== filterSeason) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!tp.styleName.toLowerCase().includes(q) && !tp.styleNumber.toLowerCase().includes(q) && !tp.brand.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  // ── Dashboard stats ───────────────────────────────────────────────────────
  const statTotal = techPacks.length;
  const statDraft = techPacks.filter(t => t.status === "Draft").length;
  const statReview = techPacks.filter(t => t.status === "In Review").length;
  const statApproved = techPacks.filter(t => t.status === "Approved").length;

  // All samples across all tech packs
  const allSamples = techPacks.flatMap(tp => tp.samples.map(s => ({ ...s, styleNumber: tp.styleNumber, styleName: tp.styleName })));

  // ── Helpers for detail ────────────────────────────────────────────────────
  const updateSelected = (changes: Partial<TechPack>) => {
    if (!selected) return;
    const updated = { ...selected, ...changes };
    autoSave(updated);
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={S.app}>
      {/* NAV */}
      <nav style={S.nav}>
        <div style={S.navLeft}>
          <div style={S.navLogo}>📐</div>
          <span style={S.navTitle}>Tech Packs</span>
          <span style={S.navSub}>Product Specs & BOM</span>
        </div>
        <div style={S.navRight}>
          <button style={view === "dashboard" ? S.navBtnActive : S.navBtn} onClick={() => { setSelected(null); setView("dashboard"); }}>Dashboard</button>
          <button style={view === "list" ? S.navBtnActive : S.navBtn} onClick={() => { setSelected(null); setView("list"); }}>All Packs</button>
          <button style={view === "materials" ? S.navBtnActive : S.navBtn} onClick={() => { setSelected(null); setView("materials"); }}>Materials</button>
          <button style={view === "samples" ? S.navBtnActive : S.navBtn} onClick={() => { setSelected(null); setView("samples"); }}>Samples</button>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: 8 }}>
            {user.avatar ? (
              <img src={user.avatar} alt={user.name || ""} style={{ width: 28, height: 28, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />
            ) : (
              <div style={{ width: 28, height: 28, borderRadius: "50%", background: user.color ?? "#3B82F6", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 11, fontWeight: 700, flexShrink: 0 }}>
                {user.initials || (user.name || user.username || "?").split(" ").map((w: string) => w[0]).join("").toUpperCase().slice(0, 2)}
              </div>
            )}
            <span style={{ color: "#94A3B8", fontSize: 12, fontWeight: 600 }}>{user.name || user.username}</span>
          </div>
          <button style={S.navBtn} onClick={() => window.location.href = "/"}>← PLM</button>
          <button style={S.navBtnDanger} onClick={() => { sessionStorage.removeItem("plm_user"); window.location.href = "/"; }}>Sign Out</button>
        </div>
      </nav>

      {/* TOAST */}
      {toast && (
        <div style={{ position: "fixed", top: 70, right: 24, background: "#10B981", color: "#fff", padding: "10px 20px", borderRadius: 8, fontSize: 14, fontWeight: 600, zIndex: 999, boxShadow: "0 4px 12px rgba(0,0,0,0.3)" }}>
          {toast}
        </div>
      )}

      <div style={S.content}>
        {loading ? (
          <div style={{ textAlign: "center", padding: 60, color: "#6B7280" }}>Loading tech packs...</div>
        ) : (
          <>
            {/* ═══════════ DASHBOARD ═══════════ */}
            {view === "dashboard" && (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
                  <h2 style={{ margin: 0, color: "#F1F5F9", fontSize: 22 }}>Dashboard</h2>
                  <button style={S.btnPrimarySmall} onClick={() => { setCreateForm({ styleName: "", styleNumber: "", brand: "", season: "", category: "", description: "", designer: user.name || user.username || "" }); setShowCreateModal(true); }}>+ New Tech Pack</button>
                </div>

                {/* Stat Cards */}
                <div style={S.statsRow}>
                  {renderStatCard("Total Packs", statTotal, "#3B82F6", "📦")}
                  {renderStatCard("Draft", statDraft, "#6B7280", "📝")}
                  {renderStatCard("In Review", statReview, "#F59E0B", "🔍")}
                  {renderStatCard("Approved", statApproved, "#10B981", "✅")}
                </div>

                {/* Recent Tech Packs */}
                <div style={S.card}>
                  <h3 style={S.cardTitle}>Recent Tech Packs</h3>
                  {techPacks.length === 0 ? (
                    <div style={S.emptyState}>
                      <div style={{ fontSize: 40 }}>📐</div>
                      <p>No tech packs yet. Create your first one!</p>
                    </div>
                  ) : (
                    [...techPacks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5).map(tp => renderTPRow(tp))
                  )}
                </div>

                {/* Approval Summary */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                  <div style={S.card}>
                    <h3 style={S.cardTitle}>Approval Status</h3>
                    {(() => {
                      const allApprovals = techPacks.flatMap(tp => tp.approvals);
                      const pending = allApprovals.filter(a => a.status === "Pending").length;
                      const approved = allApprovals.filter(a => a.status === "Approved").length;
                      const rejected = allApprovals.filter(a => a.status === "Rejected").length;
                      const revision = allApprovals.filter(a => a.status === "Revision Required").length;
                      const total = allApprovals.length || 1;
                      return (
                        <div>
                          {[["Pending", pending, "#6B7280"], ["Approved", approved, "#10B981"], ["Rejected", rejected, "#EF4444"], ["Revision Required", revision, "#F59E0B"]].map(([label, count, color]) => (
                            <div key={label as string} style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
                              <span style={{ color: color as string, fontSize: 13, width: 130, fontWeight: 600 }}>{label}</span>
                              <div style={{ flex: 1, height: 8, background: "#0F172A", borderRadius: 4, overflow: "hidden" }}>
                                <div style={{ width: `${((count as number) / total) * 100}%`, height: "100%", background: color as string, borderRadius: 4 }} />
                              </div>
                              <span style={{ color: "#94A3B8", fontSize: 13, fontFamily: "monospace", width: 30, textAlign: "right" }}>{count as number}</span>
                            </div>
                          ))}
                        </div>
                      );
                    })()}
                  </div>

                  <div style={S.card}>
                    <h3 style={S.cardTitle}>Sample Tracking</h3>
                    {allSamples.length === 0 ? (
                      <div style={{ color: "#6B7280", fontSize: 13, textAlign: "center", padding: 20 }}>No samples tracked yet</div>
                    ) : (
                      <div>
                        {SAMPLE_TYPES.map(type => {
                          const count = allSamples.filter(s => s.type === type).length;
                          const approved = allSamples.filter(s => s.type === type && s.status === "Approved").length;
                          return count > 0 ? (
                            <div key={type} style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
                              <span style={{ color: "#D1D5DB", fontSize: 13, width: 100, fontWeight: 600 }}>{type}</span>
                              <div style={{ flex: 1, height: 6, background: "#0F172A", borderRadius: 3, overflow: "hidden" }}>
                                <div style={{ width: `${(approved / count) * 100}%`, height: "100%", background: "#10B981", borderRadius: 3 }} />
                              </div>
                              <span style={{ color: "#94A3B8", fontSize: 12, fontFamily: "monospace" }}>{approved}/{count}</span>
                            </div>
                          ) : null;
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}

            {/* ═══════════ ALL PACKS LIST ═══════════ */}
            {view === "list" && (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                  <h2 style={{ margin: 0, color: "#F1F5F9", fontSize: 22 }}>All Tech Packs</h2>
                  <button style={S.btnPrimarySmall} onClick={() => { setCreateForm({ styleName: "", styleNumber: "", brand: "", season: "", category: "", description: "", designer: user.name || user.username || "" }); setShowCreateModal(true); }}>+ New Tech Pack</button>
                </div>

                {/* Filters */}
                <div style={S.filters}>
                  <input style={{ ...S.input, maxWidth: 260 }} placeholder="Search style name, number, brand..." value={search} onChange={e => setSearch(e.target.value)} />
                  <select style={S.select} value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
                    <option value="">All Statuses</option>
                    {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <select style={S.select} value={filterBrand} onChange={e => setFilterBrand(e.target.value)}>
                    <option value="">All Brands</option>
                    {brands.map(b => <option key={b} value={b}>{b}</option>)}
                  </select>
                  <select style={S.select} value={filterSeason} onChange={e => setFilterSeason(e.target.value)}>
                    <option value="">All Seasons</option>
                    {seasons.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <span style={{ color: "#6B7280", fontSize: 13 }}>{filtered.length} packs</span>
                </div>

                {/* Grid of cards */}
                {filtered.length === 0 ? (
                  <div style={S.emptyState}>
                    <div style={{ fontSize: 40 }}>📐</div>
                    <p>No tech packs match your filters</p>
                  </div>
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 16 }}>
                    {filtered.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(tp => (
                      <div key={tp.id} style={S.tpCard} onClick={() => { setSelected(tp); setDetailTab("spec"); setView("detail"); }}
                        onMouseEnter={e => e.currentTarget.style.borderColor = "#3B82F6"}
                        onMouseLeave={e => e.currentTarget.style.borderColor = "#334155"}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                          <span style={{ fontFamily: "monospace", color: "#60A5FA", fontWeight: 700, fontSize: 15 }}>{tp.styleNumber || "—"}</span>
                          <span style={{ ...S.badge, background: STATUS_COLORS[tp.status] + "22", color: STATUS_COLORS[tp.status], border: `1px solid ${STATUS_COLORS[tp.status]}44` }}>{tp.status}</span>
                        </div>
                        <div style={{ color: "#F1F5F9", fontWeight: 600, fontSize: 15, marginBottom: 4 }}>{tp.styleName}</div>
                        <div style={{ color: "#94A3B8", fontSize: 13, marginBottom: 8 }}>{tp.brand}{tp.season ? ` · ${tp.season}` : ""}</div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span style={{ color: "#6B7280", fontSize: 12 }}>{tp.category}</span>
                          <span style={{ color: "#6B7280", fontSize: 11 }}>Updated {fmtDate(tp.updatedAt)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {/* ═══════════ MATERIALS LIBRARY ═══════════ */}
            {view === "materials" && renderMaterialsView()}

            {/* ═══════════ SAMPLES OVERVIEW ═══════════ */}
            {view === "samples" && renderSamplesOverview()}
          </>
        )}
      </div>

      {/* ═══════════ DETAIL PANEL ═══════════ */}
      {view === "detail" && selected && renderDetailPanel()}

      {/* ═══════════ CREATE MODAL ═══════════ */}
      {showCreateModal && renderCreateModal()}

      {/* ═══════════ MATERIAL MODAL ═══════════ */}
      {showMaterialModal && renderMaterialModal()}

      {/* ═══════════ LIGHTBOX ═══════════ */}
      {lightboxImg && (
        <div style={S.modalOverlay} onClick={() => setLightboxImg(null)}>
          <div style={{ maxWidth: "90vw", maxHeight: "90vh" }} onClick={e => e.stopPropagation()}>
            <img src={lightboxImg} alt="" style={{ maxWidth: "90vw", maxHeight: "85vh", borderRadius: 12, objectFit: "contain" }} />
            <div style={{ textAlign: "center", marginTop: 12 }}>
              <button style={S.btnSecondary} onClick={() => setLightboxImg(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  // ══════════════════════════════════════════════════════════════════════════
  // SUB-RENDER FUNCTIONS
  // ══════════════════════════════════════════════════════════════════════════

  function renderStatCard(label: string, value: number, color: string, icon: string) {
    return (
      <div style={{ ...S.statCard, borderTop: `3px solid ${color}` }}>
        <div style={{ fontSize: 24 }}>{icon}</div>
        <div style={{ fontSize: 28, fontWeight: 700, color, fontFamily: "monospace" }}>{value}</div>
        <div style={{ color: "#9CA3AF", fontSize: 13 }}>{label}</div>
      </div>
    );
  }

  function renderTPRow(tp: TechPack) {
    return (
      <div key={tp.id} style={S.poRow} onClick={() => { setSelected(tp); setDetailTab("spec"); setView("detail"); }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
            <span style={{ fontFamily: "monospace", color: "#60A5FA", fontWeight: 700, fontSize: 15 }}>{tp.styleNumber || "—"}</span>
            <span style={{ ...S.badge, background: STATUS_COLORS[tp.status] + "22", color: STATUS_COLORS[tp.status], border: `1px solid ${STATUS_COLORS[tp.status]}44` }}>{tp.status}</span>
          </div>
          <div style={{ color: "#D1D5DB", fontWeight: 600 }}>{tp.styleName}</div>
          <div style={{ color: "#6B7280", fontSize: 12, marginTop: 2 }}>{tp.brand}{tp.season ? ` · ${tp.season}` : ""}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ color: "#94A3B8", fontSize: 13 }}>{tp.category}</div>
          <div style={{ color: "#6B7280", fontSize: 12, marginTop: 4 }}>Updated {fmtDate(tp.updatedAt)}</div>
        </div>
      </div>
    );
  }

  // ── Materials View ────────────────────────────────────────────────────────
  function renderMaterialsView() {
    const filteredMats = materials.filter(m => {
      if (matTypeFilter && m.type !== matTypeFilter) return false;
      if (matSearch) {
        const q = matSearch.toLowerCase();
        return m.name.toLowerCase().includes(q) || m.supplier.toLowerCase().includes(q) || m.composition.toLowerCase().includes(q);
      }
      return true;
    });

    return (
      <>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h2 style={{ margin: 0, color: "#F1F5F9", fontSize: 22 }}>Materials Library</h2>
          <button style={S.btnPrimarySmall} onClick={() => {
            setEditingMaterial(null);
            setMatForm({ name: "", type: "Fabric", composition: "", weight: "", width: "", color: "", supplier: "", unitPrice: 0, moq: "", leadTime: "", certifications: "", notes: "" });
            setShowMaterialModal(true);
          }}>+ Add Material</button>
        </div>

        <div style={S.filters}>
          <input style={{ ...S.input, maxWidth: 300 }} placeholder="Search materials..." value={matSearch} onChange={e => setMatSearch(e.target.value)} />
          <select style={S.select} value={matTypeFilter} onChange={e => setMatTypeFilter(e.target.value)}>
            <option value="">All Types</option>
            {MATERIAL_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <span style={{ color: "#6B7280", fontSize: 13 }}>{filteredMats.length} materials</span>
        </div>

        {filteredMats.length === 0 ? (
          <div style={S.emptyState}>
            <div style={{ fontSize: 40 }}>🧵</div>
            <p>No materials found. Add your first material!</p>
          </div>
        ) : (
          <div style={S.tableWrap}>
            <div style={S.tableHeader}>
              <span style={{ flex: 2 }}>Name</span>
              <span style={{ flex: 1 }}>Type</span>
              <span style={{ flex: 2 }}>Composition</span>
              <span style={{ flex: 1 }}>Weight</span>
              <span style={{ flex: 1 }}>Supplier</span>
              <span style={{ flex: 1 }}>Price</span>
              <span style={{ flex: 1 }}>Certs</span>
              <span style={{ width: 60 }}>Actions</span>
            </div>
            {filteredMats.map((m, i) => (
              <div key={m.id} style={{ ...S.tableRow, background: i % 2 === 0 ? "#0F172A" : "#1A2332" }}>
                <span style={{ flex: 2, color: "#60A5FA", fontWeight: 600 }}>{m.name}</span>
                <span style={{ flex: 1, color: "#94A3B8" }}>{m.type}</span>
                <span style={{ flex: 2, color: "#D1D5DB" }}>{m.composition}</span>
                <span style={{ flex: 1, color: "#94A3B8" }}>{m.weight}</span>
                <span style={{ flex: 1, color: "#94A3B8" }}>{m.supplier}</span>
                <span style={{ flex: 1, color: "#10B981", fontWeight: 600 }}>{fmtCurrency(m.unitPrice)}</span>
                <span style={{ flex: 1 }}>
                  {m.certifications.map(c => <span key={c} style={{ ...S.badge, background: "#10B98122", color: "#10B981", border: "1px solid #10B98144", marginRight: 4 }}>{c}</span>)}
                </span>
                <span style={{ width: 60, display: "flex", gap: 4 }}>
                  <button style={S.iconBtn} onClick={() => {
                    setEditingMaterial(m);
                    setMatForm({ name: m.name, type: m.type, composition: m.composition, weight: m.weight, width: m.width, color: m.color, supplier: m.supplier, unitPrice: m.unitPrice, moq: m.moq, leadTime: m.leadTime, certifications: m.certifications.join(", "), notes: m.notes });
                    setShowMaterialModal(true);
                  }}>✏️</button>
                  <button style={S.iconBtn} onClick={() => { if (confirm("Delete this material?")) saveMaterials(materials.filter(x => x.id !== m.id)); }}>🗑️</button>
                </span>
              </div>
            ))}
          </div>
        )}
      </>
    );
  }

  // ── Samples Overview ──────────────────────────────────────────────────────
  function renderSamplesOverview() {
    return (
      <>
        <h2 style={{ margin: "0 0 16px", color: "#F1F5F9", fontSize: 22 }}>All Samples</h2>
        {allSamples.length === 0 ? (
          <div style={S.emptyState}>
            <div style={{ fontSize: 40 }}>🧪</div>
            <p>No samples tracked across any tech packs</p>
          </div>
        ) : (
          <div style={S.tableWrap}>
            <div style={S.tableHeader}>
              <span style={{ flex: 1 }}>Style #</span>
              <span style={{ flex: 2 }}>Style Name</span>
              <span style={{ flex: 1 }}>Type</span>
              <span style={{ flex: 1 }}>Status</span>
              <span style={{ flex: 1 }}>Vendor</span>
              <span style={{ flex: 1 }}>Requested</span>
              <span style={{ flex: 1 }}>Received</span>
            </div>
            {allSamples.map((s, i) => (
              <div key={s.id} style={{ ...S.tableRow, background: i % 2 === 0 ? "#0F172A" : "#1A2332" }}>
                <span style={{ flex: 1, color: "#60A5FA", fontFamily: "monospace", fontWeight: 600 }}>{(s as any).styleNumber}</span>
                <span style={{ flex: 2, color: "#D1D5DB" }}>{(s as any).styleName}</span>
                <span style={{ flex: 1 }}>
                  <span style={{ ...S.badge, background: "#3B82F622", color: "#3B82F6", border: "1px solid #3B82F644" }}>{s.type}</span>
                </span>
                <span style={{ flex: 1 }}>
                  <span style={{ ...S.badge, background: (SAMPLE_STATUS_COLORS[s.status] || "#6B7280") + "22", color: SAMPLE_STATUS_COLORS[s.status] || "#6B7280", border: `1px solid ${SAMPLE_STATUS_COLORS[s.status] || "#6B7280"}44` }}>{s.status}</span>
                </span>
                <span style={{ flex: 1, color: "#94A3B8" }}>{s.vendor}</span>
                <span style={{ flex: 1, color: "#94A3B8", fontSize: 12 }}>{fmtDate(s.requestDate)}</span>
                <span style={{ flex: 1, color: "#94A3B8", fontSize: 12 }}>{fmtDate(s.receiveDate)}</span>
              </div>
            ))}
          </div>
        )}
      </>
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DETAIL PANEL
  // ══════════════════════════════════════════════════════════════════════════
  function renderDetailPanel() {
    if (!selected) return null;
    const tp = selected;

    return (
      <div style={S.detailOverlay} onClick={() => { setSelected(null); setView("list"); }}>
        <div style={S.detailPanel} onClick={e => e.stopPropagation()}>
          {/* Header */}
          <div style={S.detailHeader}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={S.detailPONum}>{tp.styleNumber || "—"}</span>
                <span style={{ ...S.badge, background: STATUS_COLORS[tp.status] + "22", color: STATUS_COLORS[tp.status], border: `1px solid ${STATUS_COLORS[tp.status]}44`, fontSize: 13 }}>{tp.status}</span>
              </div>
              <div style={S.detailVendor}>{tp.styleName}</div>
              <div style={{ color: "#6B7280", fontSize: 13, marginTop: 4 }}>{tp.brand}{tp.season ? ` · ${tp.season}` : ""}{tp.category ? ` · ${tp.category}` : ""}</div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
              <select style={{ ...S.select, fontSize: 12 }} value={tp.status} onChange={e => updateSelected({ status: e.target.value as TechPack["status"] })}>
                {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <button style={{ ...S.iconBtn, color: "#EF4444", fontSize: 14 }} onClick={() => { if (confirm("Delete this tech pack?")) deleteTechPack(tp.id); }}>🗑️</button>
              <button style={S.closeBtn} onClick={() => { setSelected(null); setView("list"); }}>✕</button>
            </div>
          </div>

          {/* Info Grid */}
          <div style={{ padding: "16px 24px 0" }}>
            <div style={S.infoGrid}>
              <div style={S.infoCell}><div style={S.infoCellLabel}>Designer</div><div style={S.infoCellValue}>{tp.designer || "—"}</div></div>
              <div style={S.infoCell}><div style={S.infoCellLabel}>Created</div><div style={S.infoCellValue}>{fmtDate(tp.createdAt)}</div></div>
              <div style={S.infoCell}><div style={S.infoCellLabel}>Updated</div><div style={S.infoCellValue}>{fmtDate(tp.updatedAt)}</div></div>
            </div>
            {tp.description && (
              <div style={{ background: "#0F172A", borderRadius: 8, padding: 12, marginBottom: 12, color: "#94A3B8", fontSize: 13 }}>{tp.description}</div>
            )}
          </div>

          {/* Tabs */}
          <div style={{ display: "flex", gap: 0, padding: "0 24px", borderBottom: "1px solid #334155" }}>
            {([["spec", "Spec Sheet"], ["construction", "Construction"], ["bom", "BOM"], ["costing", "Costing"], ["approvals", "Approvals"], ["samples", "Samples"], ["images", "Images"]] as [DetailTab, string][]).map(([key, label]) => (
              <button key={key} onClick={() => setDetailTab(key)}
                style={{ padding: "10px 16px", background: "none", border: "none", borderBottom: detailTab === key ? "2px solid #3B82F6" : "2px solid transparent", color: detailTab === key ? "#60A5FA" : "#6B7280", fontSize: 13, fontWeight: detailTab === key ? 700 : 500, cursor: "pointer", fontFamily: "inherit" }}>
                {label}
              </button>
            ))}
          </div>

          {/* Tab Content */}
          <div style={{ padding: 24, flex: 1, overflowY: "auto" }}>
            {detailTab === "spec" && renderSpecTab(tp)}
            {detailTab === "construction" && renderConstructionTab(tp)}
            {detailTab === "bom" && renderBOMTab(tp)}
            {detailTab === "costing" && renderCostingTab(tp)}
            {detailTab === "approvals" && renderApprovalsTab(tp)}
            {detailTab === "samples" && renderSamplesTab(tp)}
            {detailTab === "images" && renderImagesTab(tp)}
          </div>
        </div>
      </div>
    );
  }

  // ── Spec Sheet Tab ────────────────────────────────────────────────────────
  function renderSpecTab(tp: TechPack) {
    const sizes = tp.measurements.length > 0 ? Object.keys(tp.measurements[0].sizes) : [...DEFAULT_SIZES];

    return (
      <>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h3 style={{ margin: 0, color: "#F1F5F9", fontSize: 16 }}>Measurements</h3>
          <div style={{ display: "flex", gap: 8 }}>
            {showAddSize ? (
              <>
                <input style={{ ...S.input, width: 80, padding: "4px 8px", fontSize: 12 }} placeholder="Size" value={newSize} onChange={e => setNewSize(e.target.value)} />
                <button style={S.btnSmall} onClick={() => {
                  if (!newSize.trim()) return;
                  const updated = tp.measurements.map(m => ({ ...m, sizes: { ...m.sizes, [newSize.trim()]: "" } }));
                  updateSelected({ measurements: updated });
                  setNewSize("");
                  setShowAddSize(false);
                }}>Add</button>
                <button style={{ ...S.btnSmall, background: "none", color: "#6B7280" }} onClick={() => setShowAddSize(false)}>Cancel</button>
              </>
            ) : (
              <button style={S.btnSmall} onClick={() => setShowAddSize(true)}>+ Size Column</button>
            )}
            <button style={S.btnSmall} onClick={() => {
              const sizeObj: Record<string, string> = {};
              sizes.forEach(s => sizeObj[s] = "");
              updateSelected({ measurements: [...tp.measurements, { id: uid(), pointOfMeasure: "", tolerance: "±0.5", sizes: sizeObj }] });
            }}>+ Measurement</button>
          </div>
        </div>

        {tp.measurements.length === 0 ? (
          <div style={{ ...S.emptyState, padding: 30 }}>
            <p style={{ color: "#6B7280", fontSize: 13 }}>No measurements yet. Add size columns and measurement points.</p>
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>Point of Measure</th>
                  <th style={S.th}>Tolerance</th>
                  {sizes.map(s => (
                    <th key={s} style={S.th}>
                      {s}
                      <button style={{ ...S.iconBtnTiny, marginLeft: 4 }} onClick={() => {
                        const updated = tp.measurements.map(m => {
                          const ns = { ...m.sizes };
                          delete ns[s];
                          return { ...m, sizes: ns };
                        });
                        updateSelected({ measurements: updated });
                      }}>✕</button>
                    </th>
                  ))}
                  <th style={S.th}>Del</th>
                </tr>
              </thead>
              <tbody>
                {tp.measurements.map((m, idx) => (
                  <tr key={m.id} style={{ background: idx % 2 === 0 ? "#0F172A" : "#1A2332" }}>
                    <td style={S.td}>
                      <input style={S.cellInput} value={m.pointOfMeasure} onChange={e => {
                        const updated = [...tp.measurements];
                        updated[idx] = { ...m, pointOfMeasure: e.target.value };
                        updateSelected({ measurements: updated });
                      }} placeholder="e.g. Chest" />
                    </td>
                    <td style={S.td}>
                      <input style={{ ...S.cellInput, width: 70 }} value={m.tolerance} onChange={e => {
                        const updated = [...tp.measurements];
                        updated[idx] = { ...m, tolerance: e.target.value };
                        updateSelected({ measurements: updated });
                      }} />
                    </td>
                    {sizes.map(s => (
                      <td key={s} style={S.td}>
                        <input style={{ ...S.cellInput, width: 60, textAlign: "center" }} value={m.sizes[s] || ""} onChange={e => {
                          const updated = [...tp.measurements];
                          updated[idx] = { ...m, sizes: { ...m.sizes, [s]: e.target.value } };
                          updateSelected({ measurements: updated });
                        }} />
                      </td>
                    ))}
                    <td style={S.td}>
                      <button style={S.iconBtnTiny} onClick={() => updateSelected({ measurements: tp.measurements.filter(x => x.id !== m.id) })}>🗑️</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </>
    );
  }

  // ── Construction Tab ──────────────────────────────────────────────────────
  function renderConstructionTab(tp: TechPack) {
    return (
      <>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h3 style={{ margin: 0, color: "#F1F5F9", fontSize: 16 }}>Construction Details</h3>
          <button style={S.btnSmall} onClick={() => {
            updateSelected({ construction: [...tp.construction, { id: uid(), area: "", detail: "", notes: "" }] });
          }}>+ Add Detail</button>
        </div>

        {tp.construction.length === 0 ? (
          <div style={{ ...S.emptyState, padding: 30 }}><p style={{ color: "#6B7280" }}>No construction details yet.</p></div>
        ) : (
          tp.construction.map((c, idx) => (
            <div key={c.id} style={{ background: idx % 2 === 0 ? "#0F172A" : "#1A2332", borderRadius: 8, padding: 14, marginBottom: 10, border: "1px solid #334155" }}>
              <div style={{ display: "flex", gap: 12, marginBottom: 8 }}>
                <div style={{ flex: 1 }}>
                  <label style={S.label}>Area</label>
                  <input style={S.input} value={c.area} placeholder="e.g. Front Body, Collar, Sleeve" onChange={e => {
                    const updated = [...tp.construction];
                    updated[idx] = { ...c, area: e.target.value };
                    updateSelected({ construction: updated });
                  }} />
                </div>
                <button style={{ ...S.iconBtn, alignSelf: "flex-end", color: "#EF4444" }} onClick={() => updateSelected({ construction: tp.construction.filter(x => x.id !== c.id) })}>🗑️</button>
              </div>
              <label style={S.label}>Detail</label>
              <textarea style={{ ...S.textarea, minHeight: 60, marginBottom: 8 }} value={c.detail} onChange={e => {
                const updated = [...tp.construction];
                updated[idx] = { ...c, detail: e.target.value };
                updateSelected({ construction: updated });
              }} placeholder="Construction detail..." />
              <label style={S.label}>Notes</label>
              <input style={S.input} value={c.notes} onChange={e => {
                const updated = [...tp.construction];
                updated[idx] = { ...c, notes: e.target.value };
                updateSelected({ construction: updated });
              }} placeholder="Additional notes..." />
            </div>
          ))
        )}
      </>
    );
  }

  // ── BOM Tab ───────────────────────────────────────────────────────────────
  function renderBOMTab(tp: TechPack) {
    const bomTotal = tp.bom.reduce((sum, b) => sum + b.totalCost, 0);

    return (
      <>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h3 style={{ margin: 0, color: "#F1F5F9", fontSize: 16 }}>Bill of Materials</h3>
          <div style={{ display: "flex", gap: 8 }}>
            <button style={S.btnSmall} onClick={() => {
              updateSelected({ bom: [...tp.bom, { id: uid(), material: "", supplier: "", color: "", placement: "", quantity: "", unitCost: 0, totalCost: 0, notes: "" }] });
            }}>+ Add Item</button>
          </div>
        </div>

        {tp.bom.length === 0 ? (
          <div style={{ ...S.emptyState, padding: 30 }}><p style={{ color: "#6B7280" }}>No BOM items yet.</p></div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>Material</th>
                  <th style={S.th}>Supplier</th>
                  <th style={S.th}>Color</th>
                  <th style={S.th}>Placement</th>
                  <th style={S.th}>Qty</th>
                  <th style={S.th}>Unit Cost</th>
                  <th style={S.th}>Total</th>
                  <th style={S.th}>Del</th>
                </tr>
              </thead>
              <tbody>
                {tp.bom.map((b, idx) => (
                  <tr key={b.id} style={{ background: idx % 2 === 0 ? "#0F172A" : "#1A2332" }}>
                    <td style={S.td}>
                      <select style={{ ...S.cellInput, minWidth: 120 }} value={b.material} onChange={e => {
                        const updated = [...tp.bom];
                        const selectedMat = materials.find(m => m.name === e.target.value);
                        updated[idx] = { ...b, material: e.target.value, supplier: selectedMat?.supplier || b.supplier, unitCost: selectedMat?.unitPrice || b.unitCost };
                        updated[idx].totalCost = parseFloat(updated[idx].quantity || "0") * updated[idx].unitCost;
                        updateSelected({ bom: updated });
                      }}>
                        <option value="">Select...</option>
                        {materials.map(m => <option key={m.id} value={m.name}>{m.name}</option>)}
                        {b.material && !materials.find(m => m.name === b.material) && <option value={b.material}>{b.material}</option>}
                      </select>
                      <input style={{ ...S.cellInput, fontSize: 11, marginTop: 4 }} value={b.material} onChange={e => {
                        const updated = [...tp.bom];
                        updated[idx] = { ...b, material: e.target.value };
                        updateSelected({ bom: updated });
                      }} placeholder="or type..." />
                    </td>
                    <td style={S.td}><input style={{ ...S.cellInput, width: 100 }} value={b.supplier} onChange={e => { const updated = [...tp.bom]; updated[idx] = { ...b, supplier: e.target.value }; updateSelected({ bom: updated }); }} /></td>
                    <td style={S.td}><input style={{ ...S.cellInput, width: 80 }} value={b.color} onChange={e => { const updated = [...tp.bom]; updated[idx] = { ...b, color: e.target.value }; updateSelected({ bom: updated }); }} /></td>
                    <td style={S.td}><input style={{ ...S.cellInput, width: 90 }} value={b.placement} onChange={e => { const updated = [...tp.bom]; updated[idx] = { ...b, placement: e.target.value }; updateSelected({ bom: updated }); }} /></td>
                    <td style={S.td}>
                      <input style={{ ...S.cellInput, width: 60, textAlign: "center" }} value={b.quantity} onChange={e => {
                        const qty = e.target.value;
                        const total = parseFloat(qty || "0") * b.unitCost;
                        const updated = [...tp.bom];
                        updated[idx] = { ...b, quantity: qty, totalCost: Math.round(total * 100) / 100 };
                        updateSelected({ bom: updated });
                      }} />
                    </td>
                    <td style={S.td}>
                      <input style={{ ...S.cellInput, width: 70, textAlign: "right" }} type="number" step="0.01" value={b.unitCost || ""} onChange={e => {
                        const uc = parseFloat(e.target.value) || 0;
                        const total = parseFloat(b.quantity || "0") * uc;
                        const updated = [...tp.bom];
                        updated[idx] = { ...b, unitCost: uc, totalCost: Math.round(total * 100) / 100 };
                        updateSelected({ bom: updated });
                      }} />
                    </td>
                    <td style={{ ...S.td, color: "#10B981", fontWeight: 600, fontFamily: "monospace" }}>{fmtCurrency(b.totalCost)}</td>
                    <td style={S.td}><button style={S.iconBtnTiny} onClick={() => updateSelected({ bom: tp.bom.filter(x => x.id !== b.id) })}>🗑️</button></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ background: "#1A2332", borderTop: "2px solid #334155" }}>
                  <td colSpan={6} style={{ ...S.td, textAlign: "right", fontWeight: 700, color: "#F1F5F9" }}>Total BOM Cost:</td>
                  <td style={{ ...S.td, color: "#10B981", fontWeight: 700, fontFamily: "monospace", fontSize: 15 }}>{fmtCurrency(bomTotal)}</td>
                  <td style={S.td}></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </>
    );
  }

  // ── Costing Tab ───────────────────────────────────────────────────────────
  function renderCostingTab(tp: TechPack) {
    const c = tp.costing;

    const recalc = (updates: Partial<Costing>) => {
      const merged = { ...c, ...updates };
      merged.duty = Math.round(merged.fob * (merged.dutyRate / 100) * 100) / 100;
      merged.landedCost = Math.round((merged.fob + merged.duty + merged.freight + merged.insurance + merged.otherCosts) * 100) / 100;
      merged.margin = merged.retailPrice > 0 ? Math.round(((merged.retailPrice - merged.landedCost) / merged.retailPrice) * 10000) / 100 : 0;
      updateSelected({ costing: merged });
    };

    const marginColor = c.margin >= 50 ? "#10B981" : c.margin >= 30 ? "#F59E0B" : "#EF4444";

    return (
      <>
        <h3 style={{ margin: "0 0 16px", color: "#F1F5F9", fontSize: 16 }}>Costing Breakdown</h3>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          {/* Left: Inputs */}
          <div>
            <div style={{ ...S.card, padding: 16, marginBottom: 0 }}>
              <div style={{ marginBottom: 12 }}>
                <label style={S.label}>FOB Price ($)</label>
                <input style={S.input} type="number" step="0.01" value={c.fob || ""} onChange={e => recalc({ fob: parseFloat(e.target.value) || 0 })} />
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={S.label}>Duty Rate (%)</label>
                <input style={S.input} type="number" step="0.1" value={c.dutyRate || ""} onChange={e => recalc({ dutyRate: parseFloat(e.target.value) || 0 })} />
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={S.label}>Duty Amount ($)</label>
                <div style={{ ...S.input, background: "#1E293B", color: "#94A3B8" }}>{fmtCurrency(c.duty)}</div>
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={S.label}>Freight ($)</label>
                <input style={S.input} type="number" step="0.01" value={c.freight || ""} onChange={e => recalc({ freight: parseFloat(e.target.value) || 0 })} />
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={S.label}>Insurance ($)</label>
                <input style={S.input} type="number" step="0.01" value={c.insurance || ""} onChange={e => recalc({ insurance: parseFloat(e.target.value) || 0 })} />
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={S.label}>Other Costs ($)</label>
                <input style={S.input} type="number" step="0.01" value={c.otherCosts || ""} onChange={e => recalc({ otherCosts: parseFloat(e.target.value) || 0 })} />
              </div>
            </div>
          </div>

          {/* Right: Summary */}
          <div>
            <div style={{ ...S.card, padding: 16, marginBottom: 16 }}>
              <div style={{ marginBottom: 16 }}>
                <div style={{ color: "#6B7280", fontSize: 12, textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>Landed Cost</div>
                <div style={{ color: "#F1F5F9", fontSize: 28, fontWeight: 700, fontFamily: "monospace" }}>{fmtCurrency(c.landedCost)}</div>
                <div style={{ color: "#6B7280", fontSize: 11, marginTop: 4 }}>FOB + Duty + Freight + Insurance + Other</div>
              </div>

              <div style={{ borderTop: "1px solid #334155", paddingTop: 12, marginBottom: 12 }}>
                <label style={S.label}>Wholesale Price ($)</label>
                <input style={S.input} type="number" step="0.01" value={c.wholesalePrice || ""} onChange={e => recalc({ wholesalePrice: parseFloat(e.target.value) || 0 })} />
              </div>

              <div style={{ marginBottom: 16 }}>
                <label style={S.label}>Retail Price ($)</label>
                <input style={S.input} type="number" step="0.01" value={c.retailPrice || ""} onChange={e => recalc({ retailPrice: parseFloat(e.target.value) || 0 })} />
              </div>

              {/* Margin Indicator */}
              <div style={{ background: "#0F172A", borderRadius: 12, padding: 16, textAlign: "center" }}>
                <div style={{ color: "#6B7280", fontSize: 12, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>Margin</div>
                <div style={{ fontSize: 36, fontWeight: 800, color: marginColor, fontFamily: "monospace" }}>{c.margin.toFixed(1)}%</div>
                <div style={{ width: "100%", height: 8, background: "#334155", borderRadius: 4, overflow: "hidden", marginTop: 12 }}>
                  <div style={{ width: `${Math.min(c.margin, 100)}%`, height: "100%", background: marginColor, borderRadius: 4, transition: "width 0.3s" }} />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontSize: 10, color: "#6B7280" }}>
                  <span>0%</span>
                  <span style={{ color: "#EF4444" }}>30%</span>
                  <span style={{ color: "#F59E0B" }}>50%</span>
                  <span>100%</span>
                </div>
              </div>
            </div>

            <div>
              <label style={S.label}>Costing Notes</label>
              <textarea style={{ ...S.textarea, minHeight: 60 }} value={c.notes} onChange={e => recalc({ notes: e.target.value })} placeholder="Notes about costing..." />
            </div>
          </div>
        </div>
      </>
    );
  }

  // ── Approvals Tab ─────────────────────────────────────────────────────────
  function renderApprovalsTab(tp: TechPack) {
    const approvals = tp.approvals.length > 0 ? tp.approvals : emptyApprovals();

    // Check if previous stages are approved for sequential unlock
    const isStageUnlocked = (index: number) => {
      if (index === 0) return true;
      return approvals.slice(0, index).every(a => a.status === "Approved");
    };

    return (
      <>
        <h3 style={{ margin: "0 0 16px", color: "#F1F5F9", fontSize: 16 }}>Approval Workflow</h3>

        {/* Progress bar */}
        <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 20, padding: "0 8px" }}>
          {approvals.map((a, i) => (
            <div key={a.id} style={{ display: "flex", alignItems: "center", flex: 1 }}>
              <div style={{ width: 28, height: 28, borderRadius: "50%", background: APPROVAL_STATUS_COLORS[a.status] + "33", border: `2px solid ${APPROVAL_STATUS_COLORS[a.status]}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: APPROVAL_STATUS_COLORS[a.status], fontWeight: 700, flexShrink: 0 }}>
                {a.status === "Approved" ? "✓" : a.status === "Rejected" ? "✕" : i + 1}
              </div>
              {i < approvals.length - 1 && <div style={{ flex: 1, height: 2, background: a.status === "Approved" ? "#10B981" : "#334155", margin: "0 4px" }} />}
            </div>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 20, padding: "0 8px" }}>
          {approvals.map(a => (
            <span key={a.id} style={{ fontSize: 10, color: "#6B7280", textAlign: "center", flex: 1 }}>{a.stage}</span>
          ))}
        </div>

        {/* Approval cards */}
        {approvals.map((a, idx) => {
          const unlocked = isStageUnlocked(idx);
          return (
            <div key={a.id} style={{ background: unlocked ? "#0F172A" : "#0F172A88", borderRadius: 10, padding: 16, marginBottom: 10, border: `1px solid ${APPROVAL_STATUS_COLORS[a.status]}44`, opacity: unlocked ? 1 : 0.5 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ color: "#F1F5F9", fontWeight: 700, fontSize: 15 }}>{a.stage}</span>
                  <span style={{ ...S.badge, background: APPROVAL_STATUS_COLORS[a.status] + "22", color: APPROVAL_STATUS_COLORS[a.status], border: `1px solid ${APPROVAL_STATUS_COLORS[a.status]}44` }}>{a.status}</span>
                </div>
                {a.date && <span style={{ color: "#6B7280", fontSize: 12 }}>{fmtDate(a.date)}</span>}
              </div>

              <div style={{ display: "flex", gap: 12, marginBottom: 10 }}>
                <div style={{ flex: 1 }}>
                  <label style={S.label}>Approver</label>
                  <input style={S.input} value={a.approver} disabled={!unlocked} onChange={e => {
                    const updated = [...approvals];
                    updated[idx] = { ...a, approver: e.target.value };
                    updateSelected({ approvals: updated });
                  }} placeholder="Approver name" />
                </div>
              </div>

              <label style={S.label}>Comments</label>
              <textarea style={{ ...S.textarea, minHeight: 40, marginBottom: 10 }} value={a.comments} disabled={!unlocked} onChange={e => {
                const updated = [...approvals];
                updated[idx] = { ...a, comments: e.target.value };
                updateSelected({ approvals: updated });
              }} placeholder="Add comments..." />

              {unlocked && a.status !== "Approved" && (
                <div style={{ display: "flex", gap: 8 }}>
                  <button style={{ ...S.btnSmall, background: "#10B981", color: "#fff", border: "none" }} onClick={() => {
                    const updated = [...approvals];
                    updated[idx] = { ...a, status: "Approved", date: today() };
                    updateSelected({ approvals: updated });
                  }}>Approve</button>
                  <button style={{ ...S.btnSmall, background: "#EF4444", color: "#fff", border: "none" }} onClick={() => {
                    const updated = [...approvals];
                    updated[idx] = { ...a, status: "Rejected", date: today() };
                    updateSelected({ approvals: updated });
                  }}>Reject</button>
                  <button style={{ ...S.btnSmall, background: "#F59E0B", color: "#fff", border: "none" }} onClick={() => {
                    const updated = [...approvals];
                    updated[idx] = { ...a, status: "Revision Required", date: today() };
                    updateSelected({ approvals: updated });
                  }}>Request Revision</button>
                  {a.status !== "Pending" && (
                    <button style={{ ...S.btnSmall, background: "none", color: "#6B7280", border: "1px solid #334155" }} onClick={() => {
                      const updated = [...approvals];
                      updated[idx] = { ...a, status: "Pending", date: null };
                      updateSelected({ approvals: updated });
                    }}>Reset</button>
                  )}
                </div>
              )}
              {!unlocked && <div style={{ color: "#6B7280", fontSize: 12, fontStyle: "italic" }}>Previous stage must be approved first</div>}
            </div>
          );
        })}
      </>
    );
  }

  // ── Samples Tab ───────────────────────────────────────────────────────────
  function renderSamplesTab(tp: TechPack) {
    const sampleStatuses: Sample["status"][] = ["Requested", "In Progress", "Received", "Approved", "Rejected"];

    return (
      <>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h3 style={{ margin: 0, color: "#F1F5F9", fontSize: 16 }}>Sample Tracking</h3>
          <button style={S.btnSmall} onClick={() => {
            updateSelected({ samples: [...tp.samples, { id: uid(), type: "Proto", status: "Requested", requestDate: today(), receiveDate: null, vendor: "", comments: "", images: [] }] });
          }}>+ Add Sample</button>
        </div>

        {tp.samples.length === 0 ? (
          <div style={{ ...S.emptyState, padding: 30 }}><p style={{ color: "#6B7280" }}>No samples tracked yet.</p></div>
        ) : (
          tp.samples.map((s, idx) => (
            <div key={s.id} style={{ background: "#0F172A", borderRadius: 10, padding: 16, marginBottom: 12, border: `1px solid ${SAMPLE_STATUS_COLORS[s.status]}44` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <select style={S.select} value={s.type} onChange={e => {
                    const updated = [...tp.samples];
                    updated[idx] = { ...s, type: e.target.value as Sample["type"] };
                    updateSelected({ samples: updated });
                  }}>
                    {SAMPLE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <span style={{ ...S.badge, background: (SAMPLE_STATUS_COLORS[s.status] || "#6B7280") + "22", color: SAMPLE_STATUS_COLORS[s.status] || "#6B7280", border: `1px solid ${SAMPLE_STATUS_COLORS[s.status] || "#6B7280"}44` }}>{s.status}</span>
                </div>
                <button style={{ ...S.iconBtn, color: "#EF4444" }} onClick={() => updateSelected({ samples: tp.samples.filter(x => x.id !== s.id) })}>🗑️</button>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
                <div>
                  <label style={S.label}>Status</label>
                  <select style={{ ...S.select, width: "100%" }} value={s.status} onChange={e => {
                    const updated = [...tp.samples];
                    updated[idx] = { ...s, status: e.target.value as Sample["status"], receiveDate: e.target.value === "Received" || e.target.value === "Approved" || e.target.value === "Rejected" ? s.receiveDate || today() : s.receiveDate };
                    updateSelected({ samples: updated });
                  }}>
                    {sampleStatuses.map(st => <option key={st} value={st}>{st}</option>)}
                  </select>
                </div>
                <div>
                  <label style={S.label}>Vendor</label>
                  <input style={S.input} value={s.vendor} onChange={e => {
                    const updated = [...tp.samples];
                    updated[idx] = { ...s, vendor: e.target.value };
                    updateSelected({ samples: updated });
                  }} placeholder="Vendor name" />
                </div>
                <div>
                  <label style={S.label}>Request Date</label>
                  <input style={S.input} type="date" value={s.requestDate} onChange={e => {
                    const updated = [...tp.samples];
                    updated[idx] = { ...s, requestDate: e.target.value };
                    updateSelected({ samples: updated });
                  }} />
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
                <div>
                  <label style={S.label}>Receive Date</label>
                  <input style={S.input} type="date" value={s.receiveDate || ""} onChange={e => {
                    const updated = [...tp.samples];
                    updated[idx] = { ...s, receiveDate: e.target.value || null };
                    updateSelected({ samples: updated });
                  }} />
                </div>
                <div>
                  <label style={S.label}>Comments</label>
                  <input style={S.input} value={s.comments} onChange={e => {
                    const updated = [...tp.samples];
                    updated[idx] = { ...s, comments: e.target.value };
                    updateSelected({ samples: updated });
                  }} placeholder="Comments..." />
                </div>
              </div>

              {/* Sample Images */}
              <div>
                <label style={S.label}>Images</label>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {s.images.map((img, imgIdx) => (
                    <div key={imgIdx} style={{ position: "relative", width: 60, height: 60 }}>
                      <img src={img} alt="" style={{ width: 60, height: 60, borderRadius: 6, objectFit: "cover", cursor: "pointer" }} onClick={() => setLightboxImg(img)} />
                      <button style={{ position: "absolute", top: -4, right: -4, width: 18, height: 18, borderRadius: "50%", background: "#EF4444", color: "#fff", border: "none", fontSize: 10, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
                        onClick={() => {
                          const updated = [...tp.samples];
                          updated[idx] = { ...s, images: s.images.filter((_, i) => i !== imgIdx) };
                          updateSelected({ samples: updated });
                        }}>✕</button>
                    </div>
                  ))}
                  <label style={{ width: 60, height: 60, borderRadius: 6, border: "2px dashed #334155", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "#6B7280", fontSize: 20 }}>
                    +
                    <input type="file" accept="image/*" style={{ display: "none" }} onChange={async e => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const url = await uploadImage(file, `/techpacks/${tp.id}/samples/${s.id}/${file.name}`);
                      if (url) {
                        const updated = [...tp.samples];
                        updated[idx] = { ...s, images: [...s.images, url] };
                        updateSelected({ samples: updated });
                      } else {
                        showToast("Image upload failed");
                      }
                    }} />
                  </label>
                </div>
              </div>
            </div>
          ))
        )}
      </>
    );
  }

  // ── Images Tab ────────────────────────────────────────────────────────────
  function renderImagesTab(tp: TechPack) {
    return (
      <>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h3 style={{ margin: 0, color: "#F1F5F9", fontSize: 16 }}>Product Images</h3>
          <label style={S.btnSmall}>
            + Upload Image
            <input type="file" accept="image/*" multiple style={{ display: "none" }} onChange={async e => {
              const files = e.target.files;
              if (!files) return;
              for (let i = 0; i < files.length; i++) {
                const file = files[i];
                const url = await uploadImage(file, `/techpacks/${tp.id}/images/${file.name}`);
                if (url) {
                  const img: TPImage = { id: uid(), url, name: file.name, type: file.type };
                  tp = { ...tp, images: [...tp.images, img] };
                  updateSelected({ images: tp.images });
                }
              }
            }} />
          </label>
        </div>

        {tp.images.length === 0 ? (
          <div style={{ ...S.emptyState, padding: 40 }}>
            <div style={{ fontSize: 48 }}>🖼️</div>
            <p style={{ color: "#6B7280" }}>No images uploaded yet</p>
            <label style={S.btnPrimarySmall}>
              Upload Images
              <input type="file" accept="image/*" multiple style={{ display: "none" }} onChange={async e => {
                const files = e.target.files;
                if (!files) return;
                for (let i = 0; i < files.length; i++) {
                  const file = files[i];
                  const url = await uploadImage(file, `/techpacks/${tp.id}/images/${file.name}`);
                  if (url) {
                    const img: TPImage = { id: uid(), url, name: file.name, type: file.type };
                    tp = { ...tp, images: [...tp.images, img] };
                    updateSelected({ images: tp.images });
                  }
                }
              }} />
            </label>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 12 }}>
            {tp.images.map(img => (
              <div key={img.id} style={{ position: "relative", borderRadius: 8, overflow: "hidden", border: "1px solid #334155", cursor: "pointer" }}>
                <img src={img.url} alt={img.name} style={{ width: "100%", height: 150, objectFit: "cover" }} onClick={() => setLightboxImg(img.url)} />
                <div style={{ padding: "6px 8px", background: "#0F172A", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ color: "#94A3B8", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{img.name}</span>
                  <button style={{ ...S.iconBtnTiny, flexShrink: 0 }} onClick={() => updateSelected({ images: tp.images.filter(x => x.id !== img.id) })}>🗑️</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </>
    );
  }

  // ── Create Modal ──────────────────────────────────────────────────────────
  function renderCreateModal() {
    return (
      <div style={S.modalOverlay} onClick={() => setShowCreateModal(false)}>
        <div style={S.modal} onClick={e => e.stopPropagation()}>
          <div style={S.modalHeader}>
            <h2 style={S.modalTitle}>Create Tech Pack</h2>
            <button style={S.closeBtn} onClick={() => setShowCreateModal(false)}>✕</button>
          </div>
          <div style={S.modalBody}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div>
                <label style={S.label}>Style Name *</label>
                <input style={S.input} value={createForm.styleName} onChange={e => setCreateForm(f => ({ ...f, styleName: e.target.value }))} placeholder="e.g. Classic Oxford Shirt" />
              </div>
              <div>
                <label style={S.label}>Style Number *</label>
                <input style={S.input} value={createForm.styleNumber} onChange={e => setCreateForm(f => ({ ...f, styleNumber: e.target.value }))} placeholder="e.g. OXF-001" />
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div>
                <label style={S.label}>Brand</label>
                <input style={S.input} value={createForm.brand} onChange={e => setCreateForm(f => ({ ...f, brand: e.target.value }))} placeholder="Brand name" />
              </div>
              <div>
                <label style={S.label}>Season</label>
                <select style={{ ...S.select, width: "100%" }} value={createForm.season} onChange={e => setCreateForm(f => ({ ...f, season: e.target.value }))}>
                  <option value="">Select season...</option>
                  {SEASONS.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div>
                <label style={S.label}>Category</label>
                <select style={{ ...S.select, width: "100%" }} value={createForm.category} onChange={e => setCreateForm(f => ({ ...f, category: e.target.value }))}>
                  <option value="">Select category...</option>
                  {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label style={S.label}>Designer</label>
                <input style={S.input} value={createForm.designer} onChange={e => setCreateForm(f => ({ ...f, designer: e.target.value }))} />
              </div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={S.label}>Description</label>
              <textarea style={{ ...S.textarea, minHeight: 60 }} value={createForm.description} onChange={e => setCreateForm(f => ({ ...f, description: e.target.value }))} placeholder="Style description..." />
            </div>

            <div style={{ display: "flex", gap: 10 }}>
              <button style={{ ...S.btnSecondary, flex: 1 }} onClick={() => setShowCreateModal(false)}>Cancel</button>
              <button style={{ ...S.btnPrimary, flex: 2, opacity: (!createForm.styleName || !createForm.styleNumber) ? 0.5 : 1 }}
                disabled={!createForm.styleName || !createForm.styleNumber}
                onClick={handleCreate}>Create Tech Pack</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Material Modal ────────────────────────────────────────────────────────
  function renderMaterialModal() {
    return (
      <div style={S.modalOverlay} onClick={() => { setShowMaterialModal(false); setEditingMaterial(null); }}>
        <div style={{ ...S.modal, width: 520 }} onClick={e => e.stopPropagation()}>
          <div style={S.modalHeader}>
            <h2 style={S.modalTitle}>{editingMaterial ? "Edit Material" : "Add Material"}</h2>
            <button style={S.closeBtn} onClick={() => { setShowMaterialModal(false); setEditingMaterial(null); }}>✕</button>
          </div>
          <div style={S.modalBody}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div>
                <label style={S.label}>Name *</label>
                <input style={S.input} value={matForm.name} onChange={e => setMatForm(f => ({ ...f, name: e.target.value }))} placeholder="Material name" />
              </div>
              <div>
                <label style={S.label}>Type</label>
                <select style={{ ...S.select, width: "100%" }} value={matForm.type} onChange={e => setMatForm(f => ({ ...f, type: e.target.value }))}>
                  {MATERIAL_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
            </div>

            <div style={{ marginBottom: 12 }}>
              <label style={S.label}>Composition</label>
              <input style={S.input} value={matForm.composition} onChange={e => setMatForm(f => ({ ...f, composition: e.target.value }))} placeholder="e.g. 100% Cotton" />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div>
                <label style={S.label}>Weight</label>
                <input style={S.input} value={matForm.weight} onChange={e => setMatForm(f => ({ ...f, weight: e.target.value }))} placeholder="e.g. 180 GSM" />
              </div>
              <div>
                <label style={S.label}>Width</label>
                <input style={S.input} value={matForm.width} onChange={e => setMatForm(f => ({ ...f, width: e.target.value }))} placeholder='e.g. 58"' />
              </div>
              <div>
                <label style={S.label}>Color</label>
                <input style={S.input} value={matForm.color} onChange={e => setMatForm(f => ({ ...f, color: e.target.value }))} placeholder="Color" />
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div>
                <label style={S.label}>Supplier</label>
                <input style={S.input} value={matForm.supplier} onChange={e => setMatForm(f => ({ ...f, supplier: e.target.value }))} placeholder="Supplier name" />
              </div>
              <div>
                <label style={S.label}>Unit Price ($)</label>
                <input style={S.input} type="number" step="0.01" value={matForm.unitPrice || ""} onChange={e => setMatForm(f => ({ ...f, unitPrice: parseFloat(e.target.value) || 0 }))} />
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div>
                <label style={S.label}>MOQ</label>
                <input style={S.input} value={matForm.moq} onChange={e => setMatForm(f => ({ ...f, moq: e.target.value }))} placeholder="Min order qty" />
              </div>
              <div>
                <label style={S.label}>Lead Time</label>
                <input style={S.input} value={matForm.leadTime} onChange={e => setMatForm(f => ({ ...f, leadTime: e.target.value }))} placeholder="e.g. 4 weeks" />
              </div>
            </div>

            <div style={{ marginBottom: 12 }}>
              <label style={S.label}>Certifications (comma separated)</label>
              <input style={S.input} value={matForm.certifications} onChange={e => setMatForm(f => ({ ...f, certifications: e.target.value }))} placeholder="e.g. OEKO-TEX, GOTS, BCI" />
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={S.label}>Notes</label>
              <textarea style={{ ...S.textarea, minHeight: 50 }} value={matForm.notes} onChange={e => setMatForm(f => ({ ...f, notes: e.target.value }))} />
            </div>

            <div style={{ display: "flex", gap: 10 }}>
              <button style={{ ...S.btnSecondary, flex: 1 }} onClick={() => { setShowMaterialModal(false); setEditingMaterial(null); }}>Cancel</button>
              <button style={{ ...S.btnPrimary, flex: 2, opacity: !matForm.name ? 0.5 : 1 }} disabled={!matForm.name} onClick={handleSaveMaterial}>
                {editingMaterial ? "Update Material" : "Add Material"}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// STYLES
// ══════════════════════════════════════════════════════════════════════════════
const S: Record<string, React.CSSProperties> = {
  app:          { minHeight: "100vh", background: "#0F172A", color: "#F1F5F9", fontFamily: "'DM Sans', 'Segoe UI', sans-serif" },

  // Nav
  nav:          { background: "#1E293B", borderBottom: "1px solid #334155", padding: "0 24px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 56, position: "sticky", top: 0, zIndex: 100 },
  navLeft:      { display: "flex", alignItems: "center", gap: 12 },
  navLogo:      { width: 32, height: 32, borderRadius: 8, background: "linear-gradient(135deg,#3B82F6,#8B5CF6)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: 16 },
  navTitle:     { fontWeight: 700, fontSize: 16, color: "#F1F5F9" },
  navSub:       { fontSize: 12, color: "#6B7280" },
  navRight:     { display: "flex", alignItems: "center", gap: 8 },
  navBtn:       { background: "none", border: "1px solid #334155", color: "#94A3B8", borderRadius: 6, padding: "5px 12px", fontSize: 13, cursor: "pointer", fontFamily: "inherit" },
  navBtnActive: { background: "#3B82F620", border: "1px solid #3B82F6", color: "#60A5FA", borderRadius: 6, padding: "5px 12px", fontSize: 13, cursor: "pointer", fontWeight: 600, fontFamily: "inherit" },
  navBtnDanger: { background: "none", border: "1px solid #EF4444", color: "#EF4444", borderRadius: 6, padding: "5px 12px", fontSize: 13, cursor: "pointer", fontFamily: "inherit" },

  // Content
  content:      { maxWidth: "90%", margin: "0 auto", padding: "24px 20px" },
  statsRow:     { display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16, marginBottom: 20 },
  statCard:     { background: "#1E293B", borderRadius: 12, padding: 20, display: "flex", flexDirection: "column", gap: 6 },
  card:         { background: "#1E293B", borderRadius: 12, padding: 20, marginBottom: 20 },
  cardTitle:    { margin: "0 0 16px", fontSize: 16, fontWeight: 700, color: "#F1F5F9" },

  // Tech Pack Card
  tpCard:       { background: "#1E293B", borderRadius: 12, padding: 16, border: "1px solid #334155", cursor: "pointer", transition: "border-color 0.15s, transform 0.15s" },

  // Filters
  filters:      { display: "flex", gap: 10, marginBottom: 16, alignItems: "center", flexWrap: "wrap" as any },

  // PO Row / list item
  poRow:        { display: "flex", alignItems: "center", gap: 16, padding: "14px 16px", borderRadius: 8, marginBottom: 8, background: "#0F172A", cursor: "pointer", transition: "background .15s" },
  badge:        { fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 20 },

  // Empty state
  emptyState:   { textAlign: "center", padding: 40, color: "#6B7280", display: "flex", flexDirection: "column", gap: 12, alignItems: "center" },

  // Forms
  input:        { width: "100%", background: "#0F172A", border: "1px solid #334155", borderRadius: 8, padding: "10px 14px", color: "#F1F5F9", fontSize: 14, outline: "none", boxSizing: "border-box", fontFamily: "inherit" },
  select:       { background: "#0F172A", border: "1px solid #334155", borderRadius: 8, padding: "9px 12px", color: "#F1F5F9", fontSize: 13, outline: "none", fontFamily: "inherit" },
  textarea:     { width: "100%", background: "#0F172A", border: "1px solid #334155", borderRadius: 8, padding: "10px 14px", color: "#F1F5F9", fontSize: 14, resize: "vertical" as any, outline: "none", fontFamily: "inherit", boxSizing: "border-box" },
  label:        { color: "#94A3B8", fontSize: 13, display: "block", marginBottom: 4 },

  // Buttons
  btnPrimary:   { background: "linear-gradient(135deg,#3B82F6,#8B5CF6)", color: "#fff", border: "none", borderRadius: 8, padding: "10px 20px", fontWeight: 600, fontSize: 14, cursor: "pointer", fontFamily: "inherit" },
  btnPrimarySmall: { background: "linear-gradient(135deg,#3B82F6,#8B5CF6)", color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: "inherit" },
  btnSecondary: { background: "none", border: "1px solid #334155", color: "#94A3B8", borderRadius: 8, padding: "8px 16px", fontSize: 13, cursor: "pointer", fontFamily: "inherit" },
  btnSmall:     { background: "#334155", color: "#D1D5DB", border: "none", borderRadius: 6, padding: "5px 12px", fontSize: 12, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 },
  iconBtn:      { background: "none", border: "none", cursor: "pointer", fontSize: 16, padding: 4, lineHeight: 1 },
  iconBtnTiny:  { background: "none", border: "none", cursor: "pointer", fontSize: 12, padding: 2, lineHeight: 1, color: "#6B7280" },

  // Modal
  modalOverlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,.7)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center" },
  modal:        { background: "#1E293B", borderRadius: 16, width: 520, maxHeight: "85vh", overflow: "hidden", display: "flex", flexDirection: "column" },
  modalHeader:  { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 20px", borderBottom: "1px solid #334155" },
  modalTitle:   { margin: 0, fontSize: 18, fontWeight: 700, color: "#F1F5F9" },
  modalBody:    { padding: 20, overflowY: "auto" },
  closeBtn:     { background: "none", border: "none", color: "#6B7280", fontSize: 18, cursor: "pointer", lineHeight: 1, fontFamily: "inherit" },

  // Detail panel
  detailOverlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", zIndex: 200, display: "flex", justifyContent: "flex-end" },
  detailPanel:   { background: "#1E293B", width: 780, maxWidth: "95vw", height: "100%", overflowY: "auto", display: "flex", flexDirection: "column" },
  detailHeader:  { padding: "20px 24px", borderBottom: "1px solid #334155", display: "flex", justifyContent: "space-between", alignItems: "flex-start", background: "#0F172A" },
  detailPONum:   { fontFamily: "monospace", color: "#60A5FA", fontWeight: 800, fontSize: 20 },
  detailVendor:  { color: "#D1D5DB", fontWeight: 600, fontSize: 15, marginTop: 4 },

  // Info grid
  infoGrid:      { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 16 },
  infoCell:      { background: "#0F172A", borderRadius: 8, padding: 12 },
  infoCellLabel: { color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 },
  infoCellValue: { color: "#F1F5F9", fontSize: 14, fontWeight: 600 },

  // Tables
  table:        { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th:           { padding: "10px 8px", textAlign: "left", color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, borderBottom: "2px solid #334155", background: "#1E293B", whiteSpace: "nowrap" },
  td:           { padding: "8px", borderBottom: "1px solid #1E293B", color: "#D1D5DB", verticalAlign: "middle" },
  cellInput:    { background: "transparent", border: "1px solid transparent", borderRadius: 4, padding: "4px 6px", color: "#F1F5F9", fontSize: 13, outline: "none", fontFamily: "inherit", width: "100%", boxSizing: "border-box" },

  // Table wrap for non-HTML tables
  tableWrap:    { background: "#1E293B", borderRadius: 12, overflow: "hidden", border: "1px solid #334155" },
  tableHeader:  { display: "flex", padding: "12px 16px", background: "#0F172A", color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, gap: 12, borderBottom: "1px solid #334155", fontWeight: 600 },
  tableRow:     { display: "flex", padding: "10px 16px", gap: 12, fontSize: 13, alignItems: "center", borderBottom: "1px solid #1E293B" },
};

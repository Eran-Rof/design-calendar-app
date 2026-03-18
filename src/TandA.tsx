import { useState, useEffect, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";

// ── Supabase ─────────────────────────────────────────────────────────────────
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL!;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY!;
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Xoro API ──────────────────────────────────────────────────────────────────
// Store your Xoro API Key and Secret in .env as:
//   VITE_XORO_API_KEY=your_key
//   VITE_XORO_API_SECRET=your_secret
const XORO_API_KEY    = import.meta.env.VITE_XORO_API_KEY ?? "";
const XORO_API_SECRET = import.meta.env.VITE_XORO_API_SECRET ?? "";
const XORO_BASE_URL   = "https://res.xorosoft.io";

function xoroAuthHeader() {
  const creds = btoa(`${XORO_API_KEY}:${XORO_API_SECRET}`);
  return `Basic ${creds}`;
}

async function fetchXoroPOs(page = 1): Promise<{ pos: XoroPO[]; totalPages: number }> {
  const res = await fetch(
    `${XORO_BASE_URL}/api/xerp/purchaseorder?page=${page}`,
    { headers: { Authorization: xoroAuthHeader(), "Content-Type": "application/json" } }
  );
  if (!res.ok) throw new Error(`Xoro API error: ${res.status}`);
  const json = await res.json();
  if (!json.Result) throw new Error(json.Message ?? "Unknown Xoro error");
  const data = Array.isArray(json.Data) ? json.Data : json.Data?.PurchaseOrders ?? [];
  return { pos: data, totalPages: json.TotalPages ?? 1 };
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface XoroPO {
  PoNumber?: string;
  VendorName?: string;
  DateOrder?: string;
  DateExpectedDelivery?: string;
  VendorReqDate?: string;
  StatusName?: string;
  CurrencyCode?: string;
  Memo?: string;
  Tags?: string;
  PaymentTermsName?: string;
  ShipMethodName?: string;
  CarrierName?: string;
  BuyerName?: string;
  TotalAmount?: number;
  Items?: XoroPOItem[];
  // raw API may nest items differently
  PoLineArr?: XoroPOItem[];
}

interface XoroPOItem {
  ItemNumber?: string;
  Description?: string;
  QtyOrder?: number;
  UnitPrice?: number;
  Discount?: number;
}

interface LocalNote {
  id: string;
  po_number: string;
  note: string;
  status_override?: string;
  created_at: string;
  user_name: string;
}

interface User {
  id: number;
  name: string;
  password: string;
  role?: string;
}

type View = "dashboard" | "list" | "detail";

const STATUS_COLORS: Record<string, string> = {
  Open:       "#3B82F6",
  Released:   "#8B5CF6",
  Received:   "#10B981",
  Closed:     "#6B7280",
  Cancelled:  "#EF4444",
  Pending:    "#F59E0B",
  Draft:      "#9CA3AF",
};

const STATUS_OPTIONS = ["Open", "Released", "Received", "Closed", "Cancelled", "Pending", "Draft"];

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtDate(d?: string) {
  if (!d) return "—";
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? d : dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function fmtCurrency(n?: number, code = "USD") {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(n);
}
function daysUntil(d?: string) {
  if (!d) return null;
  const diff = Math.ceil((new Date(d).getTime() - Date.now()) / 86400000);
  return diff;
}
function poTotal(po: XoroPO) {
  if (po.TotalAmount != null) return po.TotalAmount;
  const items = po.Items ?? po.PoLineArr ?? [];
  return items.reduce((s, i) => s + (i.QtyOrder ?? 0) * (i.UnitPrice ?? 0), 0);
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function TandAApp() {
  const [user, setUser]         = useState<User | null>(null);
  const [view, setView]         = useState<View>("dashboard");
  const [pos, setPos]           = useState<XoroPO[]>([]);
  const [notes, setNotes]       = useState<LocalNote[]>([]);
  const [selected, setSelected] = useState<XoroPO | null>(null);
  const [loading, setLoading]   = useState(false);
  const [syncing, setSyncing]   = useState(false);
  const [syncErr, setSyncErr]   = useState("");
  const [lastSync, setLastSync] = useState<string>("");
  const [search, setSearch]     = useState("");
  const [filterStatus, setFilterStatus] = useState("All");
  const [filterVendor, setFilterVendor] = useState("All");
  const [xoroCreds, setXoroCreds] = useState({ key: XORO_API_KEY, secret: XORO_API_SECRET });
  const [showSettings, setShowSettings] = useState(false);
  const [newNote, setNewNote]   = useState("");
  const [noteStatus, setNoteStatus] = useState("");

  // ── Auth ──────────────────────────────────────────────────────────────────
  const [loginName, setLoginName] = useState("");
  const [loginPass, setLoginPass] = useState("");
  const [loginErr, setLoginErr]   = useState("");

  async function handleLogin() {
    setLoginErr("");
    const { data } = await sb.from("users").select("*").ilike("name", loginName.trim());
    const match = (data ?? []).find(
      (u: User) => u.password === loginPass || (u as any).pin === loginPass
    );
    if (match) { setUser(match); }
    else setLoginErr("Invalid name or password.");
  }

  // ── Load notes from Supabase ──────────────────────────────────────────────
  const loadNotes = useCallback(async () => {
    const { data } = await sb.from("tanda_notes").select("*").order("created_at", { ascending: false });
    setNotes((data as LocalNote[]) ?? []);
  }, []);

  // ── Load cached POs from Supabase ─────────────────────────────────────────
  const loadCachedPOs = useCallback(async () => {
    setLoading(true);
    const { data } = await sb.from("tanda_pos").select("*").order("date_order", { ascending: false });
    if (data && data.length > 0) {
      setPos(data.map((r: any) => r.data as XoroPO));
      setLastSync(data[0]?.synced_at ?? "");
    }
    setLoading(false);
  }, []);

  // ── Sync from Xoro ────────────────────────────────────────────────────────
  async function syncFromXoro() {
    setSyncing(true);
    setSyncErr("");
    try {
      let all: XoroPO[] = [];
      let page = 1;
      let totalPages = 1;
      do {
        const { pos: batch, totalPages: tp } = await fetchXoroPOs(page);
        all = [...all, ...batch];
        totalPages = tp;
        page++;
      } while (page <= totalPages && page <= 20); // safety cap

      // Upsert into Supabase cache
      const now = new Date().toISOString();
      await sb.from("tanda_pos").delete().neq("po_number", "___never___");
      await sb.from("tanda_pos").insert(
        all.map(po => ({
          po_number: po.PoNumber ?? `unknown-${Math.random()}`,
          vendor: po.VendorName ?? "",
          date_order: po.DateOrder ?? null,
          date_expected: po.DateExpectedDelivery ?? null,
          status: po.StatusName ?? "",
          data: po,
          synced_at: now,
        }))
      );
      setPos(all);
      setLastSync(now);
    } catch (e: any) {
      setSyncErr(e.message ?? "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  useEffect(() => {
    if (user) { loadCachedPOs(); loadNotes(); }
  }, [user, loadCachedPOs, loadNotes]);

  // ── Derived ───────────────────────────────────────────────────────────────
  const vendors = ["All", ...Array.from(new Set(pos.map(p => p.VendorName ?? "Unknown"))).sort()];

  const filtered = pos.filter(p => {
    const s = search.toLowerCase();
    const matchSearch = !s
      || (p.PoNumber ?? "").toLowerCase().includes(s)
      || (p.VendorName ?? "").toLowerCase().includes(s)
      || (p.Memo ?? "").toLowerCase().includes(s)
      || (p.Tags ?? "").toLowerCase().includes(s);
    const matchStatus = filterStatus === "All" || (p.StatusName ?? "") === filterStatus;
    const matchVendor = filterVendor === "All" || (p.VendorName ?? "") === filterVendor;
    return matchSearch && matchStatus && matchVendor;
  });

  const overdue = pos.filter(p => {
    const d = daysUntil(p.DateExpectedDelivery);
    return d !== null && d < 0 && p.StatusName !== "Received" && p.StatusName !== "Closed";
  }).length;
  const dueThisWeek = pos.filter(p => {
    const d = daysUntil(p.DateExpectedDelivery);
    return d !== null && d >= 0 && d <= 7;
  }).length;
  const totalValue = pos.reduce((s, p) => s + poTotal(p), 0);

  async function addNote() {
    if (!newNote.trim() || !selected || !user) return;
    await sb.from("tanda_notes").insert({
      po_number: selected.PoNumber,
      note: newNote.trim(),
      status_override: noteStatus || null,
      user_name: user.name,
      created_at: new Date().toISOString(),
    });
    setNewNote("");
    setNoteStatus("");
    await loadNotes();
  }

  const selectedNotes = notes.filter(n => n.po_number === selected?.PoNumber);

  // ════════════════════════════════════════════════════════════════════════════
  // LOGIN SCREEN
  // ════════════════════════════════════════════════════════════════════════════
  if (!user) return (
    <div style={S.loginBg}>
      <div style={S.loginCard}>
        <div style={S.loginLogo}>PO</div>
        <h1 style={S.loginTitle}>Purchase Orders</h1>
        <p style={S.loginSub}>Powered by XoroERP</p>
        <input style={S.input} placeholder="Name" value={loginName}
          onChange={e => setLoginName(e.target.value)}
          onKeyDown={e => e.key === "Enter" && handleLogin()} />
        <input style={S.input} placeholder="Password" type="password" value={loginPass}
          onChange={e => setLoginPass(e.target.value)}
          onKeyDown={e => e.key === "Enter" && handleLogin()} />
        {loginErr && <p style={S.err}>{loginErr}</p>}
        <button style={S.btnPrimary} onClick={handleLogin}>Sign In</button>
      </div>
    </div>
  );

  // ════════════════════════════════════════════════════════════════════════════
  // SETTINGS MODAL
  // ════════════════════════════════════════════════════════════════════════════
  const SettingsModal = () => (
    <div style={S.modalOverlay} onClick={() => setShowSettings(false)}>
      <div style={S.modal} onClick={e => e.stopPropagation()}>
        <div style={S.modalHeader}>
          <h2 style={S.modalTitle}>⚙️ Settings</h2>
          <button style={S.closeBtn} onClick={() => setShowSettings(false)}>✕</button>
        </div>
        <div style={S.modalBody}>
          <h3 style={S.settingSection}>Xoro API Credentials</h3>
          <p style={{ color: "#9CA3AF", fontSize: 13, marginBottom: 12 }}>
            These are stored in your <code>.env</code> file as <code>VITE_XORO_API_KEY</code> and <code>VITE_XORO_API_SECRET</code>.
            Changing them here applies only for this session.
          </p>
          <label style={S.label}>API Key</label>
          <input style={S.input} value={xoroCreds.key}
            onChange={e => setXoroCreds(p => ({ ...p, key: e.target.value }))}
            placeholder="Your Xoro API Key" />
          <label style={S.label}>API Secret</label>
          <input style={S.input} type="password" value={xoroCreds.secret}
            onChange={e => setXoroCreds(p => ({ ...p, secret: e.target.value }))}
            placeholder="Your Xoro API Secret" />

          <h3 style={{ ...S.settingSection, marginTop: 24 }}>Sync Info</h3>
          <p style={{ color: "#9CA3AF", fontSize: 13 }}>
            Last synced: {lastSync ? new Date(lastSync).toLocaleString() : "Never"}
          </p>
          <p style={{ color: "#9CA3AF", fontSize: 13, marginTop: 4 }}>
            POs loaded: {pos.length}
          </p>

          <h3 style={{ ...S.settingSection, marginTop: 24 }}>Status Colors</h3>
          {STATUS_OPTIONS.map(s => (
            <div key={s} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <div style={{ width: 12, height: 12, borderRadius: "50%", background: STATUS_COLORS[s] ?? "#6B7280" }} />
              <span style={{ color: "#E5E7EB", fontSize: 13 }}>{s}</span>
            </div>
          ))}

          <button style={{ ...S.btnPrimary, marginTop: 24 }} onClick={() => { syncFromXoro(); setShowSettings(false); }}>
            🔄 Sync from Xoro Now
          </button>
        </div>
      </div>
    </div>
  );

  // ════════════════════════════════════════════════════════════════════════════
  // PO DETAIL PANEL
  // ════════════════════════════════════════════════════════════════════════════
  const DetailPanel = () => {
    if (!selected) return null;
    const items = selected.Items ?? selected.PoLineArr ?? [];
    const days  = daysUntil(selected.DateExpectedDelivery);
    const total = poTotal(selected);
    const statusColor = STATUS_COLORS[selected.StatusName ?? ""] ?? "#6B7280";

    return (
      <div style={S.detailOverlay} onClick={() => setSelected(null)}>
        <div style={S.detailPanel} onClick={e => e.stopPropagation()}>
          {/* Header */}
          <div style={{ ...S.detailHeader, borderLeft: `4px solid ${statusColor}` }}>
            <div>
              <div style={S.detailPONum}>{selected.PoNumber ?? "—"}</div>
              <div style={S.detailVendor}>{selected.VendorName ?? "Unknown Vendor"}</div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ ...S.badge, background: statusColor + "33", color: statusColor, border: `1px solid ${statusColor}66` }}>
                {selected.StatusName ?? "Unknown"}
              </span>
              <button style={S.closeBtn} onClick={() => setSelected(null)}>✕</button>
            </div>
          </div>

          <div style={S.detailBody}>
            {/* Key info grid */}
            <div style={S.infoGrid}>
              <InfoCell label="Order Date"     value={fmtDate(selected.DateOrder)} />
              <InfoCell label="Vendor Req Date" value={fmtDate(selected.VendorReqDate)} />
              <InfoCell label="Expected Delivery" value={
                <span style={{ color: days !== null && days < 0 ? "#EF4444" : days !== null && days <= 7 ? "#F59E0B" : "#10B981" }}>
                  {fmtDate(selected.DateExpectedDelivery)}
                  {days !== null && <span style={{ fontSize: 11, marginLeft: 6 }}>
                    {days < 0 ? `${Math.abs(days)}d overdue` : days === 0 ? "Today!" : `in ${days}d`}
                  </span>}
                </span>
              } />
              <InfoCell label="Total Value" value={fmtCurrency(total, selected.CurrencyCode)} />
              <InfoCell label="Currency"    value={selected.CurrencyCode ?? "—"} />
              <InfoCell label="Payment Terms" value={selected.PaymentTermsName ?? "—"} />
              <InfoCell label="Ship Method"  value={selected.ShipMethodName ?? "—"} />
              <InfoCell label="Carrier"      value={selected.CarrierName ?? "—"} />
              <InfoCell label="Buyer"        value={selected.BuyerName ?? "—"} />
            </div>

            {selected.Memo && (
              <div style={S.memoBox}>
                <div style={S.sectionLabel}>Memo</div>
                <p style={{ color: "#D1D5DB", fontSize: 14, margin: 0 }}>{selected.Memo}</p>
              </div>
            )}

            {selected.Tags && (
              <div style={{ marginBottom: 16 }}>
                <div style={S.sectionLabel}>Tags</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {selected.Tags.split(",").map(t => (
                    <span key={t} style={S.tagChip}>{t.trim()}</span>
                  ))}
                </div>
              </div>
            )}

            {/* Line items */}
            {items.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <div style={S.sectionLabel}>Line Items ({items.length})</div>
                <div style={S.itemsTable}>
                  <div style={S.itemsHeader}>
                    <span>SKU</span><span>Description</span><span>Qty</span><span>Unit Price</span><span>Total</span>
                  </div>
                  {items.map((item, i) => (
                    <div key={i} style={S.itemRow}>
                      <span style={{ color: "#60A5FA", fontFamily: "monospace" }}>{item.ItemNumber ?? "—"}</span>
                      <span style={{ color: "#D1D5DB" }}>{item.Description ?? "—"}</span>
                      <span style={{ color: "#E5E7EB", textAlign: "right" }}>{item.QtyOrder ?? 0}</span>
                      <span style={{ color: "#E5E7EB", textAlign: "right" }}>{fmtCurrency(item.UnitPrice, selected.CurrencyCode)}</span>
                      <span style={{ color: "#10B981", textAlign: "right", fontWeight: 600 }}>
                        {fmtCurrency((item.QtyOrder ?? 0) * (item.UnitPrice ?? 0), selected.CurrencyCode)}
                      </span>
                    </div>
                  ))}
                  <div style={S.itemsTotal}>
                    <span style={{ gridColumn: "1/5", textAlign: "right", color: "#9CA3AF" }}>Total</span>
                    <span style={{ color: "#10B981", fontWeight: 700 }}>{fmtCurrency(total, selected.CurrencyCode)}</span>
                  </div>
                </div>
              </div>
            )}

            {/* Notes */}
            <div>
              <div style={S.sectionLabel}>Notes & Updates</div>
              {selectedNotes.length === 0 && <p style={{ color: "#6B7280", fontSize: 13 }}>No notes yet.</p>}
              {selectedNotes.map(n => (
                <div key={n.id} style={S.noteCard}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <span style={{ color: "#60A5FA", fontWeight: 600, fontSize: 13 }}>{n.user_name}</span>
                    <span style={{ color: "#6B7280", fontSize: 11 }}>{new Date(n.created_at).toLocaleString()}</span>
                  </div>
                  {n.status_override && (
                    <span style={{ ...S.badge, background: (STATUS_COLORS[n.status_override] ?? "#6B7280") + "33", color: STATUS_COLORS[n.status_override] ?? "#6B7280", marginBottom: 6, display: "inline-block" }}>
                      Status: {n.status_override}
                    </span>
                  )}
                  <p style={{ color: "#D1D5DB", fontSize: 14, margin: 0 }}>{n.note}</p>
                </div>
              ))}
              <div style={{ marginTop: 12, display: "flex", gap: 8, flexDirection: "column" }}>
                <select style={S.select} value={noteStatus} onChange={e => setNoteStatus(e.target.value)}>
                  <option value="">No status change</option>
                  {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                <textarea style={S.textarea} rows={3} placeholder="Add a note..."
                  value={newNote} onChange={e => setNewNote(e.target.value)} />
                <button style={S.btnPrimary} onClick={addNote}>Add Note</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  };

  function InfoCell({ label, value }: { label: string; value: React.ReactNode }) {
    return (
      <div style={S.infoCell}>
        <div style={S.infoCellLabel}>{label}</div>
        <div style={S.infoCellValue}>{value}</div>
      </div>
    );
  }

  // ════════════════════════════════════════════════════════════════════════════
  // MAIN RENDER
  // ════════════════════════════════════════════════════════════════════════════
  return (
    <div style={S.app}>
      {/* NAV */}
      <nav style={S.nav}>
        <div style={S.navLeft}>
          <div style={S.navLogo}>PO</div>
          <span style={S.navTitle}>Purchase Orders</span>
          <span style={S.navSub}>via XoroERP</span>
        </div>
        <div style={S.navRight}>
          <button style={view === "dashboard" ? S.navBtnActive : S.navBtn} onClick={() => setView("dashboard")}>Dashboard</button>
          <button style={view === "list"      ? S.navBtnActive : S.navBtn} onClick={() => setView("list")}>All POs</button>
          <button style={S.navBtn} onClick={syncFromXoro} disabled={syncing}>
            {syncing ? "Syncing…" : "🔄 Sync"}
          </button>
          <button style={S.navBtn} onClick={() => setShowSettings(true)}>⚙️ Settings</button>
          <div style={S.userPill}>{user.name}</div>
          <button style={S.navBtnDanger} onClick={() => setUser(null)}>Sign Out</button>
        </div>
      </nav>

      {/* SYNC ERROR */}
      {syncErr && (
        <div style={S.errBanner}>
          ⚠️ Xoro sync error: {syncErr}
          <button style={{ marginLeft: 12, color: "#FCA5A5", background: "none", border: "none", cursor: "pointer" }} onClick={() => setSyncErr("")}>✕</button>
        </div>
      )}

      <div style={S.content}>
        {/* ── DASHBOARD ── */}
        {view === "dashboard" && (
          <>
            {/* Stats */}
            <div style={S.statsRow}>
              <StatCard label="Total POs"       value={pos.length}                        color="#3B82F6" icon="📋" />
              <StatCard label="Total Value"     value={fmtCurrency(totalValue)}            color="#10B981" icon="💰" />
              <StatCard label="Overdue"         value={overdue}                            color="#EF4444" icon="⚠️" />
              <StatCard label="Due This Week"   value={dueThisWeek}                        color="#F59E0B" icon="📅" />
            </div>

            {/* Status breakdown */}
            <div style={S.card}>
              <h3 style={S.cardTitle}>POs by Status</h3>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                {STATUS_OPTIONS.map(s => {
                  const count = pos.filter(p => p.StatusName === s).length;
                  if (!count) return null;
                  const color = STATUS_COLORS[s] ?? "#6B7280";
                  return (
                    <div key={s} style={{ ...S.statusChip, background: color + "22", border: `1px solid ${color}44`, cursor: "pointer" }}
                      onClick={() => { setFilterStatus(s); setView("list"); }}>
                      <div style={{ width: 8, height: 8, borderRadius: "50%", background: color }} />
                      <span style={{ color, fontWeight: 600 }}>{count}</span>
                      <span style={{ color: "#9CA3AF" }}>{s}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Recent POs */}
            <div style={S.card}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <h3 style={S.cardTitle}>Recent Purchase Orders</h3>
                <button style={S.btnSecondary} onClick={() => setView("list")}>View All →</button>
              </div>
              {loading && <p style={{ color: "#6B7280" }}>Loading…</p>}
              {!loading && pos.length === 0 && (
                <div style={S.emptyState}>
                  <p>No purchase orders loaded.</p>
                  <button style={S.btnPrimary} onClick={syncFromXoro} disabled={syncing}>
                    {syncing ? "Syncing…" : "🔄 Sync from Xoro"}
                  </button>
                </div>
              )}
              {pos.slice(0, 8).map((po, i) => <PORow key={i} po={po} onClick={() => { setSelected(po); }} />)}
            </div>
          </>
        )}

        {/* ── ALL POs ── */}
        {view === "list" && (
          <>
            <div style={S.filters}>
              <input style={{ ...S.input, flex: 1, marginBottom: 0 }} placeholder="🔍 Search PO#, vendor, memo, tags…"
                value={search} onChange={e => setSearch(e.target.value)} />
              <select style={{ ...S.select, width: 160 }} value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
                <option value="All">All Statuses</option>
                {STATUS_OPTIONS.map(s => <option key={s}>{s}</option>)}
              </select>
              <select style={{ ...S.select, width: 180 }} value={filterVendor} onChange={e => setFilterVendor(e.target.value)}>
                {vendors.map(v => <option key={v}>{v}</option>)}
              </select>
              <button style={S.btnSecondary} onClick={() => { setSearch(""); setFilterStatus("All"); setFilterVendor("All"); }}>
                Clear
              </button>
            </div>
            <div style={S.card}>
              <div style={{ marginBottom: 12, color: "#9CA3AF", fontSize: 13 }}>
                Showing {filtered.length} of {pos.length} purchase orders
                {lastSync && <span style={{ marginLeft: 12 }}>· Last synced: {new Date(lastSync).toLocaleString()}</span>}
              </div>
              {loading && <p style={{ color: "#6B7280" }}>Loading…</p>}
              {!loading && filtered.length === 0 && (
                <div style={S.emptyState}>
                  <p>{pos.length === 0 ? "No POs loaded. Click Sync to fetch from Xoro." : "No POs match your filters."}</p>
                  {pos.length === 0 && <button style={S.btnPrimary} onClick={syncFromXoro} disabled={syncing}>🔄 Sync from Xoro</button>}
                </div>
              )}
              {filtered.map((po, i) => <PORow key={i} po={po} onClick={() => setSelected(po)} detailed />)}
            </div>
          </>
        )}
      </div>

      {selected    && <DetailPanel />}
      {showSettings && <SettingsModal />}
    </div>
  );

  function StatCard({ label, value, color, icon }: { label: string; value: string | number; color: string; icon: string }) {
    return (
      <div style={{ ...S.statCard, borderTop: `3px solid ${color}` }}>
        <div style={{ fontSize: 24 }}>{icon}</div>
        <div style={{ fontSize: 28, fontWeight: 700, color, fontFamily: "monospace" }}>{value}</div>
        <div style={{ color: "#9CA3AF", fontSize: 13 }}>{label}</div>
      </div>
    );
  }

  function PORow({ po, onClick, detailed }: { po: XoroPO; onClick: () => void; detailed?: boolean }) {
    const color = STATUS_COLORS[po.StatusName ?? ""] ?? "#6B7280";
    const days  = daysUntil(po.DateExpectedDelivery);
    const total = poTotal(po);
    const items = po.Items ?? po.PoLineArr ?? [];
    return (
      <div style={{ ...S.poRow, borderLeft: `3px solid ${color}` }} onClick={onClick}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
            <span style={S.poNumber}>{po.PoNumber ?? "—"}</span>
            <span style={{ ...S.badge, background: color + "22", color, border: `1px solid ${color}44` }}>
              {po.StatusName ?? "Unknown"}
            </span>
            {days !== null && days < 0 && <span style={{ ...S.badge, background: "#EF444422", color: "#EF4444", border: "1px solid #EF444444" }}>⚠️ Overdue</span>}
            {days !== null && days >= 0 && days <= 7 && <span style={{ ...S.badge, background: "#F59E0B22", color: "#F59E0B", border: "1px solid #F59E0B44" }}>📅 Due Soon</span>}
          </div>
          <div style={{ color: "#D1D5DB", fontWeight: 600 }}>{po.VendorName ?? "Unknown Vendor"}</div>
          {detailed && po.Memo && <div style={{ color: "#6B7280", fontSize: 12, marginTop: 2 }}>{po.Memo}</div>}
        </div>
        <div style={{ textAlign: "right", minWidth: 160 }}>
          <div style={{ color: "#10B981", fontWeight: 700, fontSize: 16 }}>{fmtCurrency(total, po.CurrencyCode)}</div>
          {detailed && <div style={{ color: "#6B7280", fontSize: 12 }}>{items.length} line items</div>}
          <div style={{ color: "#9CA3AF", fontSize: 12, marginTop: 4 }}>
            Exp: {fmtDate(po.DateExpectedDelivery)}
          </div>
        </div>
      </div>
    );
  }
}

// ── Styles ────────────────────────────────────────────────────────────────────
const S: Record<string, React.CSSProperties> = {
  app:        { minHeight: "100vh", background: "#0F172A", color: "#F1F5F9", fontFamily: "'DM Sans', 'Segoe UI', sans-serif" },
  loginBg:    { minHeight: "100vh", background: "#0F172A", display: "flex", alignItems: "center", justifyContent: "center" },
  loginCard:  { background: "#1E293B", borderRadius: 16, padding: 40, width: 360, boxShadow: "0 24px 64px rgba(0,0,0,.5)", display: "flex", flexDirection: "column", gap: 14 },
  loginLogo:  { width: 56, height: 56, borderRadius: 14, background: "linear-gradient(135deg,#3B82F6,#8B5CF6)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: 22, alignSelf: "center" },
  loginTitle: { margin: 0, textAlign: "center", fontSize: 22, fontWeight: 700, color: "#F1F5F9" },
  loginSub:   { margin: 0, textAlign: "center", fontSize: 13, color: "#6B7280" },

  nav:        { background: "#1E293B", borderBottom: "1px solid #334155", padding: "0 24px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 56, position: "sticky", top: 0, zIndex: 100 },
  navLeft:    { display: "flex", alignItems: "center", gap: 12 },
  navLogo:    { width: 32, height: 32, borderRadius: 8, background: "linear-gradient(135deg,#3B82F6,#8B5CF6)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: 13 },
  navTitle:   { fontWeight: 700, fontSize: 16, color: "#F1F5F9" },
  navSub:     { fontSize: 12, color: "#6B7280" },
  navRight:   { display: "flex", alignItems: "center", gap: 8 },
  navBtn:     { background: "none", border: "1px solid #334155", color: "#94A3B8", borderRadius: 6, padding: "5px 12px", fontSize: 13, cursor: "pointer" },
  navBtnActive:{ background: "#3B82F620", border: "1px solid #3B82F6", color: "#60A5FA", borderRadius: 6, padding: "5px 12px", fontSize: 13, cursor: "pointer", fontWeight: 600 },
  navBtnDanger:{ background: "none", border: "1px solid #EF4444", color: "#EF4444", borderRadius: 6, padding: "5px 12px", fontSize: 13, cursor: "pointer" },
  userPill:   { background: "#334155", color: "#94A3B8", borderRadius: 20, padding: "4px 12px", fontSize: 12 },

  content:    { maxWidth: 1200, margin: "0 auto", padding: "24px 20px" },
  statsRow:   { display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16, marginBottom: 20 },
  statCard:   { background: "#1E293B", borderRadius: 12, padding: 20, display: "flex", flexDirection: "column", gap: 6 },
  card:       { background: "#1E293B", borderRadius: 12, padding: 20, marginBottom: 20 },
  cardTitle:  { margin: "0 0 16px", fontSize: 16, fontWeight: 700, color: "#F1F5F9" },

  filters:    { display: "flex", gap: 10, marginBottom: 16, alignItems: "center" },

  poRow:      { display: "flex", alignItems: "center", gap: 16, padding: "14px 16px", borderRadius: 8, marginBottom: 8, background: "#0F172A", cursor: "pointer", transition: "background .15s" },
  poNumber:   { fontFamily: "monospace", color: "#60A5FA", fontWeight: 700, fontSize: 15 },
  badge:      { fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 20 },
  tagChip:    { background: "#334155", color: "#94A3B8", borderRadius: 20, padding: "3px 10px", fontSize: 12 },
  statusChip: { display: "flex", alignItems: "center", gap: 6, borderRadius: 20, padding: "6px 14px", fontSize: 13 },

  emptyState: { textAlign: "center", padding: 40, color: "#6B7280", display: "flex", flexDirection: "column", gap: 12, alignItems: "center" },

  input:      { width: "100%", background: "#0F172A", border: "1px solid #334155", borderRadius: 8, padding: "10px 14px", color: "#F1F5F9", fontSize: 14, outline: "none", boxSizing: "border-box" },
  select:     { background: "#0F172A", border: "1px solid #334155", borderRadius: 8, padding: "9px 12px", color: "#F1F5F9", fontSize: 13, outline: "none" },
  textarea:   { width: "100%", background: "#0F172A", border: "1px solid #334155", borderRadius: 8, padding: "10px 14px", color: "#F1F5F9", fontSize: 14, resize: "vertical", outline: "none", fontFamily: "inherit", boxSizing: "border-box" },
  label:      { color: "#94A3B8", fontSize: 13, display: "block", marginBottom: 4 },
  err:        { color: "#EF4444", fontSize: 13, margin: 0 },
  errBanner:  { background: "#7F1D1D", color: "#FCA5A5", padding: "10px 24px", fontSize: 14, display: "flex", alignItems: "center" },

  btnPrimary: { background: "linear-gradient(135deg,#3B82F6,#8B5CF6)", color: "#fff", border: "none", borderRadius: 8, padding: "10px 20px", fontWeight: 600, fontSize: 14, cursor: "pointer", width: "100%" },
  btnSecondary:{ background: "none", border: "1px solid #334155", color: "#94A3B8", borderRadius: 8, padding: "8px 16px", fontSize: 13, cursor: "pointer" },

  // Modal
  modalOverlay:{ position: "fixed", inset: 0, background: "rgba(0,0,0,.7)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center" },
  modal:       { background: "#1E293B", borderRadius: 16, width: 480, maxHeight: "80vh", overflow: "hidden", display: "flex", flexDirection: "column" },
  modalHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 20px", borderBottom: "1px solid #334155" },
  modalTitle:  { margin: 0, fontSize: 18, fontWeight: 700, color: "#F1F5F9" },
  modalBody:   { padding: 20, overflowY: "auto" },
  closeBtn:    { background: "none", border: "none", color: "#6B7280", fontSize: 18, cursor: "pointer", lineHeight: 1 },
  settingSection:{ color: "#F1F5F9", fontSize: 15, fontWeight: 700, margin: "0 0 10px" },

  // Detail panel
  detailOverlay:{ position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", zIndex: 200, display: "flex", justifyContent: "flex-end" },
  detailPanel:  { background: "#1E293B", width: 600, maxWidth: "90vw", height: "100%", overflowY: "auto", display: "flex", flexDirection: "column" },
  detailHeader: { padding: "20px 24px", borderBottom: "1px solid #334155", display: "flex", justifyContent: "space-between", alignItems: "flex-start", background: "#0F172A" },
  detailPONum:  { fontFamily: "monospace", color: "#60A5FA", fontWeight: 800, fontSize: 20 },
  detailVendor: { color: "#D1D5DB", fontWeight: 600, fontSize: 15, marginTop: 4 },
  detailBody:   { padding: 24, flex: 1 },

  infoGrid:     { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 20 },
  infoCell:     { background: "#0F172A", borderRadius: 8, padding: 12 },
  infoCellLabel:{ color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 },
  infoCellValue:{ color: "#F1F5F9", fontSize: 14, fontWeight: 600 },

  memoBox:      { background: "#0F172A", borderRadius: 8, padding: 14, marginBottom: 16 },
  sectionLabel: { color: "#6B7280", fontSize: 12, textTransform: "uppercase", letterSpacing: 1, marginBottom: 10, fontWeight: 600 },

  itemsTable:   { background: "#0F172A", borderRadius: 8, overflow: "hidden" },
  itemsHeader:  { display: "grid", gridTemplateColumns: "1fr 2fr 80px 100px 100px", padding: "10px 14px", background: "#1E293B", color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, gap: 8 },
  itemRow:      { display: "grid", gridTemplateColumns: "1fr 2fr 80px 100px 100px", padding: "10px 14px", borderTop: "1px solid #1E293B", gap: 8, fontSize: 13 },
  itemsTotal:   { display: "grid", gridTemplateColumns: "1fr 2fr 80px 100px 100px", padding: "12px 14px", borderTop: "2px solid #334155", gap: 8, background: "#1A2332" },

  noteCard:     { background: "#0F172A", borderRadius: 8, padding: 14, marginBottom: 10 },
};

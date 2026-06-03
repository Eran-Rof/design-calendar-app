// Costing Module — saved projects list
//
// Columns: project_name, brand, customer code, sales rep, status, due_date.
// Buttons: New project, Open (row), Delete (row).
// ExportButton mounted per project rule (xlsx-only).

import React, { useEffect, useState } from "react";
import { useCostingStore } from "../store/costingStore";
import { fmtDateDisplay, statusLabel, statusColor, navigate, defaultProjectDates } from "../helpers";
import { appConfirm } from "../../utils/theme";
import ExportButton from "../../tanda/exports/ExportButton";
import { stripExcelPrefix } from "../services/costingApi";
import type { CostingProject, CostingStatus } from "../types";

// Canonical dark-slate palette (matches the Tangerine Internal* modals).
const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", inputBg: "#0b1220",
};

// WIP-pipeline tab split (modeled on the Tanda PO detail fused-tab strip).
// "Active" folds the three working stages; the outcome stages each get a tab.
type TabKey = "all" | "active" | "awarded" | "closed" | "cancelled";
const ACTIVE_STATUSES: CostingStatus[] = ["draft", "in_progress", "quoted"];
const TABS: { key: TabKey; label: string; match: (s: CostingStatus) => boolean }[] = [
  { key: "all",       label: "All",       match: () => true },
  { key: "active",    label: "Active",    match: (s) => ACTIVE_STATUSES.includes(s) },
  { key: "awarded",   label: "Awarded",   match: (s) => s === "awarded" },
  { key: "closed",    label: "Closed",    match: (s) => s === "closed" },
  { key: "cancelled", label: "Cancelled", match: (s) => s === "cancelled" },
];

export default function ProjectListView() {
  const projects = useCostingStore((s) => s.projects);
  const loading  = useCostingStore((s) => s.loading);
  const error    = useCostingStore((s) => s.error);
  const list     = useCostingStore((s) => s.listProjects);
  const create   = useCostingStore((s) => s.createProject);
  const del      = useCostingStore((s) => s.deleteProject);
  const setNotice = useCostingStore((s) => s.setNotice);

  // New-project modal state (replaces native window.prompt).
  const [newModalOpen, setNewModalOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  // Active WIP tab — filters the grid by status bucket.
  const [tab, setTab] = useState<TabKey>("all");

  useEffect(() => { list(); }, [list]);

  // Per-tab counts (off the full list) + the rows the active tab shows.
  const tabCounts = React.useMemo(() => {
    const counts: Record<TabKey, number> = { all: 0, active: 0, awarded: 0, closed: 0, cancelled: 0 };
    for (const t of TABS) counts[t.key] = projects.filter((p) => t.match(p.status)).length;
    return counts;
  }, [projects]);

  const activeTab = TABS.find((t) => t.key === tab) ?? TABS[0];
  const visible = React.useMemo(
    () => projects.filter((p) => activeTab.match(p.status)),
    [projects, activeTab],
  );

  const onNew = React.useCallback(() => { setNewName(""); setNewModalOpen(true); }, []);

  // NavBar's "+ New" button fires this event after navigating here.
  useEffect(() => {
    const open = () => onNew();
    window.addEventListener("costing:new-project", open as EventListener);
    return () => window.removeEventListener("costing:new-project", open as EventListener);
  }, [onNew]);

  const submitNew = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      // Prefill the three header dates so the operator doesn't start with
      // empty fields: request=today, due=+5 business days, delivery=+120d
      // snapped to the 1st of that month.
      const p = await create({ project_name: name, ...defaultProjectDates() });
      setNewModalOpen(false);
      navigate("edit", p.id);
    } catch (e) {
      setNotice(`Could not create project: ${(e as Error).message}`);
    } finally {
      setCreating(false);
    }
  };

  const onOpen = (id: string) => navigate("edit", id);
  const onDelete = (p: CostingProject) => {
    appConfirm(
      `Delete "${p.project_name}"? This cascades to all lines, quotes, and compliance rows.`,
      "Delete",
      async () => {
        try { await del(p.id); }
        catch (e) { setNotice(`Could not delete: ${(e as Error).message}`); }
      },
    );
  };

  // Export follows the active tab — what you see is what you export.
  const exportRows = visible.map((p) => ({
    project_name: p.project_name,
    brand: p.brand || "",
    gender_code: p.gender_code || "",
    customer_code: (p.customer as { display_name?: string | null } | null | undefined)?.display_name || stripExcelPrefix(p.customer?.code) || "",
    sales_rep: p.sales_rep?.display_name || "",
    status: statusLabel(p.status),
    request_date: p.request_date ? fmtDateDisplay(p.request_date) : "",
    due_date: p.due_date ? fmtDateDisplay(p.due_date) : "",
    projected_delivery_date: p.projected_delivery_date ? fmtDateDisplay(p.projected_delivery_date) : "",
    created_at: p.created_at ? fmtDateDisplay(p.created_at.slice(0, 10)) : "",
  }));

  return (
    <div style={{ padding: "20px 24px", background: "#0F172A", minHeight: "100%", color: "#E2E8F0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Costing Projects</h2>
        <div style={{ marginLeft: "auto" }}>
          <ExportButton rows={exportRows} filename="costing-projects" sheetName="Projects" />
        </div>
      </div>

      {loading && <div style={{ color: "#94A3B8", fontSize: 13 }}>Loading…</div>}
      {error && <div style={{ color: "#F87171", fontSize: 13, padding: 8, background: "#7F1D1D33", borderRadius: 4 }}>{error}</div>}

      {/* WIP tab strip — fused into the panel below (Tanda PO-detail model). */}
      <div style={{ display: "flex", gap: 2, marginBottom: 0 }}>
        {TABS.map((t) => (
          <button key={t.key} style={tabStyle(t.key === tab)} onClick={() => setTab(t.key)}>
            {t.label}
            <span style={{
              marginLeft: 8, fontSize: 12, fontWeight: 700, fontFamily: "monospace",
              color: t.key === tab ? "#93C5FD" : "#64748B",
            }}>{tabCounts[t.key]}</span>
          </button>
        ))}
      </div>

      <div style={{ border: "1px solid #334155", borderTop: "none", borderRadius: "0 0 10px 10px", background: "#1E293B", overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead style={{ background: "#0F172A" }}>
            <tr>
              <Th>Project</Th>
              <Th>Brand</Th>
              <Th>Gender</Th>
              <Th>Customer</Th>
              <Th>Sales Rep</Th>
              <Th>Status</Th>
              <Th>Due</Th>
              <Th>Created</Th>
              <Th></Th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && !loading && (
              <tr><td colSpan={9} style={{ padding: 24, textAlign: "center", color: "#64748B" }}>
                {projects.length === 0
                  ? 'No projects yet — click "+ New" in the top nav to get started.'
                  : `No ${activeTab.label.toLowerCase()} projects.`}
              </td></tr>
            )}
            {visible.map((p) => {
              const sc = statusColor(p.status);
              return (
                <tr
                  key={p.id}
                  onClick={() => onOpen(p.id)}
                  style={{ borderTop: "1px solid #334155", cursor: "pointer" }}
                  // #334155 matches the grid row hover (PR #570) — #1E293B
                  // was too close to the table bg so the hover was invisible.
                  onMouseEnter={(e) => { e.currentTarget.style.background = "#334155"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                  title="Click to edit"
                >
                  <Td><span style={{ color: "#60A5FA", fontWeight: 600 }}>{p.project_name}</span></Td>
                  <Td>{p.brand || "—"}</Td>
                  <Td>{p.gender_code || "—"}</Td>
                  <Td>{(p.customer as { display_name?: string | null } | null | undefined)?.display_name || stripExcelPrefix(p.customer?.code) || "—"}</Td>
                  <Td>{p.sales_rep?.display_name || "—"}</Td>
                  <Td>
                    <span style={{ background: sc.bg, color: sc.fg, padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600 }}>
                      {statusLabel(p.status)}
                    </span>
                  </Td>
                  <Td>{p.due_date ? fmtDateDisplay(p.due_date) : "—"}</Td>
                  <Td>{p.created_at ? fmtDateDisplay(p.created_at.slice(0, 10)) : "—"}</Td>
                  <Td>
                    <button
                      onClick={(e) => { e.stopPropagation(); onDelete(p); }}
                      style={rowBtn("#EF4444")}
                    >Delete</button>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {newModalOpen && (
        <div
          onClick={() => { if (!creating) setNewModalOpen(false); }}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
            display: "flex", alignItems: "center", justifyContent: "center",
            zIndex: 1000, padding: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: C.card, border: `1px solid ${C.cardBdr}`,
              borderRadius: 10, padding: 0, width: "100%", maxWidth: 480,
              color: C.text, boxShadow: "0 24px 60px rgba(0,0,0,0.55)",
            }}
          >
            <div style={{
              display: "flex", justifyContent: "space-between", alignItems: "center",
              padding: "16px 20px", borderBottom: `1px solid ${C.cardBdr}`,
            }}>
              <span style={{ fontSize: 17, fontWeight: 700, color: C.text }}>New costing project</span>
              <button
                onClick={() => { if (!creating) setNewModalOpen(false); }}
                style={{ background: "none", border: "none", color: C.textMuted, cursor: "pointer", fontSize: 24, lineHeight: 1, padding: 2 }}
              >×</button>
            </div>
            <div style={{ padding: "18px 20px 22px" }}>
              <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: C.textMuted, marginBottom: 6, letterSpacing: ".06em", textTransform: "uppercase" }}>
                Project name
              </label>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && newName.trim()) submitNew(); }}
                placeholder='e.g. "BOYS 7/1 DDP QTN"'
                autoFocus
                style={{
                  width: "100%", padding: "9px 12px", fontSize: 14, boxSizing: "border-box",
                  border: `1px solid ${C.cardBdr}`, borderRadius: 6, outline: "none",
                  fontFamily: "inherit", color: C.text, background: C.inputBg,
                }}
              />
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
                <button
                  onClick={() => setNewModalOpen(false)}
                  disabled={creating}
                  style={{
                    background: "transparent", color: C.textSub,
                    border: `1px solid ${C.cardBdr}`, padding: "7px 18px",
                    borderRadius: 6, cursor: creating ? "not-allowed" : "pointer",
                    fontSize: 13, fontWeight: 500, fontFamily: "inherit",
                  }}
                >Cancel</button>
                <button
                  onClick={submitNew}
                  disabled={!newName.trim() || creating}
                  style={{
                    background: C.primary, color: "#fff",
                    border: "none", padding: "7px 18px",
                    borderRadius: 6, cursor: (!newName.trim() || creating) ? "not-allowed" : "pointer",
                    fontSize: 13, fontWeight: 600, fontFamily: "inherit",
                    opacity: (!newName.trim() || creating) ? 0.55 : 1,
                  }}
                >{creating ? "Creating…" : "Create"}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th style={{ textAlign: "left", padding: "8px 12px", fontWeight: 600, fontSize: 11, color: "#94A3B8", textTransform: "uppercase", letterSpacing: ".06em" }}>{children}</th>;
}
function Td({ children }: { children: React.ReactNode }) {
  return <td style={{ padding: "8px 12px", color: "#E2E8F0" }}>{children}</td>;
}
function rowBtn(color: string): React.CSSProperties {
  return {
    background: "transparent", color, border: `1px solid ${color}`,
    padding: "3px 10px", borderRadius: 3, cursor: "pointer", fontSize: 11, marginRight: 4,
  };
}
// Fused WIP tab button — active tab merges into the panel below (no bottom
// border, -1px overlap). Lifted verbatim from the Tanda PO-detail tab strip.
function tabStyle(active: boolean): React.CSSProperties {
  return {
    flex: 1, padding: "11px 18px", fontSize: 14, cursor: "pointer", fontWeight: 700,
    fontFamily: "inherit",
    border: "1px solid #334155", borderBottom: active ? "none" : "1px solid #334155",
    background: active ? "#1E293B" : "#0F172A",
    color: active ? "#60A5FA" : "#6B7280",
    borderRadius: "10px 10px 0 0",
    marginBottom: active ? -1 : 0,
    position: "relative", zIndex: active ? 1 : 0,
  };
}

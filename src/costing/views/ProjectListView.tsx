// Costing Module — saved projects list
//
// Columns: project_name, brand, customer code, sales rep, status, due_date.
// Buttons: New project, Open (row), Delete (row).
// ExportButton mounted per project rule (xlsx-only).

import React, { useEffect, useState } from "react";
import { useCostingStore } from "../store/costingStore";
import { fmtDateDisplay, statusLabel, statusColor, navigate } from "../helpers";
import { appConfirm } from "../../utils/theme";
import { Modal } from "../../components/Modal";
import ExportButton from "../../tanda/exports/ExportButton";
import type { CostingProject } from "../types";

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

  useEffect(() => { list(); }, [list]);

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
      const p = await create({ project_name: name });
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

  const exportRows = projects.map((p) => ({
    project_name: p.project_name,
    brand: p.brand || "",
    gender_code: p.gender_code || "",
    customer_code: p.customer?.code || "",
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

      <div style={{ overflowX: "auto", border: "1px solid #334155", borderRadius: 6, background: "#1E293B" }}>
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
            {projects.length === 0 && !loading && (
              <tr><td colSpan={9} style={{ padding: 24, textAlign: "center", color: "#64748B" }}>No projects yet — click "+ New" in the top nav to get started.</td></tr>
            )}
            {projects.map((p) => {
              const sc = statusColor(p.status);
              return (
                <tr
                  key={p.id}
                  onClick={() => onOpen(p.id)}
                  style={{ borderTop: "1px solid #334155", cursor: "pointer" }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "#1E293B"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                  title="Click to edit"
                >
                  <Td><span style={{ color: "#60A5FA", fontWeight: 600 }}>{p.project_name}</span></Td>
                  <Td>{p.brand || "—"}</Td>
                  <Td>{p.gender_code || "—"}</Td>
                  <Td>{p.customer?.code || "—"}</Td>
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
        <Modal title="New costing project" onClose={() => setNewModalOpen(false)}>
          <div style={{ padding: "18px 32px 26px" }}>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#4A5568", marginBottom: 6, letterSpacing: ".04em", textTransform: "uppercase" }}>
              Project name
            </label>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && newName.trim()) submitNew(); }}
              placeholder='e.g. "BOYS 7/1 DDP QTN"'
              autoFocus
              style={{
                width: "100%", padding: "10px 12px", fontSize: 14,
                border: "1px solid #CBD5E0", borderRadius: 8, outline: "none",
                fontFamily: "inherit",
              }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
              <button
                onClick={() => setNewModalOpen(false)}
                disabled={creating}
                style={{
                  background: "transparent", color: "#4A5568",
                  border: "1px solid #CBD5E0", padding: "8px 18px",
                  borderRadius: 8, cursor: creating ? "not-allowed" : "pointer",
                  fontSize: 13, fontWeight: 500,
                }}
              >Cancel</button>
              <button
                onClick={submitNew}
                disabled={!newName.trim() || creating}
                style={{
                  background: "#10B981", color: "#fff",
                  border: "none", padding: "8px 18px",
                  borderRadius: 8, cursor: (!newName.trim() || creating) ? "not-allowed" : "pointer",
                  fontSize: 13, fontWeight: 600,
                  opacity: (!newName.trim() || creating) ? 0.55 : 1,
                }}
              >{creating ? "Creating…" : "Create"}</button>
            </div>
          </div>
        </Modal>
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

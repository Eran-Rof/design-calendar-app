import { useEffect, useState } from "react";
import { notify, confirmDialog } from "../shared/ui/warn";
import { AppDatePicker } from "../shared/components/AppDatePicker";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { fmtDateDisplay } from "../utils/tandaTypes";
import SearchableSelect from "./components/SearchableSelect";

interface Vendor { id: string; name: string }
interface Workspace {
  id: string;
  entity_id: string;
  vendor_id: string;
  name: string;
  description: string | null;
  status: "active" | "archived";
  created_at: string;
  vendor?: Vendor | null;
  task_count?: number;
  open_task_count?: number;
  pin_count?: number;
}
interface Pin { id: string; entity_type: string; entity_ref_id: string; label: string | null; pinned_by_type: string; created_at: string; resolved?: { label?: string; status?: string } | null }
interface Task { id: string; title: string; description: string | null; status: string; due_date: string | null; assigned_to_type: string | null; assigned_to: string | null; completed_at: string | null; created_at: string }
interface Message { id: string; sender_name: string; sender_type: string; body: string; created_at: string }

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

export default function InternalWorkspaces() {
  const [entities, setEntities] = useState<{ id: string; name: string }[]>([]);
  const [entityId, setEntityId] = useState("");
  const [rows, setRows] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"active" | "archived">("active");
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<Workspace | null>(null);

  useEffect(() => {
    (async () => {
      const r = await fetch("/api/internal/entities?flat=true");
      if (r.ok) {
        const e = (await r.json()) as { id: string; name: string }[];
        setEntities(e);
        if (e.length && !entityId) setEntityId(e[0].id);
      }
    })();
  }, []);

  async function load() {
    if (!entityId) return;
    setLoading(true); setErr(null);
    try {
      const r = await fetch(`/api/internal/workspaces?entity_id=${entityId}&status=${statusFilter}`);
      if (!r.ok) throw new Error(await r.text());
      const d = await r.json() as { rows: Workspace[] };
      setRows(d.rows || []);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [entityId, statusFilter]);

  if (selected) {
    return <WorkspaceDetail workspace={selected} onBack={() => { setSelected(null); void load(); }} />;
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22 }}>Workspaces</h2>
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>Cross-team collab space with vendors — pin items, assign tasks, chat.</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <div style={{ width: 200 }}>
            <SearchableSelect
              value={entityId || null}
              options={entities.map((e) => ({ value: e.id, label: e.name }))}
              inputStyle={selectSt}
              onChange={(v) => setEntityId(v)}
            />
          </div>
          <div style={{ width: 140 }}>
            <SearchableSelect
              value={statusFilter}
              options={[{ value: "active", label: "Active" }, { value: "archived", label: "Archived" }]}
              inputStyle={selectSt}
              onChange={(v) => setStatusFilter(v as "active" | "archived")}
            />
          </div>
          <button onClick={() => setCreateOpen(true)} style={btnPrimary}>+ New workspace</button>
          <ExportButton
            rows={(() => {
              const base = rows.map((w) => ({
                ...w,
                vendor_name: w.vendor?.name || "—",
              })) as Array<Record<string, unknown>>;
              if (base.length === 0) return base as unknown as Array<Record<string, unknown>>;
              // #23 export totals — append a TOTAL row summing the count columns.
              const totalRow: Record<string, unknown> = {
                name: "TOTAL",
                vendor_name: "",
                description: "",
                status: "",
                pin_count: rows.reduce((s, w) => s + (Number(w.pin_count) || 0), 0),
                open_task_count: rows.reduce((s, w) => s + (Number(w.open_task_count) || 0), 0),
                task_count: rows.reduce((s, w) => s + (Number(w.task_count) || 0), 0),
                created_at: "",
              };
              return [...base, totalRow] as unknown as Array<Record<string, unknown>>;
            })()}
            filename="workspaces"
            sheetName="Workspaces"
            columns={[
              { key: "name",             header: "Name" },
              { key: "vendor_name",      header: "Vendor" },
              { key: "description",      header: "Description" },
              { key: "status",           header: "Status" },
              { key: "pin_count",        header: "Pins",      format: "number" },
              { key: "open_task_count",  header: "Open Tasks", format: "number" },
              { key: "task_count",       header: "Total Tasks", format: "number" },
              { key: "created_at",       header: "Created",   format: "datetime" },
            ] as ExportColumn<Record<string, unknown>>[]}
          />
        </div>
      </div>

      {loading ? <div style={{ color: C.textMuted }}>Loading…</div>
      : err ? <div style={{ color: C.danger }}>Error: {err}</div>
      : rows.length === 0 ? (
        <div style={{ padding: 30, textAlign: "center", color: C.textMuted, fontSize: 13, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8 }}>
          No {statusFilter} workspaces.
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))", gap: 12 }}>
          {rows.map((w) => (
            <button key={w.id} onClick={() => setSelected(w)} style={{ textAlign: "left", cursor: "pointer", background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 14, color: C.text, fontFamily: "inherit" }}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>{w.name}</div>
              <div style={{ fontSize: 11, color: C.textSub, marginTop: 2 }}>Vendor: {w.vendor?.name || "—"}</div>
              {w.description && <div style={{ fontSize: 12, color: C.textMuted, marginTop: 6, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{w.description}</div>}
              <div style={{ display: "flex", gap: 8, fontSize: 11, color: C.textMuted, marginTop: 10 }}>
                <span>Pins {w.pin_count || 0}</span>
                <span>{w.open_task_count || 0} open / {w.task_count || 0}</span>
                <span style={{ marginLeft: "auto" }}>{fmtDateDisplay(w.created_at)}</span>
              </div>
            </button>
          ))}
        </div>
      )}

      {createOpen && entityId && (
        <CreateWorkspaceModal
          entityId={entityId}
          onClose={() => setCreateOpen(false)}
          onCreated={() => { setCreateOpen(false); void load(); }}
        />
      )}
    </div>
  );
}

function CreateWorkspaceModal({ entityId, onClose, onCreated }: { entityId: string; onClose: () => void; onCreated: () => void }) {
  const [vendorId, setVendorId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const r = await fetch("/api/internal/vendors");
      if (r.ok) {
        const d = await r.json() as { rows?: Vendor[] } | Vendor[];
        const list = Array.isArray(d) ? d : (d.rows || []);
        setVendors(list);
      }
    })();
  }, []);

  async function save() {
    if (!vendorId || !name.trim()) { notify("Vendor and name are required.", "error"); return; }
    setSaving(true);
    try {
      const r = await fetch("/api/internal/workspaces", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity_id: entityId, vendor_id: vendorId, name: name.trim(), description: description.trim() || null }),
      });
      if (!r.ok) throw new Error(await r.text());
      onCreated();
    } catch (e: unknown) { notify(e instanceof Error ? e.message : String(e), "error"); }
    finally { setSaving(false); }
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...modal, width: 500 }}>
        <h3 style={{ margin: "0 0 14px", fontSize: 18 }}>New workspace</h3>
        <Row label="Vendor">
          <SearchableSelect
            value={vendorId || null}
            options={vendors.map((v) => ({ value: v.id, label: v.name }))}
            placeholder="Select a vendor…"
            inputStyle={inp}
            onChange={(v) => setVendorId(v)}
          />
        </Row>
        <Row label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Q3 capacity planning" style={inp} /></Row>
        <Row label="Description"><textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} style={{ ...inp, resize: "vertical", fontFamily: "inherit" }} /></Row>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={btnSecondary}>Cancel</button>
          <button onClick={() => void save()} disabled={saving} style={btnPrimary}>{saving ? "Creating…" : "Create"}</button>
        </div>
      </div>
    </div>
  );
}

function WorkspaceDetail({ workspace, onBack }: { workspace: Workspace; onBack: () => void }) {
  const [pins, setPins] = useState<Pin[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [pinModalOpen, setPinModalOpen] = useState(false);
  const [taskModalOpen, setTaskModalOpen] = useState(false);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const r = await fetch(`/api/internal/workspaces/${workspace.id}`);
      if (!r.ok) throw new Error(await r.text());
      const d = await r.json() as { pins: Pin[]; tasks: Task[]; messages: Message[] };
      setPins(d.pins || []); setTasks(d.tasks || []); setMessages(d.messages || []);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [workspace.id]);

  async function removePin(id: string) {
    if (!(await confirmDialog("Remove pin?"))) return;
    const r = await fetch(`/api/internal/workspaces/${workspace.id}/pins/${id}`, { method: "DELETE" });
    if (!r.ok) { notify(await r.text(), "error"); return; }
    await load();
  }

  async function setTaskStatus(taskId: string, status: string) {
    const r = await fetch(`/api/internal/workspaces/${workspace.id}/tasks/${taskId}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!r.ok) { notify(await r.text(), "error"); return; }
    await load();
  }

  async function archive() {
    if (!(await confirmDialog(`Archive workspace "${workspace.name}"?`))) return;
    const r = await fetch(`/api/internal/workspaces/${workspace.id}/archive`, { method: "PUT" });
    if (!r.ok) { notify(await r.text(), "error"); return; }
    onBack();
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, marginBottom: 16 }}>
        <div>
          <button onClick={onBack} style={{ ...btnSecondary, marginBottom: 8 }}>← Back to workspaces</button>
          <h2 style={{ margin: 0, fontSize: 22 }}>{workspace.name}</h2>
          <div style={{ fontSize: 12, color: C.textSub, marginTop: 4 }}>Vendor: {workspace.vendor?.name || "—"}</div>
          {workspace.description && <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4 }}>{workspace.description}</div>}
        </div>
        {workspace.status === "active" && <button onClick={() => void archive()} style={{ ...btnSecondary, color: C.danger }}>Archive</button>}
      </div>

      {err && <div style={{ color: C.danger, marginBottom: 10 }}>Error: {err}</div>}
      {loading ? <div style={{ color: C.textMuted }}>Loading…</div> : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr 1fr", gap: 14, alignItems: "start" }}>
          <Panel title={`Pins (${pins.length})`} style={{ gridColumn: "1" }} action={<button onClick={() => setPinModalOpen(true)} style={btnSecondary}>+ Pin</button>}>
            {pins.length === 0 ? <div style={{ color: C.textMuted, fontSize: 12 }}>No pins yet.</div> : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {pins.map((p) => (
                  <div key={p.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 10px", background: C.bg, border: `1px solid ${C.cardBdr}`, borderRadius: 6 }}>
                    <div style={{ fontSize: 12 }}>
                      <span style={{ textTransform: "uppercase", fontSize: 10, color: C.primary, fontWeight: 700, marginRight: 6 }}>{p.entity_type}</span>
                      {p.label || p.resolved?.label || p.entity_ref_id}
                      {p.resolved?.status && <span style={{ marginLeft: 6, fontSize: 10, color: C.textMuted }}>({p.resolved.status})</span>}
                    </div>
                    <button onClick={() => void removePin(p.id)} style={{ ...btnSecondary, padding: "3px 8px", color: C.danger }}>×</button>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Panel title={`Tasks (${tasks.length})`} style={{ gridColumn: "3" }} action={<button onClick={() => setTaskModalOpen(true)} style={btnSecondary}>+ Task</button>}>
            {tasks.length === 0 ? <div style={{ color: C.textMuted, fontSize: 12 }}>No tasks yet.</div> : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {tasks.map((t) => (
                  <div key={t.id} style={{ padding: "8px 10px", background: C.bg, border: `1px solid ${C.cardBdr}`, borderRadius: 6 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 6 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, textDecoration: t.status === "complete" ? "line-through" : "none" }}>{t.title}</div>
                      <StatusChip status={t.status} />
                    </div>
                    {t.description && <div style={{ fontSize: 11, color: C.textMuted, marginTop: 3 }}>{t.description}</div>}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 6, fontSize: 10, color: C.textMuted }}>
                      <div>{t.due_date ? `Due ${fmtDateDisplay(t.due_date)}` : "No due date"}{t.assigned_to ? ` · @${t.assigned_to}` : ""}</div>
                      <div style={{ display: "flex", gap: 4 }}>
                        {t.status !== "in_progress" && t.status !== "complete" && <button onClick={() => void setTaskStatus(t.id, "in_progress")} style={miniBtn}>Start</button>}
                        {t.status !== "complete" && <button onClick={() => void setTaskStatus(t.id, "complete")} style={{ ...miniBtn, color: C.success }}>Done</button>}
                        {t.status !== "cancelled" && t.status !== "complete" && <button onClick={() => void setTaskStatus(t.id, "cancelled")} style={{ ...miniBtn, color: C.danger }}>Cancel</button>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Panel title={`Messages (${messages.length})`} style={{ gridColumn: "2", gridRow: "1" }}>
            {messages.length === 0 ? <div style={{ color: C.textMuted, fontSize: 12 }}>No messages yet.</div> : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {messages.map((m) => (
                  <div key={m.id} style={{ padding: "8px 10px", background: C.bg, border: `1px solid ${C.cardBdr}`, borderRadius: 6 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: m.sender_type === "internal" ? C.primary : C.success }}>{m.sender_name}</div>
                    <div style={{ fontSize: 12, marginTop: 3 }}>{m.body}</div>
                    <div style={{ fontSize: 10, color: C.textMuted, marginTop: 4 }}>{new Date(m.created_at).toLocaleString()}</div>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>
      )}

      {pinModalOpen && <PinModal workspaceId={workspace.id} onClose={() => setPinModalOpen(false)} onSaved={() => { setPinModalOpen(false); void load(); }} />}
      {taskModalOpen && <TaskModal workspaceId={workspace.id} onClose={() => setTaskModalOpen(false)} onSaved={() => { setTaskModalOpen(false); void load(); }} />}
    </div>
  );
}

function PinModal({ workspaceId, onClose, onSaved }: { workspaceId: string; onClose: () => void; onSaved: () => void }) {
  const [entityType, setEntityType] = useState("po");
  const [entityId, setEntityId] = useState("");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!entityId.trim()) { notify("entity_id is required", "error"); return; }
    setSaving(true);
    try {
      const r = await fetch(`/api/internal/workspaces/${workspaceId}/pins`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity_type: entityType, entity_id: entityId.trim(), label: label.trim() || null }),
      });
      if (!r.ok) throw new Error(await r.text());
      onSaved();
    } catch (e: unknown) { notify(e instanceof Error ? e.message : String(e), "error"); }
    finally { setSaving(false); }
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...modal, width: 480 }}>
        <h3 style={{ margin: "0 0 14px", fontSize: 18 }}>Pin an item</h3>
        <Row label="Entity type">
          <SearchableSelect
            value={entityType}
            options={[
              { value: "po", label: "PO" },
              { value: "invoice", label: "Invoice" },
              { value: "contract", label: "Contract" },
              { value: "rfq", label: "RFQ" },
              { value: "document", label: "Compliance doc" },
            ]}
            inputStyle={inp}
            onChange={(v) => setEntityType(v)}
          />
        </Row>
        <Row label="Entity ID (UUID)"><input value={entityId} onChange={(e) => setEntityId(e.target.value)} placeholder="00000000-..." style={inp} /></Row>
        <Row label="Label (optional)"><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Auto-generated if blank" style={inp} /></Row>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={btnSecondary}>Cancel</button>
          <button onClick={() => void save()} disabled={saving} style={btnPrimary}>{saving ? "Saving…" : "Pin"}</button>
        </div>
      </div>
    </div>
  );
}

function TaskModal({ workspaceId, onClose, onSaved }: { workspaceId: string; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!title.trim()) { notify("Title is required", "error"); return; }
    setSaving(true);
    try {
      const r = await fetch(`/api/internal/workspaces/${workspaceId}/tasks`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), description: description.trim() || null, due_date: dueDate || null }),
      });
      if (!r.ok) throw new Error(await r.text());
      onSaved();
    } catch (e: unknown) { notify(e instanceof Error ? e.message : String(e), "error"); }
    finally { setSaving(false); }
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...modal, width: 480 }}>
        <h3 style={{ margin: "0 0 14px", fontSize: 18 }}>New task</h3>
        <Row label="Title"><input value={title} onChange={(e) => setTitle(e.target.value)} style={inp} /></Row>
        <Row label="Description"><textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} style={{ ...inp, resize: "vertical", fontFamily: "inherit" }} /></Row>
        <Row label="Due date"><AppDatePicker value={dueDate} onCommit={setDueDate} style={inp} /></Row>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={btnSecondary}>Cancel</button>
          <button onClick={() => void save()} disabled={saving} style={btnPrimary}>{saving ? "Saving…" : "Create"}</button>
        </div>
      </div>
    </div>
  );
}

function Panel({ title, action, style, children }: { title: string; action?: React.ReactNode; style?: React.CSSProperties; children: React.ReactNode }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 14, ...style }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>{title}</div>
        {action}
      </div>
      {children}
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const color = status === "complete" ? C.success : status === "in_progress" ? C.warn : status === "cancelled" ? C.danger : C.textSub;
  return <span style={{ fontSize: 10, color: "#fff", background: color, padding: "2px 8px", borderRadius: 10, fontWeight: 700, textTransform: "uppercase" }}>{status.replace("_", " ")}</span>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 700, textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

const inp = { width: "100%", padding: "8px 10px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.bg, color: C.text, fontSize: 13, boxSizing: "border-box", colorScheme: "dark" } as const;
const selectSt = { padding: "6px 10px", background: C.card, border: `1px solid ${C.cardBdr}`, color: C.text, borderRadius: 6, fontSize: 13, colorScheme: "dark" } as const;
const btnPrimary = { padding: "8px 14px", borderRadius: 6, border: "none", background: C.primary, color: "#FFFFFF", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;
const btnSecondary = { padding: "6px 12px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.card, color: C.text, cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit" } as const;
const miniBtn = { padding: "2px 8px", borderRadius: 4, border: `1px solid ${C.cardBdr}`, background: C.card, color: C.text, cursor: "pointer", fontSize: 10, fontWeight: 600, fontFamily: "inherit" } as const;
const overlay = { position: "fixed" as const, inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 };
const modal = { background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 22, maxWidth: "92vw", maxHeight: "90vh", overflowY: "auto" as const, color: C.text };

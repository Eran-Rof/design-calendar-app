import React, { useEffect, useMemo, useState } from "react";
import { notify, confirmDialog } from "../shared/ui/warn";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import SearchableSelect, { type SearchableSelectOption } from "./components/SearchableSelect";
import { fmtDateDisplay } from "../utils/tandaTypes";

interface Workflow {
  id: string;
  vendor_id: string;
  status: string;
  current_step: number;
  completed_steps: string[];
  started_at: string | null;
  completed_at: string | null;
  rejection_reason: string | null;
  vendor?: { id: string; name: string; status: string };
}

interface Detail {
  vendor: { id: string; name: string; status: string };
  workflow: Workflow | null;
  steps: { step_name: string; status: string; data: Record<string, unknown> | null; completed_at: string | null; skip_reason: string | null }[];
  banking: { id: string; bank_name: string; account_number_last4: string | null; account_type: string; currency: string; verified: boolean }[];
  compliance_document_types: { id: string; name: string; required: boolean }[];
  compliance_documents: { document_type_id: string; status: string; expiry_date: string | null }[];
}

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", danger: "#EF4444", success: "#10B981", warn: "#F59E0B",
};

export default function InternalOnboarding() {
  const [rows, setRows] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState("pending_review");
  const [selected, setSelected] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteRefresh, setInviteRefresh] = useState(0);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(filter === "all" ? "/api/internal/onboarding" : `/api/internal/onboarding?status=${filter}`);
      if (!r.ok) throw new Error(await r.text());
      setRows((await r.json()) as Workflow[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, [filter]);

  if (loading) return <div style={{ color: C.textMuted }}>Loading…</div>;
  if (err) return <div style={{ color: C.danger }}>Error: {err}</div>;

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16, gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Onboarding review</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <ExportButton
            rows={rows as unknown as Array<Record<string, unknown>>}
            filename="onboarding-workflows"
            sheetName="Onboarding"
            columns={[
              { key: "vendor_id",         header: "Vendor ID" },
              { key: "status",            header: "Status" },
              { key: "current_step",      header: "Current Step",  format: "number" },
              { key: "completed_steps",   header: "Completed Steps" },
              { key: "started_at",        header: "Started",       format: "datetime" },
              { key: "completed_at",      header: "Completed",     format: "datetime" },
              { key: "rejection_reason",  header: "Rejection Reason" },
            ] as ExportColumn<Record<string, unknown>>[]}
          />
          <button onClick={() => setShowInvite(true)} style={btnPrimary}>+ Invite vendor to portal</button>
          <SearchableSelect
            value={filter || null}
            onChange={(v) => setFilter(v)}
            options={[
              { value: "pending_review", label: "Pending review" },
              { value: "in_progress", label: "In progress" },
              { value: "approved", label: "Approved" },
              { value: "rejected", label: "Rejected" },
              { value: "all", label: "All" },
            ]}
            inputStyle={{ padding: "6px 10px", background: C.card, border: `1px solid ${C.cardBdr}`, color: C.text, borderRadius: 6 }}
          />
        </div>
      </div>

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1.5fr 140px 140px 140px 140px", padding: "10px 14px", background: "#0F172A", borderBottom: `1px solid ${C.cardBdr}`, fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" }}>
          <div>Vendor</div>
          <div>Status</div>
          <div>Steps</div>
          <div>Submitted</div>
          <div></div>
        </div>
        {rows.length === 0 ? (
          <div style={{ padding: 30, textAlign: "center", color: C.textMuted, fontSize: 13 }}>No workflows in this view.</div>
        ) : rows.map((w) => (
          <div key={w.id} style={{ display: "grid", gridTemplateColumns: "1.5fr 140px 140px 140px 140px", padding: "12px 14px", borderBottom: `1px solid ${C.cardBdr}`, fontSize: 13, alignItems: "center" }}>
            <div style={{ fontWeight: 600 }}>{w.vendor?.name || "Unknown"}</div>
            <div style={{ color: statusColor(w.status), fontWeight: 600, textTransform: "capitalize" }}>{w.status.replace(/_/g, " ")}</div>
            <div style={{ color: C.textSub }}>{(w.completed_steps || []).length} / 6</div>
            <div style={{ color: C.textSub }}>{w.started_at ? fmtDateDisplay(w.started_at) : "—"}</div>
            <div style={{ textAlign: "right" }}>
              <button onClick={() => setSelected(w.vendor_id)} style={btnPrimary}>Review →</button>
            </div>
          </div>
        ))}
      </div>

      <OutstandingInvites refreshKey={inviteRefresh} onResent={() => setInviteRefresh((n) => n + 1)} />

      <ActiveVendorAccess />

      {selected &&<ReviewModal vendorId={selected} onClose={() => setSelected(null)} onAction={() => { setSelected(null); void load(); }} />}
      {showInvite && <InviteVendorModal onClose={() => setShowInvite(false)} onSent={() => { setShowInvite(false); setInviteRefresh((n) => n + 1); void load(); }} />}
    </div>
  );
}

type InviteRow = { id: string; vendor_id: string; vendor_name: string | null; email: string; display_name: string | null; sent_at: string; expires_at: string; status: "pending" | "expired" | "accepted" };

function OutstandingInvites({ refreshKey, onResent }: { refreshKey: number; onResent: () => void }) {
  const [rows, setRows] = useState<InviteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [resending, setResending] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [editInvite, setEditInvite] = useState<InviteRow | null>(null);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const r = await fetch("/api/internal/vendor-invites?status=outstanding");
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error || `Failed to load invitations (${r.status})`);
      setRows((Array.isArray(body) ? body : []) as InviteRow[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [refreshKey]);

  async function resend(row: InviteRow) {
    setResending(row.id); setErr(null);
    try {
      const r = await fetch("/api/vendor-invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vendor_id: row.vendor_id, email: row.email, display_name: row.display_name || null, site_url: window.location.origin }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error || `Resend failed (${r.status})`);
      notify(body?.warning ? body.warning : `Invite resent to ${row.email} (valid 72 hours).`, body?.warning ? "info" : "success");
      onResent();
    } catch (e: unknown) {
      notify(e instanceof Error ? e.message : String(e), "error");
    } finally { setResending(null); }
  }

  // Manual-delivery fallback for when the invite email isn't arriving (e.g. an
  // unverified sending domain). Re-mints a fresh 72h link and copies it so the
  // operator can send it to the vendor directly. (Also re-sends the email.)
  async function copyLink(row: InviteRow) {
    setActing(row.id);
    try {
      const r = await fetch("/api/vendor-invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vendor_id: row.vendor_id, email: row.email, display_name: row.display_name || null, site_url: window.location.origin }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error || `Failed to generate link (${r.status})`);
      const link = body?.invite_url;
      if (!link) throw new Error("No invite link was returned.");
      await navigator.clipboard.writeText(link);
      notify(`Invite link copied for ${row.email} — paste it to the vendor directly. (A fresh email was also sent.)`, "success");
      onResent();
    } catch (e: unknown) {
      notify(e instanceof Error ? e.message : String(e), "error");
    } finally { setActing(null); }
  }

  async function deleteInvite(row: InviteRow) {
    const ok = await confirmDialog(
      `Delete the expired invitation for ${row.vendor_name || row.email}?\n\n` +
      `This removes the invite (and the unaccepted login it created). You can invite them again anytime.`,
      { confirmText: "Delete invitation" },
    );
    if (!ok) return;
    setActing(row.id);
    try {
      const r = await fetch("/api/internal/vendor-invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", invite_id: row.id }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error || `Delete failed (${r.status})`);
      notify(`Invitation for ${row.vendor_name || row.email} deleted.`, "success");
      onResent();
    } catch (e: unknown) {
      notify(e instanceof Error ? e.message : String(e), "error");
    } finally { setActing(null); }
  }

  return (
    <div style={{ marginTop: 28 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>Outstanding invitations</h3>
        <span style={{ color: C.textMuted, fontSize: 12 }}>{rows.length} not yet accepted</span>
        <span style={{ color: C.textMuted, fontSize: 11, fontStyle: "italic" }}>· click a row to edit</span>
      </div>
      {err && <div style={{ color: C.danger, fontSize: 12, marginBottom: 8 }}>{err}</div>}
      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1.4fr 110px 150px 1fr", padding: "10px 14px", background: "#0F172A", borderBottom: `1px solid ${C.cardBdr}`, fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" }}>
          <div>Vendor</div><div>Email</div><div>Status</div><div>Expires</div><div></div>
        </div>
        {loading ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted, fontSize: 13 }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted, fontSize: 13 }}>No outstanding invitations — everyone invited has accepted.</div>
        ) : rows.map((row) => {
          const expired = row.status === "expired";
          return (
            <div
              key={row.id}
              onClick={() => setEditInvite(row)}
              onMouseEnter={(e) => { e.currentTarget.style.background = "#0F172A"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              style={{ display: "grid", gridTemplateColumns: "1.3fr 1.4fr 110px 150px 1fr", padding: "12px 14px", borderBottom: `1px solid ${C.cardBdr}`, fontSize: 13, alignItems: "center", cursor: "pointer", background: "transparent", transition: "background 0.1s" }}
            >
              <div style={{ fontWeight: 600 }}>{row.vendor_name || "Unknown"}</div>
              <div style={{ color: C.textSub, overflow: "hidden", textOverflow: "ellipsis" }}>{row.email}</div>
              <div><span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 10, background: expired ? "#7F1D1D" : "#1E3A8A", color: expired ? "#FCA5A5" : "#BFDBFE" }}>{expired ? "Expired" : "Pending"}</span></div>
              <div style={{ color: C.textSub }}>{new Date(row.expires_at).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" })} {new Date(row.expires_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
              <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", flexWrap: "wrap" }}>
                <button onClick={(e) => { e.stopPropagation(); setEditInvite(row); }} style={btnSecondary}>Edit</button>
                <button onClick={(e) => { e.stopPropagation(); void copyLink(row); }} disabled={acting === row.id} title="Copy a fresh invite link to send manually" style={{ ...btnSecondary, opacity: acting === row.id ? 0.6 : 1 }}>{acting === row.id ? "…" : "Copy link"}</button>
                <button onClick={(e) => { e.stopPropagation(); void resend(row); }} disabled={resending === row.id} style={{ ...btnPrimary, opacity: resending === row.id ? 0.6 : 1 }}>{resending === row.id ? "Resending…" : "Resend"}</button>
                {expired && (
                  <button onClick={(e) => { e.stopPropagation(); void deleteInvite(row); }} disabled={acting === row.id} style={{ ...btnSecondary, color: "#fff", background: C.danger, borderColor: C.danger, opacity: acting === row.id ? 0.6 : 1 }}>Delete</button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ color: C.textMuted, fontSize: 11, marginTop: 8 }}>
        Vendor not receiving the email? Use <b>Copy link</b> to grab a fresh invite link and send it to them directly. Once an invite is expired, a <b>Delete</b> button appears to clear it.
      </div>
      {editInvite && (
        <EditInviteModal
          invite={editInvite}
          onClose={() => setEditInvite(null)}
          onSaved={() => { setEditInvite(null); onResent(); }}
        />
      )}
    </div>
  );
}

function EditInviteModal({ invite, onClose, onSaved }: { invite: InviteRow; onClose: () => void; onSaved: () => void }) {
  const expired = invite.status === "expired";
  const [email, setEmail] = useState(invite.email || "");
  const [displayName, setDisplayName] = useState(invite.display_name || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const fmtDateTime = (s: string | null) => {
    if (!s) return "—";
    const d = new Date(s);
    return `${d.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" })} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  };

  async function save() {
    const trimmed = email.trim();
    if (!trimmed) { setErr("Email is required."); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) { setErr("Enter a valid email address."); return; }
    setBusy(true); setErr(null); setNote(null);
    try {
      const r = await fetch("/api/internal/vendor-invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          invite_id: invite.id,
          email: trimmed,
          display_name: displayName.trim() || null,
          site_url: window.location.origin,
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error || `Update failed (${r.status})`);
      notify(body?.warning ? body.warning : `Invitation updated — a fresh invite was sent to ${trimmed} (valid 72 hours).`, body?.warning ? "info" : "success");
      onSaved();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div onClick={(e) => { if (e.currentTarget === e.target && !busy) onClose(); }} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.7)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "min(480px, calc(100vw - 32px))", background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 22, color: C.text, fontFamily: "system-ui, -apple-system, sans-serif" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
          <div style={{ fontSize: 17, fontWeight: 700 }}>Edit invitation</div>
          <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 10, background: expired ? "#7F1D1D" : "#1E3A8A", color: expired ? "#FCA5A5" : "#BFDBFE" }}>{expired ? "Expired" : "Pending"}</span>
        </div>
        <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 16 }}>
          Fix a mistyped address. Saving resends a fresh invite link to the new email and invalidates the old one.
        </div>

        <label style={labelStyle}>Vendor</label>
        <div style={{ ...inputStyle, background: C.bg, color: C.textSub, opacity: 0.85, cursor: "default" }}>{invite.vendor_name || "Unknown vendor"}</div>

        <label style={labelStyle}>Email (required)</label>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jane@supplier.com" style={inputStyle} disabled={busy} />

        <label style={labelStyle}>Contact name (optional)</label>
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="e.g. Jane Smith" style={inputStyle} disabled={busy} />

        <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", rowGap: 6, columnGap: 12, fontSize: 12, marginTop: 14, color: C.textMuted }}>
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4, alignSelf: "center" }}>Currently expires</div>
          <div style={{ color: C.textSub, alignSelf: "center" }}>{fmtDateTime(invite.expires_at)}</div>
        </div>

        {err && <div style={{ color: C.danger, fontSize: 12, marginTop: 10 }}>{err}</div>}
        {note && <div style={{ color: C.success, fontSize: 12, marginTop: 10 }}>{note}</div>}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 22 }}>
          <button onClick={onClose} disabled={busy} style={{ ...btnSecondary, opacity: busy ? 0.6 : 1 }}>Cancel</button>
          <button onClick={() => void save()} disabled={busy || !email.trim()} style={{ ...btnPrimary, opacity: busy || !email.trim() ? 0.6 : 1 }}>
            {busy ? "Saving…" : "Save & resend"}
          </button>
        </div>
      </div>
    </div>
  );
}

type AccessRow = {
  id: string;
  auth_id: string | null;
  vendor_id: string;
  vendor_name: string | null;
  email: string | null;
  role: string | null;
  last_login: string | null;
  status: "active" | "disabled" | "removed" | string;
  // Onboarding approval state (joined server-side). A login is "Active" only
  // once onboarding is approved; before that it shows the onboarding progress.
  onboarding_status?: "not_started" | "in_progress" | "pending_review" | "approved" | "rejected" | string;
  onboarding_step?: number;
  onboarding_total?: number;
};

function ActiveVendorAccess() {
  const [rows, setRows] = useState<AccessRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [viewVendorId, setViewVendorId] = useState<string | null>(null);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const r = await fetch("/api/internal/vendor-access");
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error || `Failed to load vendor access (${r.status})`);
      setRows((Array.isArray(body) ? body : []) as AccessRow[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  async function mutate(row: AccessRow, action: "disable" | "enable" | "remove") {
    const who = row.vendor_name || row.email || "this vendor";
    let confirmMsg: string;
    let confirmOpts: { danger?: boolean; confirmText?: string; title?: string } = {};
    if (action === "disable") {
      confirmMsg = `Disable portal access for ${who}? They will be signed out and blocked from the portal immediately. You can re-enable later.`;
      confirmOpts = { confirmText: "Disable access" };
    } else if (action === "enable") {
      confirmMsg = `Re-enable portal access for ${who}? They will be able to sign in again.`;
      confirmOpts = { danger: false, confirmText: "Enable access", title: "Confirm" };
    } else {
      confirmMsg =
        `Permanently REMOVE portal access for ${who}?\n\n` +
        `This deletes their login for good and cannot be undone. ` +
        `Financial and historical records (invoices, shipments, documents) are kept, ` +
        `but this person will no longer be able to sign in and a new invite would be required to restore access.`;
      confirmOpts = { confirmText: "Remove permanently" };
    }
    const ok = await confirmDialog(confirmMsg, confirmOpts);
    if (!ok) return;

    setBusy(row.id); setErr(null);
    try {
      const r = await fetch("/api/internal/vendor-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vendor_user_id: row.id, action }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error || `Action failed (${r.status})`);
      const verb = action === "disable" ? "disabled" : action === "enable" ? "enabled" : "removed";
      notify(body?.warning ? body.warning : `Portal access ${verb} for ${who}.`, body?.warning ? "info" : "success");
      await load();
    } catch (e: unknown) {
      notify(e instanceof Error ? e.message : String(e), "error");
    } finally { setBusy(null); }
  }

  const activeCount = rows.filter((r) => r.status === "active").length;

  return (
    <div style={{ marginTop: 28 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>Active vendor access</h3>
        <span style={{ color: C.textMuted, fontSize: 12 }}>{activeCount} with portal access</span>
        <span style={{ color: C.textMuted, fontSize: 11, fontStyle: "italic" }}>· click a row to view</span>
      </div>
      {err && <div style={{ color: C.danger, fontSize: 12, marginBottom: 8 }}>{err}</div>}
      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1.4fr 100px 150px 110px 200px", padding: "10px 14px", background: "#0F172A", borderBottom: `1px solid ${C.cardBdr}`, fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" }}>
          <div>Vendor</div><div>Email</div><div>Role</div><div>Last login</div><div>Status</div><div></div>
        </div>
        {loading ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted, fontSize: 13 }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted, fontSize: 13 }}>No vendor portal users yet.</div>
        ) : rows.map((row) => {
          const isBusy = busy === row.id;
          const badge = accessBadge(row);
          return (
            <div
              key={row.id}
              onClick={() => setViewVendorId(row.vendor_id)}
              onMouseEnter={(e) => { e.currentTarget.style.background = "#0F172A"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              style={{ display: "grid", gridTemplateColumns: "1.3fr 1.4fr 100px 150px 110px 200px", padding: "12px 14px", borderBottom: `1px solid ${C.cardBdr}`, fontSize: 13, alignItems: "center", cursor: "pointer", background: "transparent", transition: "background 0.1s" }}
            >
              <div style={{ fontWeight: 600 }}>{row.vendor_name || "Unknown"}</div>
              <div style={{ color: C.textSub, overflow: "hidden", textOverflow: "ellipsis" }}>{row.email || "—"}</div>
              <div style={{ color: C.textSub, textTransform: "capitalize" }}>{row.role || "—"}</div>
              <div style={{ color: C.textSub }}>{row.last_login ? fmtDateDisplay(row.last_login) : "Never"}</div>
              <div><span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 10, background: badge.bg, color: badge.fg }}>{badge.label}</span></div>
              <div style={{ textAlign: "right", display: "flex", gap: 6, justifyContent: "flex-end" }}>
                {row.status === "removed" ? (
                  <span style={{ color: C.textMuted, fontSize: 12 }}>Access removed</span>
                ) : (
                  <>
                    {row.status === "disabled" ? (
                      <button onClick={(e) => { e.stopPropagation(); void mutate(row, "enable"); }} disabled={isBusy} style={{ ...btnSecondary, opacity: isBusy ? 0.6 : 1, color: C.success, borderColor: C.success }}>Enable</button>
                    ) : (
                      <button onClick={(e) => { e.stopPropagation(); void mutate(row, "disable"); }} disabled={isBusy} style={{ ...btnSecondary, opacity: isBusy ? 0.6 : 1, color: C.warn, borderColor: C.warn }}>Disable</button>
                    )}
                    <button onClick={(e) => { e.stopPropagation(); void mutate(row, "remove"); }} disabled={isBusy} style={{ ...btnSecondary, opacity: isBusy ? 0.6 : 1, color: "#fff", background: C.danger, borderColor: C.danger }}>Remove</button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ color: C.textMuted, fontSize: 11, marginTop: 8 }}>
        Disable is reversible (vendor is signed out and blocked, can be re-enabled). Remove permanently deletes the login; financial history is preserved.
      </div>
      {viewVendorId && <ReviewModal vendorId={viewVendorId} onClose={() => setViewVendorId(null)} onAction={() => { setViewVendorId(null); void load(); }} />}
    </div>
  );
}

// Badge reflects login state first (a disabled/removed login is never "Active"),
// then ONBOARDING APPROVAL for an active login: green "Active" ONLY once approved,
// otherwise the onboarding stage so an un-approved vendor isn't shown as Active.
function accessBadge(row: AccessRow): { label: string; bg: string; fg: string } {
  if (row.status === "disabled") return { label: "Disabled", bg: "#78350F", fg: "#FCD34D" };
  if (row.status === "removed") return { label: "Removed", bg: "#7F1D1D", fg: "#FCA5A5" };
  const ob = row.onboarding_status || "not_started";
  if (ob === "approved") return { label: "Active", bg: "#064E3B", fg: "#6EE7B7" };
  if (ob === "rejected") return { label: "Rejected", bg: "#7F1D1D", fg: "#FCA5A5" };
  if (ob === "pending_review") return { label: "Pending review", bg: "#1E3A8A", fg: "#93C5FD" };
  const step = row.onboarding_step ?? 0;
  const total = row.onboarding_total ?? 6;
  return { label: `Onboarding ${step}/${total}`, bg: "#334155", fg: "#CBD5E1" };
}

type VendorOpt = { id: string; name: string };

function InviteVendorModal({ onClose, onSent }: { onClose: () => void; onSent: () => void }) {
  const [vendors, setVendors] = useState<VendorOpt[]>([]);
  const [vendorId, setVendorId] = useState<string | null>(null);
  const [loadingVendors, setLoadingVendors] = useState(true);
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Load existing vendors for the dropdown.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/internal/vendor-master?limit=1000");
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body?.error || `Failed to load vendors (${r.status})`);
        const rows = (Array.isArray(body) ? body : body?.rows || []) as { id: string; name?: string; legal_name?: string }[];
        if (cancelled) return;
        setVendors(rows.map((v) => ({ id: v.id, name: v.legal_name || v.name || "(unnamed)" })));
      } catch (e: unknown) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoadingVendors(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const options: SearchableSelectOption[] = useMemo(
    () => vendors.map((v) => ({ value: v.id, label: v.name, searchHaystack: `${v.name} ${v.id}` })),
    [vendors],
  );

  // "Add new vendor" — create through the canonical vendor-master endpoint
  // (auto-generates code, entity, etc.), then select the new row.
  async function addVendor(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/internal/vendor-master", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error || `Could not create vendor (${r.status})`);
      const created: VendorOpt = { id: body.id, name: body.legal_name || body.name || trimmed };
      setVendors((prev) => [created, ...prev]);
      setVendorId(created.id);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (!vendorId) { setErr("Select an existing vendor or add a new one."); return; }
    if (!email.trim()) { setErr("Email is required."); return; }
    setBusy(true); setErr(null); setNote(null);
    try {
      const r = await fetch("/api/vendor-invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vendor_id: vendorId,
          email: email.trim(),
          display_name: displayName.trim() || null,
          site_url: window.location.origin,
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error || `Invite failed (${r.status})`);
      setNote(`Invite sent to ${email}. The vendor will receive a magic-link email.`);
      setTimeout(onSent, 1500);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div onClick={(e) => { if (e.currentTarget === e.target) onClose(); }} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.7)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ width: "min(520px, calc(100vw - 32px))", background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, color: C.text, fontFamily: "system-ui, -apple-system, sans-serif" }}>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Invite vendor to portal</div>
        <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 16 }}>
          Sends a magic-link email so the vendor can set up their portal login and begin onboarding.
        </div>
        <label style={labelStyle}>Vendor (select existing or add new)</label>
        <SearchableSelect
          value={vendorId}
          onChange={setVendorId}
          options={options}
          placeholder={loadingVendors ? "Loading vendors…" : "Search vendors…"}
          disabled={busy || loadingVendors}
          emptyText="No matching vendor — use “Add” below"
          onAddNew={(q) => void addVendor(q)}
          addNewLabel={(q) => (q.trim() ? `+ Add new vendor “${q.trim()}”` : "+ Add new vendor")}
        />
        <label style={labelStyle}>Contact name (optional)</label>
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="e.g. Jane Smith" style={inputStyle} />
        <label style={labelStyle}>Email (required)</label>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jane@supplier.com" style={inputStyle} />
        {err && <div style={{ color: C.danger, fontSize: 12, marginTop: 10 }}>{err}</div>}
        {note && <div style={{ color: C.success, fontSize: 12, marginTop: 10 }}>{note}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
          <button onClick={onClose} disabled={busy} style={{ padding: "7px 14px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: "transparent", color: C.textSub, cursor: busy ? "not-allowed" : "pointer", fontFamily: "inherit", fontSize: 13 }}>Cancel</button>
          <button onClick={() => void send()} disabled={busy || !vendorId || !email.trim()} style={{ padding: "7px 16px", borderRadius: 6, border: "none", background: busy || !vendorId || !email.trim() ? C.textMuted : C.primary, color: "#fff", cursor: busy ? "not-allowed" : "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 600 }}>
            {busy ? "Sending…" : "Send invite"}
          </button>
        </div>
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = { display: "block", fontSize: 11, fontWeight: 600, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.4, marginTop: 12, marginBottom: 4 };
const inputStyle: React.CSSProperties = { width: "100%", padding: "8px 10px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.bg, color: C.text, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" };

function statusColor(s: string) {
  if (s === "approved") return C.success;
  if (s === "rejected") return C.danger;
  if (s === "pending_review") return C.warn;
  return C.textSub;
}

function ReviewModal({ vendorId, onClose, onAction }: { vendorId: string; onClose: () => void; onAction: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<"approve" | "reject" | null>(null);
  const [reviewer, setReviewer] = useState("");
  const [reason, setReason] = useState("");
  const [failedSteps, setFailedSteps] = useState<Set<string>>(new Set());

  useEffect(() => {
    (async () => {
      const r = await fetch(`/api/internal/onboarding/${vendorId}`);
      if (r.ok) setDetail((await r.json()) as Detail);
      setLoading(false);
    })();
  }, [vendorId]);

  async function submit() {
    if (!action) return;
    const body: Record<string, unknown> = { action, reviewer_name: reviewer || "Internal" };
    if (action === "reject") {
      if (!reason.trim()) { notify("Rejection reason required.", "error"); return; }
      body.rejection_reason = reason;
      body.failed_steps = [...failedSteps];
    }
    const r = await fetch(`/api/internal/onboarding/${vendorId}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) { notify(await r.text(), "error"); return; }
    onAction();
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 22, width: "min(720px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
        {loading || !detail ? (
          <div style={{ color: C.textMuted }}>Loading…</div>
        ) : (
          <>
            <h3 style={{ margin: "0 0 14px", fontSize: 18 }}>{detail.vendor.name}</h3>
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", fontWeight: 700 }}>Steps</div>
              {detail.steps.map((s) => {
                const isSkipped = s.status === "skipped";
                const statusColorVal = s.status === "complete" ? C.success : isSkipped ? C.warn : C.textMuted;
                return (
                  <div key={s.step_name} style={{ padding: "6px 0", borderBottom: `1px solid ${C.cardBdr}`, display: "grid", gridTemplateColumns: "160px 100px 1fr auto", gap: 10, fontSize: 12, alignItems: "center" }}>
                    <div style={{ fontWeight: 600 }}>{s.step_name.replace(/_/g, " ")}</div>
                    <div style={{ color: statusColorVal, fontWeight: isSkipped ? 700 : 400 }}>
                      {s.status}
                      {isSkipped && s.skip_reason && (
                        <span style={{ display: "block", color: C.textMuted, fontWeight: 400, fontSize: 10, marginTop: 2 }}>
                          reason: {s.skip_reason}
                        </span>
                      )}
                    </div>
                    <div style={{ color: C.textSub, fontFamily: "SFMono-Regular, Menlo, monospace", fontSize: 11 }}>
                      {isSkipped
                        ? `Vendor skipped this step${s.skip_reason === "no_docs" ? " — no compliance documents on file" : ""}.`
                        : s.data ? JSON.stringify(s.data).slice(0, 80) : "—"}
                    </div>
                    {action === "reject" && (
                      <label style={{ fontSize: 11, color: C.danger, display: "flex", alignItems: "center", gap: 4 }}>
                        <input type="checkbox" checked={failedSteps.has(s.step_name)} onChange={(e) => {
                          const next = new Set(failedSteps);
                          if (e.target.checked) next.add(s.step_name); else next.delete(s.step_name);
                          setFailedSteps(next);
                        }} />
                        Reject
                      </label>
                    )}
                  </div>
                );
              })}
            </div>

            {detail.banking.length > 0 && (
              <div style={{ marginBottom: 14, fontSize: 12, color: C.textSub }}>
                <b>Banking:</b> {detail.banking[0].bank_name} ••••{detail.banking[0].account_number_last4} ({detail.banking[0].account_type}, {detail.banking[0].currency}) — {detail.banking[0].verified ? "verified" : "unverified"}
              </div>
            )}

            {action === null ? (
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button onClick={() => setAction("reject")} style={{ ...btnSecondary, color: C.danger }}>Reject…</button>
                <button onClick={() => setAction("approve")} style={{ ...btnPrimary, background: C.success }}>Approve…</button>
                <button onClick={onClose} style={btnSecondary}>Close</button>
              </div>
            ) : (
              <div>
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", fontWeight: 700, marginBottom: 4 }}>Your name (for audit)</div>
                  <input value={reviewer} onChange={(e) => setReviewer(e.target.value)} placeholder="reviewer name" style={inp} />
                </div>
                {action === "reject" && (
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", fontWeight: 700, marginBottom: 4 }}>Rejection reason</div>
                    <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} style={{ ...inp, resize: "vertical" }} />
                    <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>Use the checkboxes above to mark which steps need to be redone.</div>
                  </div>
                )}
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <button onClick={() => setAction(null)} style={btnSecondary}>Back</button>
                  <button onClick={() => void submit()} style={action === "reject" ? { ...btnPrimary, background: C.danger } : { ...btnPrimary, background: C.success }}>
                    Confirm {action}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const inp = { width: "100%", padding: "8px 10px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: "#0F172A", color: C.text, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" } as const;
const btnPrimary = { padding: "6px 14px", borderRadius: 6, border: "none", background: C.primary, color: "#FFFFFF", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;
const btnSecondary = { padding: "6px 14px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.card, color: C.text, cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;

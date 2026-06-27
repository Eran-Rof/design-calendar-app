// src/tanda/components/BuyersEditor.tsx
//
// Buyers editor for the Customer Master modal (#1156). Replaces the legacy
// ContactList-backed "Contacts" tab. Each buyer is a first-class row in
// customer_buyers, persisted PER-ROW via /api/internal/customer-buyers (NOT
// batch-replace-on-save) so the self-FK "Report" can always point at an
// already-saved manager.
//
// Required fields (enforced here + at the API): Name, Phone, Email, Title.
// Optional: Scope(s) (multi-select from buyer_scope_master), Report
// (reports-to, a manager buyer on THIS customer, excluding self), Manager flag.
//
// Buyers can only be edited for a SAVED customer (we need its id). On the
// "add customer" flow we show a hint to save first.

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatUsPhone } from "../../shared/phone";
import { notify, confirmDialog } from "../../shared/ui/warn";
import SearchableSelect, { type SearchableSelectOption } from "./SearchableSelect";

export type BuyerScope = { id: string; name: string };
export type Buyer = {
  id: string;
  customer_id: string;
  name: string;
  phone: string | null;
  email: string | null;
  title: string | null;
  is_manager: boolean;
  reports_to_buyer_id: string | null;
  reports_to_name: string | null;
  scopes: BuyerScope[];
  scope_ids: string[];
  sort_order: number;
  is_active: boolean;
};

type ScopeMaster = { id: string; name: string; code: string | null; is_active: boolean };

const C = {
  card: "#1E293B", cardBdr: "#334155", text: "#F1F5F9", textMuted: "#94A3B8",
  textSub: "#CBD5E1", primary: "#3B82F6", success: "#10B981", danger: "#EF4444",
};
const input: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%", boxSizing: "border-box",
};
const btnPrimary: React.CSSProperties = {
  background: C.primary, color: "white", border: 0, padding: "7px 12px",
  borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600,
};
const btnSecondary: React.CSSProperties = {
  background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "5px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12,
};
const lbl: React.CSSProperties = { fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 };

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_RE = /^\(\d{3}\) \d{3}-\d{4}$/;

type Draft = {
  id?: string;
  name: string;
  phone: string;
  email: string;
  title: string;
  is_manager: boolean;
  reports_to_buyer_id: string;
  scope_ids: string[];
};

function emptyDraft(): Draft {
  return { name: "", phone: "", email: "", title: "", is_manager: false, reports_to_buyer_id: "", scope_ids: [] };
}

export default function BuyersEditor({ customerId }: { customerId: string | null }) {
  const [buyers, setBuyers] = useState<Buyer[]>([]);
  const [scopes, setScopes] = useState<ScopeMaster[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [saving, setSaving] = useState(false);
  const [draftErr, setDraftErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!customerId) return;
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(`/api/internal/customer-buyers?customer_id=${customerId}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setBuyers(await r.json() as Buyer[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [customerId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    fetch("/api/internal/buyer-scope-master")
      .then((r) => (r.ok ? r.json() : []))
      .then((arr) => setScopes(Array.isArray(arr) ? arr as ScopeMaster[] : []))
      .catch(() => {});
  }, []);

  // Report options = manager buyers on this customer, excluding the one being
  // edited (a buyer cannot report to themselves).
  const reportOptions: SearchableSelectOption[] = useMemo(() => {
    const selfId = editingId && editingId !== "new" ? editingId : null;
    const opts: SearchableSelectOption[] = [{ value: "", label: "(none)" }];
    for (const b of buyers) {
      if (!b.is_manager) continue;
      if (selfId && b.id === selfId) continue;
      opts.push({ value: b.id, label: `${b.name}${b.title ? ` — ${b.title}` : ""}` });
    }
    return opts;
  }, [buyers, editingId]);

  function startAdd() {
    setDraft(emptyDraft());
    setDraftErr(null);
    setEditingId("new");
  }
  function startEdit(b: Buyer) {
    setDraft({
      id: b.id,
      name: b.name ?? "",
      phone: b.phone ?? "",
      email: b.email ?? "",
      title: b.title ?? "",
      is_manager: b.is_manager,
      reports_to_buyer_id: b.reports_to_buyer_id ?? "",
      scope_ids: b.scope_ids ?? [],
    });
    setDraftErr(null);
    setEditingId(b.id);
  }
  function cancelEdit() {
    setEditingId(null);
    setDraft(emptyDraft());
    setDraftErr(null);
  }

  function validateDraft(): string | null {
    if (!draft.name.trim()) return "Name is required";
    if (!draft.phone.trim()) return "Phone is required";
    if (!PHONE_RE.test(draft.phone.trim())) return "Phone must be (xxx) xxx-xxxx";
    if (!draft.email.trim()) return "Email is required";
    if (!EMAIL_RE.test(draft.email.trim())) return "Email is not valid";
    if (!draft.title.trim()) return "Title is required";
    return null;
  }

  async function saveDraft() {
    if (!customerId) return;
    const ve = validateDraft();
    if (ve) { setDraftErr(ve); return; }
    setSaving(true);
    setDraftErr(null);
    try {
      const isNew = editingId === "new";
      const url = isNew
        ? "/api/internal/customer-buyers"
        : `/api/internal/customer-buyers/${draft.id}`;
      const method = isNew ? "POST" : "PATCH";
      const body: Record<string, unknown> = {
        name: draft.name.trim(),
        phone: draft.phone.trim(),
        email: draft.email.trim(),
        title: draft.title.trim(),
        is_manager: draft.is_manager,
        reports_to_buyer_id: draft.reports_to_buyer_id || null,
        scope_ids: draft.scope_ids,
      };
      if (isNew) body.customer_id = customerId;
      const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      cancelEdit();
      await load();
    } catch (e: unknown) {
      setDraftErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function del(b: Buyer) {
    if (!(await confirmDialog(`Delete buyer "${b.name}"? Any buyer reporting to them, and any sales order recording them, will simply lose the link.`))) return;
    try {
      const r = await fetch(`/api/internal/customer-buyers/${b.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      await load();
    } catch (e: unknown) {
      notify(`Delete failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  function toggleScope(id: string) {
    setDraft((d) => ({
      ...d,
      scope_ids: d.scope_ids.includes(id) ? d.scope_ids.filter((s) => s !== id) : [...d.scope_ids, id],
    }));
  }

  if (!customerId) {
    return (
      <div style={{ fontSize: 13, color: C.textMuted, fontStyle: "italic", padding: "8px 0" }}>
        Save the customer first, then re-open it to add buyers.
      </div>
    );
  }

  const activeScopes = scopes.filter((s) => s.is_active || draft.scope_ids.includes(s.id));

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ fontSize: 12, color: C.textMuted }}>
          Buyers for this customer. Required: Name, Phone, Email, Title. Each buyer saves immediately.
        </div>
        {editingId === null && (
          <button type="button" onClick={startAdd} style={btnPrimary}>+ Add buyer</button>
        )}
      </div>

      {err && (
        <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 10, fontSize: 12 }}>{err}</div>
      )}

      {/* Inline add/edit form */}
      {editingId !== null && (
        <div style={{ border: `1px solid ${C.primary}`, borderRadius: 8, padding: 12, marginBottom: 12, background: "rgba(59,130,246,0.06)" }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10, color: C.text }}>
            {editingId === "new" ? "New buyer" : "Edit buyer"}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <div style={lbl}>Name *</div>
              <input style={input} value={draft.name} placeholder="Buyer name"
                onChange={(e) => setDraft({ ...draft, name: e.target.value })} autoFocus />
            </div>
            <div>
              <div style={lbl}>Phone *</div>
              <input style={input} value={draft.phone} placeholder="(xxx) xxx-xxxx"
                onChange={(e) => setDraft({ ...draft, phone: formatUsPhone(e.target.value) })} />
            </div>
            <div>
              <div style={lbl}>Email *</div>
              <input style={input} type="email" value={draft.email} placeholder="buyer@example.com"
                onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
            </div>
            <div>
              <div style={lbl}>Title *</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input style={input} value={draft.title} placeholder="e.g. Senior Buyer"
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
                <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: C.textSub, whiteSpace: "nowrap" }} title="Management buyer — can be a Report target for other buyers">
                  <input type="checkbox" checked={draft.is_manager}
                    onChange={(e) => setDraft({ ...draft, is_manager: e.target.checked })} />
                  Manager
                </label>
              </div>
            </div>
            <div style={{ gridColumn: "1 / -1" }}>
              <div style={lbl}>Scope (what they buy) — optional</div>
              {activeScopes.length === 0 ? (
                <div style={{ fontSize: 12, color: C.textMuted, fontStyle: "italic" }}>
                  No scopes defined yet — add them in Master Data → Buyer Scope Master.
                </div>
              ) : (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {activeScopes.map((s) => (
                    <label key={s.id} style={{
                      display: "flex", alignItems: "center", gap: 5, fontSize: 12,
                      color: draft.scope_ids.includes(s.id) ? C.text : C.textSub,
                      border: `1px solid ${draft.scope_ids.includes(s.id) ? C.primary : C.cardBdr}`,
                      borderRadius: 14, padding: "3px 10px", cursor: "pointer",
                      background: draft.scope_ids.includes(s.id) ? "rgba(59,130,246,0.18)" : "transparent",
                    }}>
                      <input type="checkbox" checked={draft.scope_ids.includes(s.id)} onChange={() => toggleScope(s.id)} style={{ margin: 0 }} />
                      {s.name}
                    </label>
                  ))}
                </div>
              )}
            </div>
            <div style={{ gridColumn: "1 / -1" }}>
              <div style={lbl}>Report (reports to) — optional, management buyers on this customer</div>
              <SearchableSelect
                value={draft.reports_to_buyer_id || ""}
                onChange={(v) => setDraft({ ...draft, reports_to_buyer_id: v })}
                options={reportOptions}
                placeholder="(none)"
              />
            </div>
          </div>

          {draftErr && (
            <div style={{ background: "#7f1d1d", color: "white", padding: "7px 10px", borderRadius: 6, marginTop: 10, fontSize: 12 }}>{draftErr}</div>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
            <button type="button" onClick={cancelEdit} style={btnSecondary} disabled={saving}>Cancel</button>
            <button type="button" onClick={() => void saveDraft()} style={btnPrimary} disabled={saving}>
              {saving ? "Saving…" : editingId === "new" ? "Add buyer" : "Save buyer"}
            </button>
          </div>
        </div>
      )}

      {/* Buyer list */}
      {loading ? (
        <div style={{ padding: 12, color: C.textMuted, fontSize: 13 }}>Loading…</div>
      ) : buyers.length === 0 ? (
        editingId === null && (
          <div style={{ fontSize: 13, color: C.textMuted, fontStyle: "italic", padding: "8px 0" }}>
            No buyers yet. Click “+ Add buyer”.
          </div>
        )
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {buyers.map((b) => (
            <div key={b.id} style={{ border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: "10px 12px", opacity: b.is_active ? 1 : 0.55 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>
                    {b.name}
                    {b.is_manager && (
                      <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: C.success, border: `1px solid ${C.success}`, borderRadius: 10, padding: "1px 7px", textTransform: "uppercase", letterSpacing: 0.5 }}>Manager</span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: C.textSub, marginTop: 2 }}>{b.title || "—"}</div>
                  <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4, display: "flex", flexWrap: "wrap", gap: "2px 14px" }}>
                    <span>Phone: {b.phone || "—"}</span>
                    <span>Email: {b.email || "—"}</span>
                    {b.reports_to_name && <span>↳ Reports to: {b.reports_to_name}</span>}
                  </div>
                  {b.scopes.length > 0 && (
                    <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {b.scopes.map((s) => (
                        <span key={s.id} style={{ fontSize: 11, color: C.textSub, background: "rgba(148,163,184,0.12)", border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: "1px 8px" }}>{s.name}</span>
                      ))}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                  <button type="button" onClick={() => startEdit(b)} style={btnSecondary}>Edit</button>
                  <button type="button" onClick={() => void del(b)} style={{ ...btnSecondary, color: C.danger, borderColor: "#7f1d1d" }}>Delete</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// /planning/vendors — planning vendor master (ip_vendor_master) management.
//
// The buy-plan → Tangerine-PO chain needs every buy action to carry a vendor:
// action.vendor_id → ip_vendor_master row → its portal_vendor_id linked to a
// Tangerine vendor. This screen is where operators create/edit those rows and
// link them to Tangerine — previously there was no UI and the table was empty,
// so every buy recommendation skipped with "no vendor".
//
// Actions: + New vendor · inline edit (code/name) · Link/Unlink to a Tangerine
// vendor · Seed from Tangerine (bulk, idempotent). Gated on manage_integrations
// (the server enforces it; the UI reflects the result).

import { useCallback, useEffect, useMemo, useState } from "react";
import { S, PAL, formatDate } from "../../components/styles";
import Toast, { type ToastMessage } from "../../components/Toast";
import SearchableSelect from "../../../tanda/components/SearchableSelect";
import { confirmDialog } from "../../../shared/ui/warn";
import { currentUserEmail, loadPermissionsFor, can } from "../../governance/services/permissionService";
import type { IpUserWithPermissions } from "../../governance/types/governance";
import UserSwitcher from "../../admin/components/UserSwitcher";
import type { PlanningVendor, TangerineVendorOption } from "../types/vendors";
import {
  listPlanningVendors,
  listTangerineVendorOptions,
  createPlanningVendor,
  updatePlanningVendor,
  linkPlanningVendor,
  unlinkPlanningVendor,
  seedFromTangerine,
} from "../services/vendorMasterService";

type EditTarget = { mode: "create" } | { mode: "edit"; vendor: PlanningVendor };

export default function VendorManagerPanel() {
  const [user, setUser] = useState<IpUserWithPermissions | null>(null);
  const [vendors, setVendors] = useState<PlanningVendor[]>([]);
  const [options, setOptions] = useState<TangerineVendorOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [query, setQuery] = useState("");
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [linkTarget, setLinkTarget] = useState<PlanningVendor | null>(null);
  const [busy, setBusy] = useState(false);

  const canManage = !!user && can(user, "manage_integrations");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [vs, opts] = await Promise.all([listPlanningVendors(), listTangerineVendorOptions()]);
      setVendors(vs);
      setOptions(opts);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPermissionsFor(currentUserEmail()).then(setUser);
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return vendors;
    return vendors.filter((v) =>
      v.vendor_code.toLowerCase().includes(q) ||
      v.name.toLowerCase().includes(q) ||
      (v.tangerine_vendor_name || "").toLowerCase().includes(q));
  }, [vendors, query]);

  const stats = useMemo(() => {
    const total = vendors.length;
    const linked = vendors.filter((v) => v.portal_vendor_id).length;
    return { total, linked, unlinked: total - linked };
  }, [vendors]);

  async function handleSave(vendorCode: string, name: string) {
    setBusy(true);
    try {
      if (editTarget?.mode === "create") {
        await createPlanningVendor({ vendor_code: vendorCode, name });
        setToast({ text: `Vendor "${vendorCode}" created`, kind: "success" });
      } else if (editTarget?.mode === "edit") {
        await updatePlanningVendor({ id: editTarget.vendor.id, vendor_code: vendorCode, name });
        setToast({ text: "Vendor updated", kind: "success" });
      }
      setEditTarget(null);
      await refresh();
    } catch (e) {
      setToast({ text: e instanceof Error ? e.message : String(e), kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function handleLink(vendor: PlanningVendor, tangerineVendorId: string) {
    setBusy(true);
    try {
      const msg = await linkPlanningVendor({ planningVendorId: vendor.id, tangerineVendorId });
      setToast({ text: msg, kind: "success" });
      setLinkTarget(null);
      await refresh();
    } catch (e) {
      setToast({ text: e instanceof Error ? e.message : String(e), kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function handleUnlink(vendor: PlanningVendor) {
    if (!(await confirmDialog(`Unlink "${vendor.vendor_code}" from Tangerine vendor "${vendor.tangerine_vendor_name}"?`, { confirmText: "Unlink" }))) return;
    setBusy(true);
    try {
      await unlinkPlanningVendor(vendor.id);
      setToast({ text: "Unlinked", kind: "success" });
      await refresh();
    } catch (e) {
      setToast({ text: e instanceof Error ? e.message : String(e), kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function handleSeed() {
    if (!(await confirmDialog("Create one planning vendor for each Tangerine vendor not already represented? This is idempotent — re-running creates nothing new.", { title: "Seed from Tangerine", confirmText: "Seed" }))) return;
    setBusy(true);
    try {
      const r = await seedFromTangerine();
      setToast({ text: r.message || `Created ${r.created}, skipped ${r.skipped}`, kind: "success" });
      await refresh();
    } catch (e) {
      setToast({ text: e instanceof Error ? e.message : String(e), kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={S.app}>
      <div style={S.content}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: PAL.text }}>Vendors</h2>
            <div style={{ ...S.navSub, marginTop: 2 }}>
              Planning vendor master — link each to a Tangerine vendor so buy plans can create POs.
            </div>
          </div>
          <UserSwitcher onChange={setUser} />
        </div>

        <div style={{ ...S.statsRow, gridTemplateColumns: "repeat(3,1fr)" }}>
          <Stat label="Planning vendors" value={stats.total} />
          <Stat label="Linked to Tangerine" value={stats.linked} color={PAL.green} />
          <Stat label="Unlinked" value={stats.unlinked} color={stats.unlinked ? PAL.yellow : PAL.textMuted} />
        </div>

        <div style={S.toolbar}>
          <input
            style={{ ...S.input, minWidth: 260 }}
            placeholder="Search code, name, or Tangerine vendor…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <button
              style={{ ...S.btnSecondary, opacity: canManage ? 1 : 0.5, cursor: canManage ? "pointer" : "not-allowed" }}
              disabled={!canManage || busy}
              title={canManage ? "Create one planning vendor per Tangerine vendor" : "Requires manage_integrations"}
              onClick={handleSeed}
            >
              Seed from Tangerine
            </button>
            <button
              style={{ ...S.btnPrimary, opacity: canManage ? 1 : 0.5, cursor: canManage ? "pointer" : "not-allowed" }}
              disabled={!canManage || busy}
              title={canManage ? "" : "Requires manage_integrations"}
              onClick={() => setEditTarget({ mode: "create" })}
            >
              + New vendor
            </button>
          </div>
        </div>

        {error && (
          <div style={{ ...S.card, border: `1px solid ${PAL.red}55`, color: PAL.red }}>{error}</div>
        )}

        <div style={S.card}>
          <div style={S.tableWrap}>
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>Code</th>
                  <th style={S.th}>Name</th>
                  <th style={S.th}>Country</th>
                  <th style={{ ...S.th, textAlign: "right" }}>Lead time</th>
                  <th style={{ ...S.th, textAlign: "right" }}>MOQ</th>
                  <th style={S.th}>Tangerine link</th>
                  <th style={S.th}>Updated</th>
                  <th style={S.th}></th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={8} style={{ ...S.td, textAlign: "center", color: PAL.textMuted, padding: 24 }}>Loading…</td></tr>
                ) : filtered.length === 0 ? (
                  <tr><td colSpan={8} style={{ ...S.td, textAlign: "center", color: PAL.textMuted, padding: 24 }}>
                    {vendors.length === 0 ? "No planning vendors yet. Create one, or Seed from Tangerine." : "No vendors match your search."}
                  </td></tr>
                ) : (
                  filtered.map((v) => (
                    <tr key={v.id}>
                      <td style={{ ...S.td, fontFamily: "monospace", fontWeight: 600 }}>{v.vendor_code}</td>
                      <td style={S.td}>{v.name}</td>
                      <td style={{ ...S.td, color: PAL.textDim }}>{v.country || "–"}</td>
                      <td style={S.tdNum}>{v.default_lead_time_days ?? "–"}</td>
                      <td style={S.tdNum}>{v.moq_units != null ? v.moq_units.toLocaleString() : "–"}</td>
                      <td style={S.td}>
                        {v.portal_vendor_id ? (
                          <span style={{ ...S.chip, background: `${PAL.green}22`, color: PAL.green }} title={v.tangerine_vendor_code || undefined}>
                            🔗 {v.tangerine_vendor_name || "Linked"}
                          </span>
                        ) : (
                          <span style={{ ...S.chip, background: `${PAL.yellow}22`, color: PAL.yellow }}>⚠ Unlinked</span>
                        )}
                      </td>
                      <td style={{ ...S.td, fontSize: 11, color: PAL.textDim }}>{formatDate(v.updated_at?.slice(0, 10))}</td>
                      <td style={{ ...S.td, whiteSpace: "nowrap" }}>
                        {canManage && (
                          <>
                            <button style={S.btnGhost} onClick={() => setEditTarget({ mode: "edit", vendor: v })}>Edit</button>
                            {v.portal_vendor_id ? (
                              <button style={{ ...S.btnGhost, color: PAL.yellow }} onClick={() => handleUnlink(v)}>Unlink</button>
                            ) : (
                              <button style={{ ...S.btnGhost, color: PAL.accent }} onClick={() => setLinkTarget(v)}>Link</button>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {editTarget && (
        <VendorEditModal
          target={editTarget}
          existingCodes={vendors.map((v) => v.vendor_code.toLowerCase())}
          busy={busy}
          onCancel={() => setEditTarget(null)}
          onSave={handleSave}
        />
      )}

      {linkTarget && (
        <LinkModal
          vendor={linkTarget}
          options={options}
          alreadyLinkedIds={new Set(vendors.map((v) => v.portal_vendor_id).filter(Boolean) as string[])}
          busy={busy}
          onCancel={() => setLinkTarget(null)}
          onLink={(tid) => handleLink(linkTarget, tid)}
        />
      )}

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div style={S.statCard}>
      <div style={{ fontSize: 12, color: PAL.textMuted }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: color || PAL.text }}>{value.toLocaleString()}</div>
    </div>
  );
}

// ── Create / edit modal (code + name) ───────────────────────────────────────
function VendorEditModal({
  target, existingCodes, busy, onCancel, onSave,
}: {
  target: EditTarget;
  existingCodes: string[];
  busy: boolean;
  onCancel: () => void;
  onSave: (vendorCode: string, name: string) => void;
}) {
  const initial = target.mode === "edit" ? target.vendor : null;
  const [code, setCode] = useState(initial?.vendor_code ?? "");
  const [name, setName] = useState(initial?.name ?? "");

  const codeTrim = code.trim();
  const nameTrim = name.trim();
  const ownCode = initial?.vendor_code.toLowerCase();
  const dup = codeTrim !== "" && existingCodes.includes(codeTrim.toLowerCase()) && codeTrim.toLowerCase() !== ownCode;
  const valid = codeTrim !== "" && nameTrim !== "" && !dup;

  return (
    <div style={overlay} onClick={onCancel}>
      <div style={modalCard} onClick={(e) => e.stopPropagation()}>
        <div style={modalHeader}>{target.mode === "create" ? "New planning vendor" : `Edit ${initial?.vendor_code}`}</div>
        <div style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <label style={S.label}>Vendor code</label>
            <input style={{ ...S.input, width: "100%" }} value={code} autoFocus
                   placeholder="e.g. ACME-APPAREL" onChange={(e) => setCode(e.target.value)} />
            {dup && <div style={{ color: PAL.red, fontSize: 11, marginTop: 4 }}>A vendor with this code already exists.</div>}
          </div>
          <div>
            <label style={S.label}>Name</label>
            <input style={{ ...S.input, width: "100%" }} value={name}
                   placeholder="Vendor name" onChange={(e) => setName(e.target.value)} />
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
            <button style={{ ...S.btnSecondary, flex: 1 }} onClick={onCancel}>Cancel</button>
            <button style={{ ...S.btnPrimary, flex: 1, opacity: valid && !busy ? 1 : 0.5, cursor: valid && !busy ? "pointer" : "not-allowed" }}
                    disabled={!valid || busy} onClick={() => onSave(codeTrim, nameTrim)}>
              {target.mode === "create" ? "Create" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Link-to-Tangerine modal ─────────────────────────────────────────────────
function LinkModal({
  vendor, options, alreadyLinkedIds, busy, onCancel, onLink,
}: {
  vendor: PlanningVendor;
  options: TangerineVendorOption[];
  alreadyLinkedIds: Set<string>;
  busy: boolean;
  onCancel: () => void;
  onLink: (tangerineVendorId: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);

  const selectOptions = useMemo(() => options.map((o) => ({
    value: o.id,
    label: o.code ? `${o.name} (${o.code})` : o.name,
    searchHaystack: `${o.name} ${o.code ?? ""}`,
    disabled: alreadyLinkedIds.has(o.id),
  })), [options, alreadyLinkedIds]);

  return (
    <div style={overlay} onClick={onCancel}>
      <div style={modalCard} onClick={(e) => e.stopPropagation()}>
        <div style={modalHeader}>Link "{vendor.vendor_code}" to Tangerine</div>
        <div style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontSize: 13, color: PAL.textDim }}>
            Choose the Tangerine vendor this planning vendor maps to. Buy plans will route its POs to that vendor.
          </div>
          <div>
            <label style={S.label}>Tangerine vendor</label>
            <SearchableSelect
              value={selected}
              onChange={setSelected}
              options={selectOptions}
              placeholder="Search Tangerine vendors…"
              emptyText="No Tangerine vendors"
            />
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
            <button style={{ ...S.btnSecondary, flex: 1 }} onClick={onCancel}>Cancel</button>
            <button style={{ ...S.btnPrimary, flex: 1, opacity: selected && !busy ? 1 : 0.5, cursor: selected && !busy ? "pointer" : "not-allowed" }}
                    disabled={!selected || busy} onClick={() => selected && onLink(selected)}>
              Link
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 300,
  display: "flex", alignItems: "center", justifyContent: "center",
};
const modalCard: React.CSSProperties = {
  background: PAL.panel, borderRadius: 14, width: "min(440px, 95vw)",
  border: `1px solid ${PAL.border}`, boxShadow: "0 24px 64px rgba(0,0,0,0.4)", overflow: "hidden",
};
const modalHeader: React.CSSProperties = {
  padding: "16px 24px", borderBottom: `1px solid ${PAL.border}`,
  fontSize: 16, fontWeight: 700, color: PAL.text, background: PAL.bg,
};

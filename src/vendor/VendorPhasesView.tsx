// Vendor-facing PO phase grid. Mirrors the layout of the internal
// TandA Grid but is read-mostly: a vendor can only propose edits on
// phases the ROF admin has flagged can_edit = true. Edits don't mutate
// tanda_milestones directly — they're staged in
// tanda_milestone_change_requests with status='pending' for internal
// review. The grid shows pending + reviewed activity per row.

import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { TH } from "../utils/theme";
import { supabaseVendor } from "./supabaseVendor";
import { fmtDate } from "./utils";
import { showAlert } from "./ui/AppDialog";

export type PhaseFilter = "all" | "overdue" | "this_week" | "next_30";

// Default WIP phases sourced from src/utils/tandaTypes.ts so the grid
// matches the internal TandA view. Kept in sync manually for now.
export const PHASES: { name: string; category: string; daysBeforeDDP: number }[] = [
  { name: "Lab Dip / Strike Off",      category: "Pre-Production", daysBeforeDDP: 120 },
  { name: "Trims",                     category: "Pre-Production", daysBeforeDDP: 110 },
  { name: "Raw Goods Available",       category: "Fabric T&A",     daysBeforeDDP: 100 },
  { name: "Fabric at Printing Mill",   category: "Fabric T&A",     daysBeforeDDP: 90  },
  { name: "Fabric Finished Goods",     category: "Fabric T&A",     daysBeforeDDP: 80  },
  { name: "Fabric at Factory",         category: "Fabric T&A",     daysBeforeDDP: 70  },
  { name: "Fabric at Cutting Line",    category: "Fabric T&A",     daysBeforeDDP: 60  },
  { name: "Fit Sample",                category: "Samples",        daysBeforeDDP: 90  },
  { name: "PP Sample",                 category: "Samples",        daysBeforeDDP: 75  },
  { name: "PP Approval",               category: "Samples",        daysBeforeDDP: 65  },
  { name: "Size Set",                  category: "Samples",        daysBeforeDDP: 55  },
  { name: "Top Sample",                category: "Samples",        daysBeforeDDP: 18  },
  { name: "Fabric Ready",              category: "Production",     daysBeforeDDP: 50  },
  { name: "Prod Start",                category: "Production",     daysBeforeDDP: 42  },
  { name: "Packing Start",             category: "Production",     daysBeforeDDP: 28  },
  { name: "Prod End",                  category: "Production",     daysBeforeDDP: 21  },
  { name: "Ex Factory",                category: "Transit",        daysBeforeDDP: 14  },
  { name: "Packing List / Docs Rec'd", category: "Transit",        daysBeforeDDP: 7   },
  { name: "In House / DDP",            category: "Transit",        daysBeforeDDP: 0   },
];

const STATUSES = ["Not Started", "In Progress", "Complete", "Delayed", "N/A"] as const;
type Status = typeof STATUSES[number];

const STATUS_COLORS: Record<Status, { bg: string; fg: string }> = {
  "Not Started": { bg: "#E5E7EB", fg: "#374151" },
  "In Progress": { bg: "#DBEAFE", fg: "#1E40AF" },
  "Complete":    { bg: "#D1FAE5", fg: "#065F46" },
  "Delayed":     { bg: "#FECACA", fg: "#991B1B" },
  "N/A":         { bg: "#F3F4F6", fg: "#6B7280" },
};

interface PORow {
  uuid_id: string;
  po_number: string;
  buyer_name: string | null;
  date_expected_delivery: string | null;
  data: { BuyerName?: string; DateExpectedDelivery?: string } | null;
}

interface ChangeRequest {
  id: string;
  po_id: string;
  phase_name: string;
  field_name: string;
  old_value: string | null;
  new_value: string | null;
  status: "pending" | "approved" | "rejected";
  requested_at: string;
  reviewed_at: string | null;
  review_note: string | null;
}

// Compute a phase's expected date = DDP − daysBeforeDDP.
export function computeExpectedDate(ddp: string | null, daysBefore: number): string | null {
  if (!ddp) return null;
  const d = new Date(ddp);
  if (isNaN(d.getTime())) return null;
  d.setDate(d.getDate() - daysBefore);
  return d.toISOString().slice(0, 10);
}

async function token() {
  const { data: { session } } = await supabaseVendor.auth.getSession();
  return session?.access_token || "";
}

interface Props {
  /** If set, view is scoped to just this PO (used inside VendorPODetail). */
  poId?: string;
}

export default function VendorPhasesView({ poId }: Props = {}) {
  const [params, setParams] = useSearchParams();
  const filterFromUrl = (params.get("filter") as PhaseFilter | null) || "all";
  const [filter, setFilter] = useState<PhaseFilter>(filterFromUrl);
  const [pos, setPos] = useState<PORow[]>([]);
  const [permissions, setPermissions] = useState<Map<string, boolean>>(new Map());
  const [requests, setRequests] = useState<ChangeRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => { setFilter(filterFromUrl); }, [filterFromUrl]);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const { data: userRes } = await supabaseVendor.auth.getUser();
      const uid = userRes.user?.id;
      if (!uid) throw new Error("Not signed in.");
      const { data: vu } = await supabaseVendor.from("vendor_users").select("vendor_id").eq("auth_id", uid).maybeSingle();
      const vid = (vu as { vendor_id: string } | null)?.vendor_id;
      if (!vid) throw new Error("Not linked to a vendor.");

      let poQuery = supabaseVendor.from("tanda_pos")
        .select("uuid_id, po_number, buyer_name, date_expected_delivery, data")
        .eq("vendor_id", vid)
        .order("date_expected_delivery", { ascending: true });
      if (poId) poQuery = poQuery.eq("uuid_id", poId);

      const [poRes, permRes, reqRes] = await Promise.all([
        poQuery,
        supabaseVendor.from("vendor_phase_permissions")
          .select("phase_name, can_edit")
          .eq("vendor_id", vid),
        supabaseVendor.from("tanda_milestone_change_requests")
          .select("id, po_id, phase_name, field_name, old_value, new_value, status, requested_at, reviewed_at, review_note")
          .eq("vendor_id", vid)
          .order("requested_at", { ascending: false }),
      ]);
      if (poRes.error) throw poRes.error;
      if (permRes.error) throw permRes.error;
      if (reqRes.error) throw reqRes.error;

      setPos(((poRes.data ?? []) as PORow[]).filter((r) => !(r.data as { _archived?: boolean } | null)?._archived));
      const m = new Map<string, boolean>();
      for (const r of (permRes.data ?? []) as { phase_name: string; can_edit: boolean }[]) {
        m.set(r.phase_name, r.can_edit);
      }
      setPermissions(m);
      setRequests((reqRes.data ?? []) as ChangeRequest[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [poId]);

  // Index requests by (po_id, phase_name, field_name) for quick display lookup.
  const requestIndex = useMemo(() => {
    const map = new Map<string, ChangeRequest[]>();
    for (const r of requests) {
      const key = `${r.po_id}::${r.phase_name}::${r.field_name}`;
      const arr = map.get(key) || [];
      arr.push(r);
      map.set(key, arr);
    }
    return map;
  }, [requests]);

  function latestRequest(poId: string, phase: string, field: string): ChangeRequest | null {
    return requestIndex.get(`${poId}::${phase}::${field}`)?.[0] || null;
  }

  function pendingCountForPO(poId: string): number {
    return requests.filter((r) => r.po_id === poId && r.status === "pending").length;
  }

  const banner = useMemo(() => {
    // Surface recent reviewer activity (last 24h) in a top banner so the
    // vendor notices if a proposed change got approved or rejected.
    const cutoff = Date.now() - 24 * 3600 * 1000;
    const recent = requests.filter((r) => r.reviewed_at && new Date(r.reviewed_at).getTime() > cutoff);
    if (recent.length === 0) return null;
    const approved = recent.filter((r) => r.status === "approved").length;
    const rejected = recent.filter((r) => r.status === "rejected").length;
    return { approved, rejected, total: recent.length };
  }, [requests]);

  const visiblePOs = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return pos;
    return pos.filter((p) => p.po_number.toLowerCase().includes(q) || (p.buyer_name ?? "").toLowerCase().includes(q));
  }, [pos, search]);

  // Flatten PO × phase into rows and filter by the date bucket.
  const phaseRows = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const in7 = new Date(today); in7.setDate(today.getDate() + 7);
    const in30 = new Date(today); in30.setDate(today.getDate() + 30);
    const rows: Array<{
      po: PORow;
      phase: typeof PHASES[number];
      effectiveDate: string | null;
      effectiveStatus: Status;
      dateReq: ChangeRequest | null;
      statusReq: ChangeRequest | null;
      bucket: PhaseFilter;
      daysFromToday: number | null;
    }> = [];
    for (const po of visiblePOs) {
      const ddp = po.date_expected_delivery || po.data?.DateExpectedDelivery || null;
      for (const phase of PHASES) {
        const defaultDate = computeExpectedDate(ddp, phase.daysBeforeDDP);
        const dateReq = latestRequest(po.uuid_id, phase.name, "expected_date");
        const statusReq = latestRequest(po.uuid_id, phase.name, "status");
        const effectiveDate =
          dateReq?.status === "approved" ? dateReq.new_value
          : dateReq?.status === "pending" ? dateReq.new_value
          : defaultDate;
        const effectiveStatus = (
          statusReq?.status === "approved" ? statusReq.new_value
          : statusReq?.status === "pending" ? statusReq.new_value
          : "Not Started"
        ) as Status;
        const complete = effectiveStatus === "Complete" || effectiveStatus === "N/A";
        const dateObj = effectiveDate ? new Date(effectiveDate) : null;
        const daysFromToday = dateObj ? Math.round((dateObj.getTime() - today.getTime()) / 86_400_000) : null;
        let bucket: PhaseFilter = "all";
        if (dateObj && !complete) {
          if (dateObj < today) bucket = "overdue";
          else if (dateObj <= in7) bucket = "this_week";
          else if (dateObj <= in30) bucket = "next_30";
        }
        rows.push({ po, phase, effectiveDate, effectiveStatus, dateReq, statusReq, bucket, daysFromToday });
      }
    }
    return rows;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visiblePOs, requestIndex]);

  const filteredRows = useMemo(() => {
    if (filter === "all") return phaseRows;
    return phaseRows.filter((r) => r.bucket === filter);
  }, [phaseRows, filter]);

  const bucketCounts = useMemo(() => {
    const c = { overdue: 0, this_week: 0, next_30: 0 };
    for (const r of phaseRows) {
      if (r.bucket === "overdue") c.overdue++;
      else if (r.bucket === "this_week") c.this_week++;
      else if (r.bucket === "next_30") c.next_30++;
    }
    return c;
  }, [phaseRows]);

  async function proposeChange(po: PORow, phaseName: string, fieldName: string, oldValue: string | null, newValue: string | null) {
    if (newValue === oldValue) return;
    try {
      const accessToken = await token();
      const r = await fetch("/api/vendor/change-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ po_id: po.uuid_id, phase_name: phaseName, field_name: fieldName, old_value: oldValue, new_value: newValue }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error || `Request failed (${r.status})`);
      await load();
    } catch (e: unknown) {
      await showAlert({ title: "Could not propose change", message: e instanceof Error ? e.message : String(e), tone: "danger" });
    }
  }

  if (loading && pos.length === 0) return <div style={{ color: poId ? TH.text : "#FFFFFF" }}>Loading phases…</div>;
  if (err) return <div style={{ color: TH.primary, padding: "10px 12px", background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6 }}>Error: {err}</div>;

  function setFilterAndUrl(f: PhaseFilter) {
    setFilter(f);
    if (!poId) {
      const p = new URLSearchParams(params);
      if (f === "all") p.delete("filter"); else p.set("filter", f);
      setParams(p, { replace: true });
    }
  }

  const showHeader = !poId;
  const totalPending = requests.filter((r) => r.status === "pending").length;

  return (
    <div>
      {showHeader && (
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0, color: "#FFFFFF", fontSize: 20 }}>Production phases</h2>
          <div style={{ color: "rgba(255,255,255,0.7)", fontSize: 12 }}>
            Propose changes on phases where your Ring of Fire admin has granted edit rights. Every change goes to them for approval.
          </div>
        </div>
      )}

      {banner && banner.total > 0 && (
        <div style={{ marginBottom: 14, padding: "10px 14px", background: "#ECFDF5", border: "1px solid #A7F3D0", borderRadius: 8, fontSize: 13, color: "#065F46" }}>
          Ring of Fire reviewed {banner.total} of your proposed changes in the last 24 hours — {banner.approved} approved · {banner.rejected} rejected. See the cell indicators below for details.
        </div>
      )}

      {/* Filter pills + counts. Counts apply to the caller's scope (all POs, or this one). */}
      <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
        <FilterPill active={filter === "all"} onClick={() => setFilterAndUrl("all")} label={`All (${phaseRows.length})`} />
        <FilterPill active={filter === "overdue"} onClick={() => setFilterAndUrl("overdue")} label={`Overdue (${bucketCounts.overdue})`} tone="danger" />
        <FilterPill active={filter === "this_week"} onClick={() => setFilterAndUrl("this_week")} label={`This week (${bucketCounts.this_week})`} tone="warn" />
        <FilterPill active={filter === "next_30"} onClick={() => setFilterAndUrl("next_30")} label={`Next 30 days (${bucketCounts.next_30})`} />
        <span style={{ color: "rgba(255,255,255,0.6)", fontSize: 12, marginLeft: "auto", alignSelf: "center" }}>
          {totalPending} pending change{totalPending === 1 ? "" : "s"}
        </span>
      </div>

      {showHeader && (
        <input
          placeholder="Search by PO # or buyer…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: "100%", maxWidth: 360, marginBottom: 10, padding: "7px 12px", borderRadius: 6, border: `1px solid ${TH.border}`, fontSize: 13, background: TH.surface, color: TH.text }}
        />
      )}

      <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, overflow: "auto", boxShadow: `0 1px 2px ${TH.shadow}` }}>
        <div style={{ display: "grid", gridTemplateColumns: `${poId ? "" : "140px "}240px 120px 110px 120px 1fr`, padding: "10px 14px", background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase", letterSpacing: 0.05 }}>
          {!poId && <div>PO #</div>}
          <div>Phase</div>
          <div>Expected</div>
          <div style={{ textAlign: "center" }}>Days</div>
          <div>Status</div>
          <div>Review state</div>
        </div>

        {filteredRows.length === 0 ? (
          <div style={{ padding: 30, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>
            {filter === "all" ? "No phases to show." : `No phases match "${filter.replace("_", " ")}".`}
          </div>
        ) : filteredRows.map((r) => {
          const editable = permissions.get(r.phase.name) === true;
          const pending = (r.dateReq?.status === "pending") || (r.statusReq?.status === "pending");
          const rejected = (r.dateReq?.status === "rejected") || (r.statusReq?.status === "rejected");
          const sc = STATUS_COLORS[r.effectiveStatus] || STATUS_COLORS["Not Started"];
          return (
            <div key={`${r.po.uuid_id}-${r.phase.name}`} style={{ display: "grid", gridTemplateColumns: `${poId ? "" : "140px "}240px 120px 110px 120px 1fr`, padding: "10px 14px", borderBottom: `1px solid ${TH.border}`, fontSize: 13, alignItems: "center" }}>
              {!poId && (
                <div style={{ fontWeight: 600, fontFamily: "Menlo, monospace" }}>
                  <Link to={`/vendor/pos/${r.po.uuid_id}`} style={{ color: TH.primary, textDecoration: "none" }}>{r.po.po_number}</Link>
                </div>
              )}
              <div style={{ color: TH.text }}>
                <div style={{ fontWeight: 600 }}>{r.phase.name}{editable ? "" : " 🔒"}</div>
                <div style={{ fontSize: 10, color: TH.textMuted, marginTop: 2 }}>{r.phase.category} · T−{r.phase.daysBeforeDDP}d</div>
              </div>
              <div>
                <input
                  type="date"
                  value={r.effectiveDate || ""}
                  disabled={!editable}
                  onChange={(e) => void proposeChange(r.po, r.phase.name, "expected_date", r.effectiveDate, e.target.value || null)}
                  style={{ width: "100%", padding: "4px 6px", fontSize: 12, borderRadius: 4,
                    border: `1px solid ${r.dateReq?.status === "pending" ? "#F59E0B" : r.dateReq?.status === "rejected" ? "#EF4444" : "#CBD5E1"}`,
                    background: editable ? "#fff" : "#f1f5f9", cursor: editable ? "text" : "not-allowed",
                    fontFamily: "inherit",
                  }}
                />
              </div>
              <div style={{ textAlign: "center", fontSize: 12, color: r.daysFromToday == null ? TH.textMuted : r.daysFromToday < 0 ? "#B91C1C" : r.daysFromToday <= 7 ? "#B45309" : TH.textSub2, fontWeight: 600 }}>
                {r.daysFromToday == null ? "—" : r.daysFromToday < 0 ? `${-r.daysFromToday}d late` : `${r.daysFromToday}d`}
              </div>
              <div>
                <select
                  value={r.effectiveStatus}
                  disabled={!editable}
                  onChange={(e) => void proposeChange(r.po, r.phase.name, "status", r.effectiveStatus, e.target.value)}
                  style={{ width: "100%", padding: "3px 4px", fontSize: 11, borderRadius: 4,
                    border: `1px solid ${r.statusReq?.status === "pending" ? "#F59E0B" : "#CBD5E1"}`,
                    background: sc.bg, color: sc.fg, cursor: editable ? "pointer" : "not-allowed",
                    fontWeight: 600, fontFamily: "inherit",
                  }}
                >
                  {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div style={{ fontSize: 11 }}>
                {pending && <span style={{ color: "#92400E" }}>⏳ pending review</span>}
                {rejected && !pending && (
                  <span style={{ color: "#991B1B" }} title={r.dateReq?.review_note || r.statusReq?.review_note || ""}>✗ rejected</span>
                )}
                {!pending && !rejected && (r.dateReq?.status === "approved" || r.statusReq?.status === "approved") && (
                  <span style={{ color: "#065F46" }}>✓ approved by reviewer</span>
                )}
                {!pending && !rejected && !r.dateReq?.status && !r.statusReq?.status && (
                  <span style={{ color: TH.textMuted }}>—</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FilterPill({ active, onClick, label, tone }: { active: boolean; onClick: () => void; label: string; tone?: "danger" | "warn" }) {
  const toneColor = tone === "danger" ? "#B91C1C" : tone === "warn" ? "#B45309" : TH.primary;
  return (
    <button
      onClick={onClick}
      style={{
        padding: "5px 12px", borderRadius: 999, fontSize: 12, fontWeight: 600,
        border: `1px solid ${active ? toneColor : TH.border}`,
        background: active ? toneColor : TH.surface,
        color: active ? "#FFFFFF" : TH.textSub,
        cursor: "pointer", fontFamily: "inherit",
      }}
    >
      {label}
    </button>
  );
}


// Vendor-facing PO phase grid. Mirrors the layout of the internal
// TandA Grid but is read-mostly: a vendor can only propose edits on
// phases the ROF admin has flagged can_edit = true. Edits don't mutate
// tanda_milestones directly — they're staged in
// tanda_milestone_change_requests with status='pending' for internal
// review. The grid shows pending + reviewed activity per row.

import React, { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { TH } from "./theme";
import { supabaseVendor } from "./supabaseVendor";
import { fmtDate } from "./utils";
import { showAlert, showConfirm } from "./ui/AppDialog";

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

// Dark-theme pill palette — semi-transparent tints over slate so the
// selects read as status chips rather than solid light rectangles.
const STATUS_COLORS: Record<Status, { bg: string; fg: string }> = {
  "Not Started": { bg: "#47556933", fg: "#CBD5E1" },
  "In Progress": { bg: "#1E40AF44", fg: "#93C5FD" },
  "Complete":    { bg: "#065F4644", fg: "#6EE7B7" },
  "Delayed":     { bg: "#991B1B44", fg: "#FCA5A5" },
  "N/A":         { bg: "#33415533", fg: "#94A3B8" },
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
  po_line_key: string | null; // null = phase-master, non-null = per-line override
}

interface POLine {
  id: string;
  line_index: number;
  item_number: string | null;
  description: string | null;
  qty_ordered: number | null;
  unit_price: number | null;
}

interface PhaseNote {
  id: string;
  po_id: string;
  phase_name: string;
  po_line_key: string | null;
  body: string;
  author_auth_id: string | null;
  author_name: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
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
  const [poLinesByPo, setPoLinesByPo] = useState<Record<string, POLine[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set()); // keys: `${po_id}::${phase_name}`
  const [notes, setNotes] = useState<PhaseNote[]>([]);
  const [currentAuthAid, setCurrentAuthAid] = useState<string | null>(null);
  const [currentDisplayName, setCurrentDisplayName] = useState<string>("Vendor");
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
      setCurrentAuthAid(uid);
      const { data: vu } = await supabaseVendor.from("vendor_users").select("vendor_id, display_name").eq("auth_id", uid).maybeSingle();
      const vid = (vu as { vendor_id: string; display_name: string | null } | null)?.vendor_id;
      const vname = (vu as { vendor_id: string; display_name: string | null } | null)?.display_name;
      if (!vid) throw new Error("Not linked to a vendor.");
      setCurrentDisplayName(vname || userRes.user?.email || "Vendor");

      let poQuery = supabaseVendor.from("tanda_pos")
        .select("uuid_id, po_number, buyer_name, date_expected_delivery, data")
        .eq("vendor_id", vid)
        .order("date_expected_delivery", { ascending: true });
      if (poId) poQuery = poQuery.eq("uuid_id", poId);

      const [poRes, permRes, reqRes, notesRes] = await Promise.all([
        poQuery,
        supabaseVendor.from("vendor_phase_permissions")
          .select("phase_name, can_edit")
          .eq("vendor_id", vid),
        supabaseVendor.from("tanda_milestone_change_requests")
          .select("id, po_id, phase_name, field_name, old_value, new_value, status, requested_at, reviewed_at, review_note, po_line_key")
          .eq("vendor_id", vid)
          .order("requested_at", { ascending: false }),
        supabaseVendor.from("po_phase_notes")
          .select("id, po_id, phase_name, po_line_key, body, author_auth_id, author_name, created_at, updated_at, deleted_at")
          .eq("vendor_id", vid)
          .is("deleted_at", null)
          .order("created_at", { ascending: true }),
      ]);
      if (poRes.error) throw poRes.error;
      if (permRes.error) throw permRes.error;
      if (reqRes.error) throw reqRes.error;
      if (notesRes.error) throw notesRes.error;
      setNotes((notesRes.data ?? []) as PhaseNote[]);

      const activePos = ((poRes.data ?? []) as PORow[]).filter((r) => !(r.data as { _archived?: boolean } | null)?._archived);
      setPos(activePos);

      // Fetch PO line items for all POs we're about to show so expansion
      // is instant (no second round-trip on each expand).
      const ids = activePos.map((p) => p.uuid_id);
      if (ids.length > 0) {
        const { data: lineRows } = await supabaseVendor
          .from("po_line_items")
          .select("id, po_id, line_index, item_number, description, qty_ordered, unit_price")
          .in("po_id", ids)
          .order("line_index", { ascending: true });
        const byPo: Record<string, POLine[]> = {};
        for (const l of (lineRows ?? []) as (POLine & { po_id: string })[]) {
          (byPo[l.po_id] ||= []).push({
            id: l.id, line_index: l.line_index, item_number: l.item_number,
            description: l.description, qty_ordered: l.qty_ordered, unit_price: l.unit_price,
          });
        }
        setPoLinesByPo(byPo);
      }
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

  // Index requests by (po_id, phase_name, po_line_key ?? "__master", field_name).
  // po_line_key null represents the phase-master row; non-null rows are
  // per-line-item overrides.
  const requestIndex = useMemo(() => {
    const map = new Map<string, ChangeRequest[]>();
    for (const r of requests) {
      const key = `${r.po_id}::${r.phase_name}::${r.po_line_key ?? "__master"}::${r.field_name}`;
      const arr = map.get(key) || [];
      arr.push(r);
      map.set(key, arr);
    }
    return map;
  }, [requests]);

  function latestRequest(poId: string, phase: string, field: string, lineKey: string | null = null): ChangeRequest | null {
    return requestIndex.get(`${poId}::${phase}::${lineKey ?? "__master"}::${field}`)?.[0] || null;
  }

  // Prior reviewed requests on the same cell (excluding the latest one).
  // Used to show review history — e.g. "previously REJECTED on 4/22".
  function priorHistory(poId: string, phase: string, field: string, lineKey: string | null = null): ChangeRequest[] {
    const all = requestIndex.get(`${poId}::${phase}::${lineKey ?? "__master"}::${field}`) || [];
    return all.slice(1).filter((r) => r.reviewed_at && r.status !== "pending");
  }

  // All reviewed requests for a phase (across status + expected_date fields),
  // surfaced to the vendor so they can see ROF's review notes alongside their
  // own phase notes. Sorted newest-first.
  function reviewEntriesFor(poIdArg: string, phase: string): ChangeRequest[] {
    return requests
      .filter((r) => r.po_id === poIdArg && r.phase_name === phase && r.reviewed_at && r.status !== "pending")
      .sort((a, b) => new Date(b.reviewed_at || 0).getTime() - new Date(a.reviewed_at || 0).getTime());
  }

  // Same as reviewEntriesFor but scoped to a specific line item.
  function reviewEntriesForLine(poIdArg: string, phase: string, lineKey: string): ChangeRequest[] {
    return requests
      .filter((r) => r.po_id === poIdArg && r.phase_name === phase && r.po_line_key === lineKey && r.reviewed_at && r.status !== "pending")
      .sort((a, b) => new Date(b.reviewed_at || 0).getTime() - new Date(a.reviewed_at || 0).getTime());
  }

  // Summarise line-level reviews for a phase so the master row can show
  // "✓ Line items approved · 4/23" etc. inline. Returns one entry per
  // status (approved / rejected) that actually occurred, each with the
  // most-recent reviewed_at and a count of line reviews feeding it.
  function lineReviewSummary(poIdArg: string, phase: string): Array<{ status: "approved" | "rejected"; latestDate: string; count: number }> {
    const lineRevs = requests.filter((r) =>
      r.po_id === poIdArg && r.phase_name === phase && r.po_line_key != null && r.reviewed_at && r.status !== "pending"
    );
    const byStatus = new Map<"approved" | "rejected", { latestDate: string; count: number }>();
    for (const rv of lineRevs) {
      const s = rv.status as "approved" | "rejected";
      const cur = byStatus.get(s);
      if (!cur || new Date(rv.reviewed_at || 0).getTime() > new Date(cur.latestDate).getTime()) {
        byStatus.set(s, { latestDate: rv.reviewed_at || "", count: (cur?.count || 0) + 1 });
      } else {
        byStatus.set(s, { latestDate: cur.latestDate, count: cur.count + 1 });
      }
    }
    const out: Array<{ status: "approved" | "rejected"; latestDate: string; count: number }> = [];
    const a = byStatus.get("approved");
    const j = byStatus.get("rejected");
    if (a) out.push({ status: "approved", ...a });
    if (j) out.push({ status: "rejected", ...j });
    return out.sort((x, y) => new Date(y.latestDate).getTime() - new Date(x.latestDate).getTime());
  }

  // Notes CRUD. Direct supabase calls — RLS enforces ownership on update.
  function notesFor(poIdArg: string, phase: string, lineKey: string | null = null): PhaseNote[] {
    const list = Array.isArray(notes) ? notes : [];
    return list.filter((n) => n.po_id === poIdArg && n.phase_name === phase && (n.po_line_key ?? null) === (lineKey ?? null));
  }
  function notesAndLineNotesFor(poIdArg: string, phase: string): PhaseNote[] {
    const list = Array.isArray(notes) ? notes : [];
    return list.filter((n) => n.po_id === poIdArg && n.phase_name === phase);
  }

  async function addNote(po: PORow, phase: string, lineKey: string | null, body: string) {
    if (!currentAuthAid || !body.trim()) return;
    const { data: vu } = await supabaseVendor.from("vendor_users").select("vendor_id").eq("auth_id", currentAuthAid).maybeSingle();
    const vid = (vu as { vendor_id: string } | null)?.vendor_id;
    if (!vid) return;
    const { data, error } = await supabaseVendor
      .from("po_phase_notes")
      .insert({
        vendor_id: vid,
        po_id: po.uuid_id,
        phase_name: phase,
        po_line_key: lineKey,
        body: body.trim(),
        author_auth_id: currentAuthAid,
        author_name: currentDisplayName,
      })
      .select("*")
      .single();
    if (error || !data) { await showAlert({ title: "Could not save note", message: error?.message || "unknown error", tone: "danger" }); return; }
    setNotes((prev) => [...prev, data as PhaseNote]);
  }

  async function editNote(id: string, body: string) {
    if (!body.trim()) return;
    const { data, error } = await supabaseVendor
      .from("po_phase_notes")
      .update({ body: body.trim(), updated_at: new Date().toISOString() })
      .eq("id", id)
      .select("*")
      .single();
    if (error || !data) { await showAlert({ title: "Could not edit note", message: error?.message || "unknown error", tone: "danger" }); return; }
    setNotes((prev) => prev.map((n) => n.id === id ? (data as PhaseNote) : n));
  }

  async function deleteNote(id: string) {
    const { error } = await supabaseVendor
      .from("po_phase_notes")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id);
    if (error) { await showAlert({ title: "Could not delete note", message: error.message, tone: "danger" }); return; }
    setNotes((prev) => prev.filter((n) => n.id !== id));
  }

  function pendingCountForPO(poId: string): number {
    return requests.filter((r) => r.po_id === poId && r.status === "pending").length;
  }

  const banner = useMemo(() => {
    // Surface recent reviewer activity (last 24h) in a top banner so the
    // vendor notices if a proposed change got approved or rejected. When
    // the view is scoped to a single PO (poId passed), only count that
    // PO's activity — otherwise approvals from other POs leak into the
    // banner on an unrelated PO's page.
    const cutoff = Date.now() - 24 * 3600 * 1000;
    const recent = requests.filter((r) => {
      if (!r.reviewed_at) return false;
      if (new Date(r.reviewed_at).getTime() <= cutoff) return false;
      if (poId && r.po_id !== poId) return false;
      return true;
    });
    if (recent.length === 0) return null;
    const approved = recent.filter((r) => r.status === "approved").length;
    const rejected = recent.filter((r) => r.status === "rejected").length;
    return { approved, rejected, total: recent.length };
  }, [requests, poId]);

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

  async function proposeChange(
    po: PORow,
    phaseName: string,
    fieldName: string,
    oldValue: string | null,
    newValue: string | null,
    lineKey: string | null = null,
  ) {
    if (newValue === oldValue) return;
    // Optimistic insert: surface the pending change in local state
    // immediately so the cell updates without waiting for the round-trip.
    // Tmp id gets replaced with the server's canonical id once POST resolves.
    const tmpId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const optimistic: ChangeRequest = {
      id: tmpId,
      po_id: po.uuid_id,
      phase_name: phaseName,
      field_name: fieldName,
      old_value: oldValue,
      new_value: newValue,
      status: "pending",
      requested_at: new Date().toISOString(),
      reviewed_at: null,
      review_note: null,
      po_line_key: lineKey,
    };
    setRequests((prev) => [optimistic, ...prev]);
    try {
      const accessToken = await token();
      const r = await fetch("/api/vendor/change-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          po_id: po.uuid_id,
          phase_name: phaseName,
          field_name: fieldName,
          old_value: oldValue,
          new_value: newValue,
          po_line_key: lineKey,
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error || `Request failed (${r.status})`);
      setRequests((prev) => prev.map((x) => (x.id === tmpId ? { ...optimistic, ...body, id: body.id || tmpId } : x)));
    } catch (e: unknown) {
      setRequests((prev) => prev.filter((x) => x.id !== tmpId));
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
        <div style={{ marginBottom: 14, padding: "10px 14px", background: "#064E3B33", border: "1px solid #10B98166", borderRadius: 8, fontSize: 13, color: "#6EE7B7" }}>
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
        <div style={{ display: "grid", gridTemplateColumns: `32px ${poId ? "" : "140px "}240px 120px 110px 120px 60px 280px 60px`, padding: "10px 14px", background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase", letterSpacing: 0.05 }}>
          <div></div>{/* expand-toggle column — keeps header aligned with rows */}
          {!poId && <div>PO #</div>}
          <div>Phase</div>
          <div>Expected</div>
          <div style={{ textAlign: "center" }}>Days</div>
          <div>Status</div>
          <div></div>{/* spacer — push Review state + Notes to the right */}
          <div style={{ textAlign: "left" }}>Review state</div>
          <div style={{ textAlign: "right" }}>Notes</div>
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
          const expandKey = `${r.po.uuid_id}::${r.phase.name}`;
          const isExpanded = expanded.has(expandKey);
          const lines = poLinesByPo[r.po.uuid_id] || [];

          // Aggregated notes for the master icon (master + every line).
          const allPhaseNotes = notesAndLineNotesFor(r.po.uuid_id, r.phase.name);

          // Detect mismatch: any line whose effective status differs from master's.
          const lineStatusOverrides = lines.map((l) => {
            const lReq = latestRequest(r.po.uuid_id, r.phase.name, "status", l.id);
            return lReq?.new_value || null;
          });
          const hasMismatch = lineStatusOverrides.some((s) => s != null && s !== r.effectiveStatus);
          const masterCellBorder = hasMismatch ? "#7C3AED" // distinct purple when lines diverge
            : r.statusReq?.status === "pending" ? "#F59E0B"
            : TH.border;

          return (
            <div key={expandKey}>
              {/* ── Master phase row ─────────────────────────────────── */}
              <div style={{ display: "grid", gridTemplateColumns: `32px ${poId ? "" : "140px "}240px 120px 110px 120px 60px 280px 60px`, padding: "10px 14px", borderBottom: isExpanded ? "none" : `1px solid ${TH.border}`, fontSize: 13, alignItems: "center", background: isExpanded ? TH.surfaceHi : "transparent" }}>
                <button
                  onClick={() => setExpanded((prev) => {
                    const next = new Set(prev);
                    if (next.has(expandKey)) next.delete(expandKey); else next.add(expandKey);
                    return next;
                  })}
                  aria-label={isExpanded ? "Collapse lines" : "Expand lines"}
                  style={{ width: 24, height: 24, border: `1px solid ${TH.border}`, background: TH.surface, color: TH.textSub, borderRadius: 4, cursor: "pointer", fontFamily: "inherit", fontSize: 11, lineHeight: 1, padding: 0 }}
                >
                  {isExpanded ? "▼" : "▶"}
                </button>
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
                      border: `1px solid ${r.dateReq?.status === "pending" ? "#F59E0B" : r.dateReq?.status === "rejected" ? "#EF4444" : TH.border}`,
                      background: editable ? TH.bg : TH.surface, color: TH.text,
                      cursor: editable ? "text" : "not-allowed",
                      fontFamily: "inherit", colorScheme: "dark",
                    }}
                  />
                </div>
                <div style={{ textAlign: "center", fontSize: 12, color: r.daysFromToday == null ? TH.textMuted : r.daysFromToday < 0 ? "#F87171" : r.daysFromToday <= 7 ? "#FBBF24" : TH.textSub2, fontWeight: 600 }}>
                  {r.daysFromToday == null ? "—" : r.daysFromToday < 0 ? `${-r.daysFromToday}d late` : `${r.daysFromToday}d`}
                </div>
                <div>
                  <select
                    value={r.effectiveStatus}
                    disabled={!editable}
                    onChange={(e) => void proposeChange(r.po, r.phase.name, "status", r.effectiveStatus, e.target.value)}
                    title={hasMismatch ? "One or more lines have a different status — expand to review" : undefined}
                    style={{ width: "100%", padding: "3px 4px", fontSize: 11, borderRadius: 4,
                      border: `2px solid ${masterCellBorder}`,
                      background: sc.bg, color: sc.fg, cursor: editable ? "pointer" : "not-allowed",
                      fontWeight: 600, fontFamily: "inherit",
                    }}
                  >
                    {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div></div>{/* spacer column — matches header, pushes review state + notes right */}
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, lineHeight: 1.35, display: "grid", gap: 2 }}>
                  {pending && <div style={{ color: "#FCD34D" }}>⏳ Pending review</div>}
                  {hasMismatch && <div style={{ color: "#7C3AED" }}>⚠ Lines differ</div>}

                  {/* Stack all reviewed history for this phase (across status +
                      expected_date fields) newest-first, so the vendor sees the
                      full audit trail inline instead of a "+ N earlier" hint. */}
                  {(() => {
                    const history = [
                      ...(r.statusReq?.reviewed_at && r.statusReq.status !== "pending" ? [r.statusReq] : []),
                      ...(r.dateReq?.reviewed_at && r.dateReq.status !== "pending" ? [r.dateReq] : []),
                      ...priorHistory(r.po.uuid_id, r.phase.name, "status"),
                      ...priorHistory(r.po.uuid_id, r.phase.name, "expected_date"),
                    ]
                      .filter((x, i, arr) => arr.findIndex((y) => y.id === x.id) === i)
                      .sort((a, b) => new Date(b.reviewed_at || 0).getTime() - new Date(a.reviewed_at || 0).getTime());

                    return history.map((h) => {
                      const approved = h.status === "approved";
                      const hasComment = !!(h.review_note && h.review_note.trim());
                      const color = approved ? "#6EE7B7" : "#FCA5A5";
                      const icon = approved ? "✓" : "✗";
                      const label = approved
                        ? hasComment ? "Approved w/ note" : "Approved"
                        : "Rejected";
                      const date = h.reviewed_at ? new Date(h.reviewed_at).toLocaleDateString() : "";
                      const tooltip = [
                        `${h.field_name} → ${h.new_value ?? "(cleared)"}`,
                        h.reviewed_by_internal_id ? `Reviewed by ${h.reviewed_by_internal_id}` : null,
                        h.review_note ? `Note: ${h.review_note}` : null,
                      ].filter(Boolean).join("\n");
                      return (
                        <div key={h.id} style={{ color, display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "baseline", whiteSpace: "nowrap" }} title={tooltip}>
                          <span>{icon} {label}</span>
                          {date && <span style={{ color: TH.textMuted, fontWeight: 500, textAlign: "right" }}>{date}</span>}
                        </div>
                      );
                    });
                  })()}

                  {!pending && !hasMismatch && !r.dateReq?.status && !r.statusReq?.status && (
                    <div style={{ color: TH.textMuted, fontWeight: 500 }}>—</div>
                  )}
                  {lineReviewSummary(r.po.uuid_id, r.phase.name).map((sum) => {
                    const approved = sum.status === "approved";
                    const color = approved ? "#6EE7B7" : "#FCA5A5";
                    const icon = approved ? "✓" : "✗";
                    const label = approved ? "Line item approved" : "Line item rejected";
                    const date = sum.latestDate ? new Date(sum.latestDate).toLocaleDateString() : "";
                    const countSuffix = sum.count > 1 ? ` (${sum.count})` : "";
                    return (
                      <div
                        key={sum.status}
                        title={`${sum.count} line item${sum.count === 1 ? "" : "s"} ${sum.status}. Expand the phase row to see each line.`}
                        style={{ color, display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "baseline", whiteSpace: "nowrap" }}
                      >
                        <span>{icon} {label}{countSuffix}</span>
                        {date && <span style={{ color: TH.textMuted, fontWeight: 500, textAlign: "right" }}>{date}</span>}
                      </div>
                    );
                  })}
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <NotesButton
                    notes={allPhaseNotes}
                    reviewEntries={reviewEntriesFor(r.po.uuid_id, r.phase.name)}
                    currentAuthAid={currentAuthAid}
                    title={`${r.po.po_number} — ${r.phase.name}`}
                    lines={lines}
                    onAdd={(body) => void addNote(r.po, r.phase.name, null, body)}
                    onEdit={(id, body) => void editNote(id, body)}
                    onDelete={(id) => void deleteNote(id)}
                  />
                </div>
              </div>

              {/* ── Expanded panel: line breakdown, aligned with master grid ── */}
              {isExpanded && (
                <div style={{ background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}` }}>
                  {lines.length === 0 ? (
                    <div style={{ fontSize: 12, color: TH.textMuted, padding: "10px 14px" }}>No line items materialized for this PO yet.</div>
                  ) : lines.map((l) => {
                        const lineStatusReq = latestRequest(r.po.uuid_id, r.phase.name, "status", l.id);
                        const lineStatus = (lineStatusReq?.new_value || r.effectiveStatus) as Status;
                        const differs = lineStatusReq?.new_value && lineStatusReq.new_value !== r.effectiveStatus;
                        const lsc = STATUS_COLORS[lineStatus] || STATUS_COLORS["Not Started"];
                        const lineReviews = reviewEntriesForLine(r.po.uuid_id, r.phase.name, l.id);
                        const linePending = lineStatusReq?.status === "pending";
                        return (
                          // Mirror the master row's grid so every cell (and
                          // especially the right-most Notes icon) lines up
                          // vertically with the master above.
                          <div key={l.id} style={{ display: "grid", gridTemplateColumns: `32px ${poId ? "" : "140px "}240px 120px 110px 120px 60px 280px 60px`, padding: "6px 14px", borderTop: `1px solid ${TH.border}`, fontSize: 12, alignItems: "start", gap: 0 }}>
                            <div></div>{/* expand-toggle placeholder */}
                            {!poId && <div></div>}{/* PO # placeholder — master shows number, line leaves blank */}
                            {/* Style + description occupy the Phase column so
                                the text naturally indents under the phase name
                                above without breaking the grid alignment. */}
                            <div style={{ paddingTop: 4 }}>
                              <div style={{ fontFamily: "Menlo, monospace", fontWeight: 600, fontSize: 11, color: TH.textSub2 }}>{l.item_number || "—"}</div>
                              <div style={{ fontSize: 11, color: TH.text, marginTop: 2, lineHeight: 1.35 }}>{l.description || "—"}</div>
                            </div>
                            <div></div>{/* Expected date placeholder */}
                            <div></div>{/* Days placeholder */}
                            <div>
                              <select
                                value={lineStatus}
                                disabled={!editable}
                                onChange={(e) => void proposeChange(r.po, r.phase.name, "status", lineStatus, e.target.value, l.id)}
                                style={{ width: "100%", padding: "2px 4px", fontSize: 10, borderRadius: 4,
                                  border: `1px solid ${linePending ? "#F59E0B" : differs ? "#7C3AED" : TH.border}`,
                                  background: lsc.bg, color: lsc.fg, cursor: editable ? "pointer" : "not-allowed",
                                  fontWeight: 600, fontFamily: "inherit",
                                }}
                              >
                                {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                              </select>
                              {differs && (
                                <div style={{ fontSize: 9, color: "#7C3AED", marginTop: 2 }}>overrides master</div>
                              )}
                              {linePending && (
                                <div style={{ fontSize: 9, color: "#FCD34D", marginTop: 2, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.3 }}>⏳ Pending</div>
                              )}
                            </div>
                            <div></div>{/* spacer */}
                            {/* Review state column — stack line review history
                                here so it aligns under the master's review
                                chips, matching the user's "beacon" ask. */}
                            <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, lineHeight: 1.35, display: "grid", gap: 2 }}>
                              {lineReviews.map((rv) => {
                                const approved = rv.status === "approved";
                                const hasComment = !!(rv.review_note && rv.review_note.trim());
                                const color = approved ? "#6EE7B7" : "#FCA5A5";
                                const icon = approved ? "✓" : "✗";
                                const label = approved
                                  ? hasComment ? "Approved w/ note" : "Approved"
                                  : "Rejected";
                                const date = rv.reviewed_at ? new Date(rv.reviewed_at).toLocaleDateString() : "";
                                const tooltip = [
                                  `${rv.field_name} → ${rv.new_value ?? "(cleared)"}`,
                                  rv.reviewed_by_internal_id ? `Reviewed by ${rv.reviewed_by_internal_id}` : null,
                                  rv.review_note ? `Note: ${rv.review_note}` : null,
                                ].filter(Boolean).join("\n");
                                return (
                                  <div key={rv.id} title={tooltip} style={{ color, display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "baseline", whiteSpace: "nowrap" }}>
                                    <span>{icon} {label}</span>
                                    {date && <span style={{ color: TH.textMuted, fontWeight: 500, textAlign: "right" }}>{date}</span>}
                                  </div>
                                );
                              })}
                            </div>
                            <div style={{ display: "flex", justifyContent: "flex-end", paddingTop: 2 }}>
                              <NotesButton
                                notes={notesFor(r.po.uuid_id, r.phase.name, l.id)}
                                reviewEntries={lineReviews}
                                currentAuthAid={currentAuthAid}
                                title={`${l.item_number || `Line ${l.line_index}`} · ${r.phase.name}`}
                                onAdd={(body) => void addNote(r.po, r.phase.name, l.id, body)}
                                onEdit={(id, body) => void editNote(id, body)}
                                onDelete={(id) => void deleteNote(id)}
                              />
                            </div>
                          </div>
                        );
                      })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Icon button that opens a popover of threaded notes. Notes are
 * user + timestamped. Each note has Edit + Delete (author only;
 * RLS also enforces that server-side). Master-level buttons get
 * passed both master and line notes so the vendor sees everything
 * in one place.
 */
function NotesButton({
  notes, reviewEntries, currentAuthAid, title, lines, onAdd, onEdit, onDelete,
}: {
  notes: PhaseNote[];
  reviewEntries?: ChangeRequest[];
  currentAuthAid: string | null;
  title: string;
  lines?: POLine[];
  onAdd: (body: string) => void;
  onEdit: (id: string, body: string) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const count = notes.length;
  const reviews = (reviewEntries || []).filter((r) => r.reviewed_at && r.status !== "pending");
  const reviewCount = reviews.length;

  // Map line id → label so we can caption line-level notes inside
  // the master popover.
  const lineLabel = useMemo(() => {
    const m: Record<string, string> = {};
    for (const l of lines || []) m[l.id] = l.item_number || `Line ${l.line_index}`;
    return m;
  }, [lines]);

  async function handleDelete(id: string) {
    const ok = await showConfirm({ title: "Delete note?", message: "This note will be removed for everyone. The audit trail is preserved server-side.", tone: "danger", confirmLabel: "Delete" });
    if (ok) onDelete(id);
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title={
          count === 0 && reviewCount === 0 ? "Add a note"
          : `${count} note${count === 1 ? "" : "s"}${reviewCount ? ` · ${reviewCount} ROF review${reviewCount === 1 ? "" : "s"}` : ""}`
        }
        style={{
          width: 28, height: 24, padding: 0,
          border: `1px solid ${count > 0 || reviewCount > 0 ? TH.primary : TH.border}`,
          borderRadius: 6,
          background: count > 0 || reviewCount > 0 ? "#1E3A8A55" : TH.surface,
          color: count > 0 || reviewCount > 0 ? TH.primaryLt : TH.textMuted,
          cursor: "pointer", fontFamily: "inherit",
          display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 3,
          fontSize: 11, fontWeight: 700,
        }}
      >
        💬{count + reviewCount > 0 ? count + reviewCount : ""}
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={(e) => { if (e.currentTarget === e.target) { setOpen(false); setEditingId(null); } }}
          style={{
            position: "fixed", inset: 0, zIndex: 9999,
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "rgba(15, 23, 42, 0.55)",
          }}
        >
          <div
            style={{
              width: "min(480px, calc(100vw - 32px))",
              maxHeight: "min(560px, calc(100vh - 48px))",
              overflow: "hidden",
              display: "flex", flexDirection: "column",
              background: TH.surface, border: `1px solid ${TH.border}`,
              borderRadius: 10, boxShadow: "0 12px 40px rgba(0,0,0,0.35)",
              fontFamily: "system-ui, -apple-system, sans-serif", color: TH.text,
            }}
          >
            <div style={{ padding: "12px 16px", borderBottom: `1px solid ${TH.border}`, background: TH.surfaceHi, display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 13 }}>{title}</div>
                <div style={{ fontSize: 10, color: TH.textMuted }}>{count} note{count === 1 ? "" : "s"}</div>
              </div>
              <button
                onClick={() => { setOpen(false); setEditingId(null); }}
                aria-label="Close"
                style={{ ...iconBtn, padding: "3px 10px" }}
              >Close</button>
            </div>

            <div style={{ padding: "8px 16px", overflowY: "auto", flex: 1 }}>
              {reviews.length > 0 && (
                <div style={{ marginBottom: 10, paddingBottom: 10, borderBottom: `1px solid ${TH.border}` }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>
                    Ring of Fire review notes ({reviews.length})
                  </div>
                  {reviews.map((rv) => {
                    const approved = rv.status === "approved";
                    const color = approved ? "#6EE7B7" : "#FCA5A5";
                    const bg = approved ? "#064E3B33" : "#7F1D1D33";
                    const border = approved ? "#10B98166" : "#EF444466";
                    return (
                      <div key={rv.id} style={{ padding: 8, marginBottom: 6, background: bg, border: `1px solid ${border}`, borderRadius: 6 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: TH.textMuted, fontWeight: 600 }}>
                          <span style={{ color }}>
                            {approved ? "✓" : "✗"} {approved ? "Approved" : "Rejected"} · {rv.field_name} → {rv.new_value ?? "(cleared)"}
                          </span>
                          <span>{rv.reviewed_at && new Date(rv.reviewed_at).toLocaleString()}</span>
                        </div>
                        {rv.reviewed_by_internal_id && (
                          <div style={{ fontSize: 10, color: TH.textMuted, marginTop: 2 }}>by {rv.reviewed_by_internal_id}</div>
                        )}
                        {rv.review_note && (
                          <div style={{ fontSize: 12, color: TH.text, marginTop: 4, whiteSpace: "pre-wrap" }}>{rv.review_note}</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {notes.length === 0 && (
                <div style={{ color: TH.textMuted, fontSize: 12, padding: "6px 0" }}>{reviews.length === 0 ? "No notes yet." : "No vendor notes yet — add one below."}</div>
              )}
              {notes.map((n) => {
                const mine = !!currentAuthAid && n.author_auth_id === currentAuthAid;
                const isEditing = editingId === n.id;
                return (
                  <div key={n.id} style={{ padding: "6px 0", borderBottom: `1px dashed ${TH.border}` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 6, fontSize: 10, color: TH.textMuted }}>
                      <span>
                        <strong style={{ color: TH.text }}>{n.author_name}</strong>
                        {n.po_line_key && lineLabel[n.po_line_key] && (
                          <> · <span style={{ fontFamily: "Menlo, monospace" }}>{lineLabel[n.po_line_key]}</span></>
                        )}
                      </span>
                      <span title={n.created_at}>{new Date(n.created_at).toLocaleString()}</span>
                    </div>
                    {isEditing ? (
                      <>
                        <textarea
                          rows={2}
                          value={editDraft}
                          onChange={(e) => setEditDraft(e.target.value)}
                          style={{ width: "100%", marginTop: 4, padding: "4px 6px", fontSize: 12, borderRadius: 4, border: `1px solid ${TH.border}`, fontFamily: "inherit", boxSizing: "border-box" }}
                        />
                        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 4 }}>
                          <button onClick={() => { setEditingId(null); }} style={iconBtn}>Cancel</button>
                          <button
                            onClick={() => { if (editDraft.trim()) { onEdit(n.id, editDraft); setEditingId(null); } }}
                            style={{ ...iconBtn, background: TH.primary, color: "#fff", borderColor: TH.primary }}
                          >Save</button>
                        </div>
                      </>
                    ) : (
                      <>
                        <div style={{ fontSize: 12, color: TH.text, marginTop: 2, whiteSpace: "pre-wrap" }}>{n.body}</div>
                        {n.updated_at && n.updated_at !== n.created_at && (
                          <div style={{ fontSize: 9, color: TH.textMuted, marginTop: 2 }}>edited {new Date(n.updated_at).toLocaleString()}</div>
                        )}
                        {mine && (
                          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 4 }}>
                            <button onClick={() => { setEditingId(n.id); setEditDraft(n.body); }} style={iconBtn}>Edit</button>
                            <button onClick={() => void handleDelete(n.id)} style={{ ...iconBtn, color: "#F87171" }}>Delete</button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>

            <div style={{ padding: "8px 12px", borderTop: `1px solid ${TH.border}`, background: TH.surfaceHi }}>
              <textarea
                rows={2}
                placeholder="Add a note…"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                style={{ width: "100%", padding: "4px 6px", fontSize: 12, borderRadius: 4, border: `1px solid ${TH.border}`, fontFamily: "inherit", boxSizing: "border-box" }}
              />
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
                <button
                  disabled={!draft.trim()}
                  onClick={() => { onAdd(draft); setDraft(""); }}
                  style={{ ...iconBtn, background: draft.trim() ? TH.primary : TH.textMuted, color: "#fff", borderColor: draft.trim() ? TH.primary : TH.textMuted, cursor: draft.trim() ? "pointer" : "not-allowed" }}
                >Add note</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const iconBtn: React.CSSProperties = {
  padding: "3px 10px",
  fontSize: 11,
  fontWeight: 600,
  borderRadius: 4,
  border: `1px solid ${TH.border}`,
  background: TH.surface,
  color: TH.textSub,
  cursor: "pointer",
  fontFamily: "inherit",
};

function FilterPill({ active, onClick, label, tone }: { active: boolean; onClick: () => void; label: string; tone?: "danger" | "warn" }) {
  const toneColor = tone === "danger" ? "#F87171" : tone === "warn" ? "#FBBF24" : TH.primary;
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


import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { TH } from "../theme";
import { supabaseVendor } from "../supabaseVendor";
import { fmtDate, fmtMoney, daysUntil, parseLocalDate, errMsg } from "../utils";

// Only surface current POs. Anything ordered before this date is legacy Xoro
// history the vendor doesn't need to act on. Keyed on tanda_pos.date_order
// (the PO order/creation date).
const MIN_PO_DATE = "2025-12-01";
import { showAlert } from "../ui/AppDialog";

// tanda_pos row shape (subset we care about in the portal). The query is scoped
// to the logged-in vendor with an explicit .eq("vendor_id", …) — RLS is NOT
// relied on for isolation (it's permissive; see vendorId.ts).
type POItem = {
  QtyOrder?: number;
  QtyReceived?: number;
  QtyRemaining?: number;
  UnitPrice?: number;
};

type POPayload = {
  PoNumber?: string;
  DateOrder?: string;
  DateExpectedDelivery?: string;
  StatusName?: string;
  TotalAmount?: number;
  BuyerName?: string;
  BuyerPo?: string;
  Items?: POItem[];
  PoLineArr?: POItem[];
  _archived?: boolean;
};

type PORow = {
  id: string;
  uuid_id: string;
  po_number: string;
  data: POPayload | null;
  buyer_name: string | null;
  date_expected_delivery: string | null;
  vendor_id: string | null;
  /** "xoro" = tanda_pos (legacy sync); "tangerine" = purchase_orders (new ERP). */
  source?: "xoro" | "tangerine";
};

// Tangerine-native PO (purchase_orders) — the new ERP's POs, unioned into the
// portal alongside the Xoro tanda_pos rows.
type TangerinePO = {
  id: string;
  po_number: string;
  order_date: string | null;
  expected_date: string | null;
  status: string | null;
  total_cents: number | null;
  notes: string | null;
  vendor_id: string | null;
};
type TangerineLine = {
  purchase_order_id: string;
  qty_ordered: number | null;
  qty_received: number | null;
  unit_cost_cents: number | null;
};

function poItems(p: POPayload | null | undefined): POItem[] {
  return (p?.Items || p?.PoLineArr || []) as POItem[];
}

function poReceivedTotals(p: POPayload | null | undefined) {
  const items = poItems(p);
  let qtyOrd = 0, qtyRcv = 0, amtRcv = 0, amtOrd = 0;
  for (const it of items) {
    const qo = Number(it.QtyOrder) || 0;
    const qr = Number(it.QtyReceived) || 0;
    const up = Number(it.UnitPrice) || 0;
    qtyOrd += qo;
    qtyRcv += qr;
    amtOrd += qo * up;
    amtRcv += qr * up;
  }
  const totalAmount = Number(p?.TotalAmount) || amtOrd;
  return {
    qtyOrdered: qtyOrd,
    qtyReceived: qtyRcv,
    qtyRemaining: Math.max(qtyOrd - qtyRcv, 0),
    amountReceived: amtRcv,
    amountRemaining: Math.max(totalAmount - amtRcv, 0),
  };
}

type Filter = "all" | "action" | "ack";

export default function POList() {
  const [rows, setRows] = useState<PORow[]>([]);
  const [ackIds, setAckIds] = useState<Set<string>>(new Set());
  const [ackAtByPo, setAckAtByPo] = useState<Map<string, string>>(new Map());
  const [vendorUserId, setVendorUserId] = useState<string | null>(null);
  const [lastReceivedByPo, setLastReceivedByPo] = useState<Map<string, string>>(new Map());
  const [shippedPoIds, setShippedPoIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  function toggleSort(k: string) {
    setSortKey((prev) => (prev === k ? (sortDir === "asc" ? k : null) : k));
    setSortDir((prev) => (sortKey === k && prev === "asc" ? "desc" : "asc"));
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const { data: userRes } = await supabaseVendor.auth.getUser();
        const uid = userRes.user?.id;
        if (!uid) throw new Error("Not signed in.");

        // Resolve the vendor first — the PO query MUST be scoped to this
        // vendor explicitly (RLS is permissive, see vendorId.ts), otherwise
        // every vendor's POs leak into the list.
        const { data: vu, error: vuErr } = await supabaseVendor
          .from("vendor_users").select("id, vendor_id").eq("auth_id", uid).maybeSingle();
        if (vuErr) throw vuErr;
        if (!vu) throw new Error("Your account is not linked to a vendor.");
        const vuId = vu.id as string;
        const vendorId = vu.vendor_id as string | null;
        if (!vendorId) throw new Error("Your account is not linked to a vendor.");

        const { data: pos, error: posErr } = await supabaseVendor
          .from("tanda_pos")
          .select("id, uuid_id, po_number, data, buyer_name, date_expected_delivery, vendor_id")
          .eq("vendor_id", vendorId)
          .gte("date_order", MIN_PO_DATE)
          .order("date_order", { ascending: false });
        if (posErr) throw posErr;

        const { data: acks, error: acksErr } = await supabaseVendor
          .from("po_acknowledgments")
          .select("po_number, acknowledged_at")
          .eq("vendor_user_id", vuId);
        if (acksErr) throw acksErr;

        const active = ((pos ?? []) as PORow[])
          .filter((r) => !r.data?._archived)
          .map((r) => ({ ...r, source: "xoro" as const }));

        // Tangerine-native POs live in `purchase_orders` (the new ERP), NOT in
        // tanda_pos (Xoro sync). Union them in so the vendor sees active POs from
        // BOTH systems (in future only Tangerine will exist). Fail-safe: any error
        // here leaves the Xoro list fully intact.
        let tangerineRows: PORow[] = [];
        try {
          const { data: tpos } = await supabaseVendor
            .from("purchase_orders")
            .select("id, po_number, order_date, expected_date, status, total_cents, notes, vendor_id")
            .eq("vendor_id", vendorId)
            .in("status", ["issued", "in_transit", "received"])
            .gte("order_date", MIN_PO_DATE)
            .order("order_date", { ascending: false });
          const tposList = (tpos ?? []) as TangerinePO[];
          if (tposList.length > 0) {
            const tIds = tposList.map((p) => p.id);
            const { data: tlines } = await supabaseVendor
              .from("purchase_order_lines")
              .select("purchase_order_id, qty_ordered, qty_received, unit_cost_cents")
              .in("purchase_order_id", tIds);
            const linesByPo = new Map<string, TangerineLine[]>();
            for (const l of (tlines ?? []) as TangerineLine[]) {
              if (!linesByPo.has(l.purchase_order_id)) linesByPo.set(l.purchase_order_id, []);
              linesByPo.get(l.purchase_order_id)!.push(l);
            }
            tangerineRows = tposList.map((p) => {
              const lines = linesByPo.get(p.id) || [];
              return {
                id: p.id,
                uuid_id: p.id,
                po_number: p.po_number,
                buyer_name: null,
                date_expected_delivery: p.expected_date,
                vendor_id: p.vendor_id,
                source: "tangerine" as const,
                data: {
                  PoNumber: p.po_number,
                  DateOrder: p.order_date ?? undefined,
                  DateExpectedDelivery: p.expected_date ?? undefined,
                  StatusName: p.status ?? undefined,
                  TotalAmount: typeof p.total_cents === "number" ? p.total_cents / 100 : undefined,
                  BuyerName: null,
                  Items: lines.map((l) => ({
                    QtyOrder: l.qty_ordered ?? 0,
                    QtyReceived: l.qty_received ?? 0,
                    UnitPrice: typeof l.unit_cost_cents === "number" ? l.unit_cost_cents / 100 : 0,
                  })),
                  _archived: false,
                },
              };
            });
          }
        } catch (te) {
          // Non-fatal — Tangerine POs are additive; the Xoro list still renders.
          console.warn("[vendor/POList] purchase_orders fetch failed:", te);
        }

        const merged = [...active, ...tangerineRows].sort((a, b) =>
          (b.data?.DateOrder || "").localeCompare(a.data?.DateOrder || ""));

        if (cancelled) return;
        setVendorUserId(vuId);
        setRows(merged);
        setAckIds(new Set((acks ?? []).map((a: { po_number: string }) => a.po_number)));
        const ackMap = new Map<string, string>();
        for (const a of (acks ?? []) as { po_number: string; acknowledged_at: string | null }[]) {
          if (a.acknowledged_at) ackMap.set(a.po_number, a.acknowledged_at);
        }
        setAckAtByPo(ackMap);

        // Pull the most recent received_date per PO for the "Received" column.
        // (Tangerine PO ids simply won't match the tanda_pos-keyed receipt/invoice
        // tables — they show no received/shipped info, which is correct for now.)
        const poIds = merged.map((r) => r.uuid_id).filter(Boolean);
        if (poIds.length > 0) {
          const [{ data: receipts }, { data: invoices }] = await Promise.all([
            supabaseVendor.from("receipts").select("po_id, received_date").in("po_id", poIds),
            supabaseVendor.from("invoices").select("po_id, status").in("po_id", poIds),
          ]);
          const map = new Map<string, string>();
          for (const r of (receipts || []) as { po_id: string; received_date: string | null }[]) {
            if (!r.po_id || !r.received_date) continue;
            const prev = map.get(r.po_id);
            if (!prev || new Date(r.received_date) > new Date(prev)) map.set(r.po_id, r.received_date);
          }
          if (!cancelled) setLastReceivedByPo(map);
          const shipped = new Set<string>();
          for (const i of (invoices || []) as { po_id: string | null; status: string }[]) {
            if (i.po_id && i.status !== "rejected") shipped.add(i.po_id);
          }
          if (!cancelled) setShippedPoIds(shipped);
        }
      } catch (e: unknown) {
        if (!cancelled) setErr(errMsg(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const visible = useMemo(() => {
    if (filter === "ack") return rows.filter((r) => ackIds.has(r.po_number));
    if (filter === "action") return rows.filter((r) => !ackIds.has(r.po_number));
    return rows;
  }, [rows, ackIds, filter]);

  const sorted = useMemo(() => {
    if (!sortKey) return visible;
    const dir = sortDir === "asc" ? 1 : -1;
    const scalar = (r: PORow): string | number | null => {
      const p = r.data ?? {};
      const totals = poReceivedTotals(p);
      switch (sortKey) {
        case "po_number": return r.po_number || null;
        case "issued": return p.DateOrder || null;
        case "required": return r.date_expected_delivery || p.DateExpectedDelivery || null;
        case "amount": return typeof p.TotalAmount === "number" ? p.TotalAmount : null;
        case "received_on": return lastReceivedByPo.get(r.uuid_id) || null;
        case "qty_rcv": return totals.qtyOrdered > 0 ? totals.qtyReceived : null;
        case "qty_remain": return totals.qtyOrdered > 0 ? totals.qtyRemaining : null;
        case "amt_received": return totals.qtyOrdered > 0 ? totals.amountReceived : null;
        case "amt_remain": return totals.qtyOrdered > 0 ? totals.amountRemaining : null;
        case "status": return (shippedPoIds.has(r.uuid_id) ? "Shipped/Invoiced" : p.StatusName) || null;
        default: return null;
      }
    };
    const arr = [...visible];
    arr.sort((a, b) => {
      const va = scalar(a);
      const vb = scalar(b);
      const aEmpty = va == null || va === "";
      const bEmpty = vb == null || vb === "";
      if (aEmpty && bEmpty) return 0;
      if (aEmpty) return 1;
      if (bEmpty) return -1;
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
    return arr;
  }, [visible, sortKey, sortDir, lastReceivedByPo, shippedPoIds]);

  const stats = useMemo(() => {
    const open = rows.length;
    const pending = rows.filter((r) => !ackIds.has(r.po_number));
    const acked = rows.filter((r) => ackIds.has(r.po_number));
    const sumAmount = (list: PORow[]) =>
      list.reduce((acc, r) => acc + (Number(r.data?.TotalAmount) || 0), 0);
    const pendingAmount = sumAmount(pending);
    const ackedAmount = sumAmount(acked);
    const todayMidnight = new Date();
    todayMidnight.setHours(0, 0, 0, 0);
    const ddps = rows
      .map((r) => r.date_expected_delivery || r.data?.DateExpectedDelivery)
      .map((d) => parseLocalDate(d))
      .filter((dt): dt is Date => dt != null && dt.getTime() >= todayMidnight.getTime())
      .map((dt) => dt.getTime())
      .sort((a, b) => a - b);
    const next = ddps[0] ? new Date(ddps[0]).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" }) : "—";
    return {
      open,
      pendingCount: pending.length,
      ackedCount: acked.length,
      pendingAmount,
      ackedAmount,
      next,
    };
  }, [rows, ackIds]);

  async function acknowledge(poNumber: string) {
    if (!vendorUserId) return;
    const { error } = await supabaseVendor
      .from("po_acknowledgments")
      .upsert(
        { po_number: poNumber, vendor_user_id: vendorUserId },
        { onConflict: "po_number,vendor_user_id" },
      );
    if (error) {
      await showAlert({ title: "Could not acknowledge", message: error.message, tone: "danger" });
      return;
    }
    setAckIds((prev) => new Set(prev).add(poNumber));
  }

  if (loading) return <div style={{ color: TH.textMuted }}>Loading POs…</div>;
  if (err) return <div style={{ color: TH.primary, padding: "10px 12px", background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6 }}>Error: {err}</div>;

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 20 }}>
        <StatCard label="Open POs" value={String(stats.open)} />
        <StatCard
          label="Pending acknowledgment"
          value={fmtMoney(stats.pendingAmount)}
          sub={`${stats.pendingCount} PO${stats.pendingCount === 1 ? "" : "s"}`}
          tone={stats.pendingCount > 0 ? "warn" : "ok"}
        />
        <StatCard
          label="Acknowledged"
          value={fmtMoney(stats.ackedAmount)}
          sub={`${stats.ackedCount} PO${stats.ackedCount === 1 ? "" : "s"}`}
          tone="ok"
        />
        <StatCard label="Next shipment ETA" value={stats.next} />
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        <Pill active={filter === "all"} onClick={() => setFilter("all")}>All ({rows.length})</Pill>
        <Pill active={filter === "action"} onClick={() => setFilter("action")}>
          Action needed ({rows.filter((r) => !ackIds.has(r.po_number)).length})
        </Pill>
        <Pill active={filter === "ack"} onClick={() => setFilter("ack")}>
          Acknowledged ({rows.filter((r) => ackIds.has(r.po_number)).length})
        </Pill>
      </div>

      <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, overflow: "auto", boxShadow: `0 1px 2px ${TH.shadow}` }}>
        <div style={{ display: "grid", gridTemplateColumns: "120px 100px 110px 110px 24px 110px 130px 110px 120px 120px 260px 170px", padding: "10px 14px", background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase", letterSpacing: 0.05, minWidth: 1554 }}>
          <div onClick={() => toggleSort("po_number")} style={{ cursor: "pointer", userSelect: "none" }}>PO #{sortKey === "po_number" ? (sortDir === "asc" ? " ▲" : " ▼") : ""}</div>
          <div onClick={() => toggleSort("issued")} style={{ cursor: "pointer", userSelect: "none" }}>Issued{sortKey === "issued" ? (sortDir === "asc" ? " ▲" : " ▼") : ""}</div>
          <div onClick={() => toggleSort("required")} style={{ cursor: "pointer", userSelect: "none" }}>Required{sortKey === "required" ? (sortDir === "asc" ? " ▲" : " ▼") : ""}</div>
          <div onClick={() => toggleSort("amount")} style={{ textAlign: "right", cursor: "pointer", userSelect: "none" }}>Amount{sortKey === "amount" ? (sortDir === "asc" ? " ▲" : " ▼") : ""}</div>
          <div></div>
          <div onClick={() => toggleSort("received_on")} style={{ cursor: "pointer", userSelect: "none" }}>Dt Rcvd{sortKey === "received_on" ? (sortDir === "asc" ? " ▲" : " ▼") : ""}</div>
          <div onClick={() => toggleSort("qty_rcv")} style={{ textAlign: "right", cursor: "pointer", userSelect: "none" }}>Qty Rcv / Ord{sortKey === "qty_rcv" ? (sortDir === "asc" ? " ▲" : " ▼") : ""}</div>
          <div onClick={() => toggleSort("qty_remain")} style={{ textAlign: "right", cursor: "pointer", userSelect: "none" }}>Qty Remain{sortKey === "qty_remain" ? (sortDir === "asc" ? " ▲" : " ▼") : ""}</div>
          <div onClick={() => toggleSort("amt_received")} style={{ textAlign: "right", cursor: "pointer", userSelect: "none" }}>Amt Received{sortKey === "amt_received" ? (sortDir === "asc" ? " ▲" : " ▼") : ""}</div>
          <div onClick={() => toggleSort("amt_remain")} style={{ textAlign: "right", cursor: "pointer", userSelect: "none" }}>Amt Remain{sortKey === "amt_remain" ? (sortDir === "asc" ? " ▲" : " ▼") : ""}</div>
          <div onClick={() => toggleSort("status")} style={{ textAlign: "center", cursor: "pointer", userSelect: "none" }}>Status{sortKey === "status" ? (sortDir === "asc" ? " ▲" : " ▼") : ""}</div>
          <div style={{ textAlign: "center" }}>Acknowledge Date</div>
        </div>
        {sorted.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>
            No POs in this view.
          </div>
        ) : sorted.map((r) => {
          const p = r.data ?? {};
          const ddp = r.date_expected_delivery || p.DateExpectedDelivery;
          const days = daysUntil(ddp);
          const acked = ackIds.has(r.po_number);
          const ackedAt = ackAtByPo.get(r.po_number);
          const totals = poReceivedTotals(p);
          const receivedOn = lastReceivedByPo.get(r.uuid_id);
          return (
            <Link
              key={r.id}
              to={`/vendor/pos/${r.uuid_id}`}
              style={{ display: "grid", gridTemplateColumns: "120px 100px 110px 110px 24px 110px 130px 110px 120px 120px 260px 170px", padding: "12px 14px", borderBottom: `1px solid ${TH.border}`, fontSize: 13, alignItems: "center", textDecoration: "none", color: "inherit", minWidth: 1554 }}
            >
              <div style={{ fontWeight: 600, color: TH.primary, display: "flex", alignItems: "center", gap: 6 }}>
                {r.po_number}
                {r.source === "tangerine" && (
                  <span
                    title="Tangerine PO (new system)"
                    style={{ fontSize: 9, fontWeight: 700, color: "#A7F3D0", background: "#064E3B", border: "1px solid #065F46", borderRadius: 4, padding: "1px 4px", textTransform: "uppercase", letterSpacing: ".04em", flexShrink: 0 }}
                  >TGR</span>
                )}
              </div>
              <div style={{ color: TH.textSub2 }}>{fmtDate(p.DateOrder)}</div>
              <div style={{ color: TH.textSub2, display: "flex", flexDirection: "column", lineHeight: 1.25 }}>
                <span>{fmtDate(ddp)}</span>
                {days != null && days <= 14 && days >= 0 && (
                  <span style={{ fontSize: 11, color: TH.primaryLt, fontWeight: 600 }}>({days}d)</span>
                )}
                {days != null && days < 0 && (
                  <span style={{ fontSize: 11, color: TH.primary, fontWeight: 600 }}>overdue</span>
                )}
              </div>
              <div style={{ color: TH.textSub2, textAlign: "right" }}>{fmtMoney(p.TotalAmount)}</div>
              <div></div>
              <div style={{ color: TH.textSub2 }}>{receivedOn ? fmtDate(receivedOn) : "—"}</div>
              <div style={{ color: TH.textSub2, textAlign: "right" }}>
                {totals.qtyOrdered > 0 ? `${totals.qtyReceived} / ${totals.qtyOrdered}` : "—"}
              </div>
              <div style={{ color: totals.qtyRemaining === 0 ? "#047857" : TH.textSub2, textAlign: "right", fontWeight: totals.qtyRemaining === 0 ? 600 : 400 }}>
                {totals.qtyOrdered > 0 ? totals.qtyRemaining : "—"}
              </div>
              <div style={{ color: TH.textSub2, textAlign: "right" }}>{totals.qtyOrdered > 0 ? fmtMoney(totals.amountReceived) : "—"}</div>
              <div style={{ color: totals.amountRemaining === 0 ? "#047857" : TH.textSub2, textAlign: "right", fontWeight: totals.amountRemaining === 0 ? 600 : 400 }}>
                {totals.qtyOrdered > 0 ? fmtMoney(totals.amountRemaining) : "—"}
              </div>
              <div style={{ textAlign: "center" }}>
                {shippedPoIds.has(r.uuid_id) ? (
                  <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 10, background: "#064E3B33", border: "1px solid #10B981", color: "#34D399", whiteSpace: "nowrap", fontWeight: 700 }}>
                    Shipped/Invoiced
                  </span>
                ) : (
                  <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 10, background: TH.surfaceHi, border: `1px solid ${TH.border}`, color: TH.textSub, whiteSpace: "nowrap" }}>
                    {p.StatusName || "—"}
                  </span>
                )}
              </div>
              <div style={{ textAlign: "center" }}>
                {acked ? (
                  <span style={{ fontSize: 12, color: "#047857", fontWeight: 600 }}>
                    ✓ {ackedAt ? fmtDate(ackedAt) : "—"}
                  </span>
                ) : (
                  <button onClick={(e) => { e.preventDefault(); void acknowledge(r.po_number); }} style={{ padding: "6px 12px", borderRadius: 6, border: "none", background: TH.primary, color: "#FFFFFF", cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit" }}>
                    Acknowledge
                  </button>
                )}
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function StatCard({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "warn" | "ok" }) {
  const color = tone === "warn" ? TH.primary : tone === "ok" ? "#047857" : TH.text;
  return (
    <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, padding: "14px 16px", boxShadow: `0 1px 2px ${TH.shadow}` }}>
      <div style={{ fontSize: 11, color: TH.textMuted, textTransform: "uppercase", letterSpacing: 0.05, fontWeight: 600, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: TH.textMuted, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "6px 12px",
        borderRadius: 999,
        border: `1px solid ${active ? TH.primary : TH.border}`,
        background: active ? TH.primary : TH.surface,
        color: active ? "#FFFFFF" : TH.textSub,
        cursor: "pointer",
        fontSize: 12,
        fontWeight: 600,
        fontFamily: "inherit",
      }}
    >
      {children}
    </button>
  );
}

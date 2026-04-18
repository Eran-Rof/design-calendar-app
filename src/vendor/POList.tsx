import { useEffect, useMemo, useState } from "react";
import { supabaseVendor } from "./supabaseVendor";

// tanda_pos row shape (subset we care about in the portal). RLS scopes the
// SELECT to rows where vendor_id matches the logged-in vendor_user, so we
// don't need a vendor_id filter in the query.
type POPayload = {
  PoNumber?: string;
  DateOrder?: string;
  DateExpectedDelivery?: string;
  StatusName?: string;
  TotalAmount?: number;
  BuyerName?: string;
  BuyerPo?: string;
  _archived?: boolean;
};

type PORow = {
  id: string;
  po_number: string;
  data: POPayload | null;
  buyer_name: string | null;
  date_expected_delivery: string | null;
  vendor_id: string | null;
};

type Filter = "all" | "action" | "ack";

function fmtDate(d?: string | null) {
  if (!d) return "—";
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return d;
  return t.toLocaleDateString();
}

function fmtMoney(n?: number) {
  if (n == null || Number.isNaN(n)) return "—";
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function daysUntil(d?: string | null): number | null {
  if (!d) return null;
  const t = new Date(d).getTime();
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - Date.now()) / 86_400_000);
}

export default function POList() {
  const [rows, setRows] = useState<PORow[]>([]);
  const [ackIds, setAckIds] = useState<Set<string>>(new Set());
  const [vendorUserId, setVendorUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const { data: userRes } = await supabaseVendor.auth.getUser();
        const uid = userRes.user?.id;
        if (!uid) throw new Error("Not signed in.");

        const [{ data: vu, error: vuErr }, { data: pos, error: posErr }] = await Promise.all([
          supabaseVendor.from("vendor_users").select("id").eq("auth_id", uid).maybeSingle(),
          supabaseVendor
            .from("tanda_pos")
            .select("id, po_number, data, buyer_name, date_expected_delivery, vendor_id")
            .order("date_order", { ascending: false }),
        ]);
        if (vuErr) throw vuErr;
        if (posErr) throw posErr;
        if (!vu) throw new Error("Your account is not linked to a vendor.");

        const vuId = vu.id as string;
        const { data: acks, error: acksErr } = await supabaseVendor
          .from("po_acknowledgments")
          .select("po_number")
          .eq("vendor_user_id", vuId);
        if (acksErr) throw acksErr;

        if (cancelled) return;
        setVendorUserId(vuId);
        const active = ((pos ?? []) as PORow[]).filter((r) => !r.data?._archived);
        setRows(active);
        setAckIds(new Set((acks ?? []).map((a: { po_number: string }) => a.po_number)));
      } catch (e: unknown) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
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

  const stats = useMemo(() => {
    const open = rows.length;
    const pending = rows.filter((r) => !ackIds.has(r.po_number));
    const acked = rows.filter((r) => ackIds.has(r.po_number));
    const sumAmount = (list: PORow[]) =>
      list.reduce((acc, r) => acc + (Number(r.data?.TotalAmount) || 0), 0);
    const pendingAmount = sumAmount(pending);
    const ackedAmount = sumAmount(acked);
    const ddps = rows
      .map((r) => r.date_expected_delivery || r.data?.DateExpectedDelivery)
      .filter((d): d is string => !!d)
      .map((d) => new Date(d).getTime())
      .filter((t) => !Number.isNaN(t) && t >= Date.now())
      .sort((a, b) => a - b);
    const next = ddps[0] ? new Date(ddps[0]).toLocaleDateString() : "—";
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
      alert("Could not acknowledge: " + error.message);
      return;
    }
    setAckIds((prev) => new Set(prev).add(poNumber));
  }

  if (loading) return <div style={{ color: "#6B7280" }}>Loading POs…</div>;
  if (err) return <div style={{ color: "#B91C1C" }}>Error: {err}</div>;

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

      <div style={{ background: "#FFFFFF", border: "1px solid #E5E7EB", borderRadius: 8, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "140px 110px 150px 120px 130px 1fr", padding: "10px 14px", background: "#F9FAFB", borderBottom: "1px solid #E5E7EB", fontSize: 11, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: 0.05 }}>
          <div>PO #</div>
          <div>Issued</div>
          <div>Required</div>
          <div>Amount</div>
          <div>Status</div>
          <div style={{ textAlign: "right" }}>Action</div>
        </div>
        {visible.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: "#6B7280", fontSize: 13 }}>
            No POs in this view.
          </div>
        ) : visible.map((r) => {
          const p = r.data ?? {};
          const ddp = r.date_expected_delivery || p.DateExpectedDelivery;
          const days = daysUntil(ddp);
          const acked = ackIds.has(r.po_number);
          return (
            <div key={r.id} style={{ display: "grid", gridTemplateColumns: "140px 110px 150px 120px 130px 1fr", padding: "12px 14px", borderBottom: "1px solid #F3F4F6", fontSize: 13, alignItems: "center" }}>
              <div style={{ fontWeight: 600, color: "#111827" }}>{r.po_number}</div>
              <div style={{ color: "#4B5563" }}>{fmtDate(p.DateOrder)}</div>
              <div style={{ color: "#4B5563", display: "flex", flexDirection: "column", lineHeight: 1.25 }}>
                <span>{fmtDate(ddp)}</span>
                {days != null && days <= 14 && days >= 0 && (
                  <span style={{ fontSize: 11, color: "#B45309" }}>({days}d)</span>
                )}
                {days != null && days < 0 && (
                  <span style={{ fontSize: 11, color: "#B91C1C" }}>overdue</span>
                )}
              </div>
              <div style={{ color: "#4B5563" }}>{fmtMoney(p.TotalAmount)}</div>
              <div>
                <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 10, background: "#F3F4F6", color: "#374151" }}>
                  {p.StatusName || "—"}
                </span>
              </div>
              <div style={{ textAlign: "right" }}>
                {acked ? (
                  <span style={{ fontSize: 12, color: "#047857" }}>✓ Acknowledged</span>
                ) : (
                  <button onClick={() => acknowledge(r.po_number)} style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid #111827", background: "#111827", color: "#FFFFFF", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
                    Acknowledge
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StatCard({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "warn" | "ok" }) {
  const color = tone === "warn" ? "#B45309" : tone === "ok" ? "#047857" : "#111827";
  return (
    <div style={{ background: "#FFFFFF", border: "1px solid #E5E7EB", borderRadius: 8, padding: "14px 16px" }}>
      <div style={{ fontSize: 11, color: "#6B7280", textTransform: "uppercase", letterSpacing: 0.05, fontWeight: 600, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: "#6B7280", marginTop: 2 }}>{sub}</div>}
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
        border: `1px solid ${active ? "#111827" : "#D1D5DB"}`,
        background: active ? "#111827" : "#FFFFFF",
        color: active ? "#FFFFFF" : "#374151",
        cursor: "pointer",
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      {children}
    </button>
  );
}

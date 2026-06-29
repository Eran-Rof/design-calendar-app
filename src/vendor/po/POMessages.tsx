import { useEffect, useMemo, useState } from "react";
import { TH } from "../theme";
import { supabaseVendor } from "../supabaseVendor";
import POMessageThread, { type Sender } from "./POMessageThread";
import VendorRfqMessageThread from "../rfqs/VendorRfqMessageThread";

interface POSummary {
  uuid_id: string;
  po_number: string;
  data: { BuyerName?: string } | null;
  unread_count?: number;
  last_message_at?: string | null;
}

interface RfqInboxRow {
  rfq_id: string;
  title: string;
  status: string | null;
  total: number;
  unread: number;
  last_message_at: string | null;
}

async function token() {
  const { data: { session } } = await supabaseVendor.auth.getSession();
  return session?.access_token || "";
}

export default function POMessages() {
  const [tab, setTab] = useState<"po" | "rfq">("po");

  // ── PO threads ──────────────────────────────────────────────────────────
  const [pos, setPOs] = useState<POSummary[]>([]);
  const [selectedPoId, setSelectedPoId] = useState<string | null>(null);
  const [sender, setSender] = useState<Sender | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // ── RFQ threads ─────────────────────────────────────────────────────────
  const [rfqs, setRfqs] = useState<RfqInboxRow[]>([]);
  const [selectedRfqId, setSelectedRfqId] = useState<string | null>(null);
  const [rfqLoading, setRfqLoading] = useState(true);
  const [rfqErr, setRfqErr] = useState<string | null>(null);
  const [rfqSearch, setRfqSearch] = useState("");

  useEffect(() => {
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const { data: userRes } = await supabaseVendor.auth.getUser();
        const uid = userRes.user?.id;
        if (!uid) throw new Error("Not signed in.");
        const { data: vu } = await supabaseVendor
          .from("vendor_users").select("display_name").eq("auth_id", uid).maybeSingle();
        setSender({
          type: "vendor",
          auth_id: uid,
          name: vu?.display_name || userRes.user?.email || "Vendor",
        });

        const { data: poRows, error: poErr } = await supabaseVendor
          .from("tanda_pos")
          .select("uuid_id, po_number, data")
          .order("date_order", { ascending: false });
        if (poErr) throw poErr;
        const active = (poRows ?? []).filter((r: { data: { _archived?: boolean } | null }) => !r.data?._archived);

        const { data: msgs } = await supabaseVendor
          .from("po_messages")
          .select("po_id, read_by_vendor, sender_type, created_at")
          .order("created_at", { ascending: false });
        const unreadByPO: Record<string, number> = {};
        const lastByPO: Record<string, string> = {};
        for (const m of (msgs ?? []) as { po_id: string; read_by_vendor: boolean; sender_type: string; created_at: string }[]) {
          if (!lastByPO[m.po_id]) lastByPO[m.po_id] = m.created_at;
          if (m.sender_type === "internal" && !m.read_by_vendor) {
            unreadByPO[m.po_id] = (unreadByPO[m.po_id] ?? 0) + 1;
          }
        }

        const enriched = active.map((p: POSummary) => ({
          ...p,
          unread_count: unreadByPO[p.uuid_id] ?? 0,
          last_message_at: lastByPO[p.uuid_id] ?? null,
        }));
        enriched.sort((a: POSummary, b: POSummary) => {
          if ((b.unread_count ?? 0) !== (a.unread_count ?? 0)) return (b.unread_count ?? 0) - (a.unread_count ?? 0);
          const la = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
          const lb = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
          return lb - la;
        });

        setPOs(enriched as POSummary[]);
      } catch (e: unknown) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function loadRfqs() {
    setRfqLoading(true);
    setRfqErr(null);
    try {
      const t = await token();
      const r = await fetch("/api/vendor/rfqs/messages-inbox", { headers: { Authorization: `Bearer ${t}` } });
      if (!r.ok) throw new Error(await r.text());
      setRfqs((await r.json()) as RfqInboxRow[]);
    } catch (e: unknown) {
      setRfqErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRfqLoading(false);
    }
  }
  useEffect(() => { void loadRfqs(); }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return pos;
    return pos.filter((p) =>
      p.po_number.toLowerCase().includes(q) || (p.data?.BuyerName ?? "").toLowerCase().includes(q)
    );
  }, [pos, search]);

  const rfqFiltered = useMemo(() => {
    const q = rfqSearch.trim().toLowerCase();
    if (!q) return rfqs;
    return rfqs.filter((r) => r.title.toLowerCase().includes(q));
  }, [rfqs, rfqSearch]);

  const selected = pos.find((p) => p.uuid_id === selectedPoId);
  const poUnread = pos.reduce((a, p) => a + (p.unread_count ?? 0), 0);
  const rfqUnread = rfqs.reduce((a, r) => a + (r.unread ?? 0), 0);

  if (loading) return <div style={{ color: "#FFFFFF" }}>Loading messages…</div>;
  if (err) return <div style={{ color: TH.primary, padding: "10px 12px", background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6 }}>Error: {err}</div>;

  return (
    <div>
      {/* Tab bar */}
      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        <TabBtn active={tab === "po"} onClick={() => setTab("po")} label="Purchase orders" badge={poUnread} />
        <TabBtn active={tab === "rfq"} onClick={() => setTab("rfq")} label="RFQs" badge={rfqUnread} />
      </div>

      {tab === "po" ? (
        <div style={{ display: "grid", gridTemplateColumns: "340px 1fr", gap: 14, height: "calc(100vh - 240px)", minHeight: 480 }}>
          <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ padding: "10px 14px", borderBottom: `1px solid ${TH.border}`, background: TH.surfaceHi, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong style={{ fontSize: 14, color: TH.text }}>Purchase orders</strong>
              {poUnread > 0 && (
                <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 10, background: TH.primary, color: "#FFFFFF", fontWeight: 700 }}>{poUnread} unread</span>
              )}
            </div>
            <input
              placeholder="Search PO # or buyer…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              style={{ margin: "8px 12px", padding: "7px 10px", borderRadius: 6, border: `1px solid ${TH.border}`, fontSize: 13, fontFamily: "inherit" }}
            />
            <div style={{ flex: 1, overflowY: "auto" }}>
              {filtered.length === 0 ? (
                <div style={{ padding: 20, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>No POs match.</div>
              ) : filtered.map((p) => {
                const isSel = p.uuid_id === selectedPoId;
                return (
                  <div
                    key={p.uuid_id}
                    onClick={() => setSelectedPoId(p.uuid_id)}
                    style={{ padding: "10px 14px", borderBottom: `1px solid ${TH.border}`, cursor: "pointer", background: isSel ? TH.surfaceHi : TH.surface, borderLeft: `3px solid ${isSel ? TH.primary : "transparent"}` }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <strong style={{ fontSize: 13, color: TH.text, fontFamily: "Menlo, monospace" }}>{p.po_number}</strong>
                      {(p.unread_count ?? 0) > 0 && (
                        <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 8, background: TH.primary, color: "#FFFFFF", fontWeight: 700 }}>{p.unread_count}</span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: TH.textMuted, marginTop: 2 }}>{p.data?.BuyerName ?? "—"}</div>
                  </div>
                );
              })}
            </div>
          </div>

          <div style={{ overflow: "hidden" }}>
            {!selectedPoId || !sender ? (
              <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, padding: "60px 20px", textAlign: "center", color: TH.textMuted, fontSize: 14, height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
                Select a PO from the left to view its messages.
              </div>
            ) : (
              <POMessageThread
                poId={selectedPoId}
                poNumber={selected?.po_number}
                sender={sender}
                client={supabaseVendor}
                height={600}
                autoMarkRead
              />
            )}
          </div>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "340px 1fr", gap: 14, height: "calc(100vh - 240px)", minHeight: 480 }}>
          <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ padding: "10px 14px", borderBottom: `1px solid ${TH.border}`, background: TH.surfaceHi, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong style={{ fontSize: 14, color: TH.text }}>RFQs</strong>
              {rfqUnread > 0 && (
                <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 10, background: TH.primary, color: "#FFFFFF", fontWeight: 700 }}>{rfqUnread} unread</span>
              )}
            </div>
            <input
              placeholder="Search RFQ…"
              value={rfqSearch}
              onChange={(e) => setRfqSearch(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              style={{ margin: "8px 12px", padding: "7px 10px", borderRadius: 6, border: `1px solid ${TH.border}`, fontSize: 13, fontFamily: "inherit" }}
            />
            <div style={{ flex: 1, overflowY: "auto" }}>
              {rfqErr ? (
                <div style={{ padding: 16, color: TH.primary, fontSize: 13 }}>{rfqErr}</div>
              ) : rfqLoading ? (
                <div style={{ padding: 20, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>Loading…</div>
              ) : rfqFiltered.length === 0 ? (
                <div style={{ padding: 20, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>No RFQs yet.</div>
              ) : rfqFiltered.map((r) => {
                const isSel = r.rfq_id === selectedRfqId;
                return (
                  <div
                    key={r.rfq_id}
                    onClick={() => setSelectedRfqId(r.rfq_id)}
                    style={{ padding: "10px 14px", borderBottom: `1px solid ${TH.border}`, cursor: "pointer", background: isSel ? TH.surfaceHi : TH.surface, borderLeft: `3px solid ${isSel ? TH.primary : "transparent"}` }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                      <strong style={{ fontSize: 13, color: TH.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</strong>
                      {r.unread > 0 && (
                        <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 8, background: TH.primary, color: "#FFFFFF", fontWeight: 700 }}>{r.unread}</span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: TH.textMuted, marginTop: 2 }}>
                      {r.total > 0 ? `${r.total} message${r.total === 1 ? "" : "s"}` : "No messages yet"}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div style={{ overflow: "auto" }}>
            {!selectedRfqId ? (
              <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, padding: "60px 20px", textAlign: "center", color: TH.textMuted, fontSize: 14, height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
                Select an RFQ from the left to view its messages.
              </div>
            ) : (
              <VendorRfqMessageThread rfqId={selectedRfqId} height={520} onChanged={loadRfqs} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function TabBtn({ active, onClick, label, badge }: { active: boolean; onClick: () => void; label: string; badge: number }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "8px 14px", borderRadius: 8, border: `1px solid ${active ? TH.primary : TH.border}`,
        background: active ? TH.primary : TH.surface, color: active ? "#FFFFFF" : TH.textSub,
        cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit", display: "flex", alignItems: "center", gap: 6,
      }}
    >
      {label}
      {badge > 0 && (
        <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 8, background: active ? "rgba(255,255,255,0.25)" : TH.primary, color: "#FFFFFF", fontWeight: 700 }}>{badge}</span>
      )}
    </button>
  );
}

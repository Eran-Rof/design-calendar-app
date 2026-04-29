import { useEffect, useMemo, useState } from "react";
import { TH } from "../utils/theme";
import { SB_URL, SB_HEADERS, supabaseClient } from "../utils/supabase";
import POMessageThread, { type Sender } from "../vendor/POMessageThread";

interface POSummary {
  uuid_id: string;
  po_number: string;
  vendor_id: string | null;
  data: { BuyerName?: string; _archived?: boolean } | null;
  unread_count?: number;
  last_message_at?: string | null;
}

export default function MessagesView() {
  const [pos, setPOs] = useState<POSummary[]>([]);
  const [vendors, setVendors] = useState<Record<string, string>>({});
  const [selectedPoId, setSelectedPoId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [onlyUnread, setOnlyUnread] = useState(false);

  const [sender] = useState<Sender>(() => {
    // plm_user is a JSON blob in sessionStorage ({id, name, role}). The
    // previous read pulled it from localStorage as a raw string and
    // always landed on null → "Ring of Fire", so every internal message
    // was attributed to the same generic name regardless of who sent it.
    let user: { id?: string; name?: string } | null = null;
    try {
      const raw = sessionStorage.getItem("plm_user");
      if (raw) user = JSON.parse(raw);
    } catch { /* malformed — treat as no user */ }
    return {
      type: "internal",
      internal_id: user?.id ?? "internal",
      name: user?.name ?? "Ring of Fire",
    };
  });

  useEffect(() => {
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const [poRes, vRes, msgRes] = await Promise.all([
          fetch(`${SB_URL}/rest/v1/tanda_pos?select=uuid_id,po_number,vendor_id,data&order=date_order.desc`, { headers: SB_HEADERS }),
          fetch(`${SB_URL}/rest/v1/vendors?select=id,name`, { headers: SB_HEADERS }),
          fetch(`${SB_URL}/rest/v1/po_messages?select=po_id,read_by_internal,sender_type,created_at&order=created_at.desc`, { headers: SB_HEADERS }),
        ]);
        if (!poRes.ok) throw new Error(`pos: ${poRes.status}`);
        if (!vRes.ok) throw new Error(`vendors: ${vRes.status}`);
        if (!msgRes.ok) throw new Error(`messages: ${msgRes.status}`);
        const poRows: POSummary[] = await poRes.json();
        const active = poRows.filter((r) => !r.data?._archived);
        const vs: { id: string; name: string }[] = await vRes.json();
        const m: Record<string, string> = {};
        for (const v of vs) m[v.id] = v.name;
        setVendors(m);

        const msgs: { po_id: string; read_by_internal: boolean; sender_type: string; created_at: string }[] = await msgRes.json();
        const unreadByPO: Record<string, number> = {};
        const lastByPO: Record<string, string> = {};
        for (const x of msgs) {
          if (!lastByPO[x.po_id]) lastByPO[x.po_id] = x.created_at;
          if (x.sender_type === "vendor" && !x.read_by_internal) {
            unreadByPO[x.po_id] = (unreadByPO[x.po_id] ?? 0) + 1;
          }
        }

        const enriched = active.map((p) => ({
          ...p,
          unread_count: unreadByPO[p.uuid_id] ?? 0,
          last_message_at: lastByPO[p.uuid_id] ?? null,
        }));
        // Only show POs with any messaging activity OR all if filter off
        enriched.sort((a, b) => {
          if ((b.unread_count ?? 0) !== (a.unread_count ?? 0)) return (b.unread_count ?? 0) - (a.unread_count ?? 0);
          const la = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
          const lb = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
          return lb - la;
        });
        setPOs(enriched);
      } catch (e: unknown) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return pos.filter((p) => {
      if (onlyUnread && (p.unread_count ?? 0) === 0) return false;
      if (!q) return true;
      return p.po_number.toLowerCase().includes(q)
          || (vendors[p.vendor_id ?? ""] ?? "").toLowerCase().includes(q);
    });
  }, [pos, vendors, search, onlyUnread]);

  const selected = pos.find((p) => p.uuid_id === selectedPoId);
  const totalUnread = pos.reduce((a, p) => a + (p.unread_count ?? 0), 0);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "360px 1fr", gap: 14, height: "calc(100vh - 220px)", minHeight: 500 }}>
      <div style={{ background: "#FFFFFF", border: `1px solid ${TH.border}`, borderRadius: 10, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ padding: "10px 14px", borderBottom: `1px solid ${TH.border}`, background: TH.surfaceHi, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <strong style={{ fontSize: 14, color: TH.text }}>PO conversations</strong>
          {totalUnread > 0 && <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 10, background: TH.primary, color: "#FFFFFF", fontWeight: 700 }}>{totalUnread}</span>}
        </div>
        <div style={{ padding: "8px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
          <input
            placeholder="Search PO # or vendor…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ padding: "7px 10px", borderRadius: 6, border: `1px solid ${TH.border}`, fontSize: 13, fontFamily: "inherit" }}
          />
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: TH.textSub2 }}>
            <input type="checkbox" checked={onlyUnread} onChange={(e) => setOnlyUnread(e.target.checked)} />
            Only POs with unread
          </label>
        </div>
        <div style={{ flex: 1, overflowY: "auto" }}>
          {loading ? (
            <div style={{ padding: 20, color: TH.textMuted, fontSize: 13 }}>Loading…</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: 20, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>No POs match.</div>
          ) : filtered.map((p) => {
            const isSel = p.uuid_id === selectedPoId;
            return (
              <div
                key={p.uuid_id}
                onClick={() => setSelectedPoId(p.uuid_id)}
                style={{ padding: "10px 14px", borderBottom: `1px solid ${TH.border}`, cursor: "pointer", background: isSel ? TH.surfaceHi : "#FFFFFF", borderLeft: `3px solid ${isSel ? TH.primary : "transparent"}` }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <strong style={{ fontSize: 13, color: TH.text, fontFamily: "Menlo, monospace" }}>{p.po_number}</strong>
                  {(p.unread_count ?? 0) > 0 && <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 8, background: TH.primary, color: "#FFFFFF", fontWeight: 700 }}>{p.unread_count}</span>}
                </div>
                <div style={{ fontSize: 12, color: TH.textMuted, marginTop: 2 }}>{vendors[p.vendor_id ?? ""] || "—"}</div>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ overflow: "hidden" }}>
        {err && <div style={{ color: "#B91C1C", background: "#FEF2F2", border: "1px solid #FCA5A5", padding: "10px 14px", borderRadius: 8, marginBottom: 10 }}>Error: {err}</div>}
        {!selectedPoId || !supabaseClient ? (
          <div style={{ background: "#FFFFFF", border: `1px solid ${TH.border}`, borderRadius: 10, padding: "60px 20px", textAlign: "center", color: TH.textMuted, fontSize: 14, height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
            Select a PO from the left to view its messages.
          </div>
        ) : (
          <POMessageThread
            poId={selectedPoId}
            poNumber={selected?.po_number}
            sender={sender}
            client={supabaseClient}
            height={600}
            autoMarkRead
          />
        )}
      </div>
    </div>
  );
}

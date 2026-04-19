import { useEffect, useState } from "react";
import { TH } from "../utils/theme";
import { supabaseVendor } from "./supabaseVendor";

interface EntityLink {
  id: string;
  name: string;
  slug: string;
  status: string;
  relationship_status: string;
  branding: { logo_url: string | null; primary_color: string | null; company_display_name: string | null } | null;
}

async function token() {
  const { data: { session } } = await supabaseVendor.auth.getSession();
  return session?.access_token || "";
}

const ACTIVE_KEY = "sb-vendor-active-entity";

export default function VendorEntitySwitcher() {
  const [entities, setEntities] = useState<EntityLink[]>([]);
  const [openPoCounts, setOpenPoCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(() => localStorage.getItem(ACTIVE_KEY));

  useEffect(() => {
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const t = await token();
        const r = await fetch("/api/vendor/entities", { headers: { Authorization: `Bearer ${t}` } });
        if (!r.ok) throw new Error(await r.text());
        const data = await r.json() as EntityLink[];
        setEntities(data);
        if (!active && data.length > 0) {
          setActive(data[0].id);
          localStorage.setItem(ACTIVE_KEY, data[0].id);
        }

        // Fetch open PO counts per entity via direct supabase query
        const { data: { user } } = await supabaseVendor.auth.getUser();
        if (user) {
          const { data: vu } = await supabaseVendor.from("vendor_users").select("vendor_id").eq("auth_id", user.id).maybeSingle();
          const vid = (vu as { vendor_id: string } | null)?.vendor_id;
          if (vid) {
            const { data: pos } = await supabaseVendor
              .from("tanda_pos")
              .select("entity_id, data")
              .eq("vendor_id", vid);
            const counts: Record<string, number> = {};
            for (const p of (pos || []) as { entity_id: string | null; data: { StatusName?: string; _archived?: boolean } | null }[]) {
              if (!p.entity_id || p.data?._archived) continue;
              const s = (p.data?.StatusName || "").toLowerCase();
              if (s.includes("closed")) continue;
              counts[p.entity_id] = (counts[p.entity_id] || 0) + 1;
            }
            setOpenPoCounts(counts);
          }
        }
      } catch (e: unknown) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally { setLoading(false); }
    })();
  }, []);

  function switchTo(id: string) {
    localStorage.setItem(ACTIVE_KEY, id);
    setActive(id);
    // Reload to re-fetch data scoped to new entity (current retrofit
    // is minimal — future work will apply entity context to other
    // vendor endpoints).
    window.location.reload();
  }

  if (loading) return <div style={{ color: "rgba(255,255,255,0.85)" }}>Loading…</div>;
  if (err) return <div style={{ color: TH.primary, padding: 12, background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6 }}>Error: {err}</div>;

  if (entities.length === 0) {
    return (
      <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 10, padding: 30, textAlign: "center", color: TH.textMuted }}>
        No entities linked to your vendor account.
      </div>
    );
  }

  return (
    <div>
      <h2 style={{ color: "#FFFFFF", fontSize: 20, marginTop: 0, marginBottom: 16 }}>Switch entity</h2>
      <div style={{ color: "rgba(255,255,255,0.75)", fontSize: 13, marginBottom: 16 }}>
        You're linked to {entities.length} entit{entities.length === 1 ? "y" : "ies"}. Switching reloads the portal in that context.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
        {entities.map((e) => {
          const isActive = e.id === active;
          return (
            <div key={e.id} style={{ background: TH.surface, border: `2px solid ${isActive ? TH.primary : TH.border}`, borderRadius: 10, padding: "18px 20px", boxShadow: `0 1px 2px ${TH.shadow}` }}>
              {e.branding?.logo_url && (
                <img src={e.branding.logo_url} alt={e.name} style={{ maxHeight: 40, maxWidth: "100%", objectFit: "contain", marginBottom: 10 }} />
              )}
              <div style={{ fontSize: 15, fontWeight: 700, color: TH.text }}>{e.branding?.company_display_name || e.name}</div>
              <div style={{ fontSize: 11, color: TH.textMuted, marginTop: 2, fontFamily: "SFMono-Regular, Menlo, monospace" }}>{e.slug}</div>
              <div style={{ fontSize: 12, color: TH.textSub2, marginTop: 10 }}>
                {openPoCounts[e.id] ?? 0} open PO{(openPoCounts[e.id] ?? 0) === 1 ? "" : "s"}
              </div>
              <div style={{ marginTop: 14 }}>
                {isActive ? (
                  <div style={{ fontSize: 12, color: "#047857", fontWeight: 600 }}>✓ Active</div>
                ) : (
                  <button onClick={() => switchTo(e.id)} style={{ padding: "6px 14px", borderRadius: 6, border: "none", background: TH.primary, color: "#FFFFFF", cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit" }}>
                    Switch to this entity
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

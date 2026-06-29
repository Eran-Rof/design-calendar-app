// src/tanda/InternalShopifyStores.tsx
//
// Tangerine P11 — Connect Shopify store.
//
// The write path that lets an operator connect Shopify from the app: enter the
// *.myshopify.com domain + the Admin API access token (shpat_…), and the server
// encrypts it at rest (AES-256-GCM) into shopify_stores. Tokens are NEVER shown
// back — only "set / not set" flags. Connecting a store is the prerequisite for
// orders sync, refunds, and product-image pull.
//
// All reads/writes go through /api/internal/shopify/stores (service-role +
// server-side encryption) — NOT the client REST API, which must never see the
// encryption key.

import { useEffect, useState } from "react";
import SearchableSelect from "./components/SearchableSelect";
import { notify, confirmDialog } from "../shared/ui/warn";
import { fmtDateDisplay } from "../utils/tandaTypes";

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

interface Store {
  id: string;
  shopify_domain: string;
  store_name: string;
  api_version: string;
  is_active: boolean;
  has_token: boolean;
  has_webhook_secret: boolean;
  last_backfill_at: string | null;
  last_webhook_at: string | null;
  created_at: string;
}

const blankForm = { shopify_domain: "", store_name: "", api_version: "2025-01", access_token: "", webhook_secret: "" };

export default function InternalShopifyStores() {
  const [stores, setStores] = useState<Store[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Store | null>(null);
  const [form, setForm] = useState({ ...blankForm });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  // Bulk image pull (P11-10-bulk).
  const [bulkBusy, setBulkBusy] = useState<"dryrun" | "link" | "pull" | "meta" | null>(null);
  const [bulkLog, setBulkLog] = useState<string[]>([]);
  const [bulkStoreId, setBulkStoreId] = useState<string>(""); // which store the bulk actions target

  function logBulk(line: string) { setBulkLog((prev) => [...prev, line]); }

  async function bulkDryRun(storeId: string) {
    setBulkBusy("dryrun"); setBulkLog(["Dry-run: matching Shopify products to styles by SKU prefix…"]);
    try {
      const r = await fetch(`/api/internal/shopify/stores/${storeId}/bulk-link?dry_run=true`, { method: "POST" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      logBulk(`Catalog: ${j.total_products} products · matched ${j.matched} · unmatched ${j.total_products - j.matched}.`);
      (j.unmatched || []).slice(0, 12).forEach((u: { handle: string; sku_prefixes: string[] }) => logBulk(`  ✗ ${u.handle} [${(u.sku_prefixes || []).join(", ")}]`));
    } catch (e: unknown) { logBulk(`Error: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setBulkBusy(null); }
  }

  async function bulkLink(storeId: string) {
    setBulkBusy("link"); setBulkLog(["Linking matched products (mirror + style link)…"]);
    try {
      const r = await fetch(`/api/internal/shopify/stores/${storeId}/bulk-link`, { method: "POST" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      logBulk(`Linked ${j.linked}/${j.matched} matched products. Unmatched: ${j.total_products - j.matched}.`);
      (j.errors || []).slice(0, 10).forEach((e: string) => logBulk(`  ! ${e}`));
      await load();
    } catch (e: unknown) { logBulk(`Error: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setBulkBusy(null); }
  }

  async function bulkPull(storeId: string) {
    setBulkBusy("pull"); setBulkLog(["Pulling images for linked styles (batched)…"]);
    try {
      let offset = 0, pulled = 0, skipped = 0, failed = 0, guard = 0;
      for (;;) {
        const r = await fetch(`/api/internal/shopify/stores/${storeId}/bulk-pull?offset=${offset}&limit=8`, { method: "POST" });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        pulled += j.pulled; skipped += j.skipped; failed += j.failed;
        logBulk(`  …${Math.min(j.next_offset, j.total_linked)}/${j.total_linked} styles · +${j.pulled} images this batch (total pulled ${pulled})`);
        offset = j.next_offset;
        if (j.done || ++guard > 400) break;
      }
      logBulk(`Done. Pulled ${pulled} images · skipped ${skipped} (already present) · failed ${failed}.`);
    } catch (e: unknown) { logBulk(`Error: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setBulkBusy(null); }
  }

  async function bulkMeta(storeId: string) {
    setBulkBusy("meta"); setBulkLog(["Syncing descriptions + attributes + per-image colors (batched)…"]);
    try {
      let offset = 0, d = 0, a = 0, ci = 0, failed = 0, guard = 0;
      for (;;) {
        const r = await fetch(`/api/internal/shopify/stores/${storeId}/bulk-sync-meta?offset=${offset}&limit=12`, { method: "POST" });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        d += j.descriptions; a += j.attributes; ci += j.colored_images; failed += j.failed;
        logBulk(`  …${Math.min(j.next_offset, j.total_linked)}/${j.total_linked} styles · +${j.descriptions} desc · +${j.colored_images} colored imgs`);
        offset = j.next_offset;
        if (j.done || ++guard > 400) break;
      }
      logBulk(`Done. Descriptions ${d} · attributes ${a} · colored images ${ci} · failed ${failed}.`);
    } catch (e: unknown) { logBulk(`Error: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setBulkBusy(null); }
  }

  async function load() {
    setLoading(true); setErr(null);
    try {
      const r = await fetch("/api/internal/shopify/stores");
      if (!r.ok) throw new Error(await r.text());
      setStores(await r.json() as Store[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  function openAdd() { setEditing(null); setForm({ ...blankForm }); setShowForm(true); }
  function openEdit(s: Store) {
    setEditing(s);
    // Token/secret left blank → unchanged unless the operator types a new one.
    setForm({ shopify_domain: s.shopify_domain, store_name: s.store_name, api_version: s.api_version, access_token: "", webhook_secret: "" });
    setShowForm(true);
  }

  async function save() {
    setSaving(true);
    try {
      const isEdit = !!editing;
      const url = isEdit ? `/api/internal/shopify/stores/${editing!.id}` : "/api/internal/shopify/stores";
      const method = isEdit ? "PUT" : "POST";
      const body: Record<string, unknown> = {
        store_name: form.store_name,
        api_version: form.api_version,
      };
      if (!isEdit) body.shopify_domain = form.shopify_domain;
      if (form.access_token.trim()) body.access_token = form.access_token.trim();
      if (form.webhook_secret.trim()) body.webhook_secret = form.webhook_secret.trim();

      const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      notify(isEdit ? "Store updated" : "Store connected", "success");
      setShowForm(false);
      await load();
    } catch (e: unknown) {
      notify(`Save failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally { setSaving(false); }
  }

  async function testConn(s: Store) {
    setTesting(s.id);
    try {
      const r = await fetch(`/api/internal/shopify/stores/${s.id}/test`, { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (j.ok) notify(`✓ Connected to ${j.shopify_domain} — Admin API reachable.`, "success");
      else notify(`Connection failed: ${j.error || "unknown error"}`, "error");
    } catch (e: unknown) {
      notify(`Test failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally { setTesting(null); }
  }

  async function toggleActive(s: Store) {
    try {
      const r = await fetch(`/api/internal/shopify/stores/${s.id}`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ is_active: !s.is_active }),
      });
      if (!r.ok) throw new Error(await r.text());
      await load();
    } catch (e: unknown) {
      notify(`Update failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  async function remove(s: Store) {
    if (!(await confirmDialog(`Remove the connection to ${s.shopify_domain}? (If it already has orders, deactivate instead.)`))) return;
    try {
      const r = await fetch(`/api/internal/shopify/stores/${s.id}`, { method: "DELETE" });
      if (!r.ok && r.status !== 204) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `HTTP ${r.status}`); }
      notify("Store removed", "success");
      await load();
    } catch (e: unknown) {
      notify(`Remove failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 12, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20 }}>Connect Shopify Store</h2>
          <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4 }}>
            Connect a store to enable orders sync, refunds, and product-image pull. The Admin API token is encrypted at rest and never shown again.
          </div>
        </div>
        <button onClick={openAdd} style={btn(C.primary)}>+ Connect store</button>
      </div>

      {err && <div style={{ background: "#7f1d1d", color: "#fff", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>{err}</div>}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1.2fr 0.7fr 0.7fr 0.8fr 1fr 1.6fr", padding: "10px 14px", background: C.bg, borderBottom: `1px solid ${C.cardBdr}`, fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" }}>
          <div>Store</div><div>Domain</div><div>API ver</div><div>Token</div><div>Active</div><div>Last sync</div><div style={{ textAlign: "right" }}>Actions</div>
        </div>
        {loading ? (
          <div style={{ padding: 30, textAlign: "center", color: C.textMuted }}>Loading…</div>
        ) : stores.length === 0 ? (
          <div style={{ padding: 30, textAlign: "center", color: C.textMuted, fontSize: 13 }}>
            No Shopify store connected yet. Click <b>+ Connect store</b> to add one.
          </div>
        ) : stores.map((s) => (
          <div key={s.id} style={{ display: "grid", gridTemplateColumns: "1.4fr 1.2fr 0.7fr 0.7fr 0.8fr 1fr 1.6fr", padding: "10px 14px", borderBottom: `1px solid ${C.cardBdr}`, fontSize: 13, alignItems: "center" }}>
            <div style={{ fontWeight: 600 }}>{s.store_name}</div>
            <div style={{ color: C.textSub, fontSize: 12 }}>{s.shopify_domain}</div>
            <div style={{ color: C.textSub }}>{s.api_version}</div>
            <div style={{ color: s.has_token ? C.success : C.danger, fontWeight: 700, fontSize: 12 }}>{s.has_token ? "✓ set" : "missing"}</div>
            <div>
              <span onClick={() => void toggleActive(s)} title="Toggle active" style={{ cursor: "pointer", color: s.is_active ? C.success : C.textMuted, fontWeight: 700, fontSize: 12 }}>
                {s.is_active ? "● active" : "○ off"}
              </span>
            </div>
            <div style={{ color: C.textMuted, fontSize: 11 }}>{s.last_backfill_at ? fmtDateDisplay(s.last_backfill_at) : "—"}</div>
            <div style={{ textAlign: "right", display: "flex", gap: 6, justifyContent: "flex-end", flexWrap: "wrap" }}>
              <button onClick={() => void testConn(s)} disabled={testing === s.id} style={btn(C.cardBdr, true)}>{testing === s.id ? "Testing…" : "Test"}</button>
              <button onClick={() => openEdit(s)} style={btn(C.cardBdr, true)}>Edit</button>
              <button onClick={() => void remove(s)} style={btn(C.danger, true)}>Remove</button>
            </div>
          </div>
        ))}
      </div>

      {/* Bulk image pull — only meaningful once a token-bearing store is connected. */}
      {stores.some((s) => s.has_token && s.is_active) && (() => {
        const eligible = stores.filter((x) => x.has_token && x.is_active);
        const activeId = (bulkStoreId && eligible.some((e) => e.id === bulkStoreId)) ? bulkStoreId : eligible[0].id;
        return (
          <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 16, marginTop: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Bulk pull product images</div>
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 10 }}>
              Matches Shopify products to styles by <b>SKU prefix = style code</b> (denim inseam handled), links them, and re-hosts every product's images onto the style. Safe to re-run (skips images already pulled). Runs against the selected store only.
            </div>
            {eligible.length > 1 && (
              <div style={{ marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 12, color: C.textMuted }}>Store:</span>
                <div style={{ minWidth: 280 }}>
                  <SearchableSelect value={activeId} onChange={(v) => { setBulkStoreId(v); setBulkLog([]); }} disabled={bulkBusy != null}
                    options={eligible.map((e) => ({ value: e.id, label: `${e.store_name} (${e.shopify_domain})` }))}
                    inputStyle={{ background: C.bg, color: C.text, border: `1px solid ${C.cardBdr}`, borderRadius: 6, padding: "6px 10px", fontSize: 13 }} />
                </div>
              </div>
            )}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button onClick={() => void bulkDryRun(activeId)} disabled={bulkBusy != null} style={btn(C.cardBdr, true)}>{bulkBusy === "dryrun" ? "Checking…" : "1. Dry-run match"}</button>
              <button onClick={() => void bulkLink(activeId)} disabled={bulkBusy != null} style={btn(C.primary)}>{bulkBusy === "link" ? "Linking…" : "2. Link matched"}</button>
              <button onClick={() => void bulkPull(activeId)} disabled={bulkBusy != null} style={btn(C.success)}>{bulkBusy === "pull" ? "Pulling…" : "3. Pull all images"}</button>
              <button onClick={() => void bulkMeta(activeId)} disabled={bulkBusy != null} style={btn(C.primary, true)}>{bulkBusy === "meta" ? "Syncing…" : "4. Sync descriptions + colors"}</button>
            </div>
            {bulkLog.length > 0 && (
              <pre style={{ marginTop: 12, maxHeight: 260, overflow: "auto", background: C.bg, border: `1px solid ${C.cardBdr}`, borderRadius: 6, padding: 10, fontSize: 11, color: C.textSub, whiteSpace: "pre-wrap" }}>
                {bulkLog.join("\n")}
              </pre>
            )}
          </div>
        );
      })()}

      {showForm && (
        <div onClick={() => !saving && setShowForm(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 12, padding: 22, width: "min(560px, 95vw)", maxHeight: "90vh", overflow: "auto" }}>
            <h3 style={{ marginTop: 0, fontSize: 16 }}>{editing ? `Edit ${editing.store_name}` : "Connect a Shopify store"}</h3>

            <Field label="Store name">
              <input value={form.store_name} onChange={(e) => setForm({ ...form, store_name: e.target.value })} placeholder="e.g. Ring of Fire DTC" style={inp} />
            </Field>
            <Field label="Shopify domain (*.myshopify.com)">
              <input value={form.shopify_domain} disabled={!!editing} onChange={(e) => setForm({ ...form, shopify_domain: e.target.value })} placeholder="your-store.myshopify.com" style={{ ...inp, opacity: editing ? 0.6 : 1 }} />
            </Field>
            <Field label="API version">
              <input value={form.api_version} onChange={(e) => setForm({ ...form, api_version: e.target.value })} placeholder="2025-01" style={inp} />
            </Field>
            <Field label={editing ? "Admin API access token (leave blank to keep current)" : "Admin API access token (shpat_…)"}>
              <input type="password" autoComplete="off" value={form.access_token} onChange={(e) => setForm({ ...form, access_token: e.target.value })} placeholder={editing && editing.has_token ? "•••••••• (unchanged)" : "shpat_…"} style={inp} />
            </Field>
            <Field label="Webhook signing secret (optional)">
              <input type="password" autoComplete="off" value={form.webhook_secret} onChange={(e) => setForm({ ...form, webhook_secret: e.target.value })} placeholder={editing && editing.has_webhook_secret ? "•••••••• (unchanged)" : "Optional — for webhook HMAC"} style={inp} />
            </Field>

            <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>
              Get the token in Shopify admin → Settings → Apps and sales channels → Develop apps → your app → API credentials → <b>Admin API access token</b> (Reveal once). Needs <code>read_products</code> (and <code>read_orders</code> for order sync).
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
              <button onClick={() => setShowForm(false)} disabled={saving} style={btn(C.cardBdr, true)}>Cancel</button>
              <button onClick={() => void save()} disabled={saving} style={btn(C.primary)}>{saving ? "Saving…" : editing ? "Save changes" : "Connect"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 600, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

const inp: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", padding: "8px 10px", background: C.bg,
  border: `1px solid ${C.cardBdr}`, borderRadius: 6, color: C.text, fontSize: 13, fontFamily: "inherit",
};
function btn(color: string, outline = false): React.CSSProperties {
  return {
    padding: "6px 14px", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
    border: outline ? `1px solid ${color}` : "none",
    background: outline ? "transparent" : color,
    color: outline ? C.text : "#fff",
  };
}

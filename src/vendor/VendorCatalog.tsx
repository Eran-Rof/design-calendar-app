import { useEffect, useMemo, useState } from "react";
import { TH } from "./theme";
import { supabaseVendor } from "./supabaseVendor";
import { fmtMoney } from "./utils";

interface CatalogItem {
  id: string;
  vendor_id: string;
  sku: string;
  name: string;
  category: string | null;
  unit_price: number | null;
  currency: string;
  lead_time_days: number | null;
  min_order_quantity: number | null;
  status: "active" | "inactive" | "discontinued";
}

async function token() {
  const { data: { session } } = await supabaseVendor.auth.getSession();
  return session?.access_token || "";
}

const CSV_TEMPLATE = "sku,name,unit_price,lead_time_days,min_order_quantity,status,category\n";

export default function VendorCatalog() {
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [vendorId, setVendorId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "active" | "inactive">("active");
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<CatalogItem | null>(null);
  const [showBulk, setShowBulk] = useState(false);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const { data: { user } } = await supabaseVendor.auth.getUser();
      if (!user) throw new Error("Not authenticated");
      const { data: vu } = await supabaseVendor.from("vendor_users").select("vendor_id").eq("auth_id", user.id).maybeSingle();
      const vid = (vu as { vendor_id: string } | null)?.vendor_id;
      if (!vid) throw new Error("Not linked to a vendor");
      setVendorId(vid);
      const { data, error } = await supabaseVendor
        .from("catalog_items")
        .select("*")
        .eq("vendor_id", vid)
        .order("sku", { ascending: true });
      if (error) throw error;
      setItems((data || []) as CatalogItem[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []);

  const visible = useMemo(() => {
    if (filter === "active")   return items.filter((i) => i.status === "active");
    if (filter === "inactive") return items.filter((i) => i.status !== "active");
    return items;
  }, [items, filter]);

  async function discontinue(id: string) {
    if (!confirm("Mark this SKU as discontinued? It can be re-activated later.")) return;
    const { error } = await supabaseVendor.from("catalog_items").update({ status: "discontinued" }).eq("id", id);
    if (error) { alert(error.message); return; }
    await load();
  }

  if (loading) return <div style={{ color: TH.textMuted }}>Loading…</div>;
  if (err) return <div style={{ color: TH.primary, padding: 12, background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6 }}>Error: {err}</div>;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 16 }}>
        <h2 style={{ margin: 0, color: "#FFFFFF", fontSize: 20 }}>Catalog</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => setShowBulk(true)}  style={btnSecondary}>Bulk update (CSV)</button>
          <button onClick={() => setShowAdd(true)} style={btnPrimary}>+ Add SKU</button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        {(["active", "inactive", "all"] as const).map((f) => (
          <button key={f} onClick={() => setFilter(f)} style={{ ...pill, background: filter === f ? TH.primary : "rgba(255,255,255,0.14)", color: "#FFFFFF", border: `1px solid ${filter === f ? TH.primary : "rgba(255,255,255,0.3)"}` }}>
            {f === "all" ? "All" : f === "active" ? "Active" : "Inactive/Discontinued"}
          </button>
        ))}
      </div>

      <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, overflow: "hidden", boxShadow: `0 1px 2px ${TH.shadow}` }}>
        <div style={{ display: "grid", gridTemplateColumns: "140px 1.6fr 150px 120px 110px 110px 110px 130px", padding: "10px 14px", background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase", letterSpacing: 0.05 }}>
          <div>SKU</div>
          <div>Name</div>
          <div>Category</div>
          <div style={{ textAlign: "right" }}>Price</div>
          <div style={{ textAlign: "right" }}>Lead (d)</div>
          <div style={{ textAlign: "right" }}>MOQ</div>
          <div>Status</div>
          <div style={{ textAlign: "right" }}>Action</div>
        </div>
        {visible.length === 0 ? (
          <div style={{ padding: 30, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>No items in this view.</div>
        ) : visible.map((it) => (
          <div key={it.id} style={{ display: "grid", gridTemplateColumns: "140px 1.6fr 150px 120px 110px 110px 110px 130px", padding: "12px 14px", borderBottom: `1px solid ${TH.border}`, fontSize: 13, alignItems: "center" }}>
            <div style={{ fontFamily: "SFMono-Regular, Menlo, monospace", color: TH.textSub2 }}>{it.sku}</div>
            <div style={{ color: TH.text, fontWeight: 500 }}>{it.name}</div>
            <div style={{ color: TH.textSub2 }}>{it.category || "—"}</div>
            <div style={{ textAlign: "right", color: TH.textSub2 }}>{it.unit_price != null ? fmtMoney(it.unit_price) : "—"}</div>
            <div style={{ textAlign: "right", color: TH.textSub2 }}>{it.lead_time_days ?? "—"}</div>
            <div style={{ textAlign: "right", color: TH.textSub2 }}>{it.min_order_quantity ?? "—"}</div>
            <div style={{ color: it.status === "active" ? "#276749" : TH.textMuted, fontSize: 12, fontWeight: 600, textTransform: "capitalize" }}>{it.status}</div>
            <div style={{ textAlign: "right", display: "flex", gap: 6, justifyContent: "flex-end" }}>
              <button onClick={() => setEditing(it)} style={{ ...btnSecondary, padding: "4px 10px", fontSize: 12 }}>Edit</button>
              {it.status === "active" && <button onClick={() => void discontinue(it.id)} style={{ ...btnSecondary, padding: "4px 10px", fontSize: 12 }}>Retire</button>}
            </div>
          </div>
        ))}
      </div>

      {showAdd && vendorId && (
        <CatalogEditModal vendorId={vendorId} item={null} onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); void load(); }} />
      )}
      {editing && vendorId && (
        <CatalogEditModal vendorId={vendorId} item={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />
      )}
      {showBulk && vendorId && (
        <BulkUploadModal vendorId={vendorId} onClose={() => setShowBulk(false)} />
      )}
    </div>
  );
}

function CatalogEditModal({ vendorId, item, onClose, onSaved }: { vendorId: string; item: CatalogItem | null; onClose: () => void; onSaved: () => void }) {
  const [sku, setSku] = useState(item?.sku || "");
  const [name, setName] = useState(item?.name || "");
  const [category, setCategory] = useState(item?.category || "");
  const [unitPrice, setUnitPrice] = useState(item?.unit_price?.toString() || "");
  const [leadTime, setLeadTime] = useState(item?.lead_time_days?.toString() || "");
  const [moq, setMoq] = useState(item?.min_order_quantity?.toString() || "");
  const [status, setStatus] = useState(item?.status || "active");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!sku.trim() || !name.trim()) { alert("SKU and name are required."); return; }
    setSaving(true);
    const payload = {
      vendor_id: vendorId,
      sku: sku.trim(),
      name: name.trim(),
      category: category.trim() || null,
      unit_price: unitPrice === "" ? null : Number(unitPrice),
      lead_time_days: leadTime === "" ? null : parseInt(leadTime, 10),
      min_order_quantity: moq === "" ? null : parseInt(moq, 10),
      status,
    };
    const res = item
      ? await supabaseVendor.from("catalog_items").update(payload).eq("id", item.id)
      : await supabaseVendor.from("catalog_items").insert(payload);
    setSaving(false);
    if (res.error) { alert(res.error.message); return; }
    onSaved();
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...modalBox, width: 520 }}>
        <h3 style={{ margin: "0 0 14px", color: TH.text, fontSize: 16 }}>{item ? `Edit ${item.sku}` : "Add SKU"}</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label="SKU"><input value={sku} onChange={(e) => setSku(e.target.value)} disabled={!!item} style={inp} /></Field>
          <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} style={inp} /></Field>
          <Field label="Category"><input value={category} onChange={(e) => setCategory(e.target.value)} style={inp} /></Field>
          <Field label="Status">
            <select value={status} onChange={(e) => setStatus(e.target.value as CatalogItem["status"])} style={inp}>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="discontinued">Discontinued</option>
            </select>
          </Field>
          <Field label="Unit price"><input value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} type="number" step="0.01" style={inp} /></Field>
          <Field label="Lead time (days)"><input value={leadTime} onChange={(e) => setLeadTime(e.target.value)} type="number" style={inp} /></Field>
          <Field label="Min order qty"><input value={moq} onChange={(e) => setMoq(e.target.value)} type="number" style={inp} /></Field>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={btnSecondary}>Cancel</button>
          <button onClick={() => void save()} disabled={saving} style={{ ...btnPrimary, opacity: saving ? 0.6 : 1 }}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}

function BulkUploadModal({ vendorId, onClose }: { vendorId: string; onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  async function upload() {
    if (!file) return;
    setUploading(true);
    try {
      const path = `${vendorId}/${Date.now()}_${file.name}`;
      const { error: upErr } = await supabaseVendor.storage.from("bulk-operations").upload(path, file, { upsert: false, contentType: "text/csv" });
      if (upErr) throw upErr;
      const text = await file.text();
      const rowCount = text.split(/\r?\n/).filter((l) => l.trim().length > 0).length - 1;
      const t = await token();
      const r = await fetch("/api/vendor/bulk/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
        body: JSON.stringify({ type: "catalog_update", input_file_url: path, filename: file.name, total_rows: Math.max(rowCount, 0) }),
      });
      if (!r.ok) throw new Error(await r.text());
      alert("Upload queued. Check Bulk operations for progress.");
      onClose();
    } catch (e: unknown) {
      alert(`Upload failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setUploading(false);
    }
  }

  function downloadTemplate() {
    const blob = new Blob([CSV_TEMPLATE], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "catalog_update_template.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...modalBox, width: 480 }}>
        <h3 style={{ margin: "0 0 14px", color: TH.text, fontSize: 16 }}>Bulk catalog update</h3>
        <p style={{ fontSize: 13, color: TH.textSub2, marginBottom: 10 }}>Upload a CSV of SKU updates. Columns: <b>sku</b> (required), name, unit_price, lead_time_days, min_order_quantity, status, category.</p>
        <button onClick={downloadTemplate} style={{ ...btnSecondary, marginBottom: 12 }}>Download template</button>
        <div>
          <input type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={btnSecondary}>Cancel</button>
          <button onClick={() => void upload()} disabled={!file || uploading} style={{ ...btnPrimary, opacity: !file || uploading ? 0.6 : 1 }}>{uploading ? "Uploading…" : "Upload"}</button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: TH.textMuted, textTransform: "uppercase", letterSpacing: 0.05, fontWeight: 700, marginBottom: 3 }}>{label}</div>
      {children}
    </div>
  );
}

const inp = { width: "100%", padding: "8px 10px", borderRadius: 6, border: `1px solid ${TH.border}`, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" } as const;
const btnPrimary = { padding: "8px 16px", borderRadius: 6, border: "none", background: TH.primary, color: "#FFFFFF", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;
const btnSecondary = { padding: "8px 16px", borderRadius: 6, border: `1px solid ${TH.border}`, background: TH.surfaceHi, color: TH.text, cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;
const pill = { padding: "6px 12px", borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" } as const;
const overlay = { position: "fixed" as const, inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 };
const modalBox = { background: TH.surface, borderRadius: 10, padding: 22, maxWidth: "92vw", boxShadow: "0 10px 40px rgba(0,0,0,0.3)", maxHeight: "90vh", overflowY: "auto" as const };

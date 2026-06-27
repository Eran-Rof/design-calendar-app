// StyleImageGallery — app-wide image gallery for a style.
//
// Clicking any style image anywhere should open ALL of that style's images,
// let the user select multiple, and download or print them. Usage:
//   import { openStyleGallery, StyleGalleryHost } from ".../StyleImageGallery";
//   <img ... onClick={() => openStyleGallery(styleId, "RBB1042A")} />
// Mount <StyleGalleryHost/> once near the app root (like <WarnHost/>).
//
// Images come from the PIM endpoint (signed URLs, 1h TTL):
//   GET /api/internal/pim/styles/:id/images  → [{ id, color, alt_text, signed_urls:{thumb,web,print} }]

import { useEffect, useState } from "react";

interface GalleryImg {
  id: string;
  color: string | null;
  alt_text: string | null;
  image_kind?: string | null;
  signed_urls?: { thumb?: string | null; web?: string | null; print?: string | null } | null;
}

type GState = { open: boolean; styleId: string | null; label: string };
let state: GState = { open: false, styleId: null, label: "" };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Open the gallery for a style. `label` (e.g. style code) is shown in the header + filenames. */
export function openStyleGallery(styleId: string, label = "") {
  if (!styleId) return;
  state = { open: true, styleId, label: label || styleId };
  emit();
}
function closeGallery() { state = { ...state, open: false }; emit(); }

export function StyleGalleryHost() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  if (!state.open || !state.styleId) return null;
  return <Gallery styleId={state.styleId} label={state.label} onClose={closeGallery} />;
}

const C = { bg: "#0F172A", card: "#1E293B", bdr: "#334155", text: "#F1F5F9", sub: "#94A3B8", primary: "#3B82F6", accent: "#22C55E" };

function bestUrl(img: GalleryImg, kind: "thumb" | "web" | "print") {
  const s = img.signed_urls || {};
  return s[kind] || s.web || s.thumb || s.print || "";
}

function Gallery({ styleId, label, onClose }: { styleId: string; label: string; onClose: () => void }) {
  const [imgs, setImgs] = useState<GalleryImg[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [enlarged, setEnlarged] = useState<number | null>(null); // index into imgs, or null

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setErr(null); setSel(new Set());
    fetch(`/api/internal/pim/styles/${encodeURIComponent(styleId)}/images`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => { if (!cancelled) setImgs(Array.isArray(d) ? d : []); })
      .catch((e: unknown) => { if (!cancelled) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [styleId]);

  // Keyboard: in the lightbox, ←/→ navigate and Esc returns to the grid; in the
  // grid, Esc closes.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (enlarged != null) {
        if (e.key === "Escape") setEnlarged(null);
        else if (e.key === "ArrowRight") setEnlarged((i) => (i == null ? i : Math.min(imgs.length - 1, i + 1)));
        else if (e.key === "ArrowLeft") setEnlarged((i) => (i == null ? i : Math.max(0, i - 1)));
      } else if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose, enlarged, imgs.length]);

  const toggle = (id: string) => setSel((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const selectAll = () => setSel(new Set(imgs.map((i) => i.id)));
  const clearSel = () => setSel(new Set());
  // The set to act on: selected, or everything when nothing is selected.
  const targets = () => (sel.size > 0 ? imgs.filter((i) => sel.has(i.id)) : imgs);

  async function download() {
    const list = targets();
    if (list.length === 0) return;
    setBusy("download");
    try {
      for (let i = 0; i < list.length; i++) {
        const img = list[i];
        const url = bestUrl(img, "print");
        if (!url) continue;
        try {
          const resp = await fetch(url);
          const blob = await resp.blob();
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          const part = (img.color || img.image_kind || `img${i + 1}`).replace(/[^\w-]+/g, "_");
          a.download = `${(label || styleId).replace(/[^\w-]+/g, "_")}_${part}_${i + 1}.jpg`;
          document.body.appendChild(a); a.click(); a.remove();
          URL.revokeObjectURL(a.href);
        } catch { /* skip one bad image */ }
      }
    } finally { setBusy(null); }
  }

  function print() {
    const list = targets();
    if (list.length === 0) return;
    const w = window.open("", "_blank");
    if (!w) return;
    const items = list.map((img) => {
      const url = bestUrl(img, "print");
      const cap = [label, img.color, img.image_kind].filter(Boolean).join(" · ");
      return `<figure style="break-inside:avoid;margin:0 0 16px;text-align:center"><img src="${url}" style="max-width:100%;max-height:90vh"/><figcaption style="font:12px sans-serif;color:#444;margin-top:4px">${cap}</figcaption></figure>`;
    }).join("");
    w.document.write(`<!doctype html><html><head><title>${label || "Images"}</title></head><body style="margin:16px">${items}<script>let n=${list.length},d=0;const imgs=document.images;if(!imgs.length){window.print();}for(const im of imgs){if(im.complete){if(++d>=n)window.print();}else{im.onload=im.onerror=()=>{if(++d>=n)window.print();};}}<\/script></body></html>`);
    w.document.close();
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)", zIndex: 11000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.bdr}`, borderRadius: 12, width: "min(1000px, 96vw)", maxHeight: "92vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderBottom: `1px solid ${C.bdr}`, flexWrap: "wrap" }}>
          <div style={{ fontWeight: 700, color: C.text, fontSize: 15 }}>{label} <span style={{ color: C.sub, fontWeight: 400, fontSize: 12 }}>· {imgs.length} image{imgs.length === 1 ? "" : "s"}{sel.size > 0 ? ` · ${sel.size} selected` : ""}</span></div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button onClick={selectAll} style={btn(false)}>Select all</button>
            <button onClick={clearSel} disabled={sel.size === 0} style={btn(false)}>Clear</button>
            <button onClick={() => void download()} disabled={busy != null || imgs.length === 0} style={btn(true, C.primary)}>{busy === "download" ? "Downloading…" : `Download${sel.size ? ` (${sel.size})` : " all"}`}</button>
            <button onClick={print} disabled={imgs.length === 0} style={btn(true, C.accent)}>Print{sel.size ? ` (${sel.size})` : " all"}</button>
            <button onClick={onClose} style={btn(false)}>✕</button>
          </div>
        </div>
        <div style={{ padding: 14, overflow: "auto" }}>
          {loading ? <div style={{ color: C.sub, padding: 30, textAlign: "center" }}>Loading…</div>
            : err ? <div style={{ color: "#FCA5A5", padding: 20 }}>Error: {err}</div>
            : imgs.length === 0 ? <div style={{ color: C.sub, padding: 30, textAlign: "center" }}>No images for this style yet.</div>
            : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 10 }}>
              {imgs.map((img, idx) => {
                const on = sel.has(img.id);
                return (
                  // Click the tile to ENLARGE; tick the corner checkbox to SELECT.
                  <div key={img.id} onClick={() => setEnlarged(idx)} title="Click to enlarge" style={{ cursor: "zoom-in", border: `2px solid ${on ? C.accent : C.bdr}`, borderRadius: 8, overflow: "hidden", position: "relative", background: "#0b1220" }}>
                    <div style={{ aspectRatio: "1 / 1", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <img src={bestUrl(img, "web")} alt={img.alt_text || ""} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
                    </div>
                    <div
                      onClick={(e) => { e.stopPropagation(); toggle(img.id); }}
                      title={on ? "Deselect" : "Select"}
                      style={{ position: "absolute", top: 6, right: 6, width: 22, height: 22, borderRadius: 999, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 13, background: on ? C.accent : "rgba(2,6,23,0.7)", color: on ? "#06240F" : "#fff", border: `1px solid ${on ? C.accent : "#64748b"}` }}
                    >{on ? "✓" : ""}</div>
                    {img.color && <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, background: "rgba(0,0,0,0.6)", color: "#fff", fontSize: 10, padding: "2px 6px", textAlign: "center" }}>{img.color}</div>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Enlarged lightbox — click backdrop or ✕ to return to the grid; ←/→ to navigate. */}
      {enlarged != null && imgs[enlarged] && (
        <div onClick={(e) => { e.stopPropagation(); setEnlarged(null); }} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.92)", zIndex: 11001, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <button onClick={(e) => { e.stopPropagation(); setEnlarged(null); }} style={lbBtn} title="Close (Esc)">✕</button>
          {enlarged > 0 && <button onClick={(e) => { e.stopPropagation(); setEnlarged(enlarged - 1); }} style={{ ...lbNav, left: 12 }} title="Previous (←)">‹</button>}
          {enlarged < imgs.length - 1 && <button onClick={(e) => { e.stopPropagation(); setEnlarged(enlarged + 1); }} style={{ ...lbNav, right: 12 }} title="Next (→)">›</button>}
          <img onClick={(e) => e.stopPropagation()} src={bestUrl(imgs[enlarged], "print")} alt={imgs[enlarged].alt_text || ""} style={{ maxWidth: "94vw", maxHeight: "90vh", objectFit: "contain" }} />
          <div style={{ position: "fixed", bottom: 14, left: 0, right: 0, textAlign: "center", color: "#cbd5e1", fontSize: 12 }}>
            {[label, imgs[enlarged].color, `${enlarged + 1}/${imgs.length}`].filter(Boolean).join("  ·  ")}
          </div>
        </div>
      )}
    </div>
  );
}

const lbBtn: React.CSSProperties = { position: "fixed", top: 14, right: 16, zIndex: 11002, width: 38, height: 38, borderRadius: 999, border: "1px solid #475569", background: "rgba(2,6,23,0.7)", color: "#fff", fontSize: 18, cursor: "pointer" };
const lbNav: React.CSSProperties = { position: "fixed", top: "50%", transform: "translateY(-50%)", zIndex: 11002, width: 46, height: 64, borderRadius: 8, border: "1px solid #475569", background: "rgba(2,6,23,0.6)", color: "#fff", fontSize: 32, lineHeight: "1", cursor: "pointer" };

function btn(solid: boolean, color = "#475569"): React.CSSProperties {
  return { padding: "6px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", border: solid ? "none" : `1px solid ${C.bdr}`, background: solid ? color : "transparent", color: solid ? "#fff" : C.text };
}

import React, { useState } from "react";
import { TH } from "../utils/theme";

// ─── NOTE INPUT ───────────────────────────────────────────────────────────────
export function NoteInput({ onAdd }: { onAdd: (text: string) => void }) {
  const [text, setText] = useState("");
  function submit() {
    const t = text.trim();
    if (!t) return;
    onAdd(t);
    setText("");
  }
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
      <textarea
        style={{ flex: 1, padding: "8px 10px", borderRadius: 8, border: `1px solid ${TH.border}`, fontFamily: "inherit", fontSize: 13, lineHeight: 1.5, resize: "vertical", minHeight: 70, outline: "none", color: TH.text, background: "#fff" }}
        placeholder="Add a note..."
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter" && e.metaKey) { e.preventDefault(); submit(); }
        }}
      />
      <button
        onClick={submit}
        disabled={!text.trim()}
        style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: text.trim() ? TH.primary : TH.border, color: "#fff", cursor: text.trim() ? "pointer" : "default", fontFamily: "inherit", fontSize: 13, fontWeight: 600, flexShrink: 0, marginBottom: 0 }}
      >
        Add Note
      </button>
    </div>
  );
}

// ─── BUILD SKU CAD PAGE ───────────────────────────────────────────────────────
export function buildSkuCadPage(skus: any[], brand: any, showPrice: boolean, mode = "open"): string {
  const brandName = brand?.name || "ROF";
  const isLink = mode === "link";

  const skuCards = skus.map(s => {
    const img = s.images?.[0]?.src || "";
    const imgHtml = img
      ? `<img src="${img}" class="sku-img" alt="${s.styleNum || ""}" ondblclick="enlargeImg(this)" title="Double-click to enlarge" />`
      : `<div class="sku-img-placeholder">👕</div>`;

    const details = [
      s.description ? `<div class="detail-row"><span class="detail-label">Description</span><span class="detail-val">${s.description}</span></div>` : "",
      s.colorways ? `<div class="detail-row"><span class="detail-label">Colorways</span><span class="detail-val">${s.colorways}</span></div>` : "",
      s.fabric ? `<div class="detail-row"><span class="detail-label">Fabric</span><span class="detail-val">${s.fabric}</span></div>` : "",
      s.sizes?.length ? `<div class="detail-row"><span class="detail-label">Sizes</span><span class="detail-val">${s.sizes.join(" · ")}</span></div>` : "",
      s.wholesale ? `<div class="detail-row"><span class="detail-label">Wholesale</span><span class="detail-val">$${s.wholesale}</span></div>` : "",
      s.retail ? `<div class="detail-row"><span class="detail-label">Retail</span><span class="detail-val">$${s.retail}</span></div>` : "",
      showPrice ? `<div class="detail-row price-row"><span class="detail-label">Price</span><span class="detail-val ${s.targetSelling ? 'price-val' : 'price-tbd'}">${s.targetSelling ? "$" + s.targetSelling : "TBD"}</span></div>` : "",
    ].filter(Boolean).join("");

    return `
    <div class="sku-card">
      <div class="sku-header">
        <div class="style-num">${s.styleNum || "—"}</div>
      </div>
      <div class="sku-body">
        <div class="img-wrap">${imgHtml}</div>
        <div class="details">${details}</div>
      </div>
    </div>`;
  }).join("");

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${brandName} CAD Page</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #fff; color: #1A202C; }
    .page-header { display: flex; align-items: center; justify-content: space-between; padding: 20px 32px; border-bottom: 3px solid #C8210A; margin-bottom: 28px; }
    .brand-logo { font-size: 22px; font-weight: 900; color: #C8210A; letter-spacing: -0.5px; text-transform: uppercase; }
    .brand-sub { font-size: 11px; color: #718096; margin-top: 2px; letter-spacing: 0.05em; text-transform: uppercase; }
    .page-date { font-size: 11px; color: #718096; text-align: right; }
    .skus-grid { display: grid; grid-template-columns: repeat(auto-fill, 280px); gap: 24px; padding: 0 32px 40px; align-items: stretch; }
    .sku-card { width: 280px; border: 1px solid #E2E8F0; border-radius: 10px; overflow: hidden; break-inside: avoid; display: flex; flex-direction: column; }
    .sku-header { background: #1A202C; padding: 8px 14px; flex-shrink: 0; }
    .style-num { font-size: 13px; font-weight: 800; color: #fff; letter-spacing: 0.05em; }
    .sku-body { padding: 14px; display: flex; flex-direction: column; flex: 1; }
    .img-wrap { flex: 1; display: flex; align-items: center; justify-content: center; margin-bottom: 12px; min-height: 180px; }
    .sku-img { max-width: 240px; max-height: 260px; width: 100%; object-fit: contain; border-radius: 6px; cursor: zoom-in; }
    .sku-img-placeholder { width: 240px; height: 200px; display: flex; align-items: center; justify-content: center; font-size: 48px; background: #F7FAFC; border-radius: 6px; }
    .details { flex-shrink: 0; display: flex; flex-direction: column; gap: 5px; }
    .detail-row { display: flex; justify-content: space-between; align-items: baseline; font-size: 12px; border-bottom: 1px solid #F0F0F0; padding-bottom: 4px; }
    .detail-label { color: #718096; font-weight: 500; flex-shrink: 0; margin-right: 8px; }
    .detail-val { color: #1A202C; font-weight: 600; text-align: right; }
    .price-row { border-top: 2px solid #C8210A; padding-top: 6px; margin-top: 4px; border-bottom: none; }
    .price-val { color: #C8210A; font-size: 14px; font-weight: 800; }
    .price-tbd { color: #A0AEC0; font-size: 13px; font-weight: 600; font-style: italic; }
    .lightbox { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.9); z-index:9999; align-items:center; justify-content:center; cursor:zoom-out; }
    .lightbox.active { display:flex; }
    .lightbox img { max-width:92vw; max-height:92vh; border-radius:10px; object-fit:contain; }
    .lb-close { position:fixed; top:16px; right:20px; color:#fff; font-size:28px; cursor:pointer; background:none; border:none; }
    .footer { padding: 16px 32px; border-top: 1px solid #E2E8F0; font-size: 11px; color: #CBD5E0; text-align: center; }
    @media print {
      .lightbox { display:none !important; }
      .sku-card { break-inside: avoid; page-break-inside: avoid; }
      body { padding: 0; }
    }
  </style>
</head>
<body>
  <div class="page-header">
    <div>
      <div class="brand-logo">${brandName}</div>
      <div class="brand-sub">Product Line Sheet${isLink ? "" : " · Confidential"}</div>
    </div>
    <div class="page-date">Generated ${new Date().toLocaleDateString()}</div>
  </div>
  <div class="skus-grid">${skuCards}</div>
  <div class="footer">ROF Design Calendar · ${new Date().getFullYear()}</div>
  <div class="lightbox" id="lb" onclick="closeLb()">
    <button class="lb-close" onclick="closeLb()">✕</button>
    <img id="lb-img" src="" onclick="event.stopPropagation()" />
  </div>
  <script>
    function enlargeImg(img) { document.getElementById("lb-img").src=img.src; document.getElementById("lb").classList.add("active"); }
    function closeLb() { document.getElementById("lb").classList.remove("active"); }
    document.addEventListener("keydown", e => e.key==="Escape" && closeLb());
  <\/script>
</body>
</html>`;

  const blob = new Blob([html], { type: "text/html" });
  return URL.createObjectURL(blob);
}

// ─── BUILD ATTACHMENT PAGE ────────────────────────────────────────────────────
export function buildAttachmentPage(task: any, taskOrig: any, collData: any, brand: any, mode = "open"): string {
  // mode = "link" (minimal header) or "open" (full header with sample due)
  const images = task.images || [];

  const metaParts = [
    task.season,
    task.category,
    task.phase,
    collData?.customer ? `Customer: ${collData.customer}` : null,
    task.due ? `Due: ${task.due}` : null,
    task.status,
  ].filter(Boolean).join(" · ");

  const sampleDue = collData?.sampleDueDate;

  // Header HTML differs by mode
  const headerHtml = mode === "link"
    ? `<div class="brand-name">${brand?.name || ""}</div>
       <div class="collection">${task.collection || ""}</div>`
    : `<div class="brand-name">${brand?.name || ""}</div>
       <div class="collection">${task.collection || ""}${sampleDue ? ` <span class="sample-due">· Samples Due: ${sampleDue}</span>` : ""}</div>
       <div class="meta">${metaParts}</div>`;

  const imagesHtml = images.map((img: any) => {
    const isImg = img.src?.startsWith("http") || img.src?.startsWith("data:image");
    if (!isImg) return `<div class="attachment file-attachment"><div class="file-icon">📎</div><div class="file-name">${img.name || "File"}</div></div>`;
    return `<div class="attachment"><img src="${img.src}" alt="${img.name || ""}" ondblclick="enlargeImg(this)" title="Double-click to enlarge · Right-click to save/print" /><div class="img-info">${img.name || ""}</div></div>`;
  }).join("");

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${task.collection || ""} – ${task.phase || ""}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 32px; color: #1A202C; background: #fff; }
    .header { border-bottom: 3px solid #C8210A; padding-bottom: 16px; margin-bottom: 24px; }
    .brand-name { font-size: 11px; font-weight: 700; color: #C8210A; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 4px; }
    .collection { font-size: 22px; font-weight: 800; color: #1A202C; margin-bottom: 6px; }
    .sample-due { font-size: 14px; font-weight: 600; color: #B45309; }
    .meta { font-size: 12px; color: #718096; line-height: 1.6; }
    .phase-badge { display: inline-block; background: #C8210A; color: #fff; font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 12px; margin-bottom: 16px; }
    .attachments { display: flex; flex-wrap: wrap; gap: 20px; margin-top: 8px; }
    .attachment { break-inside: avoid; }
    .attachment img { max-width: 280px; max-height: 320px; border-radius: 8px; border: 1px solid #E2E8F0; object-fit: contain; display: block; cursor: zoom-in; transition: transform 0.1s; }
    .attachment img:hover { border-color: #C8210A; }
    .img-info { font-size: 11px; color: #718096; margin-top: 4px; max-width: 280px; word-break: break-all; }
    .file-attachment { width: 120px; height: 120px; border: 1px solid #E2E8F0; border-radius: 8px; display: flex; flex-direction: column; align-items: center; justify-content: center; }
    .file-icon { font-size: 36px; }
    .file-name { font-size: 11px; color: #718096; margin-top: 4px; text-align: center; padding: 0 8px; word-break: break-all; }
    .footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #E2E8F0; font-size: 11px; color: #CBD5E0; }
    .lightbox { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.9); z-index:9999; align-items:center; justify-content:center; cursor:zoom-out; }
    .lightbox.active { display:flex; }
    .lightbox img { max-width:92vw; max-height:92vh; border-radius:10px; object-fit:contain; cursor:default; }
    .lightbox-close { position:fixed; top:16px; right:20px; color:#fff; font-size:28px; cursor:pointer; background:none; border:none; font-family:inherit; }
    @media print { .lightbox { display:none !important; } }
  </style>
</head>
<body>
  <div class="header">${headerHtml}</div>
  <div class="phase-badge">${task.phase || ""}</div>
  <div class="attachments">${imagesHtml}</div>
  <div class="footer">Generated ${new Date().toLocaleDateString()} · ROF Design Calendar</div>
  <div class="lightbox" id="lb" onclick="closeLb()">
    <button class="lightbox-close" onclick="closeLb()">✕</button>
    <img id="lb-img" src="" onclick="event.stopPropagation()" />
  </div>
  <script>
    function enlargeImg(img) {
      document.getElementById('lb-img').src = img.src;
      document.getElementById('lb').classList.add('active');
    }
    function closeLb() {
      document.getElementById('lb').classList.remove('active');
    }
    document.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeLb(); });
  <\/script>
</body>
</html>`;

  const blob = new Blob([html], { type: "text/html" });
  return URL.createObjectURL(blob);
}

export default NoteInput;

import React, { useState } from "react";
import { TH } from "../utils/theme";
import { S } from "../utils/styles";
import { Modal } from "./Modal";

// ─── IMAGE GALLERY MODAL ──────────────────────────────────────────────────────
function ImageGalleryModal({ title, images, onClose }) {
  const [lightbox, setLightbox] = useState(null); // index of enlarged image

  function handleDownload(img) {
    if (!img.src) return;
    const a = document.createElement("a");
    a.href = img.src;
    a.download = img.title || img.name || "image";
    a.click();
  }

  function copyLink() {
    // Generate the blob URL and copy to clipboard
    const url = buildGalleryUrl();
    navigator.clipboard?.writeText(url).catch(() => {});
    // Brief visual feedback handled by caller
  }

  function buildGalleryUrl() {
    const cards = images
      .map((img, idx) => {
        const metaRows = img.meta
          ? Object.entries(img.meta)
              .filter(([, v]) => v)
              .map(
                ([k, v]) =>
                  `<tr><td style="font-size:10px;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:.06em;padding:2px 8px 2px 0;white-space:nowrap">${k}</td><td style="font-size:10px;color:rgba(255,255,255,0.82);font-weight:600;padding:2px 0">${v}</td></tr>`
              )
              .join("")
          : "";
        const name = (img.title || img.name || `Image ${idx + 1}`).replace(
          /"/g,
          "&quot;"
        );
        return `<div class="card" data-idx="${idx}">
        <div class="img-wrap">
          ${
            img.src
              ? `<img src="${img.src}" alt="${name}" draggable="false">`
              : `<div class="no-img">🖼️</div>`
          }
        </div>
        <div class="info">
          <div class="img-title">${name}</div>
          ${
            metaRows
              ? `<table style="width:100%;border-collapse:collapse;margin-top:4px">${metaRows}</table>`
              : ""
          }
          ${img.subtitle ? `<div class="subtitle">${img.subtitle}</div>` : ""}
          <div class="actions">
            <button onclick="dlImg(${idx})">⬇ Download</button>
            <button onclick="printImg(${idx})">🖨 Print</button>
          </div>
        </div>
        <div class="ctx-menu" id="ctx-${idx}">
          <div onclick="dlImg(${idx})">⬇ Download Image</div>
          <div onclick="printImg(${idx})">🖨 Print Image</div>
          <div onclick="copyImgUrl(${idx})">🔗 Copy Image URL</div>
        </div>
      </div>`;
      })
      .join("");

    const srcs = JSON.stringify(
      images.map((i) => ({
        src: i.src || "",
        title: i.title || i.name || "image",
      }))
    );
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${title.replace(/</g, "&lt;")}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0F1117;font-family:-apple-system,'Helvetica Neue',sans-serif;padding:0}
.header{display:flex;align-items:center;justify-content:space-between;padding:12px 24px;background:#1A202C;border-bottom:1px solid rgba(255,255,255,0.1);position:sticky;top:0;z-index:10}
.header-title{font-size:15px;font-weight:800;color:#fff;letter-spacing:-.01em}
.header-count{font-size:11px;color:rgba(255,255,255,0.4);background:rgba(255,255,255,0.08);padding:2px 9px;border-radius:20px;margin-left:10px}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;padding:20px 24px}
.card{border-radius:12px;overflow:visible;background:#1A202C;border:1px solid rgba(255,255,255,0.1);display:flex;flex-direction:column;cursor:pointer;position:relative;transition:transform .15s,box-shadow .15s}
.card:hover{transform:translateY(-3px);box-shadow:0 8px 32px rgba(0,0,0,0.6)}
.img-wrap{width:100%;aspect-ratio:3/4;overflow:hidden;background:#0F1117;border-radius:12px 12px 0 0;display:flex;align-items:center;justify-content:center}
.img-wrap img{width:100%;height:100%;object-fit:cover;display:block}
.no-img{font-size:48px;opacity:.3}
.info{padding:10px 12px;border-top:1px solid rgba(255,255,255,0.08)}
.img-title{font-size:12px;font-weight:800;color:#fff;margin-bottom:4px;line-height:1.3}
.subtitle{font-size:10px;color:rgba(255,255,255,0.35);margin-top:4px}
.actions{display:flex;gap:6px;margin-top:8px}
.actions button{flex:1;padding:5px 0;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.7);font-size:10px;font-weight:600;cursor:pointer;font-family:inherit}
.actions button:hover{background:rgba(255,255,255,0.12)}
.ctx-menu{display:none;position:fixed;background:#1E2532;border:1px solid rgba(255,255,255,0.15);border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,0.6);min-width:180px;z-index:9999;overflow:hidden;padding:4px 0}
.ctx-menu div{padding:9px 16px;font-size:12px;color:rgba(255,255,255,0.82);cursor:pointer;font-weight:500}
.ctx-menu div:hover{background:rgba(255,255,255,0.08)}
@media print{.header,.actions{display:none!important}.grid{grid-template-columns:repeat(2,1fr);gap:12px;padding:0}.card{break-inside:avoid;border:1px solid #ddd;background:#fff}.img-title{color:#000}.info{color:#333}}
</style></head>
<body>
<div class="header">
  <div style="display:flex;align-items:center">
    <span class="header-title">${title.replace(/</g, "&lt;")}</span>
    <span class="header-count">${images.length} image${
      images.length !== 1 ? "s" : ""
    }</span>
  </div>
  <button onclick="window.print()" style="padding:5px 14px;border-radius:7px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.07);color:rgba(255,255,255,0.7);font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">🖨 Print All</button>
</div>
<div class="grid">${cards}</div>
<script>
const imgs=${srcs};
function dlImg(i){const a=document.createElement('a');a.href=imgs[i].src;a.download=imgs[i].title||'image';a.click();}
function printImg(i){const w=window.open('','_blank');w.document.write('<html><body style="margin:0;background:#000;display:flex;align-items:center;justify-content:center;min-height:100vh"><img src="'+imgs[i].src+'" style="max-width:100%;max-height:100vh;object-fit:contain"><script>window.onload=()=>{window.print();window.close();}<\\/script></body></html>');w.document.close();}
function copyImgUrl(i){navigator.clipboard&&navigator.clipboard.writeText(imgs[i].src);}
let activeCtx=null;
document.querySelectorAll('.card').forEach((card,i)=>{
  card.addEventListener('contextmenu',e=>{
    e.preventDefault();
    if(activeCtx){activeCtx.style.display='none';}
    const m=document.getElementById('ctx-'+i);
    m.style.display='block';
    m.style.left=Math.min(e.clientX,window.innerWidth-190)+'px';
    m.style.top=Math.min(e.clientY,window.innerHeight-130)+'px';
    activeCtx=m;
  });
});
document.addEventListener('click',()=>{if(activeCtx){activeCtx.style.display='none';activeCtx=null;}});
</script>
</body></html>`;
    const blob = new Blob([html], { type: "text/html" });
    return URL.createObjectURL(blob);
  }

  const [copied, setCopied] = useState(false);

  function openNewTab() {
    window.open(buildGalleryUrl(), "_blank");
  }

  function handleCopyLink() {
    const url = buildGalleryUrl();
    navigator.clipboard
      ?.writeText(url)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
    // Do NOT open a new tab — just copy
  }

  return (
    <>
      {/* Full-screen — above all app chrome */}
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 9999,
          background: "#0F1117",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Compact header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 16px",
            borderBottom: "1px solid rgba(255,255,255,0.1)",
            flexShrink: 0,
            background: "#1A202C",
            height: 36,
            minHeight: 36,
            maxHeight: 36,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              overflow: "hidden",
            }}
          >
            <span
              style={{
                fontSize: 12,
                fontWeight: 700,
                color: "#fff",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                maxWidth: 300,
              }}
            >
              {title}
            </span>
            <span
              style={{
                fontSize: 10,
                color: "rgba(255,255,255,0.35)",
                background: "rgba(255,255,255,0.07)",
                padding: "1px 7px",
                borderRadius: 20,
                flexShrink: 0,
              }}
            >
              {images.length}
            </span>
          </div>
          <div
            style={{
              display: "flex",
              gap: 5,
              alignItems: "center",
              flexShrink: 0,
            }}
          >
            <button
              onClick={openNewTab}
              style={{
                background: "rgba(255,255,255,0.07)",
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: 6,
                padding: "3px 10px",
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 10,
                color: "rgba(255,255,255,0.65)",
                fontWeight: 600,
                whiteSpace: "nowrap",
              }}
            >
              ↗ New Tab
            </button>
            <button
              onClick={handleCopyLink}
              style={{
                background: copied
                  ? "rgba(16,185,129,0.15)"
                  : "rgba(255,255,255,0.07)",
                border: `1px solid ${
                  copied ? "rgba(16,185,129,0.4)" : "rgba(255,255,255,0.12)"
                }`,
                borderRadius: 6,
                padding: "3px 10px",
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 10,
                color: copied
                  ? "rgba(52,211,153,0.9)"
                  : "rgba(255,255,255,0.65)",
                fontWeight: 600,
                whiteSpace: "nowrap",
                transition: "all 0.2s",
              }}
            >
              {copied ? "✓ Copied!" : "🔗 Copy Link"}
            </button>
            <button
              onClick={onClose}
              style={{
                background: "rgba(220,38,38,0.12)",
                border: "1px solid rgba(220,38,38,0.3)",
                borderRadius: 6,
                padding: "3px 10px",
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 10,
                color: "rgba(252,129,129,0.85)",
                fontWeight: 700,
                lineHeight: 1,
              }}
            >
              ✕
            </button>
          </div>
        </div>

        {/* Grid */}
        <div style={{ flex: 1, overflowY: "auto", padding: "24px 28px" }}>
          {images.length === 0 ? (
            <div
              style={{
                textAlign: "center",
                color: "rgba(255,255,255,0.3)",
                padding: "100px 0",
                fontSize: 16,
              }}
            >
              No images found.
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(4, 1fr)",
                gap: 20,
              }}
            >
              {images.map((img, idx) => (
                <div
                  key={img.id || idx}
                  style={{
                    borderRadius: 14,
                    overflow: "hidden",
                    background: "#1A202C",
                    border: "1px solid rgba(255,255,255,0.1)",
                    boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
                    display: "flex",
                    flexDirection: "column",
                    cursor: "pointer",
                    transition: "transform 0.15s, box-shadow 0.15s",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLDivElement).style.transform =
                      "translateY(-3px)";
                    (e.currentTarget as HTMLDivElement).style.boxShadow =
                      "0 8px 32px rgba(0,0,0,0.6)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLDivElement).style.transform =
                      "none";
                    (e.currentTarget as HTMLDivElement).style.boxShadow =
                      "0 4px 20px rgba(0,0,0,0.4)";
                  }}
                  onClick={() => setLightbox(idx)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    handleDownload(img);
                  }}
                  title="Click to enlarge · Right-click to download"
                >
                  {/* Vertical image — 3:4 portrait ratio */}
                  <div
                    style={{
                      width: "100%",
                      aspectRatio: "3/4",
                      overflow: "hidden",
                      background: "#0F1117",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      position: "relative",
                    }}
                  >
                    {img.src ? (
                      <img
                        src={img.src}
                        alt={img.title || img.name || "Image"}
                        style={{
                          width: "100%",
                          height: "100%",
                          objectFit: "cover",
                        }}
                        draggable={false}
                      />
                    ) : (
                      <span style={{ fontSize: 56, opacity: 0.3 }}>🖼️</span>
                    )}
                    {/* Hover overlay hint */}
                    <div
                      style={{
                        position: "absolute",
                        inset: 0,
                        background: "rgba(0,0,0,0)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        transition: "background 0.15s",
                      }}
                      className="img-overlay"
                    />
                  </div>
                  {/* Info panel */}
                  <div
                    style={{
                      padding: "12px 14px",
                      borderTop: "1px solid rgba(255,255,255,0.08)",
                      flex: 1,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 800,
                        color: "#fff",
                        marginBottom: 4,
                        lineHeight: 1.3,
                      }}
                    >
                      {img.title || img.name || `Image ${idx + 1}`}
                    </div>
                    {img.meta &&
                      Object.entries(img.meta).map(([k, v]) =>
                        v ? (
                          <div
                            key={k}
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              marginBottom: 2,
                            }}
                          >
                            <span
                              style={{
                                fontSize: 10,
                                color: "rgba(255,255,255,0.4)",
                                textTransform: "uppercase",
                                letterSpacing: "0.06em",
                              }}
                            >
                              {k}
                            </span>
                            <span
                              style={{
                                fontSize: 10,
                                color: "rgba(255,255,255,0.75)",
                                fontWeight: 600,
                              }}
                            >
                              {v as string}
                            </span>
                          </div>
                        ) : null
                      )}
                    {img.subtitle && (
                      <div
                        style={{
                          fontSize: 10,
                          color: "rgba(255,255,255,0.4)",
                          marginTop: 4,
                        }}
                      >
                        {img.subtitle}
                      </div>
                    )}
                    <div
                      style={{
                        marginTop: 8,
                        fontSize: 9,
                        color: "rgba(255,255,255,0.2)",
                        display: "flex",
                        justifyContent: "space-between",
                      }}
                    >
                      <span>Click to enlarge</span>
                      <span>Right-click to download</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Lightbox */}
      {lightbox !== null && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1200,
            background: "rgba(0,0,0,0.92)",
            backdropFilter: "blur(8px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
          }}
          onClick={() => setLightbox(null)}
        >
          <button
            style={{
              position: "fixed",
              left: 20,
              top: "50%",
              transform: "translateY(-50%)",
              background: "rgba(255,255,255,0.1)",
              border: "1px solid rgba(255,255,255,0.2)",
              borderRadius: "50%",
              width: 48,
              height: 48,
              cursor: "pointer",
              color: "#fff",
              fontSize: 22,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            onClick={(e) => {
              e.stopPropagation();
              setLightbox((i) => (i - 1 + images.length) % images.length);
            }}
          >
            ‹
          </button>

          <div
            style={{
              maxWidth: "80vw",
              maxHeight: "90vh",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 16,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={images[lightbox]?.src}
              alt={images[lightbox]?.title || ""}
              style={{
                maxWidth: "100%",
                maxHeight: "75vh",
                objectFit: "contain",
                borderRadius: 12,
                boxShadow: "0 20px 60px rgba(0,0,0,0.8)",
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                handleDownload(images[lightbox]);
              }}
              draggable={false}
            />
            <div style={{ textAlign: "center" }}>
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 700,
                  color: "#fff",
                  marginBottom: 4,
                }}
              >
                {images[lightbox]?.title ||
                  images[lightbox]?.name ||
                  `Image ${lightbox + 1}`}
              </div>
              {images[lightbox]?.meta && (
                <div
                  style={{
                    display: "flex",
                    gap: 16,
                    justifyContent: "center",
                    flexWrap: "wrap",
                  }}
                >
                  {Object.entries(images[lightbox].meta).map(([k, v]) =>
                    v ? (
                      <span
                        key={k}
                        style={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }}
                      >
                        <span
                          style={{
                            textTransform: "uppercase",
                            letterSpacing: "0.06em",
                            marginRight: 4,
                          }}
                        >
                          {k}:
                        </span>
                        <span
                          style={{
                            color: "rgba(255,255,255,0.85)",
                            fontWeight: 600,
                          }}
                        >
                          {v as string}
                        </span>
                      </span>
                    ) : null
                  )}
                </div>
              )}
              <div
                style={{
                  fontSize: 11,
                  color: "rgba(255,255,255,0.3)",
                  marginTop: 8,
                }}
              >
                {lightbox + 1} / {images.length} · Right-click to download
              </div>
            </div>
          </div>

          <button
            style={{
              position: "fixed",
              right: 20,
              top: "50%",
              transform: "translateY(-50%)",
              background: "rgba(255,255,255,0.1)",
              border: "1px solid rgba(255,255,255,0.2)",
              borderRadius: "50%",
              width: 48,
              height: 48,
              cursor: "pointer",
              color: "#fff",
              fontSize: 22,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            onClick={(e) => {
              e.stopPropagation();
              setLightbox((i) => (i + 1) % images.length);
            }}
          >
            ›
          </button>

          <button
            style={{
              position: "fixed",
              top: 20,
              right: 20,
              background: "rgba(255,255,255,0.1)",
              border: "1px solid rgba(255,255,255,0.2)",
              borderRadius: 8,
              padding: "6px 16px",
              cursor: "pointer",
              color: "rgba(255,255,255,0.7)",
              fontFamily: "inherit",
              fontSize: 13,
            }}
            onClick={() => setLightbox(null)}
          >
            ✕
          </button>
        </div>
      )}
    </>
  );
}

// ─── COLLECTION ATTACHMENTS BUTTON ───────────────────────────────────────────
function CollImageBtn({ collKey, collData, brand, collections, tasks }) {
  const [showModal, setShowModal] = useState(false);
  const [lightbox, setLightbox] = useState(null);
  const [brandId, collName] = collKey.split("||");

  // All tasks in this collection
  const collTasks = tasks.filter(t => `${t.brand}||${t.collection}` === collKey);
  const totalAttachments = collTasks.reduce((a, t) => a + (t.images?.length || 0), 0);
  const skus = collData?.skus || [];
  const skuAttachments = skus.reduce((a, s) => a + (s.images?.length || 0), 0);

  return (
    <>
      <button
        onClick={(e) => { e.stopPropagation(); setShowModal(true); }}
        style={{
          width: "100%",
          padding: "4px 6px",
          borderRadius: 6,
          border: `1px solid ${brand.color}44`,
          background: brand.color + "12",
          color: brand.color,
          cursor: "pointer",
          fontFamily: "inherit",
          fontSize: 10,
          fontWeight: 700,
        }}
      >
        📎 Attachments{(totalAttachments + skuAttachments) > 0 ? ` (${totalAttachments + skuAttachments})` : ""}
      </button>

      {showModal && (
        <div
          onClick={() => setShowModal(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 9000, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ background: "#fff", borderRadius: 14, width: "100%", maxWidth: 680, maxHeight: "80vh", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 24px 60px rgba(0,0,0,0.4)" }}
          >
            {/* Header */}
            <div style={{ padding: "18px 22px", borderBottom: "1px solid #E2E8F0", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, color: "#1A202C" }}>📎 Attachments — {collName}</div>
                <div style={{ fontSize: 12, color: "#718096", marginTop: 2 }}>{totalAttachments + skuAttachments} total attachment{(totalAttachments + skuAttachments) !== 1 ? "s" : ""}</div>
              </div>
              <button onClick={() => setShowModal(false)} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#718096", padding: "4px 8px" }}>✕</button>
            </div>

            {/* Body */}
            <div style={{ overflowY: "auto", padding: "16px 22px", flex: 1 }}>
              {collTasks.length === 0 && skus.length === 0 && (
                <div style={{ textAlign: "center", color: "#718096", padding: 40, fontSize: 14 }}>No tasks in this collection yet.</div>
              )}

              {/* Tasks */}
              {collTasks.map(t => (
                <div key={t.id} style={{ marginBottom: 20 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#1A202C" }}>{t.phase}</div>
                    <div style={{ fontSize: 11, color: "#718096" }}>· {t.status} · Due: {t.due || "—"}</div>
                    {(t.images?.length || 0) === 0 && <div style={{ fontSize: 11, color: "#CBD5E0", marginLeft: "auto" }}>No attachments</div>}
                  </div>
                  {(t.images?.length || 0) > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      {t.images.map((img, i) => {
                        const isImage = img.name?.match(/\.(png|jpg|jpeg|gif|webp|svg)$/i) || img.src?.startsWith("data:image") || img.src?.includes("supabase");
                        const ext = (img.name || "").split(".").pop()?.toUpperCase() || "FILE";
                        const fileIcons = { PDF: "📄", AI: "🎨", EPS: "🎨", PSD: "🖼️", SVG: "🔷" };
                        return (
                          <div
                            key={i}
                            onClick={() => isImage && setLightbox(img.src)}
                            style={{ width: 72, height: 72, borderRadius: 8, overflow: "hidden", border: "1px solid #E2E8F0", cursor: isImage ? "zoom-in" : "default", flexShrink: 0, background: "#F7FAFC", display: "flex", alignItems: "center", justifyContent: "center" }}
                          >
                            {isImage
                              ? <img src={img.src} alt={img.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                              : <div style={{ textAlign: "center", fontSize: 22 }}>{fileIcons[ext] || "📎"}<div style={{ fontSize: 9, color: "#718096", marginTop: 2 }}>{ext}</div></div>
                            }
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <div style={{ height: 1, background: "#EDF2F7", marginTop: 12 }} />
                </div>
              ))}

              {/* SKU attachments */}
              {skuAttachments > 0 && (
                <div style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#1A202C", marginBottom: 8 }}>👕 SKU Images</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {skus.flatMap(s => (s.images || []).map((img, i) => (
                      <div
                        key={`${s.styleNum}-${i}`}
                        onClick={() => setLightbox(img.src)}
                        style={{ width: 72, height: 72, borderRadius: 8, overflow: "hidden", border: "1px solid #E2E8F0", cursor: "zoom-in", flexShrink: 0 }}
                      >
                        <img src={img.src} alt={img.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                      </div>
                    )))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Lightbox */}
      {lightbox && (
        <div onClick={() => setLightbox(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.9)", zIndex: 10000, display: "flex", alignItems: "center", justifyContent: "center", cursor: "zoom-out" }}>
          <img src={lightbox} alt="" style={{ maxWidth: "90vw", maxHeight: "90vh", borderRadius: 10, objectFit: "contain" }} onClick={e => e.stopPropagation()} />
          <button onClick={() => setLightbox(null)} style={{ position: "fixed", top: 20, right: 20, background: "rgba(255,255,255,0.15)", border: "none", color: "#fff", width: 36, height: 36, borderRadius: "50%", fontSize: 18, cursor: "pointer" }}>✕</button>
        </div>
      )}
    </>
  );
}



export { ImageGalleryModal, CollImageBtn };
export default ImageGalleryModal;

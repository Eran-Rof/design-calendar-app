import React, { useState, useRef, useEffect } from "react";
import { TH } from "../utils/theme";
import { S } from "../utils/styles";
import { uid } from "../utils/dates";
import { fileToDataURL, dbxUploadFileGlobal } from "../utils/helpers";

function ImageUploader({ images = [], onChange, label = "Attachments" }: {
  images?: any[];
  onChange: (imgs: any[]) => void;
  label?: string;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const focusStealRef = useRef<HTMLButtonElement>(null);
  const [urlInput, setUrlInput] = useState("");
  const [draggingOver, setDraggingOver] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);

  const [uploading, setUploading] = useState(false);
  const [, setImgTick] = useState(0);
  useEffect(() => {
    const hasDel = images.some((i: any) => i.deleted_at);
    if (!hasDel) return;
    const t = setInterval(() => setImgTick(c => c + 1), 1000);
    // Purge expired (>24h) on each tick
    const now = Date.now();
    const expired = images.filter((i: any) => i.deleted_at && now - new Date(i.deleted_at).getTime() > 24 * 60 * 60 * 1000);
    if (expired.length > 0) {
      // Delete from Dropbox in background
      expired.forEach((img: any) => {
        if (img.src && img.type === "dropbox") {
          console.log("[Dropbox] Permanently deleting expired image:", img.name);
        }
      });
      onChange(images.filter((i: any) => !expired.some((e: any) => e.id === i.id)));
    }
    return () => clearInterval(t);
  }, [images]);
  const [uploadingCount, setUploadingCount] = useState(0);
  // Keep a ref to track pending uploads so we can update the parent correctly
  const pendingImagesRef = useRef<any[]>([]);

  async function handleFiles(files: File[]) {
    const validFiles = Array.from(files).filter((f: File) =>
      f.type.startsWith("image/") || f.name.match(/\.(pdf|ai|eps|psd|png|jpg|jpeg|gif|webp|svg)$/i)
    );
    if (!validFiles.length) return;

    // Step 1: immediately add placeholders so user can keep working
    const newImgs: any[] = [];
    for (const f of validFiles) {
      const isImg = f.type.startsWith("image/");
      const preview = isImg ? await fileToDataURL(f) : null;
      newImgs.push({ id: uid(), src: preview || "", name: f.name, type: "uploading", file: f });
    }

    const combined = [...images, ...newImgs];
    pendingImagesRef.current = combined;
    onChange(combined);
    if (fileRef.current) fileRef.current.value = "";
    setUploadingCount(c => c + newImgs.length);

    // Step 2: upload each file to Dropbox in the background
    for (const img of newImgs) {
      (async () => {
        try {
          const dbxUrl = await dbxUploadFileGlobal(img.file, "images");
          // Update the ref and call onChange with a plain array (no function updater)
          pendingImagesRef.current = pendingImagesRef.current.map((i: any) =>
            i.id === img.id
              ? { id: i.id, src: dbxUrl || i.src, name: i.name, type: dbxUrl ? "dropbox" : "base64" }
              : i
          );
          onChange(pendingImagesRef.current);
        } catch (e) {
          console.warn("Background upload error:", e);
          // On error, mark as base64 (already has preview)
          pendingImagesRef.current = pendingImagesRef.current.map((i: any) =>
            i.id === img.id ? { ...i, type: "base64", file: undefined } : i
          );
          onChange(pendingImagesRef.current);
        } finally {
          setUploadingCount(c => Math.max(0, c - 1));
        }
      })();
    }
  }
  function addUrl() {
    if (!urlInput.trim()) return;
    onChange([
      ...images,
      { id: uid(), src: urlInput.trim(), name: "URL Image" },
    ]);
    setUrlInput("");
  }
  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDraggingOver(true);
  }
  function onDragLeave(e: React.DragEvent) {
    e.preventDefault();
    setDraggingOver(false);
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDraggingOver(false);
    // Immediately steal focus back from the OS file manager
    // by focusing a real DOM element synchronously before any async work
    if (focusStealRef.current) {
      focusStealRef.current.focus();
      focusStealRef.current.blur();
    }
    const files = Array.from(e.dataTransfer.files) as File[];
    if (files.length) handleFiles(files);
  }
  return (
    <div style={{ marginBottom: 16 }}>
      {/* Hidden button used to steal focus back from OS file manager after drag-drop */}
      <button
        ref={focusStealRef}
        style={{
          position: "absolute",
          opacity: 0,
          pointerEvents: "none",
          width: 0,
          height: 0,
          padding: 0,
          border: "none",
        }}
        tabIndex={-1}
        aria-hidden="true"
      />
      <label style={S.lbl}>{label}</label>
      {images.length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            marginBottom: 10,
          }}
        >
          {images.map((img: any) => {
            const isImage = img.name?.match(/\.(png|jpg|jpeg|gif|webp|svg)$/i) || img.src?.startsWith("data:image");
            const ext = (img.name || "").split(".").pop()?.toUpperCase() || "FILE";
            const fileIcons: Record<string, string> = { PDF: "📄", AI: "🎨", EPS: "🎨", PSD: "🖼️", SVG: "🔷" };
            const icon = fileIcons[ext] || "📎";
            return (
            <div
              key={img.id}
              style={{ position: "relative", width: 80, height: 80 }}
            >
              {img.deleted_at ? (() => {
                const msLeft = 24 * 60 * 60 * 1000 - (Date.now() - new Date(img.deleted_at).getTime());
                if (msLeft <= 0) return null;
                const h = Math.floor(msLeft / 3600000); const mn = Math.floor((msLeft % 3600000) / 60000); const sc = Math.floor((msLeft % 60000) / 1000);
                return (
                  <div style={{ width: "100%", height: "100%", borderRadius: 8, border: "1px dashed #EF444466", background: "#0F172A", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", position: "relative", overflow: "hidden" }}>
                    <div style={{ fontSize: 11, fontWeight: 800, fontFamily: "monospace", color: "#10B981", textShadow: "0 0 8px #10B98166", letterSpacing: 1, marginBottom: 4 }}>{h.toString().padStart(2,"0")}:{mn.toString().padStart(2,"0")}:{sc.toString().padStart(2,"0")}</div>
                    <button onClick={() => onChange(images.map((i: any) => i.id === img.id ? (() => { const r = { ...i }; delete r.deleted_at; return r; })() : i))}
                      style={{ padding: "2px 8px", borderRadius: 4, border: "none", background: "#F59E0B", color: "#fff", fontSize: 9, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>↩ Undo</button>
                  </div>
                );
              })() : isImage ? (
              <div style={{ position: "relative", width: "100%", height: "100%", cursor: img.type !== "uploading" ? "zoom-in" : "default" }} onClick={() => img.type !== "uploading" && setLightbox(img.src)}>
                <img
                  src={img.src}
                  alt={img.name}
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                    borderRadius: 8,
                    border: `1px solid ${TH.border}`,
                    opacity: img.type === "uploading" ? 0.4 : 1,
                  }}
                />
                {img.type === "uploading" && (
                  <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 8, fontSize: 16 }}>⏳</div>
                )}
              </div>
              ) : img.type === "uploading" ? (
              <div style={{ width: "100%", height: "100%", borderRadius: 8, border: `1px solid ${TH.border}`, display: "flex", alignItems: "center", justifyContent: "center", background: TH.surfaceHi, fontSize: 20 }}>⏳</div>
              ) : (
              <a href={img.src} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
                <div style={{
                  width: "100%", height: "100%", borderRadius: 8,
                  border: `1px solid ${TH.border}`, display: "flex",
                  flexDirection: "column", alignItems: "center", justifyContent: "center",
                  background: TH.surfaceHi, cursor: "pointer", fontSize: 24,
                }}>
                  <div>{icon}</div>
                  <div style={{ fontSize: 9, color: TH.textMuted, marginTop: 2 }}>{ext}</div>
                </div>
              </a>
              )}
              {img.deleted_at ? null : (
              <button
                onClick={() => {
                  // Soft delete: mark with timestamp instead of removing
                  onChange(images.map((i: any) => i.id === img.id ? { ...i, deleted_at: new Date().toISOString() } : i));
                }}
                style={{
                  position: "absolute",
                  top: -6,
                  right: -6,
                  width: 18,
                  height: 18,
                  borderRadius: "50%",
                  background: "#FEF2F2",
                  border: "none",
                  color: "#B91C1C",
                  fontSize: 12,
                  lineHeight: "18px",
                  cursor: "pointer",
                  textAlign: "center",
                }}
              >
                ×
              </button>
              )}
            </div>
            );
          })}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <input
          style={{ ...S.inp, marginBottom: 0, flex: 1 }}
          placeholder="Paste image URL..."
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addUrl()}
        />
        <button
          onClick={addUrl}
          style={{
            padding: "9px 14px",
            borderRadius: 8,
            border: `1px solid ${TH.border}`,
            background: TH.surfaceHi,
            color: TH.text,
            cursor: "pointer",
            fontFamily: "inherit",
            fontSize: 13,
            fontWeight: 600,
            whiteSpace: "nowrap",
          }}
        >
          Add URL
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*,.pdf,.ai,.eps,.psd,.svg"
        multiple
        style={{ display: "none" }}
        onChange={(e) => handleFiles(Array.from(e.target.files || []) as File[])}
      />
      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        style={{
          width: "100%",
          padding: "18px",
          borderRadius: 8,
          border: `2px dashed ${draggingOver ? TH.primary : TH.border}`,
          background: draggingOver ? TH.primary + "08" : "transparent",
          color: draggingOver ? TH.primary : TH.textMuted,
          cursor: "pointer",
          fontFamily: "inherit",
          fontSize: 13,
          textAlign: "center",
          transition: "all 0.15s",
        }}
        onClick={() => fileRef.current?.click()}
      >
        {draggingOver ? "Drop files here" : "📁 Upload or Drag & Drop (Images, PDF, AI, PSD)"}
      </div>
      {uploadingCount > 0 && (
        <div style={{ fontSize: 11, color: TH.primary, marginTop: 6, textAlign: "center", display: "flex", alignItems: "center", gap: 6, justifyContent: "center" }}>
          <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: TH.primary, animation: "pulse 1s infinite" }} />
          Uploading {uploadingCount} file{uploadingCount > 1 ? "s" : ""} to Dropbox in background…
        </div>
      )}

      {/* Lightbox */}
      {lightbox && (
        <div
          onClick={() => setLightbox(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", cursor: "zoom-out" }}
        >
          <img
            src={lightbox}
            alt="Preview"
            style={{ maxWidth: "90vw", maxHeight: "90vh", borderRadius: 12, boxShadow: "0 20px 60px rgba(0,0,0,0.5)", objectFit: "contain" }}
            onClick={e => e.stopPropagation()}
          />
          <button
            onClick={() => setLightbox(null)}
            style={{ position: "fixed", top: 20, right: 20, background: "rgba(255,255,255,0.1)", border: "none", color: "#fff", width: 36, height: 36, borderRadius: "50%", fontSize: 18, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
          >✕</button>
        </div>
      )}
    </div>
  );
}

export default ImageUploader;

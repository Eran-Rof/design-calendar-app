import React from "react";
import S from "../styles";
import type { DetailPanelCtx } from "../detailPanel";

/**
 * Attachments tab body. Handles upload (with duplicate detection), display
 * with file-type icons, soft-delete with countdown + undo, and download.
 */
export function AttachmentsTab({ ctx }: { ctx: DetailPanelCtx }): React.ReactElement | null {
  const {
    selected, detailMode, attachments, uploadingAttachment, setUploadingAttachment,
    setConfirmModal, deleteAttachment, undoDeleteAttachment, uploadAttachment,
    loadAttachments, addHistory,
  } = ctx;

  if (!selected) return null;
  if (!(detailMode === "attachments" || detailMode === "all")) return null;

  const pn = selected.PoNumber ?? "";
  const files = attachments[pn] || [];
  const fmtSize = (b: number) => b < 1024 ? b + " B" : b < 1048576 ? (b / 1024).toFixed(1) + " KB" : (b / 1048576).toFixed(1) + " MB";
  const getFileIcon = (type: string, name: string) => {
    const ext = name.split(".").pop()?.toLowerCase() || "";
    if (type.includes("pdf") || ext === "pdf") return { bg: "#DC2626", label: "PDF" };
    if (type.includes("sheet") || type.includes("excel") || ext === "xlsx" || ext === "xls" || ext === "csv") return { bg: "#16A34A", label: "XLS" };
    if (type.includes("word") || type.includes("doc") || ext === "docx" || ext === "doc") return { bg: "#2563EB", label: "DOC" };
    if (type.includes("presentation") || type.includes("powerpoint") || ext === "pptx" || ext === "ppt") return { bg: "#D97706", label: "PPT" };
    if (ext === "zip" || ext === "rar" || ext === "7z") return { bg: "#7C3AED", label: "ZIP" };
    if (ext === "txt" || ext === "rtf") return { bg: "#6B7280", label: "TXT" };
    return { bg: "#475569", label: ext.toUpperCase().slice(0, 3) || "FILE" };
  };

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={S.sectionLabel}>Attachments ({files.filter(f => !(f as any).deleted_at).length})</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {uploadingAttachment && <span style={{ fontSize: 12, color: "#F59E0B" }}>Uploading…</span>}
          <input id="po-attach-input" type="file" multiple accept="*/*" style={{ display: "none" }} onChange={async e => {
            const fileList = e.target.files; if (!fileList || fileList.length === 0) return;
            setUploadingAttachment(true);
            const existingFiles = (attachments[pn] || []).filter((f: any) => !(f as any).deleted_at);
            const names: string[] = [];
            for (let i = 0; i < fileList.length; i++) {
              const file = fileList[i];
              const duplicate = existingFiles.find((f: any) => f.name === file.name);
              let uploadFile = file;
              if (duplicate) {
                const action = await new Promise<"replace" | "add" | "skip">(resolve => {
                  setConfirmModal({
                    title: "File Already Exists",
                    message: `"${file.name}" already exists in this PO's attachments.`,
                    icon: "📎",
                    confirmText: "Replace",
                    confirmColor: "#EF4444",
                    cancelText: "Add Version",
                    onConfirm: () => resolve("replace"),
                    onCancel: () => resolve("add"),
                  });
                });
                if (action === "replace") {
                  await deleteAttachment(pn, duplicate.id);
                } else {
                  const baseName = file.name.replace(/\.[^.]+$/, "");
                  const ext = file.name.includes(".") ? "." + file.name.split(".").pop() : "";
                  const cleanBase = baseName.replace(/ V\d+$/, "");
                  const versionCount = existingFiles.filter((f: any) => {
                    const fBase = f.name.replace(/\.[^.]+$/, "").replace(/ V\d+$/, "");
                    return fBase === cleanBase;
                  }).length;
                  const versionedName = `${cleanBase} V${versionCount + 1}${ext}`;
                  uploadFile = new File([file], versionedName, { type: file.type });
                }
              }
              try {
                await uploadAttachment(pn, uploadFile);
                names.push(uploadFile.name);
              } catch (err) { console.error("Upload error:", err); }
            }
            if (names.length > 0) {
              addHistory(pn, `Attachment${names.length > 1 ? "s" : ""} uploaded: ${names.join(", ")}`);
            }
            await loadAttachments(pn);
            setUploadingAttachment(false);
            e.target.value = "";
          }} />
          <button onClick={() => (document.getElementById("po-attach-input") as HTMLInputElement)?.click()} disabled={uploadingAttachment} style={{ ...S.btnPrimary, fontSize: 11, padding: "6px 14px", width: "auto", opacity: uploadingAttachment ? 0.5 : 1 }}>+ Upload Files</button>
        </div>
      </div>
      {files.length === 0 ? (
        <div style={{ background: "#0F172A", borderRadius: 8, padding: 30, textAlign: "center" }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>📎</div>
          <div style={{ color: "#6B7280", fontSize: 13, marginBottom: 12 }}>No attachments yet</div>
          <button onClick={() => (document.getElementById("po-attach-input") as HTMLInputElement)?.click()} style={{ ...S.btnSecondary, fontSize: 12 }}>Upload your first file</button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {files.map(f => {
            const isDeleted = !!(f as any).deleted_at;
            const timeAgo = f.uploaded_at ? (() => { const ms = Date.now() - new Date(f.uploaded_at).getTime(); const m = Math.floor(ms / 60000); if (m < 60) return `${m}m ago`; const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`; return `${Math.floor(h / 24)}d ago`; })() : "";
            if (isDeleted) {
              const msLeft = 24 * 60 * 60 * 1000 - (Date.now() - new Date((f as any).deleted_at).getTime());
              if (msLeft <= 0) return null;
              const h = Math.floor(msLeft / 3600000); const m = Math.floor((msLeft % 3600000) / 60000); const s = Math.floor((msLeft % 60000) / 1000);
              const countdown = `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
              return (
              <div key={f.id} style={{ position: "relative", display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", background: "#0F172A", borderRadius: 8, border: "1px dashed #EF444444", overflow: "hidden" }}>
                <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1 }}>
                  <span style={{ fontSize: 28, fontWeight: 800, fontFamily: "monospace", color: "#10B981", textShadow: "0 0 12px #10B98166, 0 0 24px #10B98133", letterSpacing: 2 }}>{countdown}</span>
                </div>
                <div style={{ position: "relative", zIndex: 2, flex: 1, display: "flex", alignItems: "center", gap: 12, opacity: 0.5 }}>
                  <span style={{ fontSize: 24, flexShrink: 0 }}>🗑</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, color: "#EF4444", fontWeight: 600, textDecoration: "line-through" }}>{f.name}</div>
                  </div>
                </div>
                <button onClick={() => undoDeleteAttachment(pn, f.id)}
                  style={{ position: "relative", zIndex: 2, padding: "8px 18px", borderRadius: 8, border: "none", background: "linear-gradient(135deg, #F59E0B, #D97706)", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", flexShrink: 0, boxShadow: "0 2px 8px rgba(245,158,11,0.3)" }}>↩ Undo</button>
              </div>
              );
            }
            return (
              <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", background: "#0F172A", borderRadius: 8, border: "1px solid #334155" }}>
                {f.type.startsWith("image/") && f.url ? (
                  <img src={f.url} alt="" style={{ width: 44, height: 44, borderRadius: 6, objectFit: "cover", flexShrink: 0, border: "1px solid #334155" }} />
                ) : (
                  <div style={{ width: 44, height: 44, borderRadius: 6, background: getFileIcon(f.type, f.name).bg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <span style={{ color: "#fff", fontSize: 11, fontWeight: 800, letterSpacing: 0.5 }}>{getFileIcon(f.type, f.name).label}</span>
                  </div>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <a href={f.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, color: "#60A5FA", fontWeight: 600, textDecoration: "none", display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                    onMouseEnter={e => e.currentTarget.style.textDecoration = "underline"} onMouseLeave={e => e.currentTarget.style.textDecoration = "none"}>{f.name}</a>
                  <div style={{ fontSize: 11, color: "#6B7280" }}>{fmtSize(f.size)} · {f.uploaded_by} · {timeAgo}</div>
                </div>
                <button onClick={e => { e.stopPropagation(); setConfirmModal({ title: "Delete Attachment", message: `Delete "${f.name}"? You'll have 24 hours to undo.`, icon: "🗑", confirmText: "Delete", confirmColor: "#EF4444", onConfirm: () => deleteAttachment(pn, f.id) }); }}
                  style={{ background: "none", border: "1px solid #EF444444", color: "#EF4444", borderRadius: 6, padding: "4px 8px", fontSize: 10, cursor: "pointer", fontFamily: "inherit", flexShrink: 0 }}>✕</button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

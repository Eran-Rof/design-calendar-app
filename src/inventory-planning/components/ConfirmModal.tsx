// PO WIP-style confirm modal. Icon + title + message + Cancel/Confirm.
// Mirrors src/TandA.tsx (lines ~1548–1571) so destructive actions in
// planning share the same visual language as the rest of the app.

export interface ConfirmModalProps {
  icon: string;
  title: string;
  message: string;
  listItems?: string[];
  confirmText?: string;
  cancelText?: string;
  // One of the app palette colors: red for destructive, accent for neutral.
  confirmColor?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmModal({
  icon, title, message, listItems,
  confirmText = "Confirm", cancelText = "Cancel",
  confirmColor = "#EF4444",
  onConfirm, onCancel,
}: ConfirmModalProps) {
  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={onCancel}
    >
      <div
        style={{ background: "#1E293B", borderRadius: 16, width: 420, border: `1px solid ${confirmColor}44`, boxShadow: "0 24px 64px rgba(0,0,0,0.5)", overflow: "hidden" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ background: `${confirmColor}15`, padding: "20px 24px", borderBottom: "1px solid #334155", display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: `${confirmColor}22`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>{icon}</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#F1F5F9" }}>{title}</div>
        </div>
        <div style={{ padding: "20px 24px" }}>
          <p style={{ color: "#D1D5DB", fontSize: 14, margin: "0 0 12px", lineHeight: 1.6 }}>{message}</p>
          {listItems && listItems.length > 0 && (
            <div style={{ background: "#0F172A", borderRadius: 8, padding: "8px 12px", marginBottom: 16, maxHeight: 160, overflowY: "auto" }}>
              {listItems.map((it) => (
                <div key={it} style={{ fontSize: 12, color: "#60A5FA", fontFamily: "monospace", padding: "2px 0", borderBottom: "1px solid #1E293B" }}>{it}</div>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 10, marginTop: listItems ? 0 : 8 }}>
            <button onClick={onCancel} style={{ flex: 1, padding: "10px 20px", borderRadius: 8, border: "1px solid #334155", background: "none", color: "#94A3B8", cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 600 }}>
              {cancelText}
            </button>
            <button onClick={onConfirm} style={{ flex: 1, padding: "10px 20px", borderRadius: 8, border: "none", background: `linear-gradient(135deg, ${confirmColor}, ${confirmColor}CC)`, color: "#fff", cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 700 }}>
              {confirmText}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

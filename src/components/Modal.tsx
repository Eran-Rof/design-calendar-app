import React from "react";
import { TH } from "../utils/theme";
import { S } from "../utils/styles";

export function Modal({ title, onClose, children, wide, extraWide }: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
  extraWide?: boolean;
}) {
  const mw = extraWide ? 980 : wide ? 740 : 540;
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        backdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 16,
      }}
    >
      <div
        style={{
          background: TH.surface,
          border: `1px solid ${TH.border}`,
          borderRadius: 18,
          padding: 0,
          width: "100%",
          maxWidth: mw,
          maxHeight: "93vh",
          overflowY: "auto",
          boxShadow: `0 40px 100px rgba(0,0,0,0.4)`,
          display: "flex",
          flexDirection: "column",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "22px 32px 18px",
            position: "sticky",
            top: 0,
            background: TH.surface,
            zIndex: 10,
            borderRadius: "18px 18px 0 0",
            borderBottom: `1px solid ${TH.border}`,
          }}
        >
          <span
            style={{
              fontSize: 19,
              fontWeight: 700,
              color: TH.text,
              letterSpacing: "0.02em",
            }}
          >
            {title}
          </span>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: TH.textMuted,
              cursor: "pointer",
              fontSize: 26,
              lineHeight: 1,
              padding: 4,
            }}
          >
            ×
          </button>
        </div>
        <div style={{ padding: "28px 32px 32px", flex: 1 }}>
          {children}
        </div>
      </div>
    </div>
  );
}

export function ConfirmModal({
  title,
  message,
  onConfirm,
  onCancel,
  confirmLabel = "Accept",
  danger,
}: {
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirmLabel?: string;
  danger?: boolean;
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 2000,
        padding: 16,
      }}
    >
      <div
        style={{
          background: TH.surface,
          border: `1px solid ${danger ? "#FCA5A5" : TH.border}`,
          borderRadius: 16,
          padding: 32,
          maxWidth: 440,
          width: "100%",
          boxShadow: `0 40px 100px rgba(0,0,0,0.4)`,
        }}
      >
        <div
          style={{
            fontSize: 18,
            fontWeight: 700,
            color: TH.text,
            marginBottom: 12,
          }}
        >
          {title}
        </div>
        <div
          style={{
            fontSize: 13,
            color: TH.textMuted,
            lineHeight: 1.6,
            marginBottom: 28,
          }}
          dangerouslySetInnerHTML={{ __html: message }}
        />
        <div style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
          <button
            onClick={onCancel}
            style={{
              padding: "10px 20px",
              borderRadius: 8,
              border: `1px solid ${TH.border}`,
              background: "none",
              color: TH.textMuted,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            style={{
              padding: "10px 24px",
              borderRadius: 8,
              border: "none",
              background: danger
                ? `linear-gradient(135deg,#C0392B,#E74C3C)`
                : S.btn.background,
              color: "#fff",
              fontWeight: 700,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default Modal;

// src/tanda/components/LineViewToggle.tsx
//
// Small ▦ Matrix / ☰ List segmented toggle used on document detail line
// sections (RMA returns, AR/AP invoices) to switch the lines between the
// editable/flat list and the read-only color × size matrix.

export type LineView = "list" | "matrix";

const C = {
  cardBdr: "#334155",
  text: "#F1F5F9",
  textMuted: "#94A3B8",
  primary: "#3B82F6",
};

export default function LineViewToggle({
  value, onChange,
}: {
  value: LineView;
  onChange: (v: LineView) => void;
}) {
  const btn = (active: boolean): React.CSSProperties => ({
    background: active ? C.primary : "transparent",
    color: active ? "white" : C.textMuted,
    border: `1px solid ${active ? C.primary : C.cardBdr}`,
    padding: "4px 10px", fontSize: 12, cursor: "pointer", fontWeight: 600,
  });
  return (
    <div role="group" aria-label="Line view" style={{ display: "inline-flex", borderRadius: 6, overflow: "hidden" }}>
      <button
        type="button"
        onClick={() => onChange("list")}
        aria-pressed={value === "list"}
        style={{ ...btn(value === "list"), borderTopLeftRadius: 6, borderBottomLeftRadius: 6, borderRight: 0 }}
        title="List view"
      >
        ☰ List
      </button>
      <button
        type="button"
        onClick={() => onChange("matrix")}
        aria-pressed={value === "matrix"}
        style={{ ...btn(value === "matrix"), borderTopRightRadius: 6, borderBottomRightRadius: 6 }}
        title="Color × size matrix view"
      >
        ▦ Matrix
      </button>
    </div>
  );
}

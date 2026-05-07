// Faded "last upload: …" caption that hangs below an upload button
// without affecting its layout. Originally inline in the planning
// workbench (under "Upload item master (Excel)" / "Upload sales
// (Excel)"); extracted here so ATS, tanda, and any future upload
// surface can drop in the same visual without copying the absolute-
// positioning quirk.
//
// Usage (caller manages the ISO timestamp + localStorage):
//
//   <span style={{ position: "relative", display: "inline-flex" }}>
//     <button>Upload …</button>
//     <LastUploadStamp iso={lastUploadMaster} color={PAL.accent2} />
//   </span>
//
// The wrapper MUST be position: relative — the stamp positions itself
// against it via top: 100%. pointerEvents are off so the caption
// never intercepts clicks on the button or the row below it.

interface LastUploadStampProps {
  // ISO timestamp string from localStorage; null when no upload has
  // happened yet (caption renders nothing in that case).
  iso: string | null;
  // Optional tint hex. Defaults to a muted slate. Pass a brand color
  // (green for reference data, blue for transactional) so the
  // caption signals which feed it belongs to at a glance.
  color?: string;
}

export default function LastUploadStamp({ iso, color }: LastUploadStampProps) {
  if (!iso) return null;
  const formatted = formatLastUpload(iso);
  return (
    <span
      style={{
        position: "absolute",
        top: "100%",
        left: 0,
        right: 0,
        marginTop: 2,
        color: color ?? "#6B7280",
        fontSize: 10,
        opacity: 0.7,
        textAlign: "center",
        whiteSpace: "nowrap",
        pointerEvents: "none",
      }}
    >
      last upload: {formatted}
    </span>
  );
}

// "May 6, 7:45 PM" — short and parseable. Falls back to the raw ISO
// if Date.parse can't read it (shouldn't happen, but safe).
function formatLastUpload(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// Codec for the structured note marker stamped on every future-demand
// request. The marker preserves the planner's actual intent (cat,
// subcat, style, color, description) so the UI and build pipeline
// can render the row correctly even when the request's sku_id is an
// FK fallback (the table requires a real sku_id, but planner-typed
// fields like new colors / TBD styles don't have one yet).
//
// Format: `[<TAG> key1=val1|key2=val2|…] <user-note>`
// Tag: "TBD" when style or color is "TBD", else "REQ". Tag is purely
// cosmetic now — the build pipeline routes by meta.color, not tag.

export type RequestNoteTag = "TBD" | "REQ";

export interface RequestNoteMeta {
  cat?: string;
  subcat?: string;
  style?: string;
  color?: string;
  desc?: string;
}

export interface ParsedRequestNote {
  tag: RequestNoteTag | null;
  meta: RequestNoteMeta;
  body: string;
}

export function parseRequestNote(note: string | null | undefined): ParsedRequestNote {
  const raw = (note ?? "").trim();
  if (!raw) return { tag: null, meta: {}, body: "" };
  const m = raw.match(/^\[(TBD|REQ)\s+([^\]]+)\]\s*(.*)$/);
  if (m) {
    const meta: RequestNoteMeta = {};
    for (const pair of m[2].split("|")) {
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      (meta as Record<string, string>)[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    return { tag: m[1] as RequestNoteTag, meta, body: (m[3] ?? "").trim() };
  }
  // Legacy pre-pipe format from earlier commits — kept so old rows
  // still render with the right metadata.
  const old = raw.match(/^\[TBD style=([^ ]+) color=([^ ]+) desc=([^\]]+)\]\s*(.*)$/);
  if (old) return { tag: "TBD", meta: { style: old[1], color: old[2], desc: old[3] }, body: (old[4] ?? "").trim() };
  return { tag: null, meta: {}, body: raw };
}

export function buildRequestNote(meta: RequestNoteMeta, body: string, opts?: { tag?: RequestNoteTag }): string {
  const styleTbd = !!meta.style && meta.style.toUpperCase() === "TBD";
  const colorTbd = !!meta.color && meta.color.toUpperCase() === "TBD";
  const tag = opts?.tag ?? (styleTbd || colorTbd ? "TBD" : "REQ");
  const parts: string[] = [];
  if (meta.cat) parts.push(`cat=${meta.cat}`);
  if (meta.subcat) parts.push(`subcat=${meta.subcat}`);
  if (meta.style) parts.push(`style=${meta.style}`);
  if (meta.color) parts.push(`color=${meta.color}`);
  if (meta.desc) parts.push(`desc=${meta.desc}`);
  const head = `[${tag} ${parts.join("|")}]`;
  const trimmed = body.trim();
  return trimmed ? `${head} ${trimmed}` : head;
}

// api/_lib/edi/parser.js
//
// Minimal X12 EDI parser. Detects delimiters from the ISA header
// (element sep at byte 3, component sep at byte 104, segment terminator
// at byte 105) and splits the envelope into ISA → GS → ST groups.
//
// Exports:
//   parseEnvelope(raw) → { isa, groups: [{ gs, transactions: [{ st, segments }] }] }
//   segmentsByTag(segments, tag) → array of segments matching tag
//   el(segment, idx) → element at 1-based index (0 = segment tag)
//
// This is deliberately tolerant — EDI partners vary in formatting. It
// does NOT enforce X12 grammar; downstream mappers verify required
// segments per transaction type.

const DEFAULT_ELEMENT_SEP = "*";
const DEFAULT_COMPONENT_SEP = ">";
const DEFAULT_SEGMENT_TERM = "~";

function detectDelimiters(raw) {
  if (!raw || raw.length < 106) return { element: DEFAULT_ELEMENT_SEP, component: DEFAULT_COMPONENT_SEP, segment: DEFAULT_SEGMENT_TERM };
  if (!/^ISA/i.test(raw)) return { element: DEFAULT_ELEMENT_SEP, component: DEFAULT_COMPONENT_SEP, segment: DEFAULT_SEGMENT_TERM };
  const element = raw[3] || DEFAULT_ELEMENT_SEP;
  const component = raw[104] || DEFAULT_COMPONENT_SEP;
  let segment = raw[105] || DEFAULT_SEGMENT_TERM;
  // If segment terminator is CR/LF or whitespace, keep it; otherwise use the char.
  return { element, component, segment };
}

function splitSegments(raw, segTerm) {
  // Tolerate optional CR/LF after segment terminator.
  const normalized = raw.replace(new RegExp(`${escapeRegex(segTerm)}\\s*`, "g"), segTerm);
  return normalized.split(segTerm).map((s) => s.trim()).filter((s) => s.length > 0);
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

export function parseEnvelope(raw) {
  const delims = detectDelimiters(raw);
  const rawSegments = splitSegments(raw, delims.segment);
  const segments = rawSegments.map((s) => s.split(delims.element));

  let isa = null;
  const groups = [];
  let currentGroup = null;
  let currentTxn = null;

  for (const segment of segments) {
    const tag = (segment[0] || "").toUpperCase();
    if (tag === "ISA") { isa = segment; continue; }
    if (tag === "GS") {
      currentGroup = { gs: segment, transactions: [] };
      groups.push(currentGroup);
      continue;
    }
    if (tag === "ST") {
      currentTxn = { st: segment, segments: [] };
      if (currentGroup) currentGroup.transactions.push(currentTxn);
      continue;
    }
    if (tag === "SE") {
      if (currentTxn) currentTxn.segments.push(segment);
      currentTxn = null;
      continue;
    }
    if (tag === "GE") { currentGroup = null; continue; }
    if (tag === "IEA") continue;
    if (currentTxn) currentTxn.segments.push(segment);
  }

  return { delims, isa, groups };
}

export function segmentsByTag(segments, tag) {
  const t = tag.toUpperCase();
  return segments.filter((s) => (s[0] || "").toUpperCase() === t);
}

export function el(segment, idx) {
  if (!segment) return "";
  return segment[idx] || "";
}

export function interchangeControl(isa) {
  if (!isa) return { sender: "", receiver: "", controlNumber: "", version: "" };
  return {
    sender:        (el(isa, 6) || "").trim(),
    receiver:      (el(isa, 8) || "").trim(),
    controlNumber: (el(isa, 13) || "").trim(),
    version:       (el(isa, 12) || "").trim(),
  };
}

export function groupControl(gs) {
  if (!gs) return { functionalId: "", sender: "", receiver: "", controlNumber: "", version: "" };
  return {
    functionalId:  el(gs, 1),
    sender:        el(gs, 2),
    receiver:      el(gs, 3),
    controlNumber: el(gs, 6),
    version:       el(gs, 8),
  };
}

export function transactionControl(st) {
  if (!st) return { transactionSet: "", controlNumber: "" };
  return { transactionSet: el(st, 1), controlNumber: el(st, 2) };
}

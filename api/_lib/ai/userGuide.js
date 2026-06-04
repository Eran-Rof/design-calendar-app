// api/_lib/ai/userGuide.js
//
// Keyword search over the bundled Tangerine user-guide snapshot
// (userGuideContent.js). Backs the Ask AI `search_user_guide` tool so the
// assistant can answer "how do I…" / "where is…" / "what does X mean" from the
// actual operator documentation instead of guessing.
//
// Deliberately simple (no embeddings): split each chapter on its ## / ###
// headings into sections, score sections by query-term frequency, and return
// the top few trimmed excerpts. Good enough for a 40-chapter guide and keeps the
// tool result well under the handler's 16 KB cap.

import { USER_GUIDE } from "./userGuideContent.js";

const STOP = new Set([
  "the", "and", "for", "are", "but", "not", "you", "your", "with", "this", "that",
  "how", "what", "where", "when", "does", "can", "from", "into", "any", "all", "has",
  "have", "use", "used", "via", "per", "out", "get", "got", "set", "see", "a", "an",
  "is", "in", "on", "of", "to", "do", "i", "it", "or", "be", "by",
]);

function terms(q) {
  return [...new Set(String(q || "").toLowerCase().match(/[a-z0-9_]+/g) || [])]
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

// Split a chapter into { heading, body } sections on markdown headings.
function sections(chapter) {
  const lines = chapter.text.split("\n");
  const out = [];
  let heading = chapter.title;
  let buf = [];
  const flush = () => {
    const body = buf.join("\n").trim();
    if (body) out.push({ heading, body });
    buf = [];
  };
  for (const ln of lines) {
    const h = ln.match(/^#{1,4}\s+(.+)$/);
    if (h) { flush(); heading = h[1].trim(); } else { buf.push(ln); }
  }
  flush();
  return out.length ? out : [{ heading: chapter.title, body: chapter.text }];
}

function excerpt(body, ts, max = 700) {
  if (body.length <= max) return body;
  // Centre the window on the first term hit.
  const lc = body.toLowerCase();
  let at = -1;
  for (const t of ts) { const i = lc.indexOf(t); if (i >= 0 && (at < 0 || i < at)) at = i; }
  if (at < 0) return body.slice(0, max) + "…";
  const start = Math.max(0, at - Math.floor(max / 3));
  return (start > 0 ? "…" : "") + body.slice(start, start + max) + (start + max < body.length ? "…" : "");
}

export function searchUserGuide({ query, max_sections = 4 } = {}) {
  const ts = terms(query);
  if (!ts.length) {
    return { error: "Empty or too-generic query — pass specific keywords (e.g. 'how to post a journal entry')." };
  }
  const limit = Math.min(Math.max(1, Number(max_sections) || 4), 6);
  const scored = [];
  for (const ch of USER_GUIDE) {
    for (const sec of sections(ch)) {
      const hay = (sec.heading + "\n" + sec.body).toLowerCase();
      let score = 0;
      for (const t of ts) {
        const n = hay.split(t).length - 1;
        if (n) score += n + (sec.heading.toLowerCase().includes(t) ? 3 : 0);
      }
      if (score > 0) scored.push({ chapter: ch.file, chapter_title: ch.title, heading: sec.heading, score, body: sec.body });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit).map((s) => ({
    chapter: s.chapter,
    chapter_title: s.chapter_title,
    heading: s.heading,
    excerpt: excerpt(s.body, ts),
  }));
  if (!top.length) return { matches: [], note: "No matching section in the user guide for those terms." };
  return { matches: top, searched_terms: ts };
}

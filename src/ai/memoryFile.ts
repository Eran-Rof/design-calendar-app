// Memory-file generator for Tier 3L (Ask AI ↔ memory-tree closed loop).
//
// Builds the standard Claude Code memory-file shape (frontmatter +
// body) from an operator-captured fact so they can drop it into
// ~/.claude/projects/-Users-eranbitton/memory/. The fact ALSO lives
// in ip_ai_user_facts (Tier 2H) — the .md file is the parallel
// representation for the IDE-side Claude agent.
//
// Why dual-write instead of true bidirectional sync: the local memory
// tree is on the operator's machine, not reachable from server code.
// MVP captures into BOTH at the point of operator intent ("save this");
// a future local CLI tool can reconcile drift.

/** Lowercase slug suitable for a filename — alnum + underscore only. */
export function slugify(input: string, maxLen = 60): string {
  const cleaned = String(input || "")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  return cleaned.slice(0, maxLen) || "fact";
}

/** Strip leading/trailing whitespace from each line + collapse trailing blank lines. */
export function normaliseBody(body: string): string {
  return String(body || "")
    .split("\n")
    .map(l => l.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n+$/g, "")
    .trim();
}

/** First sentence (or first 120 chars) of `body` — used as the memory's `description:`. */
export function summariseForDescription(body: string, maxLen = 120): string {
  const normalised = normaliseBody(body).replace(/\s+/g, " ");
  if (!normalised) return "";
  const sentenceEnd = normalised.search(/[.!?]\s/);
  const candidate = sentenceEnd > 0 ? normalised.slice(0, sentenceEnd + 1) : normalised;
  return candidate.length > maxLen ? candidate.slice(0, maxLen - 1).trimEnd() + "…" : candidate;
}

export interface MemoryFileInput {
  topic: string;
  fact: string;
  scope?: "self" | "global";
  app?: string | null;
  createdBy?: string | null;
}

export interface MemoryFile {
  filename: string;
  content: string;
}

/**
 * Build a memory-file representation of an operator-captured Ask AI fact.
 *
 * Filename pattern: `project_ai_fact_<slug>.md` — matches existing
 * convention in the memory tree (project_xxx.md / feedback_xxx.md).
 * Frontmatter `type: project` because these are operational facts the
 * operator has decided to keep persistent across both surfaces.
 */
export function generateMemoryFile({ topic, fact, scope = "self", app = null, createdBy = null }: MemoryFileInput): MemoryFile {
  const cleanTopic = String(topic || "").trim();
  const cleanFact = normaliseBody(fact);
  if (!cleanTopic) throw new Error("topic is required");
  if (!cleanFact)  throw new Error("fact is required");

  const slug = slugify(cleanTopic);
  const filename = `project_ai_fact_${slug}.md`;

  const description = summariseForDescription(cleanFact);
  const scopeNote = scope === "global"
    ? "Visible to every operator (global)."
    : "Operator-private (just-me scope).";
  const appNote = app ? ` Scoped to app: ${app}.` : "";
  const provenance = createdBy ? `\n\n*Captured from Ask AI by ${createdBy}.*` : "";

  const content = `---
name: ${cleanTopic.replace(/\n/g, " ").slice(0, 100)}
description: ${(description || cleanTopic).replace(/\n/g, " ")}
type: project
---

**Topic:** ${cleanTopic}

${cleanFact}

---
${scopeNote}${appNote}${provenance}
`;
  return { filename, content };
}

/**
 * Trigger a browser download of a memory-file blob. No-op outside a
 * browser environment (tests can hit `generateMemoryFile` directly).
 */
export function downloadMemoryFile(file: MemoryFile): void {
  if (typeof document === "undefined") return;
  const blob = new Blob([file.content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke to next tick so the click handler completes first.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

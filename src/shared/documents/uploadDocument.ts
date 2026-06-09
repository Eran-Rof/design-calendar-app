// src/shared/documents/uploadDocument.ts
//
// Helpers for uploading documents to the Tangerine documents API. Used both by
// DocumentAttachmentList (in-place upload on an existing row) and by create
// flows that STAGE files before the row exists (e.g. the manual-JE modal) and
// upload them once the new row id is known.

/** Strip the data-URL prefix and return raw base64 for the file bytes. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * Upload a single document to (contextTable, contextId). Throws on a non-OK
 * response with the server's error message.
 */
export async function uploadDocument(
  contextTable: string,
  contextId: string,
  file: File,
  opts: { kind?: string; title?: string; notes?: string } = {},
): Promise<void> {
  const bytes_base64 = await fileToBase64(file);
  const r = await fetch(`/api/internal/documents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      context_table: contextTable,
      context_id: contextId,
      kind: opts.kind || "supporting_doc",
      title: opts.title || file.name,
      // Preserve the real filename so downloads keep their name (e.g.
      // Q3-costing.xlsx) rather than the storage basename vN.ext.
      original_filename: file.name,
      mime: file.type || "application/octet-stream",
      bytes_base64,
      notes: opts.notes || undefined,
    }),
  });
  if (!r.ok) {
    throw new Error((await r.json().catch(() => ({})) as { error?: string }).error || `HTTP ${r.status}`);
  }
}

/** Upload a batch of staged files sequentially; throws on the first failure. */
export async function uploadStagedDocs(
  contextTable: string,
  contextId: string,
  files: File[],
  kind = "supporting_doc",
): Promise<void> {
  for (const f of files) {
    await uploadDocument(contextTable, contextId, f, { kind });
  }
}

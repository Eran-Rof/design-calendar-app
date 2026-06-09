// api/_lib/documents/index.js
//
// Tangerine M29 Document Management - public entrypoint.
//
//   documentsAPI.attach(supabase, ctx, file, meta)  → create document + v1
//   documentsAPI.uploadVersion(supabase, document_id, file, meta) → new vN
//   documentsAPI.list(supabase, { entity_id, context_table, context_id })
//   documentsAPI.signedUrl(supabase, { document_id, version_id?, ttl_seconds })
//   documentsAPI.archive(supabase, { document_id })
//
// Storage backend: Supabase Storage bucket 'tangerine-documents'. The bucket
// is provisioned via the Supabase Dashboard (or `supabase storage create-
// bucket tangerine-documents`); this lib assumes it exists.
//
// Path convention: <entity_id>/<context_table>/<context_id>/<document_id>/<version_id>.<ext>

import crypto from "node:crypto";

const BUCKET = "tangerine-documents";

export class DocumentsError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/**
 * Create a new document with an initial v1.
 *
 * @param {Object} supabase                       Service-role client
 * @param {Object} ctx
 * @param {string} ctx.entity_id
 * @param {string} ctx.context_table
 * @param {string} ctx.context_id
 * @param {string} ctx.kind
 * @param {string} ctx.title
 * @param {string} [ctx.created_by_user_id]
 * @param {Buffer|Uint8Array} file                File bytes
 * @param {Object} meta
 * @param {string} meta.mime
 * @param {string} [meta.ext]                     File extension (defaults derived from mime)
 * @param {string} [meta.original_filename]       Original client-side filename (download name)
 * @param {string} [meta.notes]
 * @returns {Promise<{document:Object, version:Object}>}
 */
export async function attach(supabase, ctx, file, meta) {
  validateAttachInput(ctx, file, meta);

  // 1. Create document row (with current_version_id NULL; FK is DEFERRABLE)
  const { data: doc, error: dErr } = await supabase
    .from("documents")
    .insert({
      entity_id: ctx.entity_id,
      context_table: ctx.context_table,
      context_id: ctx.context_id,
      kind: ctx.kind,
      title: ctx.title,
      is_archived: false,
      created_by_user_id: ctx.created_by_user_id || null,
    })
    .select()
    .single();
  if (dErr) throw new DocumentsError("document_insert_failed", dErr.message);

  // 2. Upload bytes + create v1 in one go
  try {
    const version = await createVersion(supabase, doc, file, meta, 1);
    // 3. Update current_version_id
    const { data: updated, error: upErr } = await supabase
      .from("documents")
      .update({ current_version_id: version.id })
      .eq("id", doc.id)
      .select()
      .single();
    if (upErr) throw new DocumentsError("current_version_update_failed", upErr.message);
    return { document: updated, version };
  } catch (err) {
    // best-effort rollback of the document row
    await supabase.from("documents").delete().eq("id", doc.id);
    throw err;
  }
}

/**
 * Upload a new version of an existing document.
 */
export async function uploadVersion(supabase, document_id, file, meta) {
  if (!document_id) throw new DocumentsError("missing_document_id", "document_id required");
  if (!file) throw new DocumentsError("missing_file", "file bytes required");
  if (!meta || !meta.mime) throw new DocumentsError("missing_mime", "meta.mime required");

  const { data: doc, error: dErr } = await supabase
    .from("documents")
    .select("*")
    .eq("id", document_id)
    .maybeSingle();
  if (dErr) throw new DocumentsError("document_query_failed", dErr.message);
  if (!doc) throw new DocumentsError("document_not_found", `document ${document_id} not found`);

  // Find next version number
  const { data: rows, error: rowsErr } = await supabase
    .from("document_versions")
    .select("version_number")
    .eq("document_id", document_id)
    .order("version_number", { ascending: false })
    .limit(1);
  if (rowsErr) throw new DocumentsError("versions_query_failed", rowsErr.message);
  const nextN = (rows && rows[0] && rows[0].version_number) ? rows[0].version_number + 1 : 1;

  const version = await createVersion(supabase, doc, file, meta, nextN);

  // Update current_version_id
  const { data: updated, error: upErr } = await supabase
    .from("documents")
    .update({ current_version_id: version.id })
    .eq("id", document_id)
    .select()
    .single();
  if (upErr) throw new DocumentsError("current_version_update_failed", upErr.message);

  return { document: updated, version };
}

/**
 * List documents for a (context_table, context_id) under an entity.
 */
export async function list(supabase, { entity_id, context_table, context_id, include_archived = false }) {
  if (!entity_id) throw new DocumentsError("missing_entity_id", "entity_id required");
  if (!context_table) throw new DocumentsError("missing_context_table", "context_table required");
  if (!context_id) throw new DocumentsError("missing_context_id", "context_id required");

  let query = supabase
    .from("documents")
    .select("*, current_version:document_versions!documents_current_version_fk(*)")
    .eq("entity_id", entity_id)
    .eq("context_table", context_table)
    .eq("context_id", context_id)
    .order("created_at", { ascending: false });

  if (!include_archived) query = query.eq("is_archived", false);
  const { data, error } = await query;
  if (error) throw new DocumentsError("list_failed", error.message);
  return data || [];
}

/**
 * Generate a short-lived signed URL for downloading.
 */
export async function signedUrl(supabase, { document_id, version_id, ttl_seconds = 300 }) {
  if (!document_id) throw new DocumentsError("missing_document_id", "document_id required");

  let storagePath;
  let originalFilename = null;
  if (version_id) {
    const { data, error } = await supabase
      .from("document_versions")
      .select("storage_path, original_filename")
      .eq("id", version_id)
      .maybeSingle();
    if (error) throw new DocumentsError("version_query_failed", error.message);
    if (!data) throw new DocumentsError("version_not_found", `version ${version_id} not found`);
    storagePath = data.storage_path;
    originalFilename = data.original_filename || null;
  } else {
    const { data: doc, error: dErr } = await supabase
      .from("documents")
      .select("current_version_id")
      .eq("id", document_id)
      .maybeSingle();
    if (dErr) throw new DocumentsError("document_query_failed", dErr.message);
    if (!doc) throw new DocumentsError("document_not_found", `document ${document_id} not found`);
    if (!doc.current_version_id) {
      throw new DocumentsError("no_current_version", "document has no current version");
    }
    const { data: ver, error: vErr } = await supabase
      .from("document_versions")
      .select("storage_path, original_filename")
      .eq("id", doc.current_version_id)
      .single();
    if (vErr) throw new DocumentsError("version_query_failed", vErr.message);
    storagePath = ver.storage_path;
    originalFilename = ver.original_filename || null;
  }

  // Tell the browser to save the file under its ORIGINAL name (sets the
  // Content-Disposition filename) instead of the storage basename `vN.ext`.
  // Fall back to the storage basename for pre-migration versions that have no
  // recorded filename, preserving the prior behaviour.
  const downloadName = originalFilename || storagePath.split("/").pop();
  const { data, error } = await supabase
    .storage
    .from(BUCKET)
    .createSignedUrl(storagePath, ttl_seconds, { download: downloadName });
  if (error) throw new DocumentsError("signed_url_failed", error.message);
  return {
    url: data.signedUrl || data.signed_url,
    expires_in_seconds: ttl_seconds,
    filename: downloadName,
  };
}

/**
 * Archive (soft-delete) a document.
 */
export async function archive(supabase, { document_id }) {
  if (!document_id) throw new DocumentsError("missing_document_id", "document_id required");
  const { data, error } = await supabase
    .from("documents")
    .update({ is_archived: true })
    .eq("id", document_id)
    .select()
    .single();
  if (error) throw new DocumentsError("archive_failed", error.message);
  if (!data) throw new DocumentsError("document_not_found", `document ${document_id} not found`);
  return { document: data };
}

// ─── helpers ─────────────────────────────────────────────────────────────

function validateAttachInput(ctx, file, meta) {
  if (!ctx) throw new DocumentsError("invalid_ctx", "ctx required");
  for (const k of ["entity_id", "context_table", "context_id", "kind", "title"]) {
    if (!ctx[k]) throw new DocumentsError(`missing_${k}`, `${k} required`);
  }
  if (!file) throw new DocumentsError("missing_file", "file bytes required");
  if (!meta || !meta.mime) throw new DocumentsError("missing_mime", "meta.mime required");
}

async function createVersion(supabase, doc, file, meta, versionNumber) {
  const buf = Buffer.isBuffer(file) ? file : Buffer.from(file);
  const sha = crypto.createHash("sha256").update(buf).digest("hex");
  const ext = meta.ext || extFromMime(meta.mime) || "bin";
  const storagePath = `${doc.entity_id}/${doc.context_table}/${doc.context_id}/${doc.id}/v${versionNumber}.${ext}`;

  const { error: upErr } = await supabase
    .storage
    .from(BUCKET)
    .upload(storagePath, buf, {
      contentType: meta.mime,
      upsert: false,
    });
  if (upErr) {
    throw new DocumentsError("storage_upload_failed", upErr.message);
  }

  const { data: ver, error: insErr } = await supabase
    .from("document_versions")
    .insert({
      document_id: doc.id,
      version_number: versionNumber,
      storage_path: storagePath,
      mime_type: meta.mime,
      byte_size: buf.byteLength,
      sha256_hex: sha,
      notes: meta.notes || null,
      original_filename: meta.original_filename || null,
      created_by_user_id: meta.created_by_user_id || null,
    })
    .select()
    .single();
  if (insErr) {
    // best-effort cleanup
    await supabase.storage.from(BUCKET).remove([storagePath]);
    throw new DocumentsError("version_insert_failed", insErr.message);
  }
  return ver;
}

function extFromMime(mime) {
  if (!mime) return null;
  const map = {
    "application/pdf": "pdf",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "text/plain": "txt",
    "text/csv": "csv",
    "application/json": "json",
    "application/zip": "zip",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  };
  return map[mime] || null;
}

export { BUCKET };

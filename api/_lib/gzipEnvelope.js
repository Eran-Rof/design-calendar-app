// Node-side counterpart to src/utils/gzipBase64.ts.
//
// ATS now stores its app_data['ats_excel_data'] / app_data['ats_base_data']
// blobs as a gzip+base64 envelope:
//   {"_gz":"<base64>"}
// to keep large uploads under Supabase's 8s anon-role statement timeout.
// Server-side readers (planning-sync, ats-supply-sync, …) need to detect
// the envelope and decompress before parsing as ExcelData.
//
// Legacy uncompressed rows still parse via the JSON.parse fallback —
// callers can read either format transparently.

import { gunzipSync } from "node:zlib";

const GZ_MARKER = "_gz";

// Accepts either:
//   - a gzip envelope string `{"_gz":"<base64>"}`
//   - a legacy plain-JSON-stringified value
//   - an already-parsed object (returned as-is)
// Returns the decoded value. Returns null on totally unparseable input.
export function unpackGzipEnvelope(value) {
  if (value == null) return null;
  // Already parsed object.
  if (typeof value === "object") {
    if (GZ_MARKER in value && typeof value[GZ_MARKER] === "string") {
      return JSON.parse(gunzipSync(Buffer.from(value[GZ_MARKER], "base64")).toString("utf-8"));
    }
    return value;
  }
  if (typeof value !== "string") return null;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (parsed && typeof parsed === "object" && GZ_MARKER in parsed && typeof parsed[GZ_MARKER] === "string") {
    return JSON.parse(gunzipSync(Buffer.from(parsed[GZ_MARKER], "base64")).toString("utf-8"));
  }
  return parsed;
}

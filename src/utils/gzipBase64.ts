// Browser-native gzip + base64 helpers using the CompressionStream
// API (Chrome 80+, Firefox 113+, Safari 16.4+).
//
// Used by ATS to shrink the ats_excel_data / ats_base_data blobs
// before persisting to the app_data table. A 16-MB JSON string
// compresses ~10x to a 1-2-MB base64 payload, which keeps the
// INSERT/UPDATE under Supabase's 8-second anon-role statement
// timeout. Without compression, large uploads were tripping 57014
// errors on save.
//
// Storage format: the saver writes `{"_gz":"<base64>"}` so the
// loader can detect compressed rows. Legacy uncompressed rows
// (plain JSON strings) keep working — the loader falls back when
// `_gz` is absent.

const GZ_MARKER = "_gz";

export async function gzipBase64(input: string): Promise<string> {
  if (typeof CompressionStream === "undefined") {
    throw new Error("CompressionStream not supported by this browser");
  }
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  void writer.write(new TextEncoder().encode(input));
  void writer.close();
  const buf = await new Response(cs.readable).arrayBuffer();
  return bytesToBase64(new Uint8Array(buf));
}

export async function gunzipBase64(b64: string): Promise<string> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("DecompressionStream not supported by this browser");
  }
  const bytes = base64ToBytes(b64);
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  void writer.write(bytes);
  void writer.close();
  const buf = await new Response(ds.readable).arrayBuffer();
  return new TextDecoder().decode(buf);
}

// Wrap a JSON-serializable value as a compressed envelope.
// Returns the string to write to app_data.value. Falls back to
// plain JSON.stringify if compression fails for any reason.
export async function packGzipEnvelope(value: unknown): Promise<string> {
  const json = JSON.stringify(value);
  try {
    const b64 = await gzipBase64(json);
    return JSON.stringify({ [GZ_MARKER]: b64 });
  } catch {
    return json;
  }
}

// Detect + unwrap a compressed envelope. Accepts either:
//   - a compressed envelope string `{"_gz":"<base64>"}`
//   - a legacy plain-JSON-stringified value
//   - an already-parsed object (returned as-is)
// Returns the decoded value. Throws on totally unparseable input.
export async function unpackGzipEnvelope<T = unknown>(value: string | unknown): Promise<T> {
  // Already parsed (e.g. PostgREST sometimes returns parsed JSON).
  if (typeof value !== "string") {
    if (value && typeof value === "object" && GZ_MARKER in (value as Record<string, unknown>)) {
      const b64 = (value as Record<string, unknown>)[GZ_MARKER];
      if (typeof b64 === "string") {
        const decompressed = await gunzipBase64(b64);
        return JSON.parse(decompressed) as T;
      }
    }
    return value as T;
  }
  // String path. Try parsing as JSON first.
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("unpackGzipEnvelope: value is neither object nor JSON string");
  }
  if (parsed && typeof parsed === "object" && GZ_MARKER in (parsed as Record<string, unknown>)) {
    const b64 = (parsed as Record<string, unknown>)[GZ_MARKER];
    if (typeof b64 === "string") {
      const decompressed = await gunzipBase64(b64);
      return JSON.parse(decompressed) as T;
    }
  }
  return parsed as T;
}

// ── helpers ───────────────────────────────────────────────────────────────
// btoa() takes a binary string, but String.fromCharCode.apply over a 16MB
// Uint8Array can stack-overflow. Chunk it.
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const chunk = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// SHA-256 via the browser's native Web Crypto API — no npm dependency needed.
// Returns a 64-character lowercase hex string.
export async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const buf  = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

// A raw SHA-256 digest is always exactly 64 lowercase hex chars.
// Use this to distinguish already-hashed passwords from plaintext ones.
export function isHashed(password: string): boolean {
  return /^[0-9a-f]{64}$/.test(password);
}

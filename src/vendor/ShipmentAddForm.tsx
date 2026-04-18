import { useState, type FormEvent } from "react";
import { TH } from "../utils/theme";
import { supabaseVendor } from "./supabaseVendor";
import { isValidContainerNumber } from "./shipmentUtils";

type NumberType = "CT" | "BL" | "BK";

interface Props {
  onClose: () => void;
  onCreated: (shipmentId: string) => void;
}

export default function ShipmentAddForm({ onClose, onCreated }: Props) {
  const [numberType, setNumberType] = useState<NumberType>("CT");
  const [number, setNumber] = useState("");
  const [sealine, setSealine] = useState("");
  const [poNumber, setPoNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null);

    const n = number.trim().toUpperCase().replace(/\s+/g, "");
    if (!n) { setErr("Enter a tracking number."); return; }
    if (numberType === "CT" && !isValidContainerNumber(n)) {
      setErr("That's not a valid ISO 6346 container number. Format: AAAA1234567 (4 letters + 7 digits, last digit is checksum).");
      return;
    }

    const { data: sessionRes } = await supabaseVendor.auth.getSession();
    const accessToken = sessionRes?.session?.access_token;
    if (!accessToken) { setErr("Not signed in."); return; }

    setBusy(true);
    try {
      const q = new URLSearchParams();
      q.set("number", n);
      q.set("type", numberType);
      if (sealine.trim()) q.set("sealine", sealine.trim().toUpperCase());
      if (poNumber.trim()) q.set("po_number", poNumber.trim());
      // First fetch is always cached (force_update=false) to save API credits.
      q.set("force_update", "false");

      const res = await fetch(`/api/searates-proxy?${q.toString()}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.error) {
        setErr(body?.error || `Request failed (${res.status})`);
        return;
      }
      onCreated(body?.shipment?.id);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(17,24,39,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: TH.surface, borderRadius: 12, padding: 24, width: 460, maxWidth: "92vw", boxShadow: "0 10px 25px rgba(0,0,0,0.15)" }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: TH.text, marginBottom: 4 }}>Add shipment</div>
        <div style={{ fontSize: 12, color: TH.textMuted, marginBottom: 18 }}>
          Look up a container, Bill of Lading, or Booking number via Searates. First fetch uses cached data (cheap). Live refresh available after.
        </div>

        <label style={labelStyle}>Reference type</label>
        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          {(["CT", "BL", "BK"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setNumberType(t)}
              style={{
                padding: "6px 12px",
                borderRadius: 999,
                border: `1px solid ${numberType === t ? TH.primary : TH.border}`,
                background: numberType === t ? TH.primary : TH.surface,
                color: numberType === t ? "#FFFFFF" : TH.textSub,
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 600,
                fontFamily: "inherit",
              }}
            >
              {t === "CT" ? "Container" : t === "BL" ? "Bill of Lading" : "Booking"}
            </button>
          ))}
        </div>

        <form onSubmit={submit}>
          <label style={labelStyle}>
            {numberType === "CT" ? "Container number (ISO 6346)" : numberType === "BL" ? "Bill of Lading number" : "Booking number"}
          </label>
          <input
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            placeholder={numberType === "CT" ? "e.g. MRKU7181100" : numberType === "BL" ? "e.g. HKA2573372" : "e.g. MAEU12345678"}
            style={{ ...inputStyle, fontFamily: "Menlo, monospace", textTransform: "uppercase" }}
            autoComplete="off"
          />

          <label style={labelStyle}>Carrier SCAC (optional)</label>
          <input
            value={sealine}
            onChange={(e) => setSealine(e.target.value)}
            placeholder="e.g. MAEU, CMDU, COSU — leave blank to auto-detect"
            style={{ ...inputStyle, fontFamily: "Menlo, monospace", textTransform: "uppercase" }}
            autoComplete="off"
          />

          <label style={labelStyle}>Link to PO number (optional)</label>
          <input
            value={poNumber}
            onChange={(e) => setPoNumber(e.target.value)}
            placeholder="e.g. ROF-P001132"
            style={inputStyle}
            autoComplete="off"
          />

          {err && (
            <div style={{ marginTop: 12, padding: "8px 12px", borderRadius: 6, background: TH.accent, border: `1px solid ${TH.accentBdr}`, color: TH.primary, fontSize: 13 }}>
              {err}
            </div>
          )}

          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 18 }}>
            <button type="button" onClick={onClose} style={{ padding: "8px 14px", borderRadius: 7, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}>
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !number.trim()}
              style={{ padding: "8px 16px", borderRadius: 7, border: "none", background: busy || !number.trim() ? TH.textMuted : TH.primary, color: "#FFFFFF", cursor: busy ? "not-allowed" : "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 600 }}
            >
              {busy ? "Looking up…" : "Track"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const labelStyle = { display: "block", fontSize: 12, fontWeight: 600, color: TH.textSub, marginBottom: 6, marginTop: 8 };
const inputStyle = { width: "100%", padding: "9px 10px", borderRadius: 6, border: `1px solid ${TH.border}`, fontSize: 14, boxSizing: "border-box" as const, fontFamily: "inherit" };

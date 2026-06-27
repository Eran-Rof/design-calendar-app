import React from "react";
import { TH } from "../../utils/theme";

// Read-only reference panel: the standard GS1 / GDSN → EDI retail workflow,
// annotated with where this GS1 module fits each step. Pure content, no state.

type Step = {
  n: number;
  title: string;
  doc?: string;
  body: string;
  here?: string; // where this app fits the step
};

const STEPS: Step[] = [
  {
    n: 1,
    title: "Catalog",
    body: "Supplier publishes the style catalog via GDSN or a retail portal.",
    here: "Mint and curate the codes here first: UPC Master (one GS1 UPC per color/size) and Pack GTINs (one Pack GTIN per Style + Color + Scale).",
  },
  {
    n: 2,
    title: "Download",
    body: "Retailer imports the catalog to update their inventory system with the correct barcodes (UPC / EAN / GTIN).",
    here: "The retailer reads the exact GTIN-12/14 values published in step 1 — so the codes here must match what ships and what is invoiced.",
  },
  {
    n: 3,
    title: "Purchase Order",
    doc: "EDI 850",
    body: "Retailer sends an EDI 850 Purchase Order using the exact barcodes downloaded from the catalog.",
  },
  {
    n: 4,
    title: "Advance Shipping Notice",
    doc: "EDI 856",
    body: "Supplier ships the goods and sends an EDI 856 ASN matching those same codes.",
    here: "Built from the packing list and carton hierarchy: Packing List, Carton Labels (SSCC), and Receiving — the SSCC + GTINs on the ASN tie back to the labels generated here.",
  },
  {
    n: 5,
    title: "Invoice",
    doc: "EDI 810",
    body: "Supplier sends an EDI 810 Invoice for final payment.",
  },
];

const CARD: React.CSSProperties = {
  background: TH.surface,
  borderRadius: 10,
  padding: "18px 22px",
  boxShadow: `0 1px 4px ${TH.shadow}`,
  border: `1px solid ${TH.border}`,
};

const NUM: React.CSSProperties = {
  flex: "0 0 auto",
  width: 30,
  height: 30,
  borderRadius: 999,
  background: TH.primary,
  color: "#fff",
  fontSize: 14,
  fontWeight: 700,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};

const DOC_BADGE: React.CSSProperties = {
  display: "inline-block",
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.03em",
  color: TH.primary,
  background: "#FFF5F2",
  border: `1px solid ${TH.border}`,
  borderRadius: 6,
  padding: "2px 7px",
  marginLeft: 8,
};

export default function EdiWorkflowPanel() {
  return (
    <div style={{ padding: "24px 24px", maxWidth: 880 }}>
      <h2 style={{ margin: "0 0 4px", fontSize: 20, color: TH.text }}>The Standard Workflow</h2>
      <p style={{ margin: "0 0 20px", color: TH.textMuted, fontSize: 13, lineHeight: 1.5 }}>
        How GS1 product data flows from catalog to payment between a supplier and a retail
        partner. The codes minted in this module (UPC / Pack GTIN / SSCC) are what every EDI
        document below references — keep them consistent end to end.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {STEPS.map((s) => (
          <div key={s.n} style={CARD}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={NUM}>{s.n}</span>
              <div style={{ fontSize: 15, fontWeight: 600, color: TH.text }}>
                {s.title}
                {s.doc && <span style={DOC_BADGE}>{s.doc}</span>}
              </div>
            </div>
            <p style={{ margin: "10px 0 0 42px", color: TH.textSub, fontSize: 13, lineHeight: 1.5 }}>
              {s.body}
            </p>
            {s.here && (
              <p
                style={{
                  margin: "8px 0 0 42px",
                  color: TH.textSub2,
                  fontSize: 12,
                  lineHeight: 1.5,
                  background: TH.surfaceHi,
                  border: `1px solid ${TH.border}`,
                  borderRadius: 6,
                  padding: "8px 10px",
                }}
              >
                <strong style={{ color: TH.text }}>In this app: </strong>
                {s.here}
              </p>
            )}
          </div>
        ))}
      </div>

      <div style={{ ...CARD, marginTop: 18 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: TH.text, marginBottom: 6 }}>
          Mapping GS1 attributes for apparel
        </div>
        <ul style={{ margin: 0, paddingLeft: 18, color: TH.textSub, fontSize: 12.5, lineHeight: 1.6 }}>
          <li>
            Each saleable <strong>color / size</strong> variant carries its own GTIN — the retailer's
            EDI 850 and 810 are keyed to the variant GTIN, not the parent style.
          </li>
          <li>
            <strong>Prepacks</strong> get a Pack GTIN (Style + Color + Scale); the pack's component
            eaches are described once via the pack BOM so the ASN can roll up to cartons (SSCC).
          </li>
          <li>
            Publish the catalog (step 1) <em>before</em> the first EDI 850 — the retailer can only
            order codes they have already downloaded.
          </li>
        </ul>
      </div>
    </div>
  );
}

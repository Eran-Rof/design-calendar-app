// All-samples overview list. Flattened sample rows from every tech
// pack with the parent's styleNumber + styleName denormalized onto
// each row. Read-only view — clicking a row would normally drill in,
// but the existing inline JSX never wired that.
//
// Receives the already-flattened array (built via flattenAllSamples
// in ../listLogic.ts) so the view stays a pure render.

import { fmtDate } from "../utils";
import { SAMPLE_STATUS_COLORS } from "../constants";
import S from "../styles";
import type { SampleWithStyle } from "../listLogic";

export interface SamplesOverviewProps {
  allSamples: SampleWithStyle[];
}

export function SamplesOverview({ allSamples }: SamplesOverviewProps) {
  return (
    <>
      <h2 style={{ margin: "0 0 16px", color: "#F1F5F9", fontSize: 22 }}>All Samples</h2>
      {allSamples.length === 0 ? (
        <div style={S.emptyState}>
          <p>No samples tracked across any tech packs</p>
        </div>
      ) : (
        <div style={S.tableWrap}>
          <div style={S.tableHeader}>
            <span style={{ flex: 1 }}>Style #</span>
            <span style={{ flex: 2 }}>Style Name</span>
            <span style={{ flex: 1 }}>Type</span>
            <span style={{ flex: 1 }}>Status</span>
            <span style={{ flex: 1 }}>Vendor</span>
            <span style={{ flex: 1 }}>Requested</span>
            <span style={{ flex: 1 }}>Received</span>
          </div>
          {allSamples.map((s, i) => (
            <div key={s.id} style={{ ...S.tableRow, background: i % 2 === 0 ? "#0F172A" : "#1A2332" }}>
              <span style={{ flex: 1, color: "#60A5FA", fontFamily: "monospace", fontWeight: 600 }}>{s.styleNumber}</span>
              <span style={{ flex: 2, color: "#D1D5DB" }}>{s.styleName}</span>
              <span style={{ flex: 1 }}>
                <span style={{ ...S.badge, background: "#3B82F622", color: "#3B82F6", border: "1px solid #3B82F644" }}>{s.type}</span>
              </span>
              <span style={{ flex: 1 }}>
                <span style={{
                  ...S.badge,
                  background: (SAMPLE_STATUS_COLORS[s.status] || "#6B7280") + "22",
                  color: SAMPLE_STATUS_COLORS[s.status] || "#6B7280",
                  border: `1px solid ${SAMPLE_STATUS_COLORS[s.status] || "#6B7280"}44`,
                }}>{s.status}</span>
              </span>
              <span style={{ flex: 1, color: "#94A3B8" }}>{s.vendor}</span>
              <span style={{ flex: 1, color: "#94A3B8", fontSize: 12 }}>{fmtDate(s.requestDate)}</span>
              <span style={{ flex: 1, color: "#94A3B8", fontSize: 12 }}>{fmtDate(s.receiveDate)}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

import React from "react";
import S from "../styles";

interface PaginationProps {
  page: number;
  totalPages: number;
  setPage: (v: number | ((p: number) => number)) => void;
  filteredCount: number;
}

export const Pagination: React.FC<PaginationProps> = ({ page, totalPages, setPage, filteredCount }) => {
  if (totalPages <= 1) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12, marginTop: 16, flexWrap: "wrap" }}>
      <button
        style={{ ...S.navBtn, opacity: page === 0 ? 0.3 : 1, cursor: page === 0 ? "default" : "pointer" }}
        disabled={page === 0}
        onClick={() => setPage(p => Math.max(0, p - 1))}
      >← Prev</button>
      <span style={{ color: "#9CA3AF", fontSize: 13 }}>
        Page {page + 1} of {totalPages} &nbsp;·&nbsp; {filteredCount.toLocaleString()} SKUs
      </span>
      <button
        style={{ ...S.navBtn, opacity: page >= totalPages - 1 ? 0.3 : 1, cursor: page >= totalPages - 1 ? "default" : "pointer" }}
        disabled={page >= totalPages - 1}
        onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
      >Next →</button>
    </div>
  );
};

import React from "react";
import S from "../styles";
import { StatCard } from "../StatCard";

interface StatsRowProps {
  lowStock: number;
  zeroStock: number;
  negATSCount: number;
  totalSKUs: number;
  totalSoQty: number;
  totalSoValue: number;
  totalPoQty: number;
  totalPoValue: number;
  marginDollars: number;
  marginPct: number;
  activeSort: string | null;
  setActiveSort: (k: string | null) => void;
}

export const StatsRow: React.FC<StatsRowProps> = ({
  lowStock, zeroStock, negATSCount, totalSKUs,
  totalSoQty, totalSoValue, totalPoQty, totalPoValue,
  marginDollars, marginPct, activeSort, setActiveSort,
}) => (
  <div style={{ ...S.statsRow, gridTemplateColumns: "repeat(9,1fr)" }}>
    <StatCard icon="△" label="Low Stock (≤10)" value={lowStock}      color="#F59E0B" sortKey="lowStock"  activeSort={activeSort} onSort={k => setActiveSort(k)} />
    <StatCard icon="▽" label="Zero Stock"       value={zeroStock}     color="#EF4444" sortKey="zeroStock" activeSort={activeSort} onSort={k => setActiveSort(k)} />
    <StatCard icon="↓" label="Negative ATS"     value={negATSCount}   color="#F87171" sortKey="negATS"    activeSort={activeSort} onSort={k => setActiveSort(k)} />
    <StatCard icon="▦" label="Total SKUs"        value={totalSKUs}     color="#3B82F6" sortKey="total"     activeSort={activeSort} onSort={k => setActiveSort(k)} />
    <StatCard icon="↑" label="Units on Order"    value={totalSoQty}    color="#10B981" sortKey="onOrder"   activeSort={activeSort} onSort={k => setActiveSort(k)} />
    <StatCard icon="$" label="$ on Order"        value={totalSoValue}  color="#10B981" fmt="dollar" />
    <StatCard icon="⬆" label="Units on PO"       value={totalPoQty}    color="#60A5FA" />
    <StatCard icon="$" label="$ on PO"           value={totalPoValue}  color="#60A5FA" fmt="dollar" />
    <StatCard icon="%" label="Margin"            value={marginDollars} color={marginDollars >= 0 ? "#A3E635" : "#F87171"} fmt="margin" marginPct={marginPct} />
  </div>
);

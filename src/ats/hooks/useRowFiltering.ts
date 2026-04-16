import { useMemo } from "react";
import type { ATSRow, ExcelData } from "../types";
import { filterRows, statFilterRows, sortRows } from "../filter";

interface UseRowFilteringOpts {
  rows: ATSRow[];
  excelData: ExcelData | null;
  search: string;
  filterCategory: string;
  filterGender: string;
  filterStatus: string;
  minATS: number | "";
  storeFilter: string[];
  customerFilter: string;
  activeSort: string | null;
  sortCol: string | null;
  sortDir: "asc" | "desc";
  displayPeriods: Array<{ endDate: string }>;
  today: Date;
  pageSize: number;
  page: number;
}

// Bundles the filter → statFilter → sort → paginate chain into a single
// hook with memoized stages. Each stage only recomputes when its direct
// inputs change.
export function useRowFiltering(opts: UseRowFilteringOpts) {
  const customerSkuSet = useMemo(() => {
    if (!opts.customerFilter || !opts.excelData) return null;
    const skus = new Set<string>();
    opts.excelData.sos.forEach(s => { if (s.customerName === opts.customerFilter) skus.add(s.sku); });
    opts.excelData.pos.forEach(p => { if (p.vendor === opts.customerFilter) skus.add(p.sku); });
    return skus;
  }, [opts.customerFilter, opts.excelData]);

  const filtered = useMemo(() => filterRows(opts.rows, {
    search: opts.search,
    filterCategory: opts.filterCategory,
    filterGender: opts.filterGender,
    filterStatus: opts.filterStatus,
    minATS: opts.minATS,
    storeFilter: opts.storeFilter,
    customerSkuSet,
    today: opts.today,
  }), [
    opts.rows, opts.search, opts.filterCategory, opts.filterGender, opts.filterStatus,
    opts.minATS, opts.storeFilter, customerSkuSet, opts.today,
  ]);

  const statFiltered = useMemo(
    () => statFilterRows(filtered, opts.activeSort, opts.displayPeriods),
    [filtered, opts.activeSort, opts.displayPeriods],
  );

  const sortedFiltered = useMemo(
    () => sortRows(statFiltered, opts.sortCol, opts.sortDir),
    [statFiltered, opts.sortCol, opts.sortDir],
  );

  const totalPages = Math.ceil(sortedFiltered.length / opts.pageSize);
  const pageRows   = sortedFiltered.slice(opts.page * opts.pageSize, (opts.page + 1) * opts.pageSize);

  const filteredSkuSet = useMemo(() => new Set(filtered.map(r => r.sku)), [filtered]);

  return {
    customerSkuSet,
    filtered,
    statFiltered,
    sortedFiltered,
    pageRows,
    totalPages,
    filteredSkuSet,
  };
}

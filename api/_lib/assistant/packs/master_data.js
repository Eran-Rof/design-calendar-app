// P28 capability pack — Master Data quality.
//
// Data-quality debt that silently degrades everything downstream (matrix
// grids, PPK downloads, planning grains). Both providers ride views that
// already power their fixing tools:
//   v_style_scale_candidates — styles with sized variants + no size scale
//                              (fixed in ONE CLICK by Style Master's
//                              🎯 Auto-assign, #934/#936)
//   v_prepack_ppk_needed     — PPK styles still missing a prepack matrix
//                              (Prepack Matrices panel lists + prefills)

async function headCount(q) {
  const { count, error } = await q;
  if (error) throw new Error(error.message);
  return count || 0;
}

const scalesMissing = {
  key: "master.scales_missing",
  module_key: "style_master",
  async run(admin) {
    // v_style_scale_missing = genuinely missing (no scale + a real multi-size
    // run). NOT v_style_scale_candidates, which is one-row-per-style (its count
    // = the TOTAL style count, so it never moved — the "still 2,119" bug).
    const n = await headCount(
      admin.from("v_style_scale_missing").select("id", { count: "exact", head: true }),
    );
    if (n === 0) return [];
    return [{
      key: "master.scales_missing",
      title: "Styles missing a size scale",
      detail: "Multi-size styles with no size scale assigned",
      count: n,
      severity: "warn",
      panel: "style_master",
    }];
  },
};

const ppkMatrixNeeded = {
  key: "master.ppk_matrix_needed",
  module_key: "style_master",
  async run(admin) {
    const n = await headCount(
      admin.from("v_prepack_ppk_needed").select("ppk_style_code", { count: "exact", head: true }),
    );
    if (n === 0) return [];
    return [{
      key: "master.ppk_matrix_needed",
      title: "PPK styles without a prepack matrix",
      detail: "Pack grids can't explode these until a matrix exists",
      count: n,
      severity: "warn",
      panel: "prepack_matrices",
    }];
  },
};

const suggestBulkScaleAssign = {
  key: "master.suggest_bulk_scale_assign",
  module_key: "style_master",
  derive(aggregate) {
    const hit = aggregate.todos.find((t) => t.key === "master.scales_missing");
    if (!hit || (hit.count || 0) < 5) return [];
    // Honest framing: Auto-assign clears the ones with a clean size run it can
    // confidently match (≥3 sizes, ≥60% coverage); the rest need a quick manual
    // pick in Style Master. Don't claim it fixes "most in one click".
    return [{
      key: "master.suggest_bulk_scale_assign",
      text: `${hit.count.toLocaleString()} styles have a size run but no size scale — Style Master's 🎯 Auto-assign matches the clean ones in one preview-then-apply pass; the rest take a quick manual pick (user guide ch02).`,
      panel: "style_master",
    }];
  },
};

export default {
  key: "master_data",
  label: "Master Data",
  module_keys: ["style_master"],
  todos: [scalesMissing, ppkMatrixNeeded],
  processes: [],
  suggestions: [suggestBulkScaleAssign],
  panels: { style_master: {}, prepack_matrices: {} },
};

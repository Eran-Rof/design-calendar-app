// P28 capability pack — Manufacturing.
//
// Build-order lifecycle to-dos (M1–M6 manufacturing module). The table is
// empty today for ROF — providers return [] and the section stays quiet
// until builds are actually used; the pack existing is what matters
// (adding a module to the assistant = adding a pack, arch §4).

async function headCount(q) {
  const { count, error } = await q;
  if (error) throw new Error(error.message);
  return count || 0;
}

// Build orders started but not completed — WIP sitting on 1205.
const buildsInProgress = {
  key: "mfg.builds_open",
  module_key: "mfg_build_orders",
  async run(admin) {
    const n = await headCount(
      admin.from("mfg_build_orders").select("id", { count: "exact", head: true })
        .in("status", ["draft", "issued", "in_progress"]),
    );
    if (n === 0) return [];
    return [{
      key: "mfg.builds_open",
      title: "Build orders open",
      detail: "Draft / issued / in-progress builds carrying WIP",
      count: n,
      severity: "info",
      panel: "mfg_build_orders",
      // Build Orders filters to the open (draft/issued/in-progress) builds.
      drill: { status: "open" },
    }];
  },
};

export default {
  key: "manufacturing",
  label: "Manufacturing",
  module_keys: ["mfg_build_orders"],
  todos: [buildsInProgress],
  processes: [],
  suggestions: [],
  panels: { mfg_build_orders: {} },
};

// Run selector + "build forecast" button. A thin bar above the grid.
//
// A planner picks an active run, or creates a new one with a horizon.
// Building the forecast kicks off runForecastPass on the service.

import { useEffect, useRef, useState } from "react";
import type { IpPlanningRun, IpPlanningRunStatus } from "../types/wholesale";
import { wholesaleRepo } from "../services/wholesalePlanningRepository";
import { runForecastPass, BuildCancelledError, type BuildFilter, type BuildProgress } from "../services/wholesaleForecastService";
import { S, PAL, formatDate } from "../components/styles";
import type { ToastMessage } from "../components/Toast";
import { scenarioRepo } from "../scenarios/services/scenarioRepo";
import { cloneBaseIntoSavedBuild, deleteSavedBuild, generatePlannerBuyPlanForRun, type SaveBuildProgress, type PlannerBuyPlanProgress } from "../scenarios/services/scenarioService";
import type { IpScenario } from "../scenarios/types/scenarios";
import { AppDatePicker } from "../../shared/components/AppDatePicker";
import { confirmDialog } from "../../shared/ui/warn";
import SearchableSelect from "../../tanda/components/SearchableSelect";

export interface PlanningRunControlsProps {
  runs: IpPlanningRun[];
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
  onChange: () => Promise<void> | void;
  onToast: (t: ToastMessage) => void;
  // New runs the user creates from this bar get this scope. Default
  // 'wholesale' keeps Phase 1 unchanged; Phase 2 workbench passes 'ecom'.
  scope?: "wholesale" | "ecom" | "all";
  // Optional label shown on the action button — "Build forecast" for
  // wholesale, the ecom workbench renders its own build button and
  // passes `showBuild={false}` to avoid a duplicate.
  showBuild?: boolean;
  // Grid-derived filter. When any field is set, the Build button
  // scopes the build to the matching subset and re-labels itself
  // "Build (filtered)" so the planner knows it's not a full-run build.
  buildFilter?: BuildFilter | null;
}

export default function PlanningRunControls({
  runs, selectedRunId, onSelect, onChange, onToast,
  scope = "wholesale", showBuild = true, buildFilter = null,
}: PlanningRunControlsProps) {
  const [showNew, setShowNew] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [building, setBuilding] = useState(false);
  const [pushingBuys, setPushingBuys] = useState(false);
  // After a successful "Finalize with my buys" push we show a small success
  // modal (instead of a bare toast) that points the planner forward to the
  // Buy plan. Holds the finalized line/unit counts for the modal body.
  const [pushResult, setPushResult] = useState<{ lines: number; units: number; skippedTbdLines: number; skippedTbdUnits: number } | null>(null);
  // Live progress for the "Finalize with my buys" push — drives the inline
  // status bar next to the toolbar while pushingBuys is true. Separate from
  // the build `progress` state so the two flows never stomp each other.
  const [pushProgress, setPushProgress] = useState<PlannerBuyPlanProgress | null>(null);
  const [progress, setProgress] = useState<BuildProgress | null>(null);
  const [pendingRebuildConfirm, setPendingRebuildConfirm] = useState(false);
  const [wipeStage, setWipeStage] = useState<"choice" | "confirm">("choice");
  const [wipeTyped, setWipeTyped] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  // Build-stage vendor selection (CEO ask: same style, multiple vendors at
  // different true costs). The list is vendors that actually have POs
  // (ip_po_vendors). Selecting one persists build_vendor_id on the run so the
  // wholesale grid resolves costs vendor-first (open POs → most-recent received
  // → avg → any-vendor PO). Vendor cost is a wholesale-grid feature, so the
  // selector is hidden on the ecom workbench.
  const showVendorSelect = scope !== "ecom";
  const [poVendors, setPoVendors] = useState<Array<{ vendor_id: string; vendor_name: string; vendor_code: string | null }>>([]);
  const [savingVendor, setSavingVendor] = useState(false);
  useEffect(() => {
    if (!showVendorSelect) return;
    let live = true;
    wholesaleRepo.listPoVendors()
      .then((vs) => { if (live) setPoVendors(vs); })
      .catch((e) => { if (live) onToast({ text: "Couldn't load vendors for cost selection: " + (e instanceof Error ? e.message : String(e)), kind: "error" }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showVendorSelect]);
  async function onVendorChange(vendorId: string) {
    if (!selected) { onToast({ text: "Pick a run first", kind: "error" }); return; }
    setSavingVendor(true);
    try {
      await wholesaleRepo.updatePlanningRun(selected.id, { build_vendor_id: vendorId || null });
      const name = poVendors.find((v) => v.vendor_id === vendorId)?.vendor_name;
      onToast({
        text: vendorId
          ? `Vendor cost source set to ${name ?? "selected vendor"} — rebuild or reload to apply vendor-first costs.`
          : "Vendor cost source cleared — costs use the standard cascade (any vendor).",
        kind: "success",
      });
      await onChange();
    } catch (e) {
      onToast({ text: "Couldn't set vendor — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally {
      setSavingVendor(false);
    }
  }

  // Saved builds — snapshots of a planning run captured by the
  // planner. The list lives in ip_scenarios with type='saved_build';
  // the underlying state lives in a fresh planning_run that the
  // saved-build clone creates so the snapshot can be browsed in the
  // grid like any other run. The dropdown reads scenarios filtered
  // to type='saved_build' on every onChange.
  const [savedBuilds, setSavedBuilds] = useState<IpScenario[]>([]);
  const [savedBuildsLoading, setSavedBuildsLoading] = useState(false);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [savedBuildName, setSavedBuildName] = useState("");
  const [savedBuildNote, setSavedBuildNote] = useState("");
  const [saveBuildBusy, setSaveBuildBusy] = useState(false);
  const [pendingDeleteSaved, setPendingDeleteSaved] = useState<IpScenario | null>(null);
  // After a successful delete the modal flips to a "Deleted" confirmation
  // for 1.5s instead of vanishing immediately, so the planner sees the
  // action landed before the dialog closes itself.
  const [deleteSucceeded, setDeleteSucceeded] = useState(false);
  // Which saved build the planner explicitly picked from the "Saved
  // builds" dropdown. Independent of selectedRunId so the Delete affordance
  // stays visible even when the run-id derivation race-conditions
  // (e.g. just-forked, refresh in flight, or selectedRunId got switched
  // by some other path). Cleared on delete-success and on a literal
  // "— pick —" selection.
  const [pickedSavedBuildId, setPickedSavedBuildId] = useState<string | null>(null);
  // Save-modal progress — separate from the build progress so the two
  // flows can render concurrently without one stomping the other's bar.
  const [saveProgress, setSaveProgress] = useState<SaveBuildProgress | null>(null);

  const selected = runs.find((r) => r.id === selectedRunId) ?? null;

  // Publish the active flow run so the PlanFlowRail can show it ("Working
  // run: …") and the Execution / Supply deep-links can target it. Written
  // whenever the selected run changes and on mount when one is already
  // selected. Contract: localStorage `ip_active_flow_run` = {runId, name}.
  useEffect(() => {
    if (!selected) return;
    try {
      localStorage.setItem(
        "ip_active_flow_run",
        JSON.stringify({ runId: selected.id, name: selected.name }),
      );
    } catch { /* ignore */ }
  }, [selected?.id, selected?.name]);
  // Is the currently-loaded run itself a saved build? Drives the
  // toolbar UX — when viewing a saved build, the primary action
  // becomes "Fork" (clone-of-clone for the edit/resave workflow);
  // the build/edit buttons stay live so the planner can tweak then
  // resave from inside the snapshot.
  // Prefer the planner's explicit pick from the Saved builds dropdown —
  // that's the source of truth for "is a saved build currently selected".
  // Fall back to the selectedRunId-based lookup so deeplinks / initial-load
  // paths still light the dropdown when the planner hasn't clicked it yet.
  const selectedSavedBuild =
    (pickedSavedBuildId ? savedBuilds.find((s) => s.id === pickedSavedBuildId) : null)
    ?? savedBuilds.find((s) => s.planning_run_id === selectedRunId)
    ?? null;

  const filterActive = !!buildFilter && Object.values(buildFilter).some((v) => v != null && v !== "");

  // Treat a run as "already built" when its updated_at is meaningfully
  // newer than created_at — the build pipeline writes forecast rows
  // and bumps updated_at, so a non-trivial gap means re-building will
  // overwrite existing data. New runs start with updated_at == created_at
  // (give or take milliseconds), so the >2s threshold avoids spurious
  // warnings on the very first build right after a run is created.
  const hasExistingBuild = !!selected
    && !!selected.updated_at
    && new Date(selected.updated_at).getTime() - new Date(selected.created_at).getTime() > 2000;

  function onBuildClick() {
    if (!selected) { onToast({ text: "Pick a run first", kind: "error" }); return; }
    if (building) {
      onToast({ text: "A build is already in progress — wait for it to finish or cancel.", kind: "info" });
      return;
    }
    if (hasExistingBuild) {
      setPendingRebuildConfirm(true);
      return;
    }
    void buildForecast();
  }

  async function buildForecast(opts: { wipeFirst?: boolean } = {}) {
    if (!selected) { onToast({ text: "Pick a run first", kind: "error" }); return; }
    const controller = new AbortController();
    abortRef.current = controller;
    setBuilding(true);
    setProgress({ phase: "loading", label: opts.wipeFirst ? "Wiping prior build…" : "Starting build…" });
    try {
      if (opts.wipeFirst) {
        const wiped = await wholesaleRepo.wipePlanningRunData(selected.id);
        onToast({
          text: `Wiped ${wiped.forecast.toLocaleString()} forecast · ${wiped.recs.toLocaleString()} recs · ${wiped.tbd.toLocaleString()} TBD · ${wiped.buckets.toLocaleString()} bucket buys · ${wiped.overrides.toLocaleString()} overrides — rebuilding from scratch.`,
          kind: "info",
        });
        setProgress({ phase: "loading", label: "Wiped — starting fresh build…" });
      }
      const result = await runForecastPass(selected, {
        filter: filterActive ? buildFilter ?? undefined : undefined,
        signal: controller.signal,
        onProgress: (p) => setProgress(p),
      });
      const lyCount = result.methods.ly_sales ?? 0;
      const lyNote = lyCount > 0 ? ` · ${lyCount} Same Period LY` : "";
      const filterNote = filterActive ? ` · filter excluded ${result.pairs_pruned_filter}` : "";
      const deadNote = result.pairs_pruned_dead > 0 ? ` · pruned ${result.pairs_pruned_dead} dead SKUs` : "";
      const appliedNote = result.requests_applied > 0
        ? ` · ${result.requests_applied} request${result.requests_applied === 1 ? "" : "s"} marked applied`
        : "";
      // A 0-row build almost always means the scope matched nothing — a
      // leftover grid filter, or a period filter whose months fall outside
      // this run's horizon. Never report that as a plain success; tell the
      // planner why and how to fix it.
      if (result.forecast_rows_written === 0) {
        const why = result.period_filter_out_of_horizon
          ? "your period filter selects months outside this run's horizon"
          : filterActive
            ? "the active grid filters matched no (customer, SKU) pairs in the horizon"
            : "no (customer, SKU) pairs had demand or inventory in the horizon";
        onToast({
          text: `Build wrote 0 forecast rows — ${why}. Clear the grid filters (the button should read “Build forecast”, not “Build (filtered)”) and check the run's horizon dates, then rebuild.`,
          kind: "error",
        });
      } else {
        const horizonNote = result.period_filter_out_of_horizon
          ? " · ⚠ period filter ignored (outside horizon)"
          : "";
        onToast({
          text: `Forecast built — ${result.forecast_rows_written} rows, ${result.recommendations_written} recs${appliedNote}${lyNote}${deadNote}${filterNote}${horizonNote}`,
          kind: "success",
        });
      }
      await onChange();
    } catch (e) {
      if (e instanceof BuildCancelledError) {
        onToast({ text: "Build cancelled — partial rows may remain in the run.", kind: "info" });
        await onChange();
      } else {
        onToast({
          text: "Forecast build failed — " + (e instanceof Error ? e.message : String(e)),
          kind: "error",
        });
      }
    } finally {
      abortRef.current = null;
      setBuilding(false);
      setProgress(null);
    }
  }

  function cancelBuild() {
    abortRef.current?.abort();
  }

  async function setStatus(status: IpPlanningRunStatus) {
    if (!selected) return;
    await wholesaleRepo.updatePlanningRun(selected.id, { status });
    await onChange();
  }

  // Permanently delete a planning run. CASCADE wipes all of its data
  // (forecasts / recommendations / projected / scenarios / approvals /
  // exports); a run with execution batches is RESTRICTed by the DB, which we
  // translate into a clear message.
  async function deleteRun() {
    if (!selected) return;
    const ok = await confirmDialog(
      `Permanently DELETE planning run "${selected.name}"?\n\n` +
      `This also deletes ALL of its data — forecasts, recommendations, projected inventory, ` +
      `scenarios, approvals and exports tied to this run. It cannot be undone.\n\n` +
      `(A run that already has execution batches can't be deleted — remove those in the Execution screen first.)`,
      { title: "Delete planning run", confirmText: "Delete run" },
    );
    if (!ok) return;
    try {
      await wholesaleRepo.deletePlanningRun(selected.id);
      onToast({ text: `Deleted planning run "${selected.name}"`, kind: "info" });
      if (selectedRunId === selected.id) onSelect("");
      await refreshSavedBuilds();
      await onChange();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      onToast({
        text: /23503|foreign key|violates/i.test(msg)
          ? "Can't delete — this run has execution batches. Delete them in the Execution screen first."
          : "Delete failed — " + msg,
        kind: "error",
      });
    }
  }

  // Turn the planner's own typed buys (the Buy column, planned_buy_qty) into
  // this run's buy plan directly — BYPASSING supply reconciliation. Writes one
  // `buy` recommendation per (sku, period), REPLACING any recs a reconciliation
  // pass computed. The execution batch + buy-plan export read recommendations,
  // so afterwards they reflect the planner's numbers, not the system's shortage
  // math. (Same action as the Scenario screen's "Push planner buys → plan",
  // exposed here so a live run doesn't have to route through a scenario.)
  async function pushPlannerBuys() {
    if (!selected) return;
    const ok = await confirmDialog(
      `Finalize the plan for "${selected.name}" from your typed Buy column?\n\n` +
      `This uses the planner-typed buy quantities (the Buy column) as this run's buy plan, ` +
      `skips supply reconciliation, and approves the run so it's ready for the Buy plan on the ` +
      `Execution screen. It REPLACES any reconciliation-computed recommendations for this run.`,
      { title: "Finalize with my buys", confirmText: "Finalize" },
    );
    if (!ok) return;
    setPushingBuys(true);
    setPushProgress({ stage: "Starting…" });
    try {
      const r = await generatePlannerBuyPlanForRun(selected.id, (p) => setPushProgress(p));
      if (r.recommendations > 0) {
        // Forward-pointing success modal instead of a bare toast.
        setPushResult({ lines: r.recommendations, units: r.units, skippedTbdLines: r.skippedTbdLines, skippedTbdUnits: r.skippedTbdUnits });
      } else if (r.skippedTbdLines > 0) {
        // Buys exist but ALL of them are on TBD rows whose style+color
        // isn't in the item master yet — nothing was pushed or approved.
        onToast({
          text: `Nothing pushed — all ${r.skippedTbdUnits.toLocaleString()} typed units are on ${r.skippedTbdLines.toLocaleString()} TBD row(s) whose style+color isn't in the item master yet. Use "Add to DB" on those rows, then Finalize again.`,
          kind: "error",
        });
      } else {
        onToast({
          text: "No typed buys found (the Buy column is empty for this run) — nothing to push.",
          kind: "info",
        });
      }
    } catch (e) {
      onToast({ text: "Finalize with my buys failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally {
      setPushingBuys(false);
      setPushProgress(null);
    }
  }

  // Load the saved-build list once on mount and again after any
  // mutation (save / fork / delete). Filtered to scenario_type
  // 'saved_build' so what-if/promo scenarios stay on their own page.
  async function refreshSavedBuilds() {
    setSavedBuildsLoading(true);
    try {
      const all = await scenarioRepo.listScenarios();
      setSavedBuilds(all.filter((s) => s.scenario_type === "saved_build"));
    } catch (e) {
      onToast({ text: "Failed to load saved builds: " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally {
      setSavedBuildsLoading(false);
    }
  }
  useEffect(() => { void refreshSavedBuilds(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function onSaveBuildSubmit() {
    if (!selected) { onToast({ text: "Pick a run first", kind: "error" }); return; }
    const name = savedBuildName.trim();
    if (!name) { onToast({ text: "Name the saved build first", kind: "error" }); return; }
    setSaveBuildBusy(true);
    setSaveProgress({ label: "Saving build…", done: 0, total: 1 });
    try {
      // If the planner is already viewing a saved build, save = fork
      // (clone-of-clone). The base for the new snapshot is the run
      // they're looking at, not its original parent.
      const scenario = await cloneBaseIntoSavedBuild({
        baseRunId: selected.id,
        name,
        note: savedBuildNote.trim() || null,
        onProgress: (update) => setSaveProgress(update),
      });
      onToast({ text: `Saved build "${name}" created`, kind: "success" });
      setShowSaveModal(false);
      setSavedBuildName("");
      setSavedBuildNote("");
      await refreshSavedBuilds();
      await onChange();
      // Switch the active run to the new snapshot so the planner
      // can immediately see / fork-edit it.
      setPickedSavedBuildId(scenario.id);
      onSelect(scenario.planning_run_id);
    } catch (e) {
      onToast({ text: "Save build failed: " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally {
      setSaveBuildBusy(false);
      setSaveProgress(null);
    }
  }

  function onLoadSavedBuild(planningRunId: string) {
    if (!planningRunId) {
      setPickedSavedBuildId(null);
      return;
    }
    const sb = savedBuilds.find((s) => s.planning_run_id === planningRunId);
    setPickedSavedBuildId(sb?.id ?? null);
    onSelect(planningRunId);
  }

  async function onConfirmDeleteSavedBuild() {
    if (!pendingDeleteSaved) return;
    const scenario = pendingDeleteSaved;
    try {
      await deleteSavedBuild(scenario.id);
      onToast({ text: `Deleted saved build "${scenario.scenario_name}"`, kind: "info" });
      // If we were viewing it, drop the selection.
      if (selectedRunId === scenario.planning_run_id) onSelect("");
      // Clear the explicit dropdown pick so the Delete button hides.
      if (pickedSavedBuildId === scenario.id) setPickedSavedBuildId(null);
      await refreshSavedBuilds();
      await onChange();
      // Brief "Deleted" confirmation in the dialog before it dismisses.
      setDeleteSucceeded(true);
      setTimeout(() => {
        setPendingDeleteSaved(null);
        setDeleteSucceeded(false);
      }, 1500);
    } catch (e) {
      onToast({ text: "Delete failed: " + (e instanceof Error ? e.message : String(e)), kind: "error" });
      setPendingDeleteSaved(null);
    }
  }

  // Card-level collapse toggle. Persists to localStorage so a planner
  // who hides the run controls keeps the extra vertical space across
  // reloads.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem("ws_planning_collapse_run") === "1"; } catch { return false; }
  });
  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem("ws_planning_collapse_run", next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  }

  return (
    <div style={{ ...S.card, marginBottom: 12, position: "relative" }}>
      <button
        type="button"
        onClick={toggleCollapsed}
        title={collapsed ? "Expand planning run" : "Collapse planning run"}
        aria-label={collapsed ? "Expand planning run" : "Collapse planning run"}
        style={{
          position: "absolute", top: 6, right: 6, width: 22, height: 22, padding: 0,
          background: "transparent", border: `1px solid ${PAL.border}`, color: PAL.textDim,
          borderRadius: 4, fontSize: 11, lineHeight: 1, cursor: "pointer",
          display: "inline-flex", alignItems: "center", justifyContent: "center", zIndex: 2,
        }}
      >{collapsed ? "▸" : "▾"}</button>
      <div style={S.toolbar}>
        <strong style={{ color: PAL.text, fontSize: 14 }}>Planning run</strong>
        {collapsed && selected && (
          <span style={{ color: PAL.textDim, fontSize: 12 }}>
            {selected.name} · {selected.status}
            {selected.build_vendor_id
              ? ` · vendor cost: ${poVendors.find((v) => v.vendor_id === selected.build_vendor_id)?.vendor_name ?? "selected"}`
              : ""}
          </span>
        )}
        {!collapsed && (<>
        {/* Filter out saved-build runs from the main dropdown — they
            live in their own selector below so the working-run list
            stays focused on live planning runs. */}
        <div style={{ minWidth: 260 }}>
          <SearchableSelect
            value={selectedRunId ?? ""}
            onChange={(v) => onSelect(v)}
            inputStyle={S.select}
            placeholder="— pick —"
            options={[
              { value: "", label: "— pick —" },
              ...runs
                .filter((r) => !savedBuilds.some((s) => s.planning_run_id === r.id))
                .map((r) => ({
                  value: r.id,
                  label: `${r.name} · ${r.status} · ${formatDate(r.horizon_start)}–${formatDate(r.horizon_end)}`,
                })),
            ]}
          />
        </div>
        <button style={S.btnSecondary} onClick={() => setShowNew(true)}>+ New run</button>
        {selected && !savedBuilds.some((s) => s.planning_run_id === selected.id) && (
          <button style={S.btnSecondary} onClick={() => setShowEdit(true)}
                  title="Edit this run's name and horizon dates — rebuild afterwards to apply new dates">Edit run</button>
        )}
        {selected && !savedBuilds.some((s) => s.planning_run_id === selected.id) && (
          <button style={{ ...S.btnSecondary, color: PAL.red, borderColor: PAL.red }} onClick={deleteRun}
                  title="Permanently delete this planning run and all its data">Delete run</button>
        )}
        {selected && showVendorSelect && (
          <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: PAL.textDim, fontSize: 12 }}>Vendor:</span>
            <div style={{ minWidth: 210 }}>
              <SearchableSelect
                value={selected.build_vendor_id ?? ""}
                onChange={(v) => void onVendorChange(v)}
                disabled={savingVendor}
                inputStyle={S.select}
                placeholder="— Any vendor —"
                options={[
                  { value: "", label: "— Any vendor —" },
                  ...poVendors.map((v) => ({
                    value: v.vendor_id,
                    label: v.vendor_code ? `${v.vendor_name} (${v.vendor_code})` : v.vendor_name,
                  })),
                ]}
              />
            </div>
            {selected.build_vendor_id && (
              <span
                title="Unit costs on this build are sourced from this vendor first: open POs, then the most-recent received PO for the style/color; otherwise the standard average + any-vendor PO cascade. Rebuild or reload to apply."
                style={{
                  display: "inline-flex", alignItems: "center", gap: 5,
                  fontSize: 11, fontWeight: 600, color: "#F1F5F9",
                  background: "#1E293B", border: "1px solid #334155",
                  borderRadius: 8, padding: "4px 9px", whiteSpace: "nowrap",
                }}
              >
                <span aria-hidden style={{ color: PAL.accent, fontSize: 13, lineHeight: 1 }}>&#9679;</span>
                Vendor cost: {poVendors.find((v) => v.vendor_id === selected.build_vendor_id)?.vendor_name ?? "selected vendor"}
              </span>
            )}
          </div>
        )}
        {selected && (
          <>
            {showBuild && (
              <button
                style={{ ...S.btnPrimary }}
                onClick={onBuildClick}
                disabled={building}
                title={filterActive
                  ? `Build only the rows matching the current grid filters: ${[
                      buildFilter?.customer_ids?.length ? `${buildFilter.customer_ids.length} customers` : buildFilter?.customer_id ? "customer" : null,
                      buildFilter?.style_codes?.length ? `${buildFilter.style_codes.length} styles` : buildFilter?.style_code ? `style=${buildFilter.style_code}` : null,
                      buildFilter?.group_names?.length ? `${buildFilter.group_names.length} categories` : buildFilter?.group_name ? `category=${buildFilter.group_name}` : null,
                      buildFilter?.sub_category_names?.length ? `${buildFilter.sub_category_names.length} sub-cats` : buildFilter?.sub_category_name ? `sub-cat=${buildFilter.sub_category_name}` : null,
                      buildFilter?.genders?.length ? `${buildFilter.genders.length} genders` : buildFilter?.gender ? `gender=${buildFilter.gender}` : null,
                      buildFilter?.period_code ? `period=${buildFilter.period_code}` : null,
                      // Action / confidence / method are output dims —
                      // surfaced here so the planner sees they're scoped
                      // away from the build at this moment, but not
                      // applied as inputs (they'd cause us to discard
                      // rows the build just computed).
                      buildFilter?.recommended_action ? `action=${buildFilter.recommended_action} (display only)` : null,
                      buildFilter?.confidence_level ? `confidence=${buildFilter.confidence_level} (display only)` : null,
                      buildFilter?.forecast_method ? `method=${buildFilter.forecast_method} (display only)` : null,
                    ].filter(Boolean).join(", ")}`
                  : "Build forecast for every (customer, sku) pair in the run"}
              >
                {building ? "Building…" : (filterActive ? "Build (filtered)" : "Build forecast")}
              </button>
            )}
            {/* The finalize affordances moved into the "Next step:" group at
                the end of the toolbar — see below. */}
            {/* Save / Fork — capture the current build (including planner
                edits, TBD rows, recs, bucket buys) as a snapshot. When
                viewing a saved build the label flips to "Fork & save"
                because what we're really doing is a clone-of-clone
                (preserves the original snapshot, branches a new one). */}
            <button
              style={S.btnSecondary}
              onClick={() => { setShowSaveModal(true); setSavedBuildName(""); setSavedBuildNote(""); }}
              disabled={building || saveBuildBusy}
              title={selectedSavedBuild
                ? "Fork this saved build into a SEPARATE new copy you can edit independently. Your current build already saves itself as you edit — use Fork only to branch off a second version."
                : "Save this build as a snapshot — preserves forecast rows, planner edits, TBD stock-buys, recs, bucket buys. Find it later in the Saved builds dropdown."}
            >
              {selectedSavedBuild ? "Fork" : "Save build"}
            </button>
            {/* When viewing a saved build, edits/added rows write straight to
                it — there is no pending "save". Say so, because the only
                save-like button here is "Fork", which reads as "you must fork
                to save" and confuses planners. */}
            {selectedSavedBuild && (
              <span
                title="This saved build is a live plan — every edit and added row saves to it automatically. There is no separate Save step. Use Fork only to branch off a separate copy."
                style={{
                  display: "inline-flex", alignItems: "center", gap: 5,
                  fontSize: 11, fontWeight: 600, color: "#10B981",
                  border: `1px solid ${PAL.border}`, borderRadius: 8, padding: "4px 9px",
                }}
              >
                ✓ Changes save automatically to this build
              </span>
            )}
            {selected.status !== "active" && (
              <button style={S.btnSecondary} onClick={() => setStatus("active")}>Mark active</button>
            )}
            {/* Quick jump to the scenario manager pre-targeted at this
                run as the base. The manager reads ?baseRunId from the
                URL and pre-fills the New Scenario form so the planner
                can fork and start tweaking assumptions in one click. */}
            <a
              href={`/planning/scenarios?baseRunId=${encodeURIComponent(selected.id)}`}
              style={{ ...S.btnSecondary, textDecoration: "none" }}
              title="Open Scenarios — fork this run into a what-if scenario, tune assumptions, compare to base"
            >
              What-if →
            </a>
            {/* Build Reconcile is a DIFFERENT screen from Supply reconciliation
                (it combines recommendations across multiple saved builds). Kept
                as a small link so that path isn't lost — the guided "Reconcile
                against supply first" button in the Next-step group goes to the
                Supply screen instead. */}
            <a
              href="/planning/reconcile"
              style={{ ...S.btnGhost, textDecoration: "none", fontSize: 12 }}
              title="Open Build Reconcile — combine recommendations across multiple saved builds into one buy plan (a separate tool from Supply reconciliation)"
            >
              Build reconcile
            </a>
          </>
        )}
        {/* Saved builds dropdown — always visible in the toolbar so the
            planner can switch focus between snapshots without going
            through a separate page. Selecting a saved build switches
            the active run to its underlying planning_run_id. */}
        <span style={{ color: PAL.textDim, fontSize: 12, marginLeft: 8 }}>Saved builds:</span>
        <SearchableSelect
          value={selectedSavedBuild?.planning_run_id ?? ""}
          onChange={(v) => onLoadSavedBuild(v)}
          disabled={savedBuildsLoading}
          inputStyle={{ ...S.select, minWidth: 220 }}
          options={[
            { value: "", label: savedBuildsLoading ? "Loading…" : (savedBuilds.length === 0 ? "— none yet —" : "— pick —") },
            ...savedBuilds.map((s) => ({
              value: s.planning_run_id,
              label: `${s.scenario_name} · ${formatDate(s.created_at.slice(0, 10))}`,
            })),
          ]}
        />
        {selectedSavedBuild && (
          <button
            style={{ ...S.btnSecondary, color: PAL.red, borderColor: PAL.red }}
            onClick={() => setPendingDeleteSaved(selectedSavedBuild)}
            title="Delete this saved build — drops the snapshot's planning run and every row tied to it. Cannot be undone."
          >
            Delete saved
          </button>
        )}
        {/* ── Next step ──────────────────────────────────────────────
            The two guided finalize paths, grouped at the end of the row.
            Hidden on saved-build snapshots (exactly like the old push
            button was) — you finalize a live run, not a snapshot. */}
        {selected && !selectedSavedBuild && (
          <div
            style={{
              marginLeft: "auto",
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "5px 10px",
              border: `1px solid ${PAL.border}`,
              borderRadius: 8,
              background: `${PAL.yellow}0D`,
            }}
          >
            <span style={{ color: PAL.textDim, fontSize: 12, fontWeight: 600 }}>Next step:</span>
            <button
              style={{ ...S.btnPrimary, background: "#EA580C" }}
              onClick={() => { void pushPlannerBuys(); }}
              disabled={building || pushingBuys}
              title="Finalize the plan from your typed Buy column: uses your buys verbatim, skips supply reconciliation, and approves the run so it's ready for the Buy plan on the Execution screen."
            >
              {pushingBuys ? "Finalizing…" : "Finalize with my buys →"}
            </button>
            <a
              href={`/planning/supply?fromRunId=${encodeURIComponent(selected.id)}`}
              style={{ ...S.btnSecondary, textDecoration: "none" }}
              title="Reconcile this run's demand against on-hand + inbound supply first, then finalize the computed buy recommendations."
            >
              Reconcile against supply first →
            </a>
          </div>
        )}
        </>)}
      </div>
      {building && progress && (
        <BuildStatusBar progress={progress} onCancel={cancelBuild} />
      )}
      {pushingBuys && pushProgress && (
        <FinalizeStatusBar progress={pushProgress} />
      )}
      {!collapsed && selected && (
        <div style={{ color: PAL.textMuted, fontSize: 12 }}>
          Snapshot {formatDate(selected.source_snapshot_date)}
          {selected.note ? ` · ${selected.note}` : ""}
        </div>
      )}
      {pushResult && selected && (
        <div
          role="dialog"
          aria-modal="true"
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}
          onClick={(e) => { if (e.target === e.currentTarget) setPushResult(null); }}
        >
          <div style={{ background: PAL.panel, border: `1px solid ${PAL.green}`, borderRadius: 10, padding: 18, width: "min(480px, 95vw)", boxSizing: "border-box", boxShadow: "0 8px 24px rgba(0,0,0,0.5)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span style={{ background: PAL.green, color: "#fff", borderRadius: 3, padding: "1px 6px", fontSize: 10, fontWeight: 700 }}>DONE</span>
              <strong style={{ color: PAL.text, fontSize: 14 }}>Buy plan finalized</strong>
            </div>
            <div style={{ color: PAL.textDim, fontSize: 13, lineHeight: 1.5, marginBottom: pushResult.skippedTbdLines > 0 ? 8 : 16 }}>
              {pushResult.lines.toLocaleString()} line{pushResult.lines === 1 ? "" : "s"} · {pushResult.units.toLocaleString()} units set as this run&apos;s buy plan and the run was approved.
            </div>
            {pushResult.skippedTbdLines > 0 && (
              <div style={{ color: PAL.yellow, fontSize: 12, lineHeight: 1.5, marginBottom: 16, border: `1px solid ${PAL.yellow}`, borderRadius: 6, padding: "6px 10px" }}>
                ⚠ {pushResult.skippedTbdLines.toLocaleString()} TBD line{pushResult.skippedTbdLines === 1 ? "" : "s"} · {pushResult.skippedTbdUnits.toLocaleString()} units were NOT included — their style+color isn&apos;t in the item master yet. Use &quot;Add to DB&quot; on those rows, then Finalize again to pick them up.
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button style={S.btnSecondary} onClick={() => setPushResult(null)}>Stay here</button>
              <button
                style={{ ...S.btnPrimary, background: "#EA580C" }}
                onClick={() => { window.location.href = `/planning/execution?fromRunId=${encodeURIComponent(selected.id)}&autoCreate=buy_plan`; }}
              >
                Continue to Buy plan →
              </button>
            </div>
          </div>
        </div>
      )}
      {showNew && (
        <NewRunModal scope={scope}
                     onClose={() => setShowNew(false)}
                     onToast={onToast}
                     onCreated={async (id) => {
                       setShowNew(false);
                       onSelect(id);
                       onToast({ text: "Planning run created", kind: "success" });
                       await onChange();
                     }} />
      )}
      {showEdit && selected && (
        <EditRunModal run={selected}
                      alreadyBuilt={hasExistingBuild}
                      onClose={() => setShowEdit(false)}
                      onToast={onToast}
                      onSaved={async (rebuild) => {
                        setShowEdit(false);
                        onToast({ text: "Planning run updated", kind: "success" });
                        // Reload so the selector + selected run reflect the new
                        // name/horizon, THEN (if asked) open the existing
                        // preserve-vs-wipe rebuild dialog against the fresh run.
                        await onChange();
                        if (rebuild) setPendingRebuildConfirm(true);
                      }} />
      )}
      {showSaveModal && selected && (
        <div
          role="dialog"
          aria-modal="true"
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}
          onClick={(e) => { if (e.target === e.currentTarget && !saveBuildBusy) setShowSaveModal(false); }}
        >
          <div style={{ background: PAL.panel, border: `1px solid ${PAL.border}`, borderRadius: 10, padding: 18, width: "min(520px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", boxShadow: "0 8px 24px rgba(0,0,0,0.5)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <strong style={{ color: PAL.text, fontSize: 14 }}>{selectedSavedBuild ? "Fork & save snapshot" : "Save this build as a snapshot"}</strong>
            </div>
            <div style={{ color: PAL.textDim, fontSize: 13, lineHeight: 1.5, marginBottom: 12 }}>
              Captures the current state of <strong style={{ color: PAL.text }}>{selected.name}</strong> — forecast rows, planner edits (override / buy / unit cost), TBD stock-buys, recommendations, bucket buys — into a new browseable run. Find it later in the <em>Saved builds</em> dropdown.
            </div>
            <label style={{ display: "block", color: PAL.textDim, fontSize: 12, marginBottom: 4 }}>Name</label>
            <input
              autoFocus
              type="text"
              value={savedBuildName}
              onChange={(e) => setSavedBuildName(e.target.value)}
              placeholder={selectedSavedBuild ? `${selectedSavedBuild.scenario_name} (copy)` : "e.g. Denim FW26"}
              style={{ ...S.input, width: "100%", marginBottom: 10 }}
              disabled={saveBuildBusy}
            />
            <label style={{ display: "block", color: PAL.textDim, fontSize: 12, marginBottom: 4 }}>Note (optional)</label>
            <textarea
              value={savedBuildNote}
              onChange={(e) => setSavedBuildNote(e.target.value)}
              placeholder="Anything you want to remember about this snapshot…"
              style={{ ...S.input, width: "100%", minHeight: 60, marginBottom: 14, fontFamily: "inherit" }}
              disabled={saveBuildBusy}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button style={S.btnSecondary} onClick={() => setShowSaveModal(false)} disabled={saveBuildBusy}>Cancel</button>
              <button
                style={{ ...S.btnPrimary, opacity: saveBuildBusy ? 0.6 : 1, cursor: saveBuildBusy ? "wait" : "pointer" }}
                onClick={() => void onSaveBuildSubmit()}
                disabled={saveBuildBusy || !savedBuildName.trim()}
              >
                {saveBuildBusy ? "Saving…" : (selectedSavedBuild ? "Fork & save" : "Save build")}
              </button>
            </div>
            {saveBuildBusy && saveProgress && (
              <div style={{ marginTop: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", color: PAL.textDim, fontSize: 12, marginBottom: 4 }}>
                  <span>{saveProgress.label}</span>
                  <span>
                    {saveProgress.total > 1
                      ? `${saveProgress.done.toLocaleString()} / ${saveProgress.total.toLocaleString()}`
                      : ""}
                  </span>
                </div>
                <div style={{ height: 6, background: PAL.border, borderRadius: 3, overflow: "hidden" }}>
                  <div
                    style={{
                      height: "100%",
                      width: `${Math.max(2, Math.min(100, Math.round(100 * saveProgress.done / Math.max(1, saveProgress.total))))}%`,
                      background: PAL.accent,
                      transition: "width 200ms ease-out",
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      {pendingDeleteSaved && (
        <div
          role="dialog"
          aria-modal="true"
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}
          onClick={(e) => { if (e.target === e.currentTarget && !deleteSucceeded) setPendingDeleteSaved(null); }}
        >
          <div style={{ background: PAL.panel, border: `1px solid ${deleteSucceeded ? PAL.green : PAL.red}`, borderRadius: 10, padding: 18, width: "min(520px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", boxShadow: "0 8px 24px rgba(0,0,0,0.5)" }}>
            {deleteSucceeded ? (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <span style={{ background: PAL.green, color: "#fff", borderRadius: 3, padding: "1px 6px", fontSize: 10, fontWeight: 700 }}>DELETED</span>
                  <strong style={{ color: PAL.text, fontSize: 14 }}>Saved build removed</strong>
                </div>
                <div style={{ color: PAL.textDim, fontSize: 13, lineHeight: 1.5 }}>
                  <strong style={{ color: PAL.text }}>{pendingDeleteSaved.scenario_name}</strong> and its planning-run rows have been deleted.
                </div>
              </>
            ) : (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <span style={{ background: PAL.red, color: "#fff", borderRadius: 3, padding: "1px 6px", fontSize: 10, fontWeight: 700 }}>DELETE</span>
                  <strong style={{ color: PAL.text, fontSize: 14 }}>Delete saved build?</strong>
                </div>
                <div style={{ color: PAL.textDim, fontSize: 13, lineHeight: 1.5, marginBottom: 14 }}>
                  <strong style={{ color: PAL.text }}>{pendingDeleteSaved.scenario_name}</strong> and every row tied to its underlying planning run will be permanently deleted. This cannot be undone.
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                  <button style={S.btnSecondary} onClick={() => setPendingDeleteSaved(null)}>Cancel</button>
                  <button style={{ ...S.btnPrimary, background: PAL.red, color: "#fff" }} onClick={() => void onConfirmDeleteSavedBuild()}>Delete</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {pendingRebuildConfirm && selected && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setPendingRebuildConfirm(false);
              setWipeStage("choice");
              setWipeTyped("");
            }
          }}
        >
          <div style={{
            background: PAL.panel, border: `1px solid ${wipeStage === "confirm" ? PAL.red : PAL.border}`, borderRadius: 10,
            padding: 18, width: "min(540px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
          }}>
            {wipeStage === "choice" && (<>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <span style={{ background: PAL.yellow, color: "#000", borderRadius: 3, padding: "1px 6px", fontSize: 10, fontWeight: 700 }}>WARNING</span>
                <strong style={{ color: PAL.text, fontSize: 14 }}>Rebuild this run?</strong>
              </div>
              <div style={{ color: PAL.textDim, fontSize: 13, lineHeight: 1.5, marginBottom: 14 }}>
                <strong style={{ color: PAL.text }}>{selected.name}</strong> already has a forecast built (last updated {formatDate(selected.updated_at)}). Two rebuild paths:
                <div style={{ marginTop: 10, padding: "8px 10px", background: `${PAL.yellow}11`, border: `1px solid ${PAL.yellow}55`, borderRadius: 6 }}>
                  <div style={{ color: PAL.yellow, fontWeight: 700, fontSize: 12, marginBottom: 4 }}>Rebuild (preserve edits)</div>
                  <div style={{ color: PAL.textDim, fontSize: 12 }}>
                    Upserts forecast rows in the current build scope. Out-of-scope rows from prior builds stay. Planner overrides (Buyer / Override / Buy / Unit Cost) and TBD stock-buy rows are preserved on rows that get re-upserted.
                  </div>
                </div>
                <div style={{ marginTop: 8, padding: "8px 10px", background: `${PAL.red}11`, border: `1px solid ${PAL.red}55`, borderRadius: 6 }}>
                  <div style={{ color: PAL.red, fontWeight: 700, fontSize: 12, marginBottom: 4 }}>Wipe + rebuild (destructive)</div>
                  <div style={{ color: PAL.textDim, fontSize: 12 }}>
                    Deletes <strong>every row tied to this run</strong> before rebuilding: forecast, recommendations, <strong>TBD stock-buy rows</strong>, <strong>bucket buys</strong>, and the override audit log. <strong>Planner edits — Buyer / Override / Buy / Unit Cost — are wiped</strong>. There is no undo.
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
                <button style={S.btnSecondary} onClick={() => { setPendingRebuildConfirm(false); setWipeStage("choice"); setWipeTyped(""); }}>Cancel</button>
                <button
                  style={{ ...S.btnPrimary, background: PAL.yellow, color: "#111" }}
                  onClick={() => { setPendingRebuildConfirm(false); setWipeStage("choice"); setWipeTyped(""); void buildForecast(); }}
                >
                  Rebuild (preserve edits)
                </button>
                <button
                  style={{ ...S.btnPrimary, background: PAL.red, color: "#fff" }}
                  onClick={() => { setWipeStage("confirm"); setWipeTyped(""); }}
                  title="Opens a final-confirmation step before deleting every row in this run."
                >
                  Wipe + rebuild
                </button>
              </div>
            </>)}
            {wipeStage === "confirm" && (<>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <span style={{ background: PAL.red, color: "#fff", borderRadius: 3, padding: "1px 6px", fontSize: 10, fontWeight: 700 }}>FINAL CONFIRMATION</span>
                <strong style={{ color: PAL.text, fontSize: 14 }}>Wipe + rebuild — irreversible</strong>
              </div>
              <div style={{ color: PAL.textDim, fontSize: 13, lineHeight: 1.5, marginBottom: 14 }}>
                You are about to permanently delete every row attached to <strong style={{ color: PAL.text }}>{selected.name}</strong>:
                <ul style={{ margin: "8px 0 0 16px", padding: 0, color: PAL.textDim, fontSize: 12, lineHeight: 1.6 }}>
                  <li>Forecast rows (system computed)</li>
                  <li>Buyer / Override / Buy / Unit Cost edits on those rows</li>
                  <li>Recommendations</li>
                  <li>TBD stock-buy rows (planner-added rows + new styles you've created)</li>
                  <li>Bucket-level buy aggregates</li>
                  <li>Override audit log</li>
                </ul>
                <div style={{ marginTop: 10, padding: "8px 10px", background: `${PAL.red}11`, border: `1px solid ${PAL.red}55`, borderRadius: 6, color: PAL.red, fontSize: 12, fontWeight: 600 }}>
                  This cannot be undone. Type the run name <span style={{ fontFamily: "monospace", color: PAL.text }}>{selected.name}</span> below to enable the button.
                </div>
              </div>
              {/* Lenient name compare — strict equality fails on
                  em-dash vs hyphen vs en-dash, on extra whitespace,
                  and on case differences when the planner types the
                  name from memory. Normalize both sides: lowercase,
                  trim, collapse whitespace, fold dashes to hyphen. */}
              {(() => {
                const normalize = (s: string) => s
                  .toLowerCase()
                  .trim()
                  .replace(/\s+/g, " ")
                  .replace(/[–—―−]/g, "-");
                const matches = normalize(wipeTyped) === normalize(selected.name);
                return (<>
                  <input
                    autoFocus
                    type="text"
                    value={wipeTyped}
                    onChange={(e) => setWipeTyped(e.target.value)}
                    placeholder={selected.name}
                    style={{
                      ...S.input, width: "100%", marginBottom: 12,
                      fontFamily: "monospace",
                      borderColor: matches ? PAL.red : PAL.border,
                    }}
                  />
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
                    <button style={S.btnSecondary} onClick={() => { setWipeStage("choice"); setWipeTyped(""); }}>Back</button>
                    <button
                      style={{
                        ...S.btnPrimary,
                        background: matches ? PAL.red : PAL.border,
                        color: "#fff",
                        cursor: matches ? "pointer" : "not-allowed",
                        opacity: matches ? 1 : 0.5,
                      }}
                      disabled={!matches}
                      onClick={() => { setPendingRebuildConfirm(false); setWipeStage("choice"); setWipeTyped(""); void buildForecast({ wipeFirst: true }); }}
                    >
                      Wipe everything + rebuild
                    </button>
                  </div>
                </>);
              })()}
            </>)}
          </div>
        </div>
      )}
    </div>
  );
}

function BuildStatusBar({ progress, onCancel }: { progress: BuildProgress; onCancel: () => void }) {
  const hasCount = progress.total != null && progress.total > 0;
  const pct = hasCount ? Math.min(100, Math.round((100 * (progress.current ?? 0)) / progress.total!)) : null;
  const countLabel = hasCount
    ? ` · ${(progress.current ?? 0).toLocaleString()} / ${progress.total!.toLocaleString()}${pct != null ? ` (${pct}%)` : ""}`
    : "";
  return (
    <div style={{ marginTop: 10, padding: 10, background: PAL.bg, borderRadius: 8, border: `1px solid ${PAL.border}` }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 6 }}>
        <div style={{ fontSize: 12, color: PAL.text }}>
          {progress.label}{countLabel}
        </div>
        <button style={S.btnSecondary} onClick={onCancel}>Cancel</button>
      </div>
      <div style={{ height: 4, background: PAL.border, borderRadius: 2, overflow: "hidden" }}>
        <div
          style={{
            height: "100%",
            width: pct != null ? `${pct}%` : "30%",
            background: PAL.accent,
            transition: "width 200ms ease",
            // When count is unknown, animate an indeterminate bar.
            animation: pct == null ? "ipBuildPulse 1.4s ease-in-out infinite" : undefined,
          }}
        />
      </div>
      <style>{`@keyframes ipBuildPulse { 0% { margin-left: 0%; } 50% { margin-left: 70%; } 100% { margin-left: 0%; } }`}</style>
    </div>
  );
}

// Status bar for the "Finalize with my buys" push. Deliberately mirrors
// BuildStatusBar's visual language (same surface, 4px accent track,
// indeterminate pulse when there's no known count) so the two flows read as
// one system. No Cancel button — the finalize push isn't abortable.
function FinalizeStatusBar({ progress }: { progress: PlannerBuyPlanProgress }) {
  const hasCount = progress.total != null && progress.total > 0;
  const pct = hasCount ? Math.min(100, Math.round((100 * (progress.current ?? 0)) / progress.total!)) : null;
  const countLabel = hasCount
    ? ` · ${(progress.current ?? 0).toLocaleString()} / ${progress.total!.toLocaleString()}${pct != null ? ` (${pct}%)` : ""}`
    : "";
  const detail = progress.detail ? ` · ${progress.detail}` : "";
  return (
    <div style={{ marginTop: 10, padding: 10, background: PAL.bg, borderRadius: 8, border: `1px solid ${PAL.border}` }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 6 }}>
        <div style={{ fontSize: 12, color: PAL.text }}>
          <span style={{ color: "#EA580C", fontWeight: 700, marginRight: 6 }}>Finalizing</span>
          {progress.stage}{detail}{countLabel}
        </div>
      </div>
      <div style={{ height: 4, background: PAL.border, borderRadius: 2, overflow: "hidden" }}>
        <div
          style={{
            height: "100%",
            width: pct != null ? `${pct}%` : "30%",
            background: PAL.accent,
            transition: "width 200ms ease",
            animation: pct == null ? "ipBuildPulse 1.4s ease-in-out infinite" : undefined,
          }}
        />
      </div>
      <style>{`@keyframes ipBuildPulse { 0% { margin-left: 0%; } 50% { margin-left: 70%; } 100% { margin-left: 0%; } }`}</style>
    </div>
  );
}

function NewRunModal({ onClose, onCreated, onToast, scope }: {
  onClose: () => void;
  onCreated: (id: string) => Promise<void>;
  onToast: (t: ToastMessage) => void;
  scope: "wholesale" | "ecom" | "all";
}) {
  const today = new Date();
  const yyyy = today.getUTCFullYear();
  const mm = String(today.getUTCMonth() + 1).padStart(2, "0");
  const defaultStart = `${yyyy}-${mm}-01`;
  const endD = new Date(Date.UTC(yyyy, today.getUTCMonth() + 5, 0));
  const defaultEnd = endD.toISOString().slice(0, 10);

  const defaultName = scope === "ecom" ? `Ecom — ${yyyy}-${mm}` : scope === "all" ? `Combined — ${yyyy}-${mm}` : `Wholesale — ${yyyy}-${mm}`;
  const [name, setName] = useState(defaultName);
  const [horizonStart, setHorizonStart] = useState(defaultStart);
  const [horizonEnd, setHorizonEnd] = useState(defaultEnd);
  const [snapshot, setSnapshot] = useState(today.toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!name.trim()) { onToast({ text: "Name is required", kind: "error" }); return; }
    if (horizonEnd < horizonStart) { onToast({ text: "Horizon end is before start", kind: "error" }); return; }
    setSaving(true);
    try {
      const r = await wholesaleRepo.createPlanningRun({
        name: name.trim(),
        planning_scope: scope,
        status: "draft",
        source_snapshot_date: snapshot,
        horizon_start: horizonStart,
        horizon_end: horizonEnd,
        forecast_method_preference: "ly_sales",
        wholesale_source_run_id: null,
        ecom_source_run_id: null,
        note: note.trim() || null,
        created_by: null,
      });
      await onCreated(r.id);
    } catch (e) {
      onToast({ text: "Couldn't create run — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={S.drawerOverlay} onClick={onClose}>
      <div style={S.drawer} onClick={(e) => e.stopPropagation()}>
        <div style={S.drawerHeader}>
          <h3 style={{ margin: 0, fontSize: 16 }}>New planning run</h3>
          <button style={S.btnGhost} onClick={onClose}>✕</button>
        </div>
        <div style={S.drawerBody}>
          <div style={{ display: "grid", gap: 10 }}>
            <div>
              <label style={S.label}>Name</label>
              <input style={{ ...S.input, width: "100%" }} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div>
                <label style={S.label}>Horizon start</label>
                <AppDatePicker style={{ ...S.input, width: "100%" }} value={horizonStart} onCommit={setHorizonStart} />
              </div>
              <div>
                <label style={S.label}>Horizon end</label>
                <AppDatePicker style={{ ...S.input, width: "100%" }} value={horizonEnd} onCommit={setHorizonEnd} />
              </div>
              <div>
                <label style={S.label}>Snapshot date</label>
                <AppDatePicker style={{ ...S.input, width: "100%" }} value={snapshot} onCommit={setSnapshot} />
              </div>
            </div>
            <div>
              <label style={S.label}>Note</label>
              <input style={{ ...S.input, width: "100%" }} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
              <button style={S.btnSecondary} onClick={onClose}>Cancel</button>
              <button style={S.btnPrimary} onClick={save} disabled={saving}>
                {saving ? "Creating…" : "Create run"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Edit an existing run's name + horizon dates (+ snapshot / note). Mirrors
// NewRunModal but pre-filled and calls updatePlanningRun. When the run is
// already built, offers "Save & rebuild" — changing the horizon leaves the
// prior forecast stale, so the planner is nudged to rebuild; the actual
// rebuild reuses the parent's preserve-vs-wipe confirm dialog.
function EditRunModal({ run, alreadyBuilt, onClose, onSaved, onToast }: {
  run: IpPlanningRun;
  alreadyBuilt: boolean;
  onClose: () => void;
  onSaved: (rebuild: boolean) => Promise<void>;
  onToast: (t: ToastMessage) => void;
}) {
  const [name, setName] = useState(run.name);
  const [horizonStart, setHorizonStart] = useState(run.horizon_start ?? "");
  const [horizonEnd, setHorizonEnd] = useState(run.horizon_end ?? "");
  const [snapshot, setSnapshot] = useState(run.source_snapshot_date);
  const [note, setNote] = useState(run.note ?? "");
  const [saving, setSaving] = useState(false);

  const horizonChanged = horizonStart !== (run.horizon_start ?? "")
    || horizonEnd !== (run.horizon_end ?? "")
    || snapshot !== run.source_snapshot_date;

  async function save(rebuild: boolean) {
    if (!name.trim()) { onToast({ text: "Name is required", kind: "error" }); return; }
    if (!horizonStart || !horizonEnd) { onToast({ text: "Horizon start and end are required", kind: "error" }); return; }
    if (horizonEnd < horizonStart) { onToast({ text: "Horizon end is before start", kind: "error" }); return; }
    setSaving(true);
    try {
      await wholesaleRepo.updatePlanningRun(run.id, {
        name: name.trim(),
        horizon_start: horizonStart,
        horizon_end: horizonEnd,
        source_snapshot_date: snapshot,
        note: note.trim() || null,
      });
      await onSaved(rebuild);
    } catch (e) {
      onToast({ text: "Couldn't update run — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={S.drawerOverlay} onClick={onClose}>
      <div style={S.drawer} onClick={(e) => e.stopPropagation()}>
        <div style={S.drawerHeader}>
          <h3 style={{ margin: 0, fontSize: 16 }}>Edit planning run</h3>
          <button style={S.btnGhost} onClick={onClose}>✕</button>
        </div>
        <div style={S.drawerBody}>
          <div style={{ display: "grid", gap: 10 }}>
            <div>
              <label style={S.label}>Name</label>
              <input style={{ ...S.input, width: "100%" }} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div>
                <label style={S.label}>Horizon start</label>
                <AppDatePicker style={{ ...S.input, width: "100%" }} value={horizonStart} onCommit={setHorizonStart} />
              </div>
              <div>
                <label style={S.label}>Horizon end</label>
                <AppDatePicker style={{ ...S.input, width: "100%" }} value={horizonEnd} onCommit={setHorizonEnd} />
              </div>
              <div>
                <label style={S.label}>Snapshot date</label>
                <AppDatePicker style={{ ...S.input, width: "100%" }} value={snapshot} onCommit={setSnapshot} />
              </div>
            </div>
            <div>
              <label style={S.label}>Note</label>
              <input style={{ ...S.input, width: "100%" }} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            {alreadyBuilt && horizonChanged && (
              <div style={{ padding: "8px 10px", background: `${PAL.yellow}11`, border: `1px solid ${PAL.yellow}55`, borderRadius: 6, color: PAL.textDim, fontSize: 12 }}>
                This run is already built. You changed the horizon/snapshot, so the existing forecast is now stale — use <strong style={{ color: PAL.text }}>Save & rebuild</strong> to recompute for the new dates.
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
              <button style={S.btnSecondary} onClick={onClose} disabled={saving}>Cancel</button>
              <button style={S.btnSecondary} onClick={() => void save(false)} disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </button>
              {alreadyBuilt && (
                <button style={S.btnPrimary} onClick={() => void save(true)} disabled={saving}
                        title="Save the changes, then open the rebuild dialog to recompute the forecast for the new horizon">
                  {saving ? "Saving…" : "Save & rebuild"}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

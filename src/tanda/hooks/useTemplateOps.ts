import { SB_URL, SB_HEADERS } from "../../utils/supabase";
import { type WipTemplate, type DCVendor, DEFAULT_WIP_TEMPLATES } from "../../utils/tandaTypes";
import { useTandaStore } from "../store/index";

export function useTemplateOps() {
  const coreSet = useTandaStore.getState().setCoreField;

  // ── helpers to read / write store outside React render ──
  const getWipTemplates = () => useTandaStore.getState().wipTemplates;
  const setWipTemplates = (v: any) => {
    if (typeof v === "function") coreSet("wipTemplates", v(useTandaStore.getState().wipTemplates));
    else coreSet("wipTemplates", v);
  };
  const setDesignTemplates = (v: any) => coreSet("designTemplates", v);
  const setDcVendors = (v: any) => coreSet("dcVendors", v);

  async function _saveWipTemplatesRaw(all: Record<string, WipTemplate[]>) {
    await fetch(`${SB_URL}/rest/v1/app_data`, {
      method: "POST",
      headers: { ...SB_HEADERS, "Prefer": "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ key: "wip_templates", value: JSON.stringify(all) }),
    });
  }

  async function loadWipTemplates() {
    try {
      const res = await fetch(`${SB_URL}/rest/v1/app_data?key=eq.wip_templates&select=value`, { headers: SB_HEADERS });
      const rows = await res.json();
      if (Array.isArray(rows) && rows.length > 0 && rows[0].value) {
        const parsed = JSON.parse(rows[0].value);
        // Migrate: if old format was an array, convert to { __default__: [...] }
        if (Array.isArray(parsed)) {
          const migrated = { __default__: parsed };
          setWipTemplates(migrated);
          // Save migrated format back
          await _saveWipTemplatesRaw(migrated);
          return migrated;
        }
        if (parsed && typeof parsed === "object") {
          // Ensure __default__ exists
          if (!parsed.__default__) parsed.__default__ = DEFAULT_WIP_TEMPLATES;
          // Migrate: move "Top Sample" from Transit → Samples (last in Samples) in every vendor template
          let migrationNeeded = false;
          for (const key of Object.keys(parsed)) {
            const tpls: WipTemplate[] = parsed[key];
            const idx = tpls.findIndex(t => (t.id === "wip_topsample" || t.phase === "Top Sample") && t.category === "Transit");
            if (idx === -1) continue;
            migrationNeeded = true;
            const arr = [...tpls];
            const [ts] = arr.splice(idx, 1);
            const updated = { ...ts, category: "Samples" };
            const lastSamples = arr.reduce((last, t, i) => t.category === "Samples" ? i : last, -1);
            arr.splice(lastSamples + 1, 0, updated);
            parsed[key] = arr;
          }
          if (migrationNeeded) await _saveWipTemplatesRaw(parsed);
          setWipTemplates(parsed);
          return parsed;
        }
      }
    } catch {}
    const defaults = { __default__: DEFAULT_WIP_TEMPLATES };
    setWipTemplates(defaults);
    return defaults;
  }

  async function saveVendorTemplates(vendorKey: string, templates: WipTemplate[]) {
    const updated = { ...getWipTemplates(), [vendorKey]: templates };
    setWipTemplates(updated);
    await _saveWipTemplatesRaw(updated);
  }

  async function deleteVendorTemplate(vendorKey: string) {
    const updated = { ...getWipTemplates() };
    delete updated[vendorKey];
    setWipTemplates(updated);
    await _saveWipTemplatesRaw(updated);
  }

  function getVendorTemplates(vendorName?: string): WipTemplate[] {
    const wt = getWipTemplates();
    if (vendorName && wt[vendorName]) return wt[vendorName];
    return wt.__default__ || DEFAULT_WIP_TEMPLATES;
  }

  function vendorHasTemplate(vendorName: string): boolean {
    const tpl = getWipTemplates()[vendorName];
    return !!(vendorName && tpl && tpl.length > 0);
  }

  function templateVendorList(): string[] {
    return Object.keys(getWipTemplates()).filter(k => k !== "__default__").sort();
  }

  async function loadDesignTemplates() {
    try {
      const res = await fetch(`${SB_URL}/rest/v1/app_data?key=eq.task_templates&select=value`, { headers: SB_HEADERS });
      const rows = await res.json();
      if (Array.isArray(rows) && rows.length > 0 && rows[0].value) {
        const parsed = JSON.parse(rows[0].value);
        if (Array.isArray(parsed)) setDesignTemplates(parsed);
      }
    } catch {}
  }

  async function loadDCVendors() {
    try {
      const res = await fetch(`${SB_URL}/rest/v1/app_data?key=eq.vendors&select=value`, { headers: SB_HEADERS });
      const rows = await res.json();
      if (Array.isArray(rows) && rows.length > 0 && rows[0].value) {
        const parsed = JSON.parse(rows[0].value);
        if (Array.isArray(parsed)) setDcVendors(parsed);
      }
    } catch {}
  }

  // Sync vendor names from PO WIP into Design Calendar's vendor list.
  // replace=true: set DC vendors = vendorNames (preserve existing settings where names match, drop the rest)
  // replace=false: add-only — append any names not already in DC
  async function syncVendorsToDC(replace: boolean, vendorNames: string[]) {
    try {
      const res = await fetch(`${SB_URL}/rest/v1/app_data?key=eq.vendors&select=value`, { headers: SB_HEADERS });
      const rows = await res.json();
      const existing: any[] = (Array.isArray(rows) && rows.length > 0 && rows[0].value)
        ? (JSON.parse(rows[0].value) || []) : [];

      const mkVendor = (name: string) => ({
        id: Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
        name,
        country: "",
        transitDays: 21,
        categories: [],
        contact: "",
        email: "",
        moq: 0,
        leadOverrides: {},
        wipLeadOverrides: {},
      });

      let updated: any[];
      if (replace) {
        // Build from vendorNames, preserving existing entries where names match
        updated = vendorNames.map(name => existing.find(v => v.name === name) || mkVendor(name));
      } else {
        const existingNames = new Set(existing.map((v: any) => v.name));
        const toAdd = vendorNames.filter(name => !existingNames.has(name));
        if (toAdd.length === 0) return;
        updated = [...existing, ...toAdd.map(mkVendor)];
      }

      await fetch(`${SB_URL}/rest/v1/app_data`, {
        method: "POST",
        headers: { ...SB_HEADERS, "Prefer": "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ key: "vendors", value: JSON.stringify(updated) }),
      });
      setDcVendors(updated);
    } catch (e) {
      console.error("Failed to sync vendors to DC:", e);
    }
  }

  return {
    loadWipTemplates,
    saveVendorTemplates,
    deleteVendorTemplate,
    getVendorTemplates,
    vendorHasTemplate,
    templateVendorList,
    loadDesignTemplates,
    loadDCVendors,
    syncVendorsToDC,
  };
}

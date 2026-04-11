import { CUSTOMER_CHANNEL_MAP } from "./theme";
import { SKU_DESC_BY_CAT, COLORWAY_SETS, FABRICS, DEFAULT_TASK_TEMPLATES } from "./constants";
import { uid, getBrand, addDays, diffDays, addDaysForPhase } from "./dates";

export function fileToDataURL(f: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = (e) => res((e.target as FileReader).result as string);
    r.onerror = rej;
    r.readAsDataURL(f);
  });
}

// Upload a file to Dropbox via proxy and return a permanent public URL
export async function dbxUploadFileGlobal(file: File, folder = "images"): Promise<string | null> {
  try {
    const safeName = `${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const dbxPath = `/Eran Bitton/Apps/design-calendar-app/${folder}/${safeName}`;
    const res = await fetch("/api/dropbox-proxy", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-Dropbox-Action": "upload", "X-Dropbox-Path": dbxPath },
      body: file,
    });
    if (!res.ok) { console.warn("Dropbox upload failed:", res.status); return null; }
    const data = await res.json();
    console.log("[Dropbox] uploaded:", data.path_display);
    return data.shared_url || null;
  } catch (e) { console.warn("Dropbox upload error", e); return null; }
}

export function getChannelForCustomer(customer: string): string {
  return CUSTOMER_CHANNEL_MAP[customer] || "";
}

export function genStyleNum(brand: string, category: string, index: number): string {
  const bmap: Record<string, string> = {
    "ring-of-fire": "ROF",
    departed: "DEP",
    "fort-knox": "FKX",
    "axe-crown": "AXC",
    "blue-rise": "BLR",
    "ross-pl": "RSP",
    "macys-pl": "MCP",
  };
  const cmap: Record<string, string> = {
    Denim: "DN",
    "Twill Pants": "TW",
    Fleece: "FL",
    "Woven Tops": "WV",
    "Knit Tops": "KN",
    Outerwear: "OW",
    Shorts: "SH",
    "Printed T-Shirts": "PT",
  };
  const prefix = (bmap[brand] || "ROF") + "-" + (cmap[category] || "XX");
  const num = String(1000 + Math.floor(Math.random() * 900) + index).slice(-4);
  return `${prefix}-${num}`;
}

export function autoGenSkus(brand: string, category: string, count: number) {
  const descs = SKU_DESC_BY_CAT[category] || SKU_DESC_BY_CAT["Knit Tops"];
  return Array.from({ length: count }, (_, i) => ({
    id: uid(),
    styleNum: genStyleNum(brand, category, i),
    description: descs[i % descs.length],
    colorways: COLORWAY_SETS[i % COLORWAY_SETS.length].join(" / "),
    fabric: FABRICS[i % FABRICS.length],
    sizes: ["S", "M", "L", "XL"],
    units: Math.floor(Math.random() * 500 + 200),
    fob: "",
    landed: "",
    wholesale: "",
    retail: "",
    marginPct: "",
    images: [],
  }));
}

export function generateTasks({
  brand,
  collection,
  season,
  category,
  vendorId,
  ddpDate,
  customerShipDate,
  cancelDate,
  vendors,
  pdId,
  designerId,
  graphicId,
  customer,
  orderType,
  channelType,
  taskTemplates,
}: {
  brand: string;
  collection: string;
  season: string;
  category: string;
  vendorId: string;
  ddpDate: string;
  customerShipDate?: string;
  cancelDate?: string;
  vendors: any[];
  pdId?: string;
  designerId?: string;
  graphicId?: string;
  customer?: string;
  orderType?: string;
  channelType?: string;
  taskTemplates?: any[];
}) {
  const vendor = vendors.find((v) => v.id === vendorId);
  const transit = vendor?.transitDays || 21;

  // Use task templates if available, else fall back to DEFAULT_TASK_TEMPLATES
  const templates = (taskTemplates && taskTemplates.length > 0)
    ? taskTemplates
    : DEFAULT_TASK_TEMPLATES;

  // Vendor can override daysBeforeDDP per phase via vendor.leadOverrides
  const vendorOverrides = vendor?.leadOverrides || {};

  const isPrivate = getBrand(brand)?.isPrivateLabel || false;

  // Build phases from templates
  let phases = templates.map((tpl: any) => {
    // Vendor override takes priority, then template default
    let daysBack = vendorOverrides[tpl.phase] !== undefined
      ? Number(vendorOverrides[tpl.phase])
      : Number(tpl.daysBeforeDDP ?? 0);
    if (isNaN(daysBack)) daysBack = 0;
    // Ship Date uses transit days
    if (tpl.phase === "Ship Date") daysBack = transit;
    return { name: tpl.phase, daysBack, status: tpl.status || "Not Started", notes: tpl.notes || "", templateId: tpl.id };
  });

  if (isPrivate) {
    const bulkIdx = phases.findIndex((p: any) => p.name === "Purchase Order");
    const bulkDays = phases[bulkIdx]?.daysBack || 70;
    phases.splice(
      bulkIdx,
      0,
      { name: "Line Review", daysBack: bulkDays + 42, status: "Not Started", notes: "", templateId: null },
      { name: "Compliance/Testing", daysBack: bulkDays + 21, status: "Not Started", notes: "", templateId: null }
    );
  }

  // QC = Production due date + 3 calendar days (post-PO = calendar days)
  const prodPhase = phases.find((p: any) => p.name === "Production");
  if (prodPhase) {
    const prodDue = addDays(ddpDate, -prodPhase.daysBack);
    const qcDue = addDays(prodDue, 3);
    const qcDaysBack = Math.max(0, diffDays(ddpDate, qcDue));
    phases = phases.map((p: any) =>
      p.name === "QC" ? { ...p, daysBack: qcDaysBack } : p
    );
  }

  const shipDate = addDays(ddpDate, -transit);
  const base = {
    brand,
    collection,
    season,
    category,
    vendorId: vendorId || null,
    vendorName: vendor?.name || "",
    deliveryDate: ddpDate,
    ddpDate,
    customerShipDate: customerShipDate || addDays(shipDate, 6),
    cancelDate: cancelDate || addDays(addDays(shipDate, 6), 6),
    customer: customer || "",
    orderType: orderType || "",
    channelType: channelType || getChannelForCustomer(customer || "") || "",
    pdId: pdId || null,
    designerId: designerId || null,
    graphicId: graphicId || null,
  };

  return phases.map((p: any) => {
    const daysBack = isNaN(p.daysBack) ? 0 : Math.max(0, p.daysBack);
    // Pre-PO phases use business days (Fri=0.5, weekends/holidays skip);
    // post-PO phases (Production, QC, Ship Date, DDP) use calendar days.
    const due = ddpDate ? addDaysForPhase(ddpDate, -daysBack, p.name) : "";
    return {
      id: uid(),
      ...base,
      phase: p.name,
      status: p.status || "Not Started",
      due,
      originalDue: due,
      notes: p.notes || "",
      assigneeId: null,
      history: [],
      images: [],
    };
  });
}

export function cascadeDates(tasks: any[], collectionKey: string, changedTaskId: string, newDue: string) {
  const collTasks = tasks
    .filter((t) => `${t.brand}||${t.collection}` === collectionKey)
    .sort((a, b) => new Date(a.due).getTime() - new Date(b.due).getTime());
  const changedIdx = collTasks.findIndex((t) => t.id === changedTaskId);
  if (changedIdx < 0)
    return {
      updatedTasks: tasks,
      ddpChanged: false,
      newDDP: null,
      oldDDP: null,
    };

  const oldDue = collTasks[changedIdx].due;
  const delta = diffDays(newDue, oldDue);
  if (delta === 0)
    return {
      updatedTasks: tasks,
      ddpChanged: false,
      newDDP: null,
      oldDDP: null,
    };

  const ddpTask = collTasks.find((t) => t.phase === "DDP");
  const oldDDP = ddpTask?.due;

  // Only shift tasks that come AFTER the changed task — tasks behind it stay unchanged
  const updatedTasks = tasks.map((t) => {
    if (`${t.brand}||${t.collection}` !== collectionKey) return t;
    if (t.id === changedTaskId) return { ...t, due: newDue };
    const tIdx = collTasks.findIndex((c) => c.id === t.id);
    if (tIdx > changedIdx) return { ...t, due: addDays(t.due, delta) };
    return t;
  });

  const newDDPTask = updatedTasks.find((t) => t.id === ddpTask?.id);
  const newDDP = newDDPTask?.due;
  // Warn whenever DDP changes (either direction)
  const ddpChanged = !!(oldDDP && newDDP && newDDP !== oldDDP);

  return {
    updatedTasks,
    ddpChanged,
    newDDP,
    oldDDP,
    delta,
    affectedCount: collTasks.length - changedIdx - 1,
  };
}

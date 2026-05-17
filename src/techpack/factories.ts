// Empty-state factories for the TechPack data model. Used whenever
// a planner clicks "New tech pack" (emptyTechPack) or when an existing
// tech pack is missing the costing / approval blocks during a schema
// migration window (emptyCosting / emptyApprovals).
//
// Extracted from TechPack.tsx so the seed shapes have one source of
// truth + are testable end-to-end (every required field present,
// approval stages match the canonical list, etc.).

import { APPROVAL_STAGES } from "./constants";
import type { Approval, Costing, Material, TechPack, User } from "./types";
import { today, uid } from "./utils";

export function emptyCosting(): Costing {
  return {
    fob: 0, duty: 0, dutyRate: 0, freight: 0, insurance: 0, otherCosts: 0,
    landedCost: 0, wholesalePrice: 0, retailPrice: 0, margin: 0, notes: "",
  };
}

export function emptyApprovals(): Approval[] {
  return APPROVAL_STAGES.map(stage => ({
    id: uid(),
    stage,
    approver: "",
    status: "Pending" as const,
    date: null,
    comments: "",
  }));
}

/**
 * Form-bound shape used by the Material modal in TechPack.tsx.
 * `certifications` is a comma-separated string in the form (free
 * text input); `materialFromForm` splits + trims it into the
 * `string[]` the database expects.
 */
export interface MaterialFormValues {
  name: string;
  type: string;
  composition: string;
  weight: string;
  width: string;
  color: string;
  supplier: string;
  unitPrice: number;
  moq: string;
  leadTime: string;
  /** Comma-separated certifications string from the form input. */
  certifications: string;
  notes: string;
}

/** Default values for the Material modal form — used on open + after save. */
export const EMPTY_MATERIAL_FORM: MaterialFormValues = {
  name: "", type: "Fabric", composition: "", weight: "", width: "",
  color: "", supplier: "", unitPrice: 0, moq: "", leadTime: "",
  certifications: "", notes: "",
};

/**
 * Build a Material from the modal form values. When editing an
 * existing material, preserve its `id` + `createdAt`; otherwise
 * mint fresh ones. The `certifications` CSV string is split on
 * commas, trimmed, and empty entries dropped.
 *
 * `todayFn` is injected so tests can pin a deterministic date.
 */
export function materialFromForm(
  form: MaterialFormValues,
  editing: Material | null,
  todayFn: () => string = today,
): Material {
  return {
    id:           editing?.id || uid(),
    name:         form.name,
    type:         form.type,
    composition:  form.composition,
    weight:       form.weight,
    width:        form.width,
    color:        form.color,
    supplier:     form.supplier,
    unitPrice:    form.unitPrice,
    moq:          form.moq,
    leadTime:     form.leadTime,
    certifications: form.certifications.split(",").map(s => s.trim()).filter(Boolean),
    notes:        form.notes,
    createdAt:    editing?.createdAt || todayFn(),
  };
}

export function emptyTechPack(user: User): TechPack {
  return {
    id: uid(),
    styleName: "", styleNumber: "", brand: "", season: "",
    category: "", subCategory: "", description: "",
    designer: user.name || user.username || "",
    gender: "", vendor: "", techDesigner: "", graphicArtist: "", productDeveloper: "",
    division: "", owner: "", active: true, version: 1,
    status: "Draft",
    createdAt: today(),
    updatedAt: today(),
    updatedBy: user.name || user.username || "",
    colorways: [],
    flatSketch: {
      frontImage: null, backImage: null, callouts: [],
      stitchingDetails: "", measurementNote: "",
    },
    measurements: [],
    construction: [],
    bom: [],
    costing: emptyCosting(),
    approvals: emptyApprovals(),
    samples: [],
    images: [],
  };
}

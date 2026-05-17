// Empty-state factories for the TechPack data model. Used whenever
// a planner clicks "New tech pack" (emptyTechPack) or when an existing
// tech pack is missing the costing / approval blocks during a schema
// migration window (emptyCosting / emptyApprovals).
//
// Extracted from TechPack.tsx so the seed shapes have one source of
// truth + are testable end-to-end (every required field present,
// approval stages match the canonical list, etc.).

import { APPROVAL_STAGES } from "./constants";
import type { Approval, Costing, TechPack, User } from "./types";
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

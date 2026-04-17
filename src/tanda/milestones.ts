import { type Milestone, type WipTemplate, milestoneUid } from "../utils/tandaTypes";

export function generateMilestones(
  poNumber: string,
  ddpDate: string,
  templates: WipTemplate[],
  updatedBy: string
): Milestone[] {
  const ddp = new Date(ddpDate);
  if (isNaN(ddp.getTime())) return [];

  return templates.map((tpl, i) => {
    const expected = new Date(ddp);
    expected.setDate(expected.getDate() - tpl.daysBeforeDDP);
    return {
      id: milestoneUid(),
      po_number: poNumber,
      phase: tpl.phase,
      category: tpl.category,
      sort_order: i,
      days_before_ddp: tpl.daysBeforeDDP,
      expected_date: expected.toISOString().slice(0, 10),
      actual_date: null,
      status: "Not Started",
      status_date: null,
      status_dates: null,
      notes: "",
      note_entries: null,
      variant_statuses: null,
      updated_at: new Date().toISOString(),
      updated_by: updatedBy,
    };
  });
}

export function mergeMilestones(existing: Milestone[], fresh: Milestone[]): Milestone[] {
  return fresh.map(f => {
    const old = existing.find(e => e.phase === f.phase);
    if (old && (old.actual_date || old.status !== "Not Started" || old.notes || (old.note_entries && old.note_entries.length > 0) || (old.variant_notes && Object.keys(old.variant_notes).length > 0))) {
      return {
        ...f,
        id: old.id,
        actual_date: old.actual_date,
        status: old.status,
        status_date: old.status_date,
        status_dates: old.status_dates,
        notes: old.notes,
        note_entries: old.note_entries,
        variant_statuses: old.variant_statuses,
        variant_notes: old.variant_notes,
      };
    }
    return f;
  });
}

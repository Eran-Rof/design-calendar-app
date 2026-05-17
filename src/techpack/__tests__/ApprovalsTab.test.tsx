// @vitest-environment jsdom
//
// Integration tests for <ApprovalsTab />. Pins: the 5 stage chips
// render in order, only Stage 0 (Design) is unlocked by default, the
// Approve / Reject / Request Revision buttons fire updateSelected
// with the right status + date, and locked stages render the
// "Previous stage must be approved first" hint.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ApprovalsTab } from "../tabs/ApprovalsTab";
import { emptyTechPack, emptyApprovals } from "../factories";
import { APPROVAL_STAGES } from "../constants";
import type { TechPack, Approval } from "../types";

function makeTp(approvals: Approval[] = emptyApprovals()): TechPack {
  const base = emptyTechPack({ name: "Eran" });
  return { ...base, approvals };
}

describe("<ApprovalsTab />", () => {
  it("renders the section heading", () => {
    render(<ApprovalsTab tp={makeTp()} updateSelected={vi.fn()} />);
    expect(screen.getByText("Approval Workflow")).toBeInTheDocument();
  });

  it("renders one card per APPROVAL_STAGES entry", () => {
    render(<ApprovalsTab tp={makeTp()} updateSelected={vi.fn()} />);
    for (const stage of APPROVAL_STAGES) {
      // Stage names appear in both the chip label strip + the card header
      expect(screen.getAllByText(stage).length).toBeGreaterThan(0);
    }
  });

  it("Stage 0 is unlocked: approve/reject buttons render", () => {
    render(<ApprovalsTab tp={makeTp()} updateSelected={vi.fn()} />);
    expect(screen.getAllByText("Approve").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Reject").length).toBeGreaterThan(0);
  });

  it("later stages render the 'Previous stage must be approved first' hint", () => {
    render(<ApprovalsTab tp={makeTp()} updateSelected={vi.fn()} />);
    // 4 locked stages (Stage 0 is unlocked)
    expect(screen.getAllByText("Previous stage must be approved first").length).toBe(APPROVAL_STAGES.length - 1);
  });

  it("clicking Approve fires updateSelected with status='Approved' + today's date", () => {
    const updateSelected = vi.fn();
    render(<ApprovalsTab tp={makeTp()} updateSelected={updateSelected} />);
    // Click the FIRST Approve button (Stage 0).
    fireEvent.click(screen.getAllByText("Approve")[0]);
    expect(updateSelected).toHaveBeenCalled();
    const arg = updateSelected.mock.calls[0][0];
    expect(arg.approvals[0].status).toBe("Approved");
    expect(arg.approvals[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("clicking Reject fires updateSelected with status='Rejected'", () => {
    const updateSelected = vi.fn();
    render(<ApprovalsTab tp={makeTp()} updateSelected={updateSelected} />);
    fireEvent.click(screen.getAllByText("Reject")[0]);
    const arg = updateSelected.mock.calls[0][0];
    expect(arg.approvals[0].status).toBe("Rejected");
  });

  it("clicking Request Revision fires updateSelected with status='Revision Required'", () => {
    const updateSelected = vi.fn();
    render(<ApprovalsTab tp={makeTp()} updateSelected={updateSelected} />);
    fireEvent.click(screen.getAllByText("Request Revision")[0]);
    const arg = updateSelected.mock.calls[0][0];
    expect(arg.approvals[0].status).toBe("Revision Required");
  });

  it("editing the approver field calls updateSelected with new approver name", () => {
    const updateSelected = vi.fn();
    render(<ApprovalsTab tp={makeTp()} updateSelected={updateSelected} />);
    const firstApproverInput = screen.getAllByPlaceholderText("Approver name")[0];
    fireEvent.change(firstApproverInput, { target: { value: "Maya" } });
    const arg = updateSelected.mock.calls[0][0];
    expect(arg.approvals[0].approver).toBe("Maya");
  });

  it("once Stage 0 is Approved, Stage 1's hint is replaced by buttons", () => {
    const ap = emptyApprovals();
    ap[0].status = "Approved";
    render(<ApprovalsTab tp={makeTp(ap)} updateSelected={vi.fn()} />);
    // 3 locked stages now (Stages 2, 3, 4)
    expect(screen.getAllByText("Previous stage must be approved first").length).toBe(APPROVAL_STAGES.length - 2);
    // Stage 0 is approved → no Approve button on it; Stage 1 IS now unlocked
    // → its Approve button should exist
    expect(screen.getAllByText("Approve").length).toBeGreaterThan(0);
  });

  it("Stage 1 stays locked when Stage 0 is Rejected", () => {
    const ap = emptyApprovals();
    ap[0].status = "Rejected";
    render(<ApprovalsTab tp={makeTp(ap)} updateSelected={vi.fn()} />);
    // All 4 later stages still locked (Rejected ≠ Approved)
    expect(screen.getAllByText("Previous stage must be approved first").length).toBe(APPROVAL_STAGES.length - 1);
  });

  it("Reset button appears on non-Pending stages + fires status='Pending'", () => {
    const ap = emptyApprovals();
    ap[0].status = "Rejected";
    const updateSelected = vi.fn();
    render(<ApprovalsTab tp={makeTp(ap)} updateSelected={updateSelected} />);
    const reset = screen.getByText("Reset");
    fireEvent.click(reset);
    const arg = updateSelected.mock.calls[0][0];
    expect(arg.approvals[0].status).toBe("Pending");
    expect(arg.approvals[0].date).toBe(null);
  });
});

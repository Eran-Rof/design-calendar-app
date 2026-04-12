import { useMemo } from "react";
import { type XoroPO, type Milestone, WIP_CATEGORIES, poTotal } from "../../utils/tandaTypes";

function daysUntil(d?: string) {
  if (!d) return null;
  const target = new Date(d + "T00:00:00");
  const now = new Date();
  return Math.ceil((target.getTime() - now.getTime()) / 86400000);
}

interface UseDashboardDataOpts {
  pos: XoroPO[];
  filtered: XoroPO[];
  search: string;
  milestones: Record<string, Milestone[]>;
}

export function useDashboardData(opts: UseDashboardDataOpts) {
  const { pos, filtered, search, milestones } = opts;

  return useMemo(() => {
    const dashPOs = search ? filtered : pos;
    const dashPoNums = new Set(dashPOs.map((p: XoroPO) => p.PoNumber ?? ""));
    const today = new Date().toISOString().slice(0, 10);
    const weekFromNow = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

    const allMilestonesList = Object.values(milestones).flat();
    const overdueMilestones = allMilestonesList.filter(m => m.expected_date && m.expected_date < today && m.status !== "Complete" && m.status !== "N/A");
    const dueThisWeekMilestones = allMilestonesList.filter(m => m.expected_date && m.expected_date >= today && m.expected_date <= weekFromNow && m.status !== "Complete" && m.status !== "N/A");
    const completedMilestones = allMilestonesList.filter(m => m.status === "Complete");
    const milestoneCompletionRate = allMilestonesList.length > 0 ? Math.round((completedMilestones.length / allMilestonesList.length) * 100) : 0;
    const upcomingMilestones = allMilestonesList
      .filter(m => m.expected_date && m.expected_date >= today && m.status !== "Complete" && m.status !== "N/A")
      .sort((a, b) => (a.expected_date ?? "").localeCompare(b.expected_date ?? ""))
      .slice(0, 15);

    const dashMs = search ? allMilestonesList.filter(m => dashPoNums.has(m.po_number ?? "")) : allMilestonesList;
    const dashOverdueMilestones = dashMs.filter(m => m.expected_date && m.expected_date < today && m.status !== "Complete" && m.status !== "N/A");
    const dashDueThisWeekMilestones = dashMs.filter(m => m.expected_date && m.expected_date >= today && m.expected_date <= weekFromNow && m.status !== "Complete" && m.status !== "N/A");
    const dashUpcomingMilestones = dashMs
      .filter(m => m.expected_date && m.expected_date >= today && m.status !== "Complete" && m.status !== "N/A")
      .sort((a, b) => (a.expected_date ?? "").localeCompare(b.expected_date ?? ""))
      .slice(0, 15);
    const dashMsCompleted = dashMs.filter(m => m.status === "Complete");
    const dashMilestoneCompletionRate = dashMs.length > 0 ? Math.round((dashMsCompleted.length / dashMs.length) * 100) : 0;
    const dashTotalValue = dashPOs.reduce((s: number, p: XoroPO) => s + poTotal(p), 0);
    const dashOverduePOs = dashPOs.filter((p: XoroPO) => {
      const d = daysUntil(p.DateExpectedDelivery);
      return d !== null && d < 0 && p.StatusName !== "Received" && p.StatusName !== "Closed";
    }).length;
    const dashDueThisWeekPOs = dashPOs.filter((p: XoroPO) => {
      const d = daysUntil(p.DateExpectedDelivery);
      return d !== null && d >= 0 && d <= 7;
    }).length;

    const cascadeAlerts: { poNum: string; vendor: string; blockedCat: string; delayedCat: string; daysLate: number }[] = [];
    pos.forEach(po => {
      const poNum = po.PoNumber ?? "";
      const poMs = milestones[poNum] || [];
      if (poMs.length === 0) return;
      const grouped: Record<string, Milestone[]> = {};
      poMs.forEach(m => { if (!grouped[m.category]) grouped[m.category] = []; grouped[m.category].push(m); });
      const activeCats = WIP_CATEGORIES.filter(c => grouped[c]?.length);
      activeCats.forEach((cat, idx) => {
        for (let p = 0; p < idx; p++) {
          const prevCat = activeCats[p];
          const prevMs = grouped[prevCat] || [];
          if (prevMs.every(m => m.status === "Complete" || m.status === "N/A")) continue;
          const maxLate = prevMs.reduce((max, m) => {
            if (m.status === "Complete" || m.status === "N/A" || !m.expected_date) return max;
            const d = Math.ceil((Date.now() - new Date(m.expected_date).getTime()) / 86400000);
            return d > 0 ? Math.max(max, d) : max;
          }, 0);
          if (maxLate > 0) cascadeAlerts.push({ poNum, vendor: po.VendorName ?? "", blockedCat: cat, delayedCat: prevCat, daysLate: maxLate });
          break;
        }
      });
    });

    return {
      dashPOs,
      dashPoNums,
      today,
      weekFromNow,
      allMilestonesList,
      overdueMilestones,
      dueThisWeekMilestones,
      completedMilestones,
      milestoneCompletionRate,
      upcomingMilestones,
      dashMs,
      dashOverdueMilestones,
      dashDueThisWeekMilestones,
      dashUpcomingMilestones,
      dashMsCompleted,
      dashMilestoneCompletionRate,
      dashTotalValue,
      dashOverduePOs,
      dashDueThisWeekPOs,
      cascadeAlerts,
    };
  }, [pos, filtered, search, milestones]);
}

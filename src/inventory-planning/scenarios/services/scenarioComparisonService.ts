// Thin service that loads the rows needed to compare a scenario's
// planning_run against its base, then calls the pure compareScenarioToBase.

import { wholesaleRepo } from "../../services/wholesalePlanningRepository";
import { supplyRepo } from "../../supply/services/supplyReconciliationRepo";
import { compareScenarioToBase } from "../compute/scenarioComparison";
import type { IpScenario } from "../types/scenarios";

export async function loadScenarioComparison(scenario: IpScenario) {
  if (!scenario.base_run_reference_id) {
    throw new Error("Scenario has no base run — can't compare.");
  }
  const [baseProj, scenarioProj, baseRecs, scenarioRecs, items, categories] = await Promise.all([
    supplyRepo.listProjected(scenario.base_run_reference_id),
    supplyRepo.listProjected(scenario.planning_run_id),
    supplyRepo.listRecommendations(scenario.base_run_reference_id),
    supplyRepo.listRecommendations(scenario.planning_run_id),
    wholesaleRepo.listItems(),
    wholesaleRepo.listCategories(),
  ]);
  return compareScenarioToBase({
    base: baseProj,
    scenario: scenarioProj,
    baseRecs,
    scenarioRecs,
    items,
    categories,
  });
}

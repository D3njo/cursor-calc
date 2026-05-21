import {
  calcCost,
  resolveRates,
  normalizeStep,
  normalizeReviewTokens,
  DEFAULT_AUTO_POOL,
} from "./calc.mjs";
import {
  parseNotesRules,
  ruleBadges,
  calcCostWithRules,
  totalInputK,
  applyRulesToRates,
  inputSideMultiplier,
  isFastModeVariantName,
  resolveFastMode,
} from "./pricing-rules.mjs";

window.CursorCalcLib = {
  calcCost,
  resolveRates,
  normalizeStep,
  normalizeReviewTokens,
  DEFAULT_AUTO_POOL,
  parseNotesRules,
  ruleBadges,
  calcCostWithRules,
  totalInputK,
  applyRulesToRates,
  inputSideMultiplier,
  isFastModeVariantName,
  resolveFastMode,
};

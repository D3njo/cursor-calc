/** Parse Cursor docs Notes column into pricing rules and apply them in cost math. */

import { calcCost } from "./calc.mjs";

/** Model row is already a dedicated fast variant (e.g. GPT-5 Fast, Claude Opus Fast mode). */
export function isFastModeVariantName(name) {
  const n = String(name || "").toLowerCase();
  if (/\(fast mode\)/.test(n)) return true;
  if (/\bfast\b/.test(n) && /\bgpt-5\b/.test(n)) return true;
  return false;
}

export function parseNotesRules(notes, modelName = "") {
  const text = String(notes || "").trim();
  if (!text) return {};
  const rules = {};

  if (isFastModeVariantName(modelName)) {
    rules.isFastModeVariant = true;
    return rules;
  }

  const n = text.toLowerCase();

  if (/hidden by default/.test(n)) rules.hidden = true;
  if (/requires max mode/.test(n)) rules.requiresMaxMode = true;
  if (/no long-context surcharge|no long context surcharge/.test(n)) {
    rules.maxModeWaivesLongSurcharge = true;
  }

  const disc = n.match(/(\d+)\s*%\s*discount on cached input/);
  if (disc) rules.cachedInputDiscountPct = Number(disc[1]);

  if (
    /2x when the input exceeds 200k/.test(n) ||
    /cost is 2x when the input exceeds 200k/.test(n) ||
    (/2x input pricing/.test(n) && /long context|1m tokens/.test(n))
  ) {
    rules.longContextInputMultiplier = 2;
    rules.longContextThresholdK = 200;
  }

  const regional = n.match(/\+(\d+)\s*%\s*surcharge/);
  if (regional) rules.regionalSurchargePct = Number(regional[1]);

  if (/fast mode/.test(n)) {
    rules.fastModeAvailable = true;
    if (
      /faster speed but 2x|2x pricing|2x price|fast mode[^.;]{0,40}2x|2x[^.;]{0,40}fast mode/.test(n)
    ) {
      rules.fastModeMultiplier = 2;
    } else if (/higher rates/.test(n)) {
      rules.fastModeMultiplier = 2;
    }
  }

  return rules;
}

export function resolveFastMode(model, sessionFastMode = false, fastModeByModelId = {}) {
  if (!model) return false;
  if (model.rules?.isFastModeVariant) return true;
  if (!model.rules?.fastModeAvailable) return false;
  if (Object.prototype.hasOwnProperty.call(fastModeByModelId, model.id)) {
    return !!fastModeByModelId[model.id];
  }
  return !!sessionFastMode;
}

export function applyFastModeMultiplier(rates, multiplier) {
  const m = Number(multiplier) || 1;
  if (m === 1) return { ...(rates || {}) };
  const r = rates || {};
  return {
    ...r,
    inputP: (r.inputP || 0) * m,
    cacheP: (r.cacheP || 0) * m,
    cacheWriteP: (r.cacheWriteP || 0) * m,
    outputP: (r.outputP || 0) * m,
  };
}

export function ruleBadges(rules) {
  if (!rules || typeof rules !== "object") return [];
  const badges = [];
  if (rules.hidden) badges.push({ id: "hidden", label: "Hidden" });
  if (rules.requiresMaxMode) badges.push({ id: "maxmode", label: "Max Mode" });
  if (rules.cachedInputDiscountPct) {
    badges.push({ id: "cache-disc", label: `−${rules.cachedInputDiscountPct}% cache read` });
  }
  if (rules.longContextInputMultiplier) {
    badges.push({
      id: "long-2x",
      label: `${rules.longContextInputMultiplier}× input >${rules.longContextThresholdK ?? 200}k`,
    });
  }
  if (rules.maxModeWaivesLongSurcharge) {
    badges.push({ id: "max-waive", label: "Max Mode: no 2×" });
  }
  if (rules.regionalSurchargePct) {
    badges.push({ id: "regional", label: `+${rules.regionalSurchargePct}% regional` });
  }
  if (rules.notInCursorDocs) {
    badges.push({ id: "override", label: "Not in Cursor docs" });
  }
  if (rules.isFastModeVariant) {
    badges.push({ id: "fast-variant", label: "Fast (catalog)" });
  } else if (rules.fastModeAvailable) {
    badges.push({
      id: "fast-available",
      label: `Fast ×${rules.fastModeMultiplier || 2} optional`,
    });
  }
  return badges;
}

export function totalInputK(inputK, cacheReadK, cacheWriteK) {
  return (
    Math.max(Number(inputK) || 0, 0) +
    Math.max(Number(cacheReadK) || 0, 0) +
    Math.max(Number(cacheWriteK) || 0, 0)
  );
}

export function applyRulesToRates(rates, rules) {
  const r = { ...(rates || {}) };
  if (!rules) return r;
  if (rules.cachedInputDiscountPct) {
    const factor = 1 - rules.cachedInputDiscountPct / 100;
    r.cacheP = (r.cacheP || 0) * factor;
  }
  if (rules.regionalSurchargePct) {
    const factor = 1 + rules.regionalSurchargePct / 100;
    r.inputP = (r.inputP || 0) * factor;
    r.cacheP = (r.cacheP || 0) * factor;
    r.cacheWriteP = (r.cacheWriteP || 0) * factor;
    r.outputP = (r.outputP || 0) * factor;
  }
  return r;
}

export function inputSideMultiplier(rules, { maxMode = false, totalInputK: totIn = 0 } = {}) {
  if (!rules?.longContextInputMultiplier) return 1;
  if (rules.maxModeWaivesLongSurcharge && maxMode) return 1;
  const thresh = rules.longContextThresholdK ?? 200;
  return totIn > thresh ? rules.longContextInputMultiplier : 1;
}

/**
 * @returns {{ cost: number, multiplier: number, effectiveRates: object, totalInputK: number }}
 */
export function calcCostWithRules(
  rates,
  rules,
  inputK,
  cacheReadK,
  cacheWriteK,
  outK,
  { maxMode = false, fastMode = false } = {}
) {
  let effectiveRates = applyRulesToRates(rates, rules);
  let fastMultiplier = 1;
  if (fastMode && rules?.fastModeAvailable && !rules?.isFastModeVariant) {
    fastMultiplier = rules.fastModeMultiplier || 2;
    effectiveRates = applyFastModeMultiplier(effectiveRates, fastMultiplier);
  }
  const totIn = totalInputK(inputK, cacheReadK, cacheWriteK);
  const multiplier = inputSideMultiplier(rules, { maxMode, totalInputK: totIn });
  const base = calcCost(effectiveRates, inputK, cacheReadK, cacheWriteK, outK);
  if (multiplier === 1) {
    return {
      cost: base,
      multiplier: 1,
      fastMultiplier,
      effectiveRates,
      totalInputK: totIn,
    };
  }
  const outPart = (Math.max(Number(outK) || 0, 0) / 1000) * (effectiveRates.outputP || 0);
  const inPart = base - outPart;
  return {
    cost: inPart * multiplier + outPart,
    multiplier,
    fastMultiplier,
    effectiveRates,
    totalInputK: totIn,
  };
}

/** Shared cost math for cursor-calc (used by tests and the app via calc-bridge). */

export const DEFAULT_AUTO_POOL = {
  name: "Auto + Composer",
  inputP: 1.25,
  cacheP: 0.25,
  cacheWriteP: 1.25,
  outputP: 6,
};

/** Cost in USD for token counts in thousands (k). */
export function calcCost(rates, inputK, cacheReadK, cacheWriteK, outK) {
  const r = rates || {};
  return (
    (Math.max(Number(inputK) || 0, 0) / 1000) * (r.inputP || 0) +
    (Math.max(Number(cacheReadK) || 0, 0) / 1000) * (r.cacheP || 0) +
    (Math.max(Number(cacheWriteK) || 0, 0) / 1000) * (r.cacheWriteP || 0) +
    (Math.max(Number(outK) || 0, 0) / 1000) * (r.outputP || 0)
  );
}

export function resolveRates(model, usagePool, autoPool) {
  if (usagePool === "auto") return autoPool || DEFAULT_AUTO_POOL;
  return model;
}

/** Normalize a workflow step from v4 (cacheK / total inputK) or v5 fields. */
export function normalizeStep(raw, fallbackModelId) {
  const outputK = Math.max(1, parseInt(raw.outputK) || 1);
  let inputK;
  let cacheReadK;
  let cacheWriteK;

  if (raw.cacheReadK != null || raw.cacheWriteK != null) {
    inputK = Math.max(0, parseInt(raw.inputK) || 0);
    cacheReadK = Math.max(0, parseInt(raw.cacheReadK) || 0);
    cacheWriteK = Math.max(0, parseInt(raw.cacheWriteK) || 0);
    if (inputK < 1 && outputK >= 1) inputK = 1;
  } else {
    const totalIn = Math.max(1, parseInt(raw.inputK) || 1);
    cacheReadK = Math.min(totalIn, Math.max(0, parseInt(raw.cacheK) || 0));
    cacheWriteK = 0;
    inputK = Math.max(1, totalIn - cacheReadK);
  }

  return {
    id: raw.id || "s",
    name: String(raw.name || "Step"),
    inputK,
    cacheReadK,
    cacheWriteK,
    outputK,
    modelId: String(raw.modelId || fallbackModelId),
  };
}

export function normalizeReviewTokens(raw, defaults) {
  const d = defaults || { revInK: 80, revCacheReadK: 0, revCacheWriteK: 0, revOutK: 1 };
  if (raw.revCacheReadK != null || raw.revCacheWriteK != null) {
    return {
      revInK: Math.max(0, parseInt(raw.revInK) ?? d.revInK),
      revCacheReadK: Math.max(0, parseInt(raw.revCacheReadK) ?? 0),
      revCacheWriteK: Math.max(0, parseInt(raw.revCacheWriteK) ?? 0),
      revOutK: Math.max(1, parseInt(raw.revOutK) ?? d.revOutK),
    };
  }
  const revInK = Math.max(1, parseInt(raw.revInK) ?? d.revInK);
  const revCacheReadK = Math.min(revInK, Math.max(0, parseInt(raw.revCacheK) ?? 0));
  return {
    revInK: Math.max(1, revInK - revCacheReadK),
    revCacheReadK,
    revCacheWriteK: 0,
    revOutK: Math.max(1, parseInt(raw.revOutK) ?? d.revOutK),
  };
}

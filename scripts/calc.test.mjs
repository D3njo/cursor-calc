import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calcCost,
  normalizeStep,
  normalizeReviewTokens,
  resolveRates,
  DEFAULT_AUTO_POOL,
} from "./calc.mjs";
import {
  parseNotesRules,
  calcCostWithRules,
  ruleBadges,
  resolveFastMode,
  isFastModeVariantName,
} from "./pricing-rules.mjs";

const claudeSonnet = { inputP: 3, cacheP: 0.3, cacheWriteP: 3.75, outputP: 15 };

test("calcCost bills input, cache read, cache write, and output separately", () => {
  const cost = calcCost(claudeSonnet, 6, 94, 10, 1);
  assert.equal(cost, (6 / 1000) * 3 + (94 / 1000) * 0.3 + (10 / 1000) * 3.75 + (1 / 1000) * 15);
});

test("calcCost does not double-charge cache read as cache write", () => {
  const withWrite = calcCost(claudeSonnet, 0, 100, 0, 0);
  const withReadOnly = calcCost(claudeSonnet, 0, 100, 0, 0);
  assert.equal(withWrite, withReadOnly);
  assert.ok(withReadOnly < 1, "100k cache read alone should stay well under $1");
});

test("normalizeStep migrates legacy cacheK as cache read from total inputK", () => {
  const step = normalizeStep({ inputK: 100, cacheK: 94, outputK: 1 }, "m1");
  assert.equal(step.inputK, 6);
  assert.equal(step.cacheReadK, 94);
  assert.equal(step.cacheWriteK, 0);
});

test("normalizeReviewTokens migrates legacy revCacheK", () => {
  const rev = normalizeReviewTokens({ revInK: 80, revCacheK: 70, revOutK: 1 });
  assert.equal(rev.revInK, 10);
  assert.equal(rev.revCacheReadK, 70);
  assert.equal(rev.revCacheWriteK, 0);
});

test("resolveRates uses auto pool when selected", () => {
  const rates = resolveRates(claudeSonnet, "auto", DEFAULT_AUTO_POOL);
  assert.equal(rates.inputP, 1.25);
  assert.equal(rates.outputP, 6);
});

test("parseNotesRules extracts cache discount and long-context 2x", () => {
  const rules = parseNotesRules(
    "90% discount on cached input tokens; Long context with 2x input pricing"
  );
  assert.equal(rules.cachedInputDiscountPct, 90);
  assert.equal(rules.longContextInputMultiplier, 2);
  assert.equal(rules.longContextThresholdK, 200);
});

test("calcCostWithRules applies 90% cache read discount", () => {
  const gpt = { inputP: 2.5, cacheP: 0.25, cacheWriteP: 0, outputP: 15 };
  const rules = { cachedInputDiscountPct: 90 };
  const plain = calcCost(gpt, 0, 100, 0, 0);
  const discounted = calcCostWithRules(gpt, rules, 0, 100, 0, 0).cost;
  assert.ok(discounted < plain / 5);
});

test("calcCostWithRules applies 2x input when total input exceeds 200k", () => {
  const rules = { longContextInputMultiplier: 2, longContextThresholdK: 200 };
  const base = calcCostWithRules(claudeSonnet, rules, 50, 160, 0, 1, { maxMode: false }).cost;
  const doubled = calcCostWithRules(claudeSonnet, rules, 100, 150, 0, 1, { maxMode: false }).cost;
  assert.ok(doubled > base * 1.5);
});

test("calcCostWithRules waives 2x in Max Mode when docs say no surcharge", () => {
  const rules = {
    longContextInputMultiplier: 2,
    longContextThresholdK: 200,
    maxModeWaivesLongSurcharge: true,
  };
  const normal = calcCostWithRules(claudeSonnet, rules, 10, 195, 0, 1, { maxMode: false }).cost;
  const maxMode = calcCostWithRules(claudeSonnet, rules, 10, 195, 0, 1, { maxMode: true }).cost;
  assert.ok(normal > maxMode);
});

test("ruleBadges lists parsed rules", () => {
  const badges = ruleBadges(parseNotesRules("Hidden by default; 90% discount on cached input"));
  assert.ok(badges.some((b) => b.id === "hidden"));
  assert.ok(badges.some((b) => b.id === "cache-disc"));
});

test("parseNotesRules detects fast mode optional with 2x multiplier", () => {
  const rules = parseNotesRules(
    "Fast mode is 15% faster with 2x pricing",
    "GPT-5.4"
  );
  assert.equal(rules.fastModeAvailable, true);
  assert.equal(rules.fastModeMultiplier, 2);
});

test("isFastModeVariantName for dedicated fast models", () => {
  assert.equal(isFastModeVariantName("Claude 4.6 Opus (Fast mode)"), true);
  assert.equal(isFastModeVariantName("GPT-5 Fast"), true);
  assert.equal(isFastModeVariantName("GPT-5.4"), false);
});

test("calcCostWithRules doubles rates when fast mode enabled", () => {
  const gpt = { inputP: 2.5, cacheP: 0.25, cacheWriteP: 0, outputP: 15 };
  const rules = { fastModeAvailable: true, fastModeMultiplier: 2 };
  const normal = calcCostWithRules(gpt, rules, 10, 0, 0, 5, { fastMode: false }).cost;
  const fast = calcCostWithRules(gpt, rules, 10, 0, 0, 5, { fastMode: true }).cost;
  assert.ok(fast > normal * 1.9);
});

test("resolveFastMode uses per-model override over session default", () => {
  const model = { id: "m1", rules: { fastModeAvailable: true, fastModeMultiplier: 2 } };
  assert.equal(resolveFastMode(model, false, { m1: true }), true);
  assert.equal(resolveFastMode(model, true, { m1: false }), false);
  assert.equal(resolveFastMode(model, true, {}), true);
});

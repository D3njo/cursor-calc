import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseModelsFromMarkdown,
  parseAutoPoolFromMarkdown,
  catalogIsStale,
} from "./update-models.mjs";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "pricing-snippet.md");

test("parseModelsFromMarkdown extracts API model rows", () => {
  const md = readFileSync(FIXTURE, "utf8");
  const models = parseModelsFromMarkdown(md);
  assert.ok(models.length >= 2);
  const sonnet = models.find((m) => m.name === "Claude 4.6 Sonnet");
  assert.ok(sonnet);
  assert.equal(sonnet.inputP, 3);
  assert.equal(sonnet.cacheP, 0.3);
  assert.equal(sonnet.cacheWriteP, 3.75);
  assert.equal(sonnet.outputP, 15);
  assert.ok(sonnet.rules?.maxModeWaivesLongSurcharge);
  const gpt = models.find((m) => m.name === "GPT-5.4");
  assert.equal(gpt.rules?.cachedInputDiscountPct, 90);
  assert.equal(gpt.rules?.fastModeAvailable, true);
  assert.equal(gpt.rules?.fastModeMultiplier, 2);
  const sonnet1m = models.find((m) => m.name === "Claude 4 Sonnet 1M");
  assert.equal(sonnet1m.rules?.longContextInputMultiplier, 2);
  const composer = models.find((m) => m.name === "Composer 2.5");
  assert.equal(composer.cacheWriteP, 0);
});

test("catalogIsStale is false for a recent timestamp", () => {
  assert.equal(catalogIsStale(new Date().toISOString()), false);
});

test("catalogIsStale is true for timestamps older than the stale window", () => {
  const old = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(catalogIsStale(old), true);
});

test("parseAutoPoolFromMarkdown extracts Auto + Composer rates", () => {
  const md = readFileSync(FIXTURE, "utf8");
  const pool = parseAutoPoolFromMarkdown(md);
  assert.ok(pool);
  assert.equal(pool.inputP, 1.25);
  assert.equal(pool.cacheWriteP, 1.25);
  assert.equal(pool.cacheP, 0.25);
  assert.equal(pool.outputP, 6);
});

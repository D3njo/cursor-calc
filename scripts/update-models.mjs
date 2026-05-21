#!/usr/bin/env node
// Scrape the Cursor models & pricing page and write models.json.
// No npm dependencies: runs on plain Node 20+ (built-in fetch).
//
// The page at https://cursor.com/docs/models-and-pricing is a Mintlify-built
// docs site. The model pricing table is server-rendered into the initial HTML,
// so a plain fetch + tag-based parser is enough to extract it.
//
// Exits non-zero (without writing) if no models can be parsed, so a scheduled
// workflow does not commit an empty catalog.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PRIMARY_SOURCE_URL = "https://cursor.com/docs/models-and-pricing";
// The Mintlify-built docs page used to render its pricing tables straight into
// the initial HTML, but the markup occasionally changes (different domain,
// client-rendered tables, etc.). To stay resilient we try a handful of known
// variants in order and use the first one that yields a usable parse.
const SOURCE_URLS = [
  PRIMARY_SOURCE_URL,
  "https://www.cursor.com/docs/models-and-pricing",
  "https://docs.cursor.com/models-and-pricing",
  "https://cursor.com/pricing",
];
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUTPUT = join(ROOT, "models.json");
const MIN_EXPECTED_MODELS = 5;
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/124.0.0.0 Safari/537.36 cursor-calc-update-bot/1.0 " +
  "(+https://github.com/D3njo/cursor-calc)";

// ---------- HTML helpers (no DOM, no deps) ----------

function decodeEntities(s) {
  // Decode &amp; LAST so we don't double-unescape sequences like "&amp;nbsp;".
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/gi, "&");
}

function stripHtml(s) {
  return decodeEntities(String(s).replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function parsePrice(s) {
  // Cursor prices look like "$3", "$3.75", "$0.3"; never use thousands
  // separators. Strip thousands-style commas only when a dot is also present
  // so European decimal commas (e.g. "3,75") still parse.
  const raw = String(s);
  const normalized = raw.includes(".") ? raw.replace(/,/g, "") : raw.replace(/,/g, ".");
  const m = normalized.match(/\$?\s*([0-9]+(?:\.[0-9]+)?)/);
  return m ? Number(m[1]) : 0;
}

function extractTables(html) {
  const tables = [];
  const tableRe = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let tm;
  while ((tm = tableRe.exec(html))) {
    const rows = [];
    const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let rm;
    while ((rm = rowRe.exec(tm[1]))) {
      const cells = [];
      const cellRe = /<(t[hd])\b[^>]*>([\s\S]*?)<\/\1>/gi;
      let cm;
      while ((cm = cellRe.exec(rm[1]))) cells.push(stripHtml(cm[2]));
      if (cells.length) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }
  return tables;
}

// ---------- Pricing table parser ----------

const CACHE_READ_HEADERS = ["cache read", "cached input", "cache hit"];
const CACHE_WRITE_HEADERS = [
  "cache write",
  "cache fill",
  "cache populate",
  "cache creation",
  "cache storage",
];

const INVALID_NAME_KEYS = new Set(["model", "name", "input", "output", "price"]);
const INVALID_NAME_PARTS = ["pricing", "token"];

function nameKey(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isValidModelName(name) {
  const key = nameKey(name);
  if (!key || key.length < 2) return false;
  if (INVALID_NAME_KEYS.has(key)) return false;
  if (INVALID_NAME_PARTS.some((p) => key.includes(p))) return false;
  return true;
}

function findHeaderIndex(headers, words) {
  return headers.findIndex((h) => words.some((w) => h.includes(w)));
}

// Find the first index whose header contains any of `words` AND none of `excludeWords`.
// Falls back to the plain `findHeaderIndex` match if no exclusive match exists, so a
// table that only has a "Cached input" column still parses (just less precisely).
function findHeaderIndexExcluding(headers, words, excludeWords) {
  const strict = headers.findIndex(
    (h) => words.some((w) => h.includes(w)) && !excludeWords.some((w) => h.includes(w))
  );
  return strict >= 0 ? strict : findHeaderIndex(headers, words);
}

// The first row isn't always the header row: Mintlify occasionally renders a
// section-label row (single cell with colspan) or a multi-row header (e.g. a
// "Pricing ($/1M tokens)" group above the actual `Input`/`Output` columns).
// Pick the first row that actually looks like a pricing header.
function findHeaderRowIndex(rows) {
  for (let i = 0; i < rows.length; i++) {
    const headers = rows[i].map((h) => h.toLowerCase());
    if (
      headers.some((h) => h.includes("input")) &&
      headers.some((h) => h.includes("output"))
    ) {
      return i;
    }
  }
  return -1;
}

function parseModelsFromTables(tables) {
  const byKey = new Map();
  for (const rows of tables) {
    if (rows.length < 2) continue;
    const headerRowIdx = findHeaderRowIndex(rows);
    if (headerRowIdx < 0) continue;
    const headers = rows[headerRowIdx].map((h) => h.toLowerCase());
    const nameIdx = Math.max(findHeaderIndex(headers, ["model", "name"]), 0);
    // Avoid binding the "Input" column to "Cached input" / "Output" to a
    // hypothetical "Output cache" column when both variants are present.
    const inputIdx = findHeaderIndexExcluding(headers, ["input"], ["cache", "cached"]);
    const outputIdx = findHeaderIndexExcluding(headers, ["output"], ["cache", "cached"]);
    if (inputIdx < 0 || outputIdx < 0) continue;
    const cacheReadIdx = findHeaderIndex(headers, CACHE_READ_HEADERS);
    const cacheWriteIdx = findHeaderIndex(headers, CACHE_WRITE_HEADERS);
    // Only require enough cells to read name/input/output. Cache columns are
    // often blank or merged-away for non-Anthropic providers, so demanding a
    // cell at every header index would silently drop those rows.
    const minCells = Math.max(nameIdx, inputIdx, outputIdx) + 1;

    for (let i = headerRowIdx + 1; i < rows.length; i++) {
      const cells = rows[i];
      if (cells.length < minCells) continue;
      const rawName = cells[nameIdx] || "";
      // Strip provider icons / "(beta)" notes that follow the model name.
      const name = rawName.replace(/\s+/g, " ").trim();
      if (!isValidModelName(name)) continue;
      const inputP = parsePrice(cells[inputIdx]);
      const outputP = parsePrice(cells[outputIdx]);
      if (!inputP || !outputP) continue;
      // Cache columns are optional per-row: missing/empty/"-"/"N/A" all parse
      // to 0, which is the right value for models without cache pricing.
      const cacheP =
        cacheReadIdx >= 0 && cacheReadIdx < cells.length
          ? parsePrice(cells[cacheReadIdx])
          : 0;
      const cacheWriteP =
        cacheWriteIdx >= 0 && cacheWriteIdx < cells.length
          ? parsePrice(cells[cacheWriteIdx])
          : 0;
      byKey.set(nameKey(name), { name, inputP, cacheP, cacheWriteP, outputP });
    }
  }
  return [...byKey.values()];
}

// ---------- JSON fallback parser ----------
//
// If the page no longer ships a server-rendered <table>, the model catalog is
// usually still embedded as JSON inside a <script> tag (Next.js __NEXT_DATA__
// or similar hydration payload). Walk that JSON and harvest any object that
// looks like a model pricing entry: it has a name-ish field together with at
// least an input and output price (numbers or "$X" strings).

function toPriceNumber(v) {
  if (v == null) return 0;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string") return 0;
  return parsePrice(v);
}

const NAME_KEYS = ["name", "model", "modelName", "title", "label", "id"];
const INPUT_KEYS = ["input", "inputPrice", "input_price", "inputCost"];
const OUTPUT_KEYS = ["output", "outputPrice", "output_price", "outputCost"];
const CACHE_READ_KEYS = [
  "cacheRead", "cache_read", "cachedInput", "cached_input",
  "cacheHit", "cache_hit", "cache",
];
const CACHE_WRITE_KEYS = [
  "cacheWrite", "cache_write", "cacheCreation", "cache_creation",
  "cacheFill", "cache_fill", "cacheStorage", "cache_storage",
];

function pickField(obj, keys) {
  for (const k of keys) if (k in obj) return obj[k];
  // case-insensitive fallback
  const lower = new Map(Object.keys(obj).map((k) => [k.toLowerCase(), k]));
  for (const k of keys) {
    const hit = lower.get(k.toLowerCase());
    if (hit) return obj[hit];
  }
  return undefined;
}

function harvestJsonModels(node, out) {
  if (Array.isArray(node)) {
    for (const item of node) harvestJsonModels(item, out);
    return;
  }
  if (!node || typeof node !== "object") return;

  const rawName = pickField(node, NAME_KEYS);
  const rawInput = pickField(node, INPUT_KEYS);
  const rawOutput = pickField(node, OUTPUT_KEYS);
  if (
    typeof rawName === "string" &&
    rawInput != null &&
    rawOutput != null
  ) {
    const name = stripHtml(rawName);
    if (isValidModelName(name)) {
      const inputP = toPriceNumber(rawInput);
      const outputP = toPriceNumber(rawOutput);
      if (inputP && outputP) {
        const cacheP = toPriceNumber(pickField(node, CACHE_READ_KEYS));
        const cacheWriteP = toPriceNumber(pickField(node, CACHE_WRITE_KEYS));
        const key = nameKey(name);
        if (!out.has(key)) {
          out.set(key, { name, inputP, cacheP, cacheWriteP, outputP });
        }
      }
    }
  }
  for (const v of Object.values(node)) harvestJsonModels(v, out);
}

function parseModelsFromJsonBlobs(html) {
  const out = new Map();
  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let sm;
  while ((sm = scriptRe.exec(html))) {
    const body = sm[1].trim();
    if (!body || body[0] !== "{" && body[0] !== "[") {
      // Try to locate any JSON-looking object inside the script body.
      const jsonRe = /(\{[\s\S]*\}|\[[\s\S]*\])/;
      const m = body.match(jsonRe);
      if (!m) continue;
      try {
        harvestJsonModels(JSON.parse(m[1]), out);
      } catch {
        // Not valid JSON (regex picked up code, not data) — skip silently.
      }
      continue;
    }
    try {
      harvestJsonModels(JSON.parse(body), out);
    } catch {
      // Script body wasn't pure JSON — common for inline JS — skip silently.
    }
  }
  return [...out.values()];
}

// ---------- Main ----------

async function fetchUrl(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return await res.text();
}

function parseModelsFromHtml(html) {
  const tables = extractTables(html);
  const fromTables = parseModelsFromTables(tables);
  if (fromTables.length >= MIN_EXPECTED_MODELS) {
    return { models: fromTables, strategy: "tables", tables: tables.length };
  }
  const fromJson = parseModelsFromJsonBlobs(html);
  if (fromJson.length >= fromTables.length) {
    return { models: fromJson, strategy: "json", tables: tables.length };
  }
  return { models: fromTables, strategy: "tables", tables: tables.length };
}

async function tryFetchAndParse() {
  const errors = [];
  let lastDiagnostic = null;
  for (const url of SOURCE_URLS) {
    try {
      const html = await fetchUrl(url);
      const { models, strategy, tables } = parseModelsFromHtml(html);
      if (models.length >= MIN_EXPECTED_MODELS) {
        return { url, models, strategy };
      }
      lastDiagnostic = { url, html, models, strategy, tables };
    } catch (err) {
      errors.push(`${url}: ${err.message}`);
    }
  }
  return { failed: true, errors, diagnostic: lastDiagnostic };
}

function readExisting() {
  if (!existsSync(OUTPUT)) return null;
  try {
    return JSON.parse(readFileSync(OUTPUT, "utf8"));
  } catch {
    return null;
  }
}

function sortModels(models) {
  return [...models].sort((a, b) => a.name.localeCompare(b.name));
}

function modelsEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.name !== y.name ||
      x.inputP !== y.inputP ||
      x.cacheP !== y.cacheP ||
      x.cacheWriteP !== y.cacheWriteP ||
      x.outputP !== y.outputP
    ) {
      return false;
    }
  }
  return true;
}

(async () => {
  const result = await tryFetchAndParse();
  if (result.failed) {
    console.error("Refusing to write models.json: every source URL failed.");
    if (result.errors.length) {
      console.error("Fetch errors:");
      for (const e of result.errors) console.error("  -", e);
    }
    if (result.diagnostic) {
      const { url, html, models, strategy, tables } = result.diagnostic;
      console.error(
        `Last attempt: ${url} (strategy=${strategy}, html=${html.length}b, ` +
          `tables=${tables}, parsed=${models.length})`
      );
      console.error("--- HTML preview (first 2000 chars) ---");
      console.error(html.slice(0, 2000));
      console.error("--- end preview ---");
    }
    process.exit(1);
  }

  const { url, models: parsed, strategy } = result;
  const models = sortModels(parsed);

  const existing = readExisting();
  const sameModels = existing && modelsEqual(sortModels(existing.models || []), models);
  if (sameModels) {
    console.log(`No changes (${models.length} models from ${url} via ${strategy}).`);
    return;
  }

  const payload = {
    updatedAt: new Date().toISOString(),
    source: url,
    models,
  };
  writeFileSync(OUTPUT, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(`Wrote ${models.length} models to ${OUTPUT} (source=${url}, strategy=${strategy}).`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

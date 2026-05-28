#!/usr/bin/env node
// Sync Cursor API model pricing into models.json.
// No npm dependencies: runs on plain Node 20+ (built-in fetch).
//
// Primary source: https://cursor.com/docs/models-and-pricing.md
// Cursor docs are client-rendered HTML (no <table> in initial response), but the
// official .md endpoint (listed in llms.txt) ships pipe tables with all prices.
//
// Exits non-zero (without writing) if no models can be parsed, so a scheduled
// workflow does not commit an empty catalog.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { parseNotesRules } from "./pricing-rules.mjs";

const PRIMARY_SOURCE_URL = "https://cursor.com/docs/models-and-pricing.md";
const SOURCE_URLS = [
  PRIMARY_SOURCE_URL,
  "https://cursor.com/docs/models-and-pricing",
  "https://www.cursor.com/docs/models-and-pricing.md",
  "https://www.cursor.com/docs/models-and-pricing",
];
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUTPUT = join(ROOT, "models.json");
const MIN_EXPECTED_MODELS = 30;
const MIN_VALID_BODY_BYTES = 500;
const STALE_DAYS = 4;
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/124.0.0.0 Safari/537.36 cursor-calc-update-bot/1.0 " +
  "(+https://github.com/D3njo/cursor-calc)";

// ---------- Text helpers (no DOM, no deps) ----------

function decodeEntities(s) {
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
  const raw = String(s);
  const normalized = raw.includes(".") ? raw.replace(/,/g, "") : raw.replace(/,/g, ".");
  const m = normalized.match(/\$?\s*([0-9]+(?:\.[0-9]+)?)/);
  return m ? Number(m[1]) : 0;
}

// ---------- Markdown table parser ----------

function parseMarkdownRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  return inner.split("|").map((c) => c.trim());
}

function isMarkdownSeparatorRow(cells) {
  return cells.every((c) => /^:?-+:?$/.test(c.replace(/\s/g, "")));
}

function extractModelName(cell) {
  const m = String(cell).match(/\[([^\]]+)\]\([^)]*\)/);
  if (m) return m[1].replace(/\s+/g, " ").trim();
  return String(cell).replace(/\s+/g, " ").trim();
}

function extractMarkdownTables(md) {
  const tables = [];
  let current = null;
  for (const line of md.split("\n")) {
    if (line.includes("|")) {
      const cells = parseMarkdownRow(line);
      if (!cells || !cells.length) continue;
      if (!current) current = [];
      current.push(cells);
    } else if (current) {
      if (current.length) tables.push(current);
      current = null;
    }
  }
  if (current?.length) tables.push(current);
  return tables;
}

function parseModelsFromMarkdown(md) {
  const tables = extractMarkdownTables(md);
  const cleaned = tables
    .map((rows) => rows.filter((cells) => !isMarkdownSeparatorRow(cells)))
    .filter((rows) => rows.length >= 2);
  return parseModelsFromTables(cleaned);
}

/** Parse ### Auto pricing table (Token type | Price per 1M tokens). */
function parseAutoPoolFromMarkdown(md) {
  const tables = extractMarkdownTables(md)
    .map((rows) => rows.filter((cells) => !isMarkdownSeparatorRow(cells)))
    .filter((rows) => rows.length >= 2);

  for (const rows of tables) {
    const header = rows[0].map((h) => h.toLowerCase());
    const typeIdx = header.findIndex((h) => h.includes("token"));
    const priceIdx = header.findIndex((h) => h.includes("price"));
    if (typeIdx < 0 || priceIdx < 0) continue;

    const pool = { name: "Auto + Composer", inputP: 0, cacheP: 0, cacheWriteP: 0, outputP: 0 };
    for (let i = 1; i < rows.length; i++) {
      const label = rows[i][typeIdx].toLowerCase();
      const price = parsePrice(rows[i][priceIdx]);
      if (!price) continue;
      if (label.includes("cache read")) pool.cacheP = price;
      else if (label.includes("output")) pool.outputP = price;
      else if (label.includes("input") && label.includes("cache write")) {
        pool.inputP = price;
        pool.cacheWriteP = price;
      } else if (label.includes("input")) pool.inputP = price;
      else if (label.includes("cache write")) pool.cacheWriteP = price;
    }
    if (pool.inputP && pool.outputP) return pool;
  }
  return null;
}

export { parseModelsFromMarkdown, parseAutoPoolFromMarkdown, extractMarkdownTables, parsePrice };

// ---------- HTML table parser ----------

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

// ---------- Shared pricing table parser ----------

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

function findHeaderIndexExcluding(headers, words, excludeWords) {
  const strict = headers.findIndex(
    (h) => words.some((w) => h.includes(w)) && !excludeWords.some((w) => h.includes(w))
  );
  return strict >= 0 ? strict : findHeaderIndex(headers, words);
}

function isModelPricingHeaderRow(headers) {
  const lower = headers.map((h) => h.toLowerCase());
  const hasModel = lower.some((h) => h.includes("model") || h === "name");
  const hasInput = lower.some((h) => h.includes("input"));
  const hasOutput = lower.some((h) => h.includes("output"));
  return hasModel && hasInput && hasOutput;
}

function findHeaderRowIndex(rows) {
  for (let i = 0; i < rows.length; i++) {
    const headers = rows[i].map((h) => h.toLowerCase());
    if (
      isModelPricingHeaderRow(headers) &&
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
    if (!isModelPricingHeaderRow(headers)) continue;
    const nameIdx = Math.max(findHeaderIndex(headers, ["model", "name"]), 0);
    const inputIdx = findHeaderIndexExcluding(headers, ["input"], ["cache", "cached"]);
    const outputIdx = findHeaderIndexExcluding(headers, ["output"], ["cache", "cached"]);
    if (inputIdx < 0 || outputIdx < 0) continue;
    const cacheReadIdx = findHeaderIndex(headers, CACHE_READ_HEADERS);
    const cacheWriteIdx = findHeaderIndex(headers, CACHE_WRITE_HEADERS);
    const notesIdx = findHeaderIndex(headers, ["notes", "note"]);
    const minCells = Math.max(nameIdx, inputIdx, outputIdx) + 1;

    for (let i = headerRowIdx + 1; i < rows.length; i++) {
      const cells = rows[i];
      if (cells.length < minCells) continue;
      const rawName = cells[nameIdx] || "";
      const name = extractModelName(rawName);
      if (!isValidModelName(name)) continue;
      const inputP = parsePrice(cells[inputIdx]);
      const outputP = parsePrice(cells[outputIdx]);
      if (!inputP || !outputP) continue;
      const cacheP =
        cacheReadIdx >= 0 && cacheReadIdx < cells.length
          ? parsePrice(cells[cacheReadIdx])
          : 0;
      const cacheWriteP =
        cacheWriteIdx >= 0 && cacheWriteIdx < cells.length
          ? parsePrice(cells[cacheWriteIdx])
          : 0;
      const notes =
        notesIdx >= 0 && notesIdx < cells.length ? String(cells[notesIdx]).trim() : "";
      const rules = parseNotesRules(notes, name);
      const entry = { name, inputP, cacheP, cacheWriteP, outputP };
      if (notes) entry.notes = notes;
      if (Object.keys(rules).length) entry.rules = rules;
      byKey.set(nameKey(name), entry);
    }
  }
  return [...byKey.values()];
}

// ---------- JSON fallback parser ----------

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
  if (typeof rawName === "string" && rawInput != null && rawOutput != null) {
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
    if (!body || (body[0] !== "{" && body[0] !== "[")) {
      const jsonRe = /(\{[\s\S]*\}|\[[\s\S]*\])/;
      const m = body.match(jsonRe);
      if (!m) continue;
      try {
        harvestJsonModels(JSON.parse(m[1]), out);
      } catch {
        // skip
      }
      continue;
    }
    try {
      harvestJsonModels(JSON.parse(body), out);
    } catch {
      // skip
    }
  }
  return [...out.values()];
}

// ---------- Content parsing ----------

function isMarkdownSource(url, text) {
  return url.endsWith(".md") || text.includes("### Model pricing");
}

function parseContent(text, url) {
  const mdTables = isMarkdownSource(url, text) ? extractMarkdownTables(text).length : 0;

  if (isMarkdownSource(url, text)) {
    const fromMd = parseModelsFromMarkdown(text);
    if (fromMd.length >= MIN_EXPECTED_MODELS) {
      return {
        models: fromMd,
        strategy: "markdown",
        tables: mdTables,
        mdTables,
        sample: fromMd.slice(0, 3).map((m) => m.name),
      };
    }
  }

  const htmlTables = extractTables(text);
  const fromTables = parseModelsFromTables(htmlTables);
  if (fromTables.length >= MIN_EXPECTED_MODELS) {
    return {
      models: fromTables,
      strategy: "tables",
      tables: htmlTables.length,
      mdTables,
      sample: fromTables.slice(0, 3).map((m) => m.name),
    };
  }

  const fromJson = parseModelsFromJsonBlobs(text);
  const best = fromJson.length >= fromTables.length ? fromJson : fromTables;
  const strategy = fromJson.length >= fromTables.length ? "json" : "tables";
  return {
    models: best,
    strategy,
    tables: htmlTables.length,
    mdTables,
    sample: best.slice(0, 3).map((m) => m.name),
  };
}

// ---------- Main ----------

function isInvalidSourceBody(text) {
  const t = String(text).trim();
  if (t.length < MIN_VALID_BODY_BYTES) return true;
  if (t.startsWith('{"error"')) return true;
  if (/^Redirecting/i.test(t)) return true;
  return false;
}

async function fetchUrl(url, attempt = 0) {
  const accept = url.endsWith(".md")
    ? "text/plain,text/markdown,*/*"
    : "text/html,application/xhtml+xml";
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: accept,
      "Cache-Control": "no-cache, no-store",
      Pragma: "no-cache",
    },
    redirect: "follow",
    cache: "no-store",
  });
  if (!res.ok) {
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      return fetchUrl(url, attempt + 1);
    }
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  const text = await res.text();
  if (isInvalidSourceBody(text)) {
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      return fetchUrl(url, attempt + 1);
    }
    throw new Error(`Invalid or cached-empty body from ${url} (${text.length}b)`);
  }
  return text;
}

function catalogIsStale(updatedAtIso) {
  if (!updatedAtIso) return true;
  const updatedAt = new Date(updatedAtIso);
  if (Number.isNaN(updatedAt.getTime())) return true;
  return Date.now() - updatedAt.getTime() > STALE_DAYS * 24 * 60 * 60 * 1000;
}

async function tryFetchAndParse() {
  const errors = [];
  let lastDiagnostic = null;
  for (const url of SOURCE_URLS) {
    try {
      const text = await fetchUrl(url);
      const parsed = parseContent(text, url);
      if (parsed.models.length >= MIN_EXPECTED_MODELS) {
        return { url, text, ...parsed };
      }
      lastDiagnostic = { url, text, ...parsed };
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

function rulesEqual(a, b) {
  const x = a || {};
  const y = b || {};
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  for (const k of keys) {
    if (x[k] !== y[k]) return false;
  }
  return true;
}

function modelsEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  const byKeyA = new Map(a.map((m) => [nameKey(m.name), m]));
  const byKeyB = new Map(b.map((m) => [nameKey(m.name), m]));
  if (byKeyA.size !== byKeyB.size) return false;
  for (const [key, x] of byKeyA) {
    const y = byKeyB.get(key);
    if (!y) return false;
    if (
      x.name !== y.name ||
      x.inputP !== y.inputP ||
      x.cacheP !== y.cacheP ||
      x.cacheWriteP !== y.cacheWriteP ||
      x.outputP !== y.outputP ||
      (x.notes || "") !== (y.notes || "") ||
      !rulesEqual(x.rules, y.rules)
    ) {
      return false;
    }
  }
  return true;
}

function autoPoolEqual(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    a.inputP === b.inputP &&
    a.cacheP === b.cacheP &&
    a.cacheWriteP === b.cacheWriteP &&
    a.outputP === b.outputP
  );
}

async function main() {
  const result = await tryFetchAndParse();
  if (result.failed) {
    console.error("Refusing to write models.json: every source URL failed.");
    if (result.errors.length) {
      console.error("Fetch errors:");
      for (const e of result.errors) console.error("  -", e);
    }
    if (result.diagnostic) {
      const { url, text, models, strategy, tables, mdTables, sample } = result.diagnostic;
      console.error(
        `Last attempt: ${url} (strategy=${strategy}, size=${text.length}b, ` +
          `htmlTables=${tables}, mdTables=${mdTables ?? 0}, parsed=${models.length})`
      );
      if (sample?.length) {
        console.error(`Sample parsed: ${sample.join(", ")}`);
      }
      console.error("--- Content preview (first 2000 chars) ---");
      console.error(text.slice(0, 2000));
      console.error("--- end preview ---");
    }
    process.exit(1);
  }

  const { url, text, models: parsed, strategy } = result;
  const models = sortModels(parsed);
  const autoPool = parseAutoPoolFromMarkdown(text);

  const existing = readExisting();
  const checkedAt = new Date().toISOString();
  const sameModels =
    existing &&
    modelsEqual(sortModels(existing.models || []), models) &&
    autoPoolEqual(existing.autoPool, autoPool);
  if (sameModels) {
    if (catalogIsStale(existing.updatedAt)) {
      console.log(
        `::warning::Catalog unchanged but updatedAt is stale (${existing.updatedAt}, ${STALE_DAYS}+ days). ` +
          "Source may be serving cached content."
      );
      process.exit(1);
    }
    const payload = { ...existing, checkedAt };
    writeFileSync(OUTPUT, JSON.stringify(payload, null, 2) + "\n", "utf8");
    console.log(
      `No changes (${models.length} models from ${url} via ${strategy}). checkedAt=${checkedAt}.`
    );
    return;
  }

  const payload = {
    updatedAt: checkedAt,
    checkedAt,
    source: url,
    models,
  };
  if (autoPool) payload.autoPool = autoPool;
  writeFileSync(OUTPUT, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(
    `Wrote ${models.length} models to ${OUTPUT} (source=${url}, strategy=${strategy}` +
      `${autoPool ? ", autoPool=yes" : ""}).`
  );
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

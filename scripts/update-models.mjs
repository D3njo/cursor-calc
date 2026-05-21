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

const SOURCE_URL = "https://cursor.com/docs/models-and-pricing";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUTPUT = join(ROOT, "models.json");
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/124.0.0.0 Safari/537.36 cursor-calc-update-bot/1.0 " +
  "(+https://github.com/D3njo/cursor-calc)";

// ---------- HTML helpers (no DOM, no deps) ----------

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripHtml(s) {
  return decodeEntities(String(s).replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function parsePrice(s) {
  const m = String(s).replace(/,/g, ".").match(/\$?\s*([0-9]+(?:\.[0-9]+)?)/);
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

function parseModelsFromTables(tables) {
  const byKey = new Map();
  for (const rows of tables) {
    if (rows.length < 2) continue;
    const headers = rows[0].map((h) => h.toLowerCase());
    const nameIdx = Math.max(findHeaderIndex(headers, ["model", "name"]), 0);
    const inputIdx = findHeaderIndex(headers, ["input"]);
    const outputIdx = findHeaderIndex(headers, ["output"]);
    if (inputIdx < 0 || outputIdx < 0) continue;
    const cacheReadIdx = findHeaderIndex(headers, CACHE_READ_HEADERS);
    const cacheWriteIdx = findHeaderIndex(headers, CACHE_WRITE_HEADERS);

    for (let i = 1; i < rows.length; i++) {
      const cells = rows[i];
      if (cells.length < headers.length - 1) continue;
      const rawName = cells[nameIdx] || "";
      // Strip provider icons / "(beta)" notes that follow the model name.
      const name = rawName.replace(/\s+/g, " ").trim();
      if (!isValidModelName(name)) continue;
      const inputP = parsePrice(cells[inputIdx]);
      const outputP = parsePrice(cells[outputIdx]);
      if (!inputP || !outputP) continue;
      const cacheP = cacheReadIdx >= 0 ? parsePrice(cells[cacheReadIdx]) : 0;
      const cacheWriteP = cacheWriteIdx >= 0 ? parsePrice(cells[cacheWriteIdx]) : 0;
      byKey.set(nameKey(name), { name, inputP, cacheP, cacheWriteP, outputP });
    }
  }
  return [...byKey.values()];
}

// ---------- Main ----------

async function fetchSource() {
  const res = await fetch(SOURCE_URL, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${SOURCE_URL}`);
  return await res.text();
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
  const html = await fetchSource();
  const tables = extractTables(html);
  const models = sortModels(parseModelsFromTables(tables));

  if (models.length < 5) {
    console.error(
      `Refusing to write models.json: parsed only ${models.length} models from ${SOURCE_URL}.`
    );
    process.exit(1);
  }

  const existing = readExisting();
  const sameModels = existing && modelsEqual(sortModels(existing.models || []), models);
  if (sameModels) {
    console.log(`No changes (${models.length} models).`);
    // Still touch updatedAt? No — keep file untouched so the workflow skips the commit.
    return;
  }

  const payload = {
    updatedAt: new Date().toISOString(),
    source: SOURCE_URL,
    models,
  };
  writeFileSync(OUTPUT, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(`Wrote ${models.length} models to ${OUTPUT}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

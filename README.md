# Cursor Calc ⬡

A static PWA to estimate [Cursor AI](https://cursor.sh) Composer session costs
across different models.

## Features

- **Workflow Steps** – configure model, input, cached-input, and output tokens per step
- **Presets** – start from common workflows like bugfixes, features, and refactors, with a one-step undo
- **Session Config** – set N sessions, default step model, review model, and review cadence
- **Model Editor** – add/edit/remove models with custom pricing ($/M tokens)
- **Persistence & Sharing** – save a custom default, reset, JSON import/export, and share links
- **Results** – cost breakdown, step-level detail, currency display, and plan coverage
- **PWA** – installable on mobile & desktop with scoped offline caching

## Usage

Live: [d3njo.github.io/cursor-calc](https://d3njo.github.io/cursor-calc)

Open `index.html` directly or serve the repository root with any static file server.

Examples:

```bash
# Python 3
python -m http.server 8000

# Node.js (without installing a project dependency)
npx serve .
```

Then open `http://localhost:8000` for Python or the URL printed by `npx serve`.

## Model catalog

The list of Cursor models and their prices lives in [`models.json`](./models.json)
and is loaded same-origin at startup (no CORS, works offline once cached).
A scheduled GitHub Action (`.github/workflows/update-models.yml`) refreshes the
catalog once a day via [`scripts/update-models.mjs`](./scripts/update-models.mjs).
The script reads Cursor’s official markdown docs at
[cursor.com/docs/models-and-pricing.md](https://cursor.com/docs/models-and-pricing.md)
(the HTML page is client-rendered and has no tables in the initial response).
It commits any pricing changes automatically. To refresh on demand, run the
workflow manually from the **Actions** tab, or run `node scripts/update-models.mjs` locally.

The app ships **Gemini 3.5 Flash** as a built-in custom model (not in the Cursor docs
table yet). Edit prices in [`index.html`](./index.html) (`STANDARD_CUSTOM_MODEL`) or
via the Models tab; other custom models from old saves are removed on load.

## Tests

```bash
node --test scripts/calc.test.mjs scripts/parse-pricing.test.mjs
node scripts/update-models.mjs
```

Each catalog model includes `notes` and parsed `rules` from the docs (cache
discounts, 2× input above 200k, Max Mode waivers, etc.). The app applies these
in cost estimates when you enable **Max Mode** or exceed token thresholds.

## Validation

Serve the static files and load the app in a browser. Token fields match the
usage dashboard: input (non-cache), cache read, cache write, and output.

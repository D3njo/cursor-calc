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
A scheduled GitHub Action (`.github/workflows/update-models.yml`) re-scrapes
[cursor.com/docs/models-and-pricing](https://cursor.com/docs/models-and-pricing)
once a day via [`scripts/update-models.mjs`](./scripts/update-models.mjs) and
commits any pricing changes automatically. To refresh on demand, run the
workflow manually from the **Actions** tab, or run the script locally with
`node scripts/update-models.mjs`.

## Validation

This repository has no package manager, build script, or automated test suite. For
changes, validate by serving the static files and loading the app in a browser.

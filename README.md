# Cursor Calc ⬡

A static PWA to estimate [Cursor AI](https://cursor.sh) Composer session costs
across different models.

## Features

- **Workflow Steps** – configure input, cached-input, and output tokens per step
- **Presets** – start from common workflows like bugfixes, features, and refactors
- **Session Config** – set N sessions, main model, review model, and review cadence
- **Model Editor** – add/edit/remove models with custom pricing ($/M tokens)
- **Persistence & Sharing** – local save, reset, JSON import/export, and share links
- **Results** – cost breakdown, step-level detail, currency display, and plan coverage
- **PWA** – installable on mobile & desktop with scoped offline caching

## Usage

Live: [d3njo.github.io/cursor-calc](https://d3njo.github.io/cursor-calc)

Open `index.html` directly or serve the repository root with any static file server.

## Validation

This repository has no package manager, build script, or automated test suite. For
changes, validate by serving the static files and loading the app in a browser.

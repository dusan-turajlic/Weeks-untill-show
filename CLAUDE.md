# Project memory — Weeks-untill-show

Persistent requirements and constraints for this repo. Read this before changing
the meal-plan harness or the on-device build flow.

## Hard requirements (do not regress)

### The on-device MODEL must run on mobile too
Mobile is a **first-class target for the on-device AI model**, not just desktop.
Do **not** disable, gate off, or silently replace the WebLLM model on mobile —
phones must attempt to run the actual model like desktop does.

- The deterministic staple planner (`staplePlanLayout` in `meal-plan/planner.js`)
  is a **fallback only** — used when a model genuinely cannot load, and offline.
  It must never be the *default* path that pre-empts the model on mobile.
- If mobile memory (OOM) makes a given model unstable, the fix is to make the
  model **fit** (smaller model, tighter context window / KV cache, quantization,
  staged/low-memory load, better `computeBudgetMB` tiers, model walk + blocklist),
  **not** to stop trying the model on mobile.
- Always keep a graceful fallback so the user still gets a plan if every model
  fails — but the model is attempted first, on every device.

Context: an earlier change made mobile skip the model and build deterministically
by default. That was wrong. The requirement is: **mobile supports the model.**

## Architecture notes

- The model only ever **names foods**; the deterministic core (catalog + solver +
  `balanceMeals`) does all arithmetic and portioning. Two paths share that core:
  - **Path A (on-device):** WebLLM model in the browser (desktop AND mobile),
    with the deterministic staple planner as the fallback when no model can load.
  - **Path B (copy-prompt):** export the prompt to a frontier LLM — the quality
    ceiling (real web-searched prices/micros). Docs: `docs/meal-plan-prompt.md`.
- Mobile memory handling lives in `computeBudgetMB` / `selectModel` (planner.js)
  and the build orchestration in `index.html` (`runBuild` / `attempt`).

## Tests
Pure-Node, no browser/GPU. Run all before pushing:
`for t in harness solver foodlookup planner energy offtrack webllm; do node test/$t.test.js; done`

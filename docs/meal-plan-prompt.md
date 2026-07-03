# Meal-plan prompt & data contracts

This is the canonical reference for the LLM-assisted meal planner. The planning
prompt and the JSON output shape are **fixed inputs** — the numeric targets in a
generated prompt are pre-computed by the app's calorie model and must never be
recomputed by the model.

The app offers two paths that share one deterministic core (wizard → targets →
catalog → solver). The LLM (local or external) only **chooses foods and
narrates**; it never does the arithmetic.

- **Path A — On-device:** a small LLM runs in the browser via WebGPU/WebLLM and
  builds the plan locally. Offered only when a WebGPU adapter is present.
- **Path B — Copy-prompt:** export the prompt (below) and run it in any frontier
  LLM. Always available; also the quality ceiling.

## The prompt

The app builds the prompt at runtime from the user's computed plan
(`buildMealPlanPrompt()` in `index.html`). It always:

1. States the stats and **already-calculated** targets as fixed inputs:
   plan length, current/goal weight, height, maintenance kcal, daily kcal goal,
   and daily macro targets — Protein (min, every day), Fat (min, every day),
   Carbs (~target, per day type when carb-cycling), Fibre (≥ floor, every day).
2. Lists the carb/macro **style** (Even / High-Low / Carb-cycle) and, when
   cycling, the per-day-type macro split. The style is kept deliberately
   **separate** from dietary preferences — they are independent.
3. States the non-negotiable nutrition rules:
   - Micronutrient density is a top priority (iron, calcium, magnesium,
     potassium, zinc, iodine, B12, folate, vitamin D, omega-3); call out and fix
     any likely shortfall.
   - Fibre ≥ the floor every day.
   - Hit protein and fat minimums every day and stay within the calorie goal.
4. Asks the user (before planning): **country/region**, **weekly budget +
   currency**, **dietary preferences/restrictions**, **meals per day**.
5. Asks for: a plan that hits every target (per day type when cycling) using
   products that really exist in the country; a shopping list grouped by
   retailer with rough prices within budget; a micronutrient-coverage summary.
6. Requests the final plan as a single fenced ```json block in the import shape
   below — plain numbers, units only inside the `amount` strings.

## App import JSON (final output)

```jsonc
{
  "type": "weeks-until-show-meal-plan",
  "version": 1,
  "country": "<my country>",
  "currency": "<ISO code, e.g. EUR>",
  "weeklyBudget": 0,
  "summary": "<one or two sentence overview>",
  "days": [
    {
      "label": "<e.g. Every day, or High day>",
      "perWeek": 7,
      "meals": [
        { "name": "<e.g. Breakfast>", "items": [
          { "food": "<product>", "amount": "<e.g. 80 g>",
            "kcal": 0, "protein": 0, "fat": 0, "carbs": 0, "fiber": 0 }
        ] }
      ],
      "totals": { "kcal": 0, "protein": 0, "fat": 0, "carbs": 0, "fiber": 0 }
    }
  ],
  "shoppingList": [
    { "retailer": "<store name>", "items": [ { "name": "<product>", "qty": "1", "price": 0 } ] }
  ],
  "micronutrients": "<coverage note, shortfalls, and how fibre hits the floor>"
}
```

Per-day-type `totals` must match the deterministic solver. Numbers are plain
(no units inside number fields).

## Acceptance (per day type)

- Calories ≤ daily goal; Protein ≥ 135 g and Fat ≥ 68 g (minimums, every day);
  Carbs match the day type (High ~205 g / Low ~74 g); Fibre ≥ 35 g.
- Foods exist in the country catalog (real barcodes), respect dietary
  restrictions, and fit budget.
- Micronutrient note flags any likely shortfall with a fix.
- Final JSON validates against the import schema.

## Data contracts (verified against the producer)

Source: `github.com/YdinFit/open-food-facts-mirror-ydin`, served from R2 at
`https://catalog.ydin.app`.

### Catalog index — `indexes/catalogs/{cc}/catalog.jsonl.br`

Brotli-compressed JSONL, one **positional JSON array** per line
(`src/lib.rs` `CatalogEntry::serialize`):

```
[code, name, brand, country, serving_size, serving_unit, fiber, carbs, fat, protein]
```

`fiber/carbs/fat/protein` are **per 100 g**. There is **no kcal** in the index —
kcal comes from the product JSON, or Atwater (`4·protein + 4·carbs + 9·fat`) as a
fallback estimate (`parseCatalogLine` exposes `kcalEst`).

### Product JSON — `products/{barcode}.json`

```jsonc
{
  "product_name": "string",
  "brands": "string",
  "ingredients_text": "string",
  "breakdown": {
    "macros":      { "energy_kcal": 0, "fat": 0, "proteins": 0, "carbohydrates": 0 },
    "vitamins":    { /* per 100 g */ },
    "minerals":    { /* per 100 g */ },
    "amino_acids": { /* per 100 g */ }
  },
  "ai_guesses": { "model": "string", "timestamp": "ISO" }  // present ⇒ micros ESTIMATED
}
```

All `breakdown` values are per 100 g; scale by `grams / 100`. When `ai_guesses`
is present the micros are AI-estimated — surface "estimated" vs measured in the
UI (`buildMealTotals` sets `estimated: true`).

Units: vitamin_a µg RAE; vitamin_d/b9/b12/biotin µg; vitamin_e/c/b1/b2/b6/pp mg;
minerals mg except selenium/iodine/chromium/molybdenum µg; amino acids g/100 g.

## Shared-core modules (`meal-plan/`)

- **`food-lookup.js`** — `detectWebGPU` (Path A gate), `loadCountryCatalog`,
  `searchFoods`, `fetchProduct(s)`, `buildMealTotals`, plus the WebLLM tool
  surface (`FOOD_TOOLS`, `dispatchTool`). Pure functions are Node-testable;
  browser I/O (brotli decode, fetch, caching) degrades to clear errors elsewhere.
- **`solver.js`** — the deterministic portion solver: `solvePortions(targets,
  foods)` sizes grams to hit the four macro targets, `verify` reports failing
  constraints for the repair loop, `mealTotals` sums them. The model is
  forbidden from doing this arithmetic.
- **`planner.js`** — Path A orchestration (catalog → solver → import JSON) plus
  the optional in-browser WebLLM engine. Reliability layer:
  - **Fan-out + voting** — `buildPlan({ votes })` asks `designMeal` `votes` times
    per meal (sequential — one engine) and keeps the foods most runs agree on
    (`voteFoods`, exported + Node-tested). `votes:1` is the old single-shot path.
    `index.html` uses 3 on desktop, 2 on mobile, 1 on iOS. Locally tokens are free.
  - **Fuzzy / translation search** — the model designs in English but the catalog
    is in the country's language, so an unmatched food is passed to
    `engine.translateFoods({foods,country})` for local-language search terms,
    re-searched (`bestHit`), and PROMOTED to its real product (barcode, micros)
    when it now matches — only the genuinely unstocked foods fall through to
    `guessMacros`. One food per call, like `guessMacros`.
  - **Portion realism** — `assembleLayoutDay` balances at the DAY level (not an
    even per-meal split, which forces every meal to carry a sliver of each food —
    the source of "7 g of egg"). It then snaps foods to human portions: PIECE
    foods (eggs, fruit, bread, …) move in whole/part units (¼ egg, ½ banana) and
    are concentrated into ONE meal; BULK foods snap to a 5 g step, dropping
    sub-10 g slivers (`snapPiece`/`snapBulk`/`distributeBulk`). Piece foods are
    fixed, the day's bulk foods re-solve around them, and the final day totals are
    re-`verify()`d so any drift from real portions is reported. Meals are
    deliberately uneven — a day hits its macros, individual meals need not each
    be a balanced plate.
  - **Portion reasoning** — how a food is portioned (whole "unit" you use whole /
    in simple fractions — egg in a shell, a can, a sausage — vs "bulk" you weigh
    from a package) is decided by `engine.classifyFoods({foods,country})`, a
    per-food reasoning call whose judgement OVERRIDES the hardcoded `pieceInfo`
    regex (which stays as the fallback prior). Only foods the heuristic can't
    already place are sent (known pieces + `OBVIOUS_BULK` skip it); the result is
    clamped/vetoed by `classToDescriptor` so a hallucinated "unit" on a bulk food
    is ignored. Skipped on iOS. Progress stage: `check`.
  - **Meal-coherence critic** — `engine.critiqueMeal({mealName,items,country,prefs})`
    reads each finished meal and judges whether it hangs together as a real,
    cookable meal (not just individually-valid ingredients), catching incoherent
    combinations or a snack that's really a full meal — things the macro solver
    can't see. Runs on the representative day (`days[0]`), sequentially, and only
    FLAGS: issues are folded into the `micronutrients` note by `microNote`, never
    an auto-rewrite that could break the macro guarantees. Skipped on iOS.
    Progress stage: `review`.

  Tests: `node test/harness.test.js` (voting + translation + portion realism).

## On-device model selection (Path A)

The on-device model only *names foods* — a trivial task — so the planner favours
small, fast, reliable models and maps them to the device's actual WebGPU
capabilities instead of hardcoding one model:

- `detectGpuCaps()` reads the WebGPU adapter: the `shader-f16` feature, the
  storage-buffer limits, and the feature list.
- `selectModel(modelList, caps, opts)` walks a smallest-first preference list
  over WebLLM's official `prebuiltAppConfig.model_list`, trying `q4f16_1` then
  `q4f32_1` — **or only `q4f32_1` when the GPU lacks `shader-f16`** (common on
  Apple GPUs in Chromium, and the root cause of the "Cannot pass non-string to
  std::string" failure with f16 models). It also rejects any model whose
  `buffer_size_required_bytes` exceeds the adapter limits or whose
  `vram_required_MB` exceeds a device budget (tighter on mobile).
- A 40s stall watchdog aborts a hung/failed load to the deterministic staple
  plan, and a persisted blocklist makes a model that stalled get skipped on the
  next attempt — so retrying walks f16 → f32 → smaller automatically.

Tests: `node test/foodlookup.test.js`, `node test/solver.test.js`.

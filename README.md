# Weeks-untill-show

A small, installable web app (PWA) that counts the weeks until a target date and
projects your weight over that time, assuming a fixed percentage of fat loss
each week. Built as a single static `index.html` — no build step, no
dependencies.

## What it does

- **Weeks-left countdown** — pick an end date and see how many whole weeks remain
  from today. If your start date is in the future, the headline instead counts
  down to it ("X weeks until diet starts") so you know the deficit hasn't begun.
- **Your plan, set once** — pick your weekly loss percentage, a **start date**
  (when the phase begins, defaulting to today) and an end date. Like "About you",
  the plan collapses to a summary chip after you confirm it the first time, so
  return visits land straight on the **log today's weight** field — the one thing
  you need day to day. Tap *Edit* to change the rate or dates again.
- **Weight projection** — enter your current weight and a weekly loss percentage.
  The app compounds that loss week over week across your start→end window and
  shows your projected weight on the target date, total lost, and the percentage
  of your starting weight.
- **Trajectory chart** — an inline SVG line chart of your weight from your start
  date (week N) to your end date (week 0).
- **Week-by-week table** — every week's projected weight and cumulative loss.
- **Calories, macros & steps** — set your sex and height once (it collapses to a
  summary afterwards, so return visits land on the weight field) and the app
  works out the daily calories to eat to hit your goal as the headline, plus
  maintenance, a protein / fat / carb split (with a fibre target), and the daily
  step count needed to make up the rest of the deficit. A dieting phase always
  includes a **2,000-step daily minimum**. See
  [How the calorie numbers work](#how-the-calorie-numbers-work).
- **kg / lb toggle** — switch units on the fly (height follows as cm / in).
- **Shareable links** — all inputs are stored in the URL's query string, so you
  can bookmark or share a link to restore the exact projection (use the
  "Copy shareable link" button).
- **Installable & offline** — it's a PWA with a web app manifest and a service
  worker, so it can be added to your home screen and works offline.

## Running it

It's fully static. Any HTTP server works — for example:

```bash
# Python
python3 -m http.server 8000

# or Node
npx serve .
```

Then open `http://localhost:8000`.

> Note: the service worker and "add to home screen" install only work over
> `http://localhost` or HTTPS, not from a `file://` URL.

## Files

| File | Purpose |
|------|---------|
| `index.html` | The entire app — markup, styles, and logic |
| `manifest.webmanifest` | PWA metadata (name, icons, theme, display mode) |
| `sw.js` | Service worker — network-first for HTML, cache-first for assets |
| `meal-plan/food-lookup.js` | Catalog module — WebGPU gate, country catalog load/search, product fetch, deterministic `buildMealTotals`, WebLLM tool surface |
| `meal-plan/solver.js` | Deterministic portion solver — sizes grams to hit macro targets, verifies, reports failing constraints for the repair loop |
| `meal-plan/planner.js` | On-device (Path A) orchestration — catalog → solver → import JSON, plus the optional in-browser WebLLM engine |
| `docs/meal-plan-prompt.md` | Canonical meal-plan prompt, import JSON shape, and verified catalog/product data contracts |
| `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` | App icons |
| `apple-touch-icon.png` | iOS home-screen icon |

## How the projection works

Each week the weight is multiplied by `(1 − rate)`, where `rate` is the weekly
loss percentage divided by 100 — so the loss compounds on your current weight
rather than being linear. The phase runs from your **start date** (defaults to
today) to the end date. Week 0 is your end date; higher week numbers count back
toward your start date. Only whole weeks between start and end are shown.

## How the calorie numbers work

The aim is to keep input minimal — sex, height and your logged weight — and turn
the chosen rate of loss into a simple, actionable plan. All figures are
estimates.

- **Maintenance calories** — your current weight in **pounds** × a multiplier
  that tapers as weight rises (the midpoint of a sex-specific range). For
  example a male under 200 lb uses ~12×, 200–250 lb ~10.5×, and so on; women use
  a slightly higher set of brackets. Weight entered in kg is converted to lb
  first.
- **Minimum protein & fat** — set by your **height** (interpolated from a
  reference table, in cm) to protect muscle and keep hormones healthy.
- **"Prefer not to say"** — every sex-keyed figure (maintenance multiplier,
  protein and fat) is computed for both male and female and averaged.
- **Carbs** — whatever calories are left after protein (4 kcal/g) and fat
  (9 kcal/g), at 4 kcal/g — including a target of **≥35 g fibre**.
- **Deficit & intake** — the projected weight to lose × ~7,700 kcal/kg (≈3,500
  kcal/lb), spread over the days until your end date. The deficit taken from
  **food is capped at 700 kcal** so the diet never gets too aggressive.
- **Steps** — any deficit beyond that 700 kcal is made up with walking. A dieting
  phase also always adds a **2,000-step daily minimum**: that baseline is taken
  out of the food deficit first (so you eat a little more and your goal is
  unchanged), and anything still left over is walked off on top. The app shows
  the daily step count using a height-based stride and the net cost of walking
  (~0.5 kcal per kg per km). Enter your **current daily step average** (optional,
  under "About you") and the plan shows your *total* daily step target — your
  current average plus what's added — instead of just the extra.

### Eating patterns (carb cycling)

You can spread the same weekly calories across different day types:

- **Even** — the same macros every day (default).
- **High / Low** — high-carb days + low-carb days.
- **Carb cycle** — high + medium + low days.

Pick the pattern from the tabs, and choose **1 or 2 high-carb days** with the
sub-tabs (fewer high days means each one packs in more carbs).

The **whole week still totals 7 × your goal intake**, so the goal is unchanged —
only the day-to-day distribution shifts:

- **High / Low** — 1 high day + 6 low, or 2 high days + 5 low.
- **Carb cycle** — always 1 high day + 2 medium days + 4 low days.

**Protein is constant every day** in both patterns; only carbs (and, in carb
cycle, fat) move around. The two patterns work differently:

**High / Low** is a pure **carb shift** off the even baseline — protein *and*
fat stay exactly the same every day, and carbs are pulled off the low days and
stacked onto the high day(s):

- **1 high day** — cut **100 kcal of carbs** (−25 g) from each of the 6 low
  days and pile all 600 kcal onto the high day as carbs (**+150 g**).
- **2 high days** — cut **150 kcal of carbs** (−37.5 g) from each of the 5 low
  days and split the 750 kcal across the two high days (**+93.75 g each**).

Because it only moves carbs around, the week still totals 7 × your goal intake
exactly. If the low days bottom out at the 35 g carb floor before funding the
full bump, the **high day's fat is trimmed first** (from its height minimum down
to a 0.6 g/kg floor) to make room for the carbs — that keeps the day healthy and
avoids piling on cardio. Only what's still unfunded after that is walked off with
**steps on the high day**.

**Carb cycle** keeps a focused macro split per day type:

- **High day** — carbs = **35%** of the day's calories, fat is the remainder.
- **Medium day** — fat = **35%** of calories, carbs are the remainder.
- **Low day** — a solid **0.7 g/kg** fat at the 35 g carb floor.

The week still totals 7 × your goal intake. If the deficit is steep enough that
solid low-day fat would make low days out-eat the high days, the low-day fat
eases down toward the floor until the high days are biggest again.

Steps are the **same every day** (whatever the goal needs beyond a 700 kcal food
deficit), with any extra from the cases above added to the **high day** — where
you've eaten enough to walk them. The per-day calories, macros and steps are
shown in a table.

These are general estimates, not medical advice. If even a capped food deficit
can't fit your protein + fat minimums, the app says so — lower the weekly % or
push the end date out for a gentler plan.

## Tests

Pure logic is covered by dependency-free Node tests:

```bash
node test/offtrack.test.js     # on/off-track indicator
node test/energy.test.js       # maintenance, macros, deficit cap & steps
node test/solver.test.js       # deterministic meal-plan portion solver
node test/foodlookup.test.js   # country catalog parse/search + buildMealTotals
node test/planner.test.js      # on-device planner: catalog -> solver -> import JSON
node test/webllm.test.js       # on-device engine: streaming, memory caps, per-meal design
node test/distribution.test.js # per-meal calorie/carb split + workout-aware timing
node test/chatstore.test.js    # resumable IndexedDB chat cache (resume / partial resume)
node test/balance.test.js      # whole-food critic loop + portion realism guards
node test/portion.test.js      # discrete-unit portion labels ("70 g (~2 slices)")
```

The `webllm`/`planner`/`foodlookup` suites cover the **local-language bridge**
(`localizeFoods` → `searchFoodsMulti`) and the **dietary backstop** with fake
engines — no GPU. To eyeball whether a *real* on-device model actually translates
food names for a given catalog language, open **`docs/localize-smoke.html`** over
HTTP in a WebGPU browser: it loads a real model and prints `localizeFoods` output,
and can compare English-only vs. English+local matching against the live country
catalog (how many foods the English query misses, and how many the local terms
rescue). It's dev-only and not linked from the app.

## Meal planning

The app can build an LLM-assisted meal plan around your computed calorie/macro
targets. The targets are fixed inputs — the model only **chooses foods and
narrates**; all arithmetic and constraint-solving is deterministic code in
`meal-plan/`. See [`docs/meal-plan-prompt.md`](docs/meal-plan-prompt.md) for the
prompt, the import JSON shape, and the catalog/product data contracts.

Two paths, offered from the **Calories & macros** section on the Projection tab:

- **Copy prompt** — export the prompt (with your targets filled in) and run it in
  any frontier LLM, then paste the JSON back. Always available; best quality.
- **Build on this device** — when your browser has WebGPU, a small LLM runs
  locally and privately: a short wizard asks for country, dietary preferences,
  meals/day and **when you train** (don't train / morning / evening), then the
  on-device planner picks foods from the country catalog and the solver sizes
  every portion. Needs the country catalog (`catalog.ydin.app`) reachable online
  the first time.

On the on-device path each meal is designed by its **own** stateless prompt, and
the whole day is shaped by one extra prompt up front:

- **Calorie & carb distribution** — before any meal is designed, one prompt decides
  how to spread the day's calories and carbs across the meals (reused across day
  types). Calories usually lean toward a bigger evening meal (an even spread is fine
  when there's plenty to go round); carbs cluster around training time (morning →
  breakfast and lunch, evening → the later meals) and otherwise drift to the end of
  the day. On a very low-carb day (≈50 g or less, e.g. a carb-cycling low day)
  there's nothing to time, so each meal leans on vegetables and fibre helpers
  (psyllium husk, chia, flax) instead. Protein, fat and fibre follow the calorie
  split; carbs follow their own; each meal's kcal is the Atwater sum of its macros,
  so the day total is preserved exactly. A failed call (or iOS, where the call is
  skipped to save memory) falls back to a workout-aware heuristic, so it never blocks.
- **Per-meal design** — each meal prompt is told its carb role (carry carbs vs.
  stay low-carb) and is steered to pick **whole foods that make a balanced plate**
  (a real protein, vegetables, a little fat, a whole-food carb when not low-carb),
  to portion cleanly from a normal package, and to pair items that can't be split —
  e.g. whole eggs **plus** egg whites, so a portion never lands on "1.5 eggs".
- **Designer ↔ critic loop** — a small on-device model, left alone, tends to
  "solve the macros" with cheap fillers (protein powder for protein, nuts for fat,
  spinach for bulk) and repeat them every meal. So each designed plate is judged by
  a deterministic critic (no extra model call): it rejects supplements/protein
  powders, all-protein plates with no vegetable, single-food "meals", and any plate
  that repeats an earlier one — and re-asks the model with targeted feedback (up to
  two revisions). Only an **accepted** plate is cached, so a retry never replays a
  bad meal.
- **Dietary backstop** — the model is told the restrictions ("strict") in every
  food-choosing prompt, but that's trust-the-prompt; a weak model can still slip a
  banned food through. So the model's *own* picks are also screened deterministically
  against `dietBans` (vegan / vegetarian / pescatarian / dairy-, egg-, nut-, soy-free):
  a name-classifier (`foodDietTags`) tags each pick by category — with guards against
  the obvious false positives (plant "milks/butters" aren't dairy; coconut, butternut
  and nutmeg aren't tree nuts) — and any food whose tag is banned is dropped before it
  reaches the plate (the critic re-asks, and diet-safe staples seed the meal). Whole
  categories only; a specific "no pork"-style exclusion stays with the prompt.
- **Local-language matching** — the model names foods in English, but a country's
  Open Food Facts catalog stores **product names in the local language** (`rolled
  oats` vs. `kaurahiutaleet`). A plain English search barely hits a Finnish or
  French shelf, so most foods would fall back to AI macro-guesses and the plan
  collapses onto the few English-ish matches (endless chicken). To fix it, foods
  that miss the English search are run through one batched `localizeFoods` call —
  the **same loaded model**, which already knows the language, returns a few local
  grocery terms per food (`kaurahiutaleet`, `kaura`, `puuro`) — and the catalog is
  re-searched against the English name **and** those synonyms. Real local products
  surface (and display under their real shelf names), which is what gives the plan
  its variety. It only ever *adds* matches: a failed or empty call just leaves the
  English/AI-guess path untouched, and English-catalog countries skip the call
  entirely. Languages are mapped per country code in `CATALOG_LANGS`.
- **Portion realism** — the solver that sizes each plate is bounded: no single
  ingredient may exceed 250 g (no 291 g pile of spinach), and any food it sizes
  below 15 g is dropped and the meal re-solved (no "7 g of chicken" garnish).
  Supplements are also barred from the deterministic macro-repair, so a
  protein-short meal is patched with real food, never with whey.
- **Human portions** — foods eaten in discrete pieces are annotated with a unit
  hint, so a plate reads `70 g (~2 slices)` or `100 g (~2 eggs)` rather than bare
  weights. The unit comes from the catalog's own `servingUnit`/`servingSize` when
  it's a real piece-unit, otherwise from a small guesstimate table (bread → slice,
  egg, banana, tortilla…). Grams stay the source of truth; splittable foods may
  show a half (`½ banana`), and the hint is dropped when the rounding wouldn't be
  honest (12 g is never "1 egg").

To keep memory flat across a many-meal build (phones OOM-crash the tab if a single
generation peaks too high), the on-device path caps each prompt's size, sets a
small WebGPU prefill chunk on phones, clears the chat between meals, and persists
every model response to an **IndexedDB cache** keyed by the plan's inputs. If a
build is interrupted (including an OOM-crash + reload), retrying the same plan
**resumes from that cache** and only regenerates the meals that didn't finish. The
cache holds just the in-flight build — it's pruned on start and cleared on a clean
finish.

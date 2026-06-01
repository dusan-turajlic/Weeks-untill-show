/*
 * Tests for the on-device planner orchestration (Phases 2 & 4), deterministic
 * half only — no browser, no WebGPU, no live model. A small injected catalog +
 * product map stands in for the live host; buildPlan must still produce a valid
 * import-shape plan that hits the targets (the staple fallback path).
 *
 * Run with:  node test/planner.test.js
 */
"use strict";
var planner = require("../meal-plan/planner.js");

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok  - " + name); }
  else { fail++; console.log("  FAIL- " + name + (extra ? "  " + extra : "")); }
}

// Per-100 g products keyed by code, matching the product JSON contract.
function macro(kcal, p, f, c) {
  return { breakdown: { macros: { energy_kcal: kcal, proteins: p, fat: f, carbohydrates: c } } };
}
var PRODUCTS = {
  c1: Object.assign(macro(165, 31, 3.6, 0), { product_name: "Chicken breast" }),
  c2: Object.assign(macro(884, 0, 100, 0), { product_name: "Olive oil" }),
  c3: Object.assign(macro(130, 2.7, 0.3, 28), { product_name: "Rice, cooked" }),
  c4: Object.assign(macro(132, 8.9, 0.5, 23.7), { product_name: "Black beans" }),
  c5: Object.assign(macro(40, 1.5, 0.5, 5), { product_name: "Psyllium husk",
       ai_guesses: { model: "x", timestamp: "t" } }) // estimated micros
};
// Catalog lines [code,name,brand,country,serv,unit,fiber,carbs,fat,protein] (per 100 g).
var CATALOG = [
  ["c1", "Chicken breast", "Farm", "fi", 100, "g", 0, 0, 3.6, 31],
  ["c2", "Olive oil", "Bertolli", "fi", 100, "ml", 0, 0, 100, 0],
  ["c3", "Rice cooked", "Uncle", "fi", 100, "g", 0.4, 28, 0.3, 2.7],
  ["c4", "Black beans", "Bonduelle", "fi", 100, "g", 8.7, 23.7, 0.5, 8.9],
  ["c5", "Psyllium husk", "Health", "fi", 100, "g", 80, 5, 0.5, 1.5]
].map(function (a) { return JSON.stringify(a); }).join("\n");

var fl = require("../meal-plan/food-lookup.js");
var catalog = fl.parseCatalog(CATALOG);

function fakeFetch(url) {
  var m = url.match(/products\/(\w+)\.json$/);
  if (m && PRODUCTS[m[1]]) {
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(PRODUCTS[m[1]]); } });
  }
  return Promise.resolve({ ok: false, status: 404 });
}

var io = { catalog: catalog, fetch: fakeFetch };
var dayTargets = [
  { key: "high", label: "High day", count: 1, kcal: 1969, protein: 135, fat: 68, carbs: 205, fiber: 35 },
  { key: "low", label: "Low day", count: 6, kcal: 1444, protein: 135, fat: 68, carbs: 74, fiber: 35 }
];

var stages = [];
planner.buildPlan({
  dayTargets: dayTargets,
  country: "Finland", currency: "EUR", weeklyBudget: 70,
  prefs: "no pork", mealsPerDay: 3,
  io: io,
  // no engine -> staple fallback; restrict staples to our injected catalog
  staples: ["chicken", "olive oil", "rice", "black beans", "psyllium"],
  onProgress: function (stage) { stages.push(stage); }
}).then(function (plan) {
  console.log("Plan summary: " + plan.summary);
  ok("type/version correct", plan.type === "weeks-until-show-meal-plan" && plan.version === 1);
  ok("country/currency/budget carried", plan.country === "Finland" && plan.currency === "EUR" && plan.weeklyBudget === 70);
  ok("two day types", plan.days.length === 2);
  ok("progress stages fired", stages.indexOf("solve") >= 0 && stages.indexOf("done") >= 0, stages.join(","));

  plan.days.forEach(function (d, i) {
    var t = dayTargets[i];
    console.log("  " + d.label + " totals " + JSON.stringify(d.totals));
    ok(d.label + ": protein >= target", d.totals.protein >= t.protein - 3, "got " + d.totals.protein);
    ok(d.label + ": fat >= target", d.totals.fat >= t.fat - 3, "got " + d.totals.fat);
    ok(d.label + ": fibre >= 35", d.totals.fiber >= 34, "got " + d.totals.fiber);
    ok(d.label + ": carbs within ~10 of target", Math.abs(d.totals.carbs - t.carbs) <= 10, "got " + d.totals.carbs);
    ok(d.label + ": kcal <= goal+tol", d.totals.kcal <= t.kcal + Math.max(30, t.kcal * 0.03), "got " + d.totals.kcal);
    ok(d.label + ": has " + 3 + " meals", d.meals.length === 3);
    var hasItems = d.meals.every(function (m) { return m.items.length > 0; });
    ok(d.label + ": every meal has items", hasItems);
    // Per-day-type totals match the sum of meal items (display matches solver).
    var sumP = 0;
    d.meals.forEach(function (m) { m.items.forEach(function (it) { sumP += it.protein; }); });
    ok(d.label + ": meal items sum ~ day protein", Math.abs(sumP - d.totals.protein) <= 1.5,
       "items=" + sumP.toFixed(1) + " day=" + d.totals.protein);
  });

  ok("shopping list grouped by retailer", plan.shoppingList.length > 0 && plan.shoppingList[0].retailer);
  ok("micronutrient note flags estimated", /estimated/i.test(plan.micronutrients));

  // The whole plan must import cleanly via the app's normaliser shape: days[] non-empty,
  // every item has numeric macros.
  var importable = Array.isArray(plan.days) && plan.days.length > 0 &&
    plan.days.every(function (d) {
      return Array.isArray(d.meals) && d.meals.every(function (m) {
        return Array.isArray(m.items) && m.items.every(function (it) {
          return typeof it.kcal === "number" && typeof it.protein === "number";
        });
      });
    });
  ok("import-shape valid (days/meals/items numeric)", importable);

  // A failing engine (e.g. WebLLM stalling/erroring) must NOT silently degrade to
  // a staple plan — that path was removed. buildPlan rejects with an aiFailure
  // flag so the app can blocklist that model and walk to the next one.
  console.log("\n== engine failure rejects (no staple fallback) ==");
  var brokenEngine = {
    suggestFoods: function () { return Promise.reject(new Error("Cannot pass non-string to std::string")); }
  };
  return planner.buildPlan({
    dayTargets: dayTargets, country: "Finland", currency: "EUR", weeklyBudget: 70,
    prefs: "", mealsPerDay: 3, io: { catalog: catalog, fetch: fakeFetch },
    engine: brokenEngine,
    staples: ["chicken", "olive oil", "rice", "black beans", "psyllium"]
  }).then(function () {
    ok("engine failure rejects (no staple plan)", false, "resolved instead of rejecting");
  }, function (err) {
    ok("engine failure rejects (no staple plan)", true);
    ok("rejection flagged aiFailure (lets the app walk models)", err && err.aiFailure === true);
  }).then(function () {
    // A model that returns ZERO usable foods is also a failure, not a staple plan.
    return planner.buildPlan({
      dayTargets: dayTargets, country: "Finland", currency: "EUR", weeklyBudget: 70,
      prefs: "", mealsPerDay: 3, io: { catalog: catalog, fetch: fakeFetch },
      engine: { suggestFoods: function () { return Promise.resolve([]); } }
    }).then(function () {
      ok("empty food list rejects", false, "resolved instead of rejecting");
    }, function (err) {
      ok("empty food list rejects with aiFailure", err && err.aiFailure === true);
    });
  }).then(function () {
    // ---- device-aware model selection (pure) ----
    console.log("\n== selectModel (device mapping) ==");
    // Minimal stand-in for webllm.prebuiltAppConfig.model_list.
    var ML = [
      { model_id: "Llama-3.2-1B-Instruct-q4f16_1-MLC", vram_required_MB: 879, required_features: ["shader-f16"] },
      { model_id: "Llama-3.2-1B-Instruct-q4f32_1-MLC", vram_required_MB: 1129 },
      { model_id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC", vram_required_MB: 1630, required_features: ["shader-f16"] },
      { model_id: "Qwen2.5-1.5B-Instruct-q4f32_1-MLC", vram_required_MB: 1889 },
      { model_id: "Qwen2.5-0.5B-Instruct-q4f32_1-MLC", vram_required_MB: 1060 },
      { model_id: "Llama-3.2-3B-Instruct-q4f16_1-MLC", vram_required_MB: 2264, required_features: ["shader-f16"],
        buffer_size_required_bytes: 600000000 },
      { model_id: "Llama-3.2-3B-Instruct-q4f32_1-MLC", vram_required_MB: 2951 }
    ];
    var f16 = { shaderF16: true, features: ["shader-f16"], maxStorageBufferBindingSize: 1 << 30, maxBufferSize: 1 << 30 };
    var nof16 = { shaderF16: false, features: [], maxStorageBufferBindingSize: 1 << 30, maxBufferSize: 1 << 30 };

    ok("shader-f16 device -> biggest model that fits, in f16",
       planner.selectModel(ML, f16, { budgetMB: 6000 }) === "Llama-3.2-3B-Instruct-q4f16_1-MLC");
    ok("no shader-f16 -> biggest that fits, in f32 (the Apple/Arc fix)",
       planner.selectModel(ML, nof16, { budgetMB: 6000 }) === "Llama-3.2-3B-Instruct-q4f32_1-MLC");
    ok("snug budget degrades to a smaller base",
       planner.selectModel(ML, nof16, { budgetMB: 2000 }) === "Qwen2.5-1.5B-Instruct-q4f32_1-MLC");
    ok("blocklisting the f16 pick walks to f32 of same base",
       planner.selectModel(ML, f16, { budgetMB: 6000, preference: ["Llama-3.2-3B-Instruct"],
         blocklist: ["Llama-3.2-3B-Instruct-q4f16_1-MLC"] }) === "Llama-3.2-3B-Instruct-q4f32_1-MLC");
    ok("tiny VRAM budget skips bigger models, picks the smallest that fits",
       planner.selectModel(ML, nof16, { budgetMB: 1100 }) === "Qwen2.5-0.5B-Instruct-q4f32_1-MLC");
    ok("buffer limit excludes a model that needs a bigger binding",
       planner.selectModel(ML, { shaderF16: true, features: ["shader-f16"], maxStorageBufferBindingSize: 500000000, maxBufferSize: 1 << 30 },
         { budgetMB: 6000, preference: ["Llama-3.2-3B-Instruct"] }) === "Llama-3.2-3B-Instruct-q4f32_1-MLC");
    ok("returns null when nothing fits",
       planner.selectModel(ML, nof16, { budgetMB: 100 }) === null);
    ok("budget is tighter on mobile than desktop",
       planner.computeBudgetMB({ isMobile: true }) < planner.computeBudgetMB({ isMobile: false, deviceMemory: 8 }));
    ok("desktop budget is generous enough for a ~7B in f16 (>=5200 MB)",
       planner.computeBudgetMB({ isMobile: false, deviceMemory: 8 }) >= 5200);

    // MODEL_PREFERENCE must be biggest-first (capable models before tiny ones) and
    // free of the variants that break a short JSON reply.
    var P = planner.MODEL_PREFERENCE;
    ok("preference leads with a capable model (7B/8B)", /-(7|8)B/i.test(P[0]) || /7B|8B/.test(P[0]), P[0]);
    ok("preference is biggest-first (7B before any 1B)",
       P.findIndex(function (m) { return /7B|8B/.test(m); }) < P.findIndex(function (m) { return /(^|[^.])1B/.test(m) || /0\.5B/.test(m); }));
    ok("preference excludes Coder/Math/Vision/Base/R1 variants",
       P.every(function (m) { return !/Coder|Math|Vision|[-_]Base|R1|Distill/i.test(m); }), P.join(","));
  });
}).then(function () {
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
}).catch(function (e) {
  console.log("  FAIL- buildPlan threw: " + e.stack);
  process.exit(1);
});

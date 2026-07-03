/*
 * Tests for the reliability layer added to the on-device planner:
 *   - voteFoods(): consensus across repeated model runs (drops one-off noise).
 *   - buildPlan() fan-out + voting: designMeal asked `votes` times, voted.
 *   - Fuzzy/translation search: an English-designing model + a LOCAL-LANGUAGE
 *     (Finnish) catalog — foods must be rescued to REAL products via
 *     engine.translateFoods, not lost to AI macro guesses.
 *
 * No browser, no WebGPU, no live model: a mock engine replays canned outputs.
 * Run with:  node test/harness.test.js
 */
"use strict";
var planner = require("../meal-plan/planner.js");
var fl = require("../meal-plan/food-lookup.js");

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok  - " + name); }
  else { fail++; console.log("  FAIL- " + name + (extra ? "  " + extra : "")); }
}

// ---- 1) voteFoods: pure consensus logic ---------------------------------
(function () {
  // "chicken" & "oats" in all 3 runs; "unicorn" once → dropped. Case/space folded.
  var winners = planner.voteFoods([
    ["Chicken breast", "Oats", "Unicorn"],
    ["chicken breast", "oats"],
    ["chicken  breast", "OATS", "Kale"]
  ], { min: 0 });
  ok("vote keeps foods agreed by a majority", winners.length === 2 &&
     /chicken/i.test(winners[0]) && /oats/i.test(winners[1]), winners.join(","));
  ok("vote drops one-off noise", winners.every(function (w) { return !/unicorn|kale/i.test(w); }), winners.join(","));

  // With min backfill, a starved vote still yields foods (next most-agreed).
  var few = planner.voteFoods([["a", "b"], ["c"], ["d"]], { threshold: 3, min: 2 });
  ok("vote backfills to `min` when consensus is thin", few.length === 2, few.join(","));

  // votes===1 semantics: single run passes through unchanged.
  var one = planner.voteFoods([["Tofu", "Rice"]]);
  ok("single run passes through", one.length === 2 && one[0] === "Tofu" && one[1] === "Rice", one.join(","));
})();

// ---- 2) buildPlan: fan-out + voting + translation rescue -----------------

// Catalog in FINNISH (positional: [code,name,brand,country,serv,unit,fiber,carbs,fat,protein] /100 g).
var CATALOG = [
  ["k1", "Kananrinta", "Kotimaista", "fi", 100, "g", 0, 0, 3.6, 31],
  ["k2", "Oliivioljy", "Bertolli", "fi", 100, "ml", 0, 0, 100, 0],
  ["k3", "Kaurahiutaleet", "Elovena", "fi", 100, "g", 10, 60, 7, 13],
  ["k4", "Linssit", "Rainbow", "fi", 100, "g", 8, 20, 0.4, 9],
  ["k5", "Riisi", "Uncle", "fi", 100, "g", 0.4, 28, 0.3, 2.7],
  ["k6", "Banaani", "Chiquita", "fi", 100, "g", 2.6, 23, 0.3, 1.1]
].map(function (a) { return JSON.stringify(a); }).join("\n");
var catalog = fl.parseCatalog(CATALOG);

function macro(kcal, p, f, c) {
  return { breakdown: { macros: { energy_kcal: kcal, proteins: p, fat: f, carbohydrates: c } } };
}
var PRODUCTS = {
  k1: Object.assign(macro(165, 31, 3.6, 0), { product_name: "Kananrinta" }),
  k2: Object.assign(macro(884, 0, 100, 0), { product_name: "Oliivioljy" }),
  k3: Object.assign(macro(370, 13, 7, 60), { product_name: "Kaurahiutaleet" }),
  k4: Object.assign(macro(116, 9, 0.4, 20), { product_name: "Linssit" }),
  k5: Object.assign(macro(130, 2.7, 0.3, 28), { product_name: "Riisi" }),
  k6: Object.assign(macro(96, 1.1, 0.3, 23), { product_name: "Banaani" })
};
function fakeFetch(url) {
  var m = url.match(/products\/(\w+)\.json$/);
  if (m && PRODUCTS[m[1]]) {
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(PRODUCTS[m[1]]); } });
  }
  return Promise.resolve({ ok: false, status: 404 });
}

// English → Finnish search terms the catalog actually uses.
var FI = {
  "chicken breast": ["kananrinta"], "olive oil": ["oliivioljy"],
  "rolled oats": ["kaurahiutaleet"], "lentils": ["linssit"],
  "rice": ["riisi"], "banana": ["banaani"]
};
var ENGLISH_FOODS = Object.keys(FI);

var designCalls = 0, translateCalled = 0;
var mockEngine = {
  // Designs in English; adds a UNIQUE noise food each call so voting must drop it.
  designMeal: function () {
    var noise = "unicorn steak " + (designCalls++);
    return Promise.resolve({ foods: ENGLISH_FOODS.concat([noise]) });
  },
  // The fuzzy-search layer: English name -> local-language catalog terms.
  translateFoods: function (ctx) {
    translateCalled++;
    return Promise.resolve({ terms: (ctx.foods || []).map(function (nm) {
      return { name: nm, queries: FI[String(nm).toLowerCase()] || [] };
    }) });
  }
};

var io = { catalog: catalog, fetch: fakeFetch };
var dayTargets = [{ key: "d", label: "Every day", count: 7,
  kcal: 1620, protein: 120, fat: 60, carbs: 150, fiber: 30 }];

planner.buildPlan({
  dayTargets: dayTargets, country: "Finland", currency: "EUR", weeklyBudget: 70,
  prefs: "none", mealsPerDay: 2, io: io, engine: mockEngine, votes: 3
}).then(function (plan) {
  ok("plan built via engine path", plan && plan.days && plan.days.length === 1);
  ok("designMeal fanned out (votes×meals calls)", designCalls === 3 * 2, "calls=" + designCalls);
  ok("translateFoods was used for fuzzy search", translateCalled > 0);

  var names = [];
  plan.days[0].meals.forEach(function (m) { m.items.forEach(function (it) { names.push(it.food); }); });
  plan.shoppingList.forEach(function (r) { r.items.forEach(function (it) { names.push(it.name); }); });

  ok("voting dropped the one-off noise food", names.every(function (n) { return !/unicorn/i.test(n); }), names.join("|"));
  ok("foods rescued to REAL Finnish products", names.some(function (n) { return /Kananrinta/i.test(n); }), names.join("|"));
  ok("real products aren't flagged AI-estimated",
     !/AI-estimated/i.test(plan.micronutrients), plan.micronutrients);

  ok("every meal has items", plan.days[0].meals.every(function (m) { return m.items.length > 0; }));

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
}).catch(function (err) {
  console.error("buildPlan threw:", err && err.stack || err);
  process.exit(1);
});

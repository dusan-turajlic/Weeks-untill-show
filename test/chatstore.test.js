/*
 * Tests for the optional resumable chat store (opts.chatStore). Each model
 * response is persisted by key, so a build interrupted by an OOM-crash + reload
 * resumes from the store instead of regenerating every meal. Pure + deterministic:
 * a plain counting engine (no WebLLM/GPU) and an in-memory async store stand in
 * for the browser's IndexedDB.
 *
 * Run with:  node test/chatstore.test.js
 */
"use strict";
var planner = require("../meal-plan/planner.js");
var fl = require("../meal-plan/food-lookup.js");

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok  - " + name); }
  else { fail++; console.log("  FAIL- " + name + (extra ? "  " + extra : "")); }
}

var CATALOG = [
  ["c1", "Chicken breast", "Farm", "fi", 100, "g", 0, 0, 3.6, 31],
  ["c2", "Olive oil", "B", "fi", 100, "ml", 0, 0, 100, 0],
  ["c3", "Rice cooked", "U", "fi", 100, "g", 0.4, 28, 0.3, 2.7],
  ["c4", "Black beans", "B", "fi", 100, "g", 8.7, 23.7, 0.5, 8.9],
  ["c5", "Psyllium husk", "H", "fi", 100, "g", 80, 5, 0.5, 1.5]
].map(function (a) { return JSON.stringify(a); }).join("\n");
var PRODUCTS = {
  c1: { product_name: "Chicken breast", breakdown: { macros: { energy_kcal: 165, proteins: 31, fat: 3.6, carbohydrates: 0 } } },
  c2: { product_name: "Olive oil", breakdown: { macros: { energy_kcal: 884, proteins: 0, fat: 100, carbohydrates: 0 } } },
  c3: { product_name: "Rice", breakdown: { macros: { energy_kcal: 130, proteins: 2.7, fat: 0.3, carbohydrates: 28 } } },
  c4: { product_name: "Black beans", breakdown: { macros: { energy_kcal: 132, proteins: 8.9, fat: 0.5, carbohydrates: 23.7 } } },
  c5: { product_name: "Psyllium", breakdown: { macros: { energy_kcal: 40, proteins: 1.5, fat: 0.5, carbohydrates: 5 } } }
};
function fakeFetch(url) {
  var m = url.match(/products\/(\w+)\.json$/);
  if (m && PRODUCTS[m[1]]) return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(PRODUCTS[m[1]]); } });
  return Promise.resolve({ ok: false, status: 404 });
}
var catalog = fl.parseCatalog(CATALOG);

var MEALS = {
  Breakfast: ["chicken breast", "black beans"],
  Lunch: ["chicken breast", "rice cooked", "olive oil"],
  Dinner: ["chicken breast", "psyllium husk", "olive oil"]
};
// A plain counting engine — no GPU, no model. Counts how many real generations
// each method runs, so we can prove the store skips them on a resume.
function countingEngine(counts) {
  return {
    planDayShape: function (ctx) {
      counts.shape++;
      return Promise.resolve({ meals: ctx.mealNames.map(function (n) { return { name: n, kcal: 1, carb: 1 }; }) });
    },
    designMeal: function (ctx) {
      counts.meal++;
      return Promise.resolve({ foods: MEALS[ctx.mealName] || ["chicken breast", "rice cooked"] });
    },
    guessMacros: function (ctx) {
      counts.guess++;
      return Promise.resolve({ macros: (ctx.foods || []).map(function (f) { return { name: f }; }) });
    }
  };
}
// In-memory async store mimicking IndexedDB (structured-clone on write).
function memStore() {
  var m = {};
  return {
    _m: m,
    keys: function () { return Object.keys(m); },
    get: function (k) { return Promise.resolve(Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null); },
    set: function (k, v) { m[k] = JSON.parse(JSON.stringify(v)); return Promise.resolve(); }
  };
}
function build(engine, store) {
  return planner.buildPlan({
    dayTargets: [{ key: "low", label: "Low day", count: 7, kcal: 1444, protein: 135, fat: 68, carbs: 74, fiber: 35 }],
    country: "Finland", prefs: "", breakfast: "savory", mealsPerDay: 3, workout: "morning",
    io: { catalog: catalog, fetch: fakeFetch }, engine: engine, chatStore: store
  });
}
function foodsOf(mp) {
  return mp.days[0].meals.map(function (m) { return m.items.map(function (it) { return it.food; }).sort().join(","); });
}

var store = memStore();

// 1) First build with an empty store: the engine actually runs, and every
//    response is written to the store.
var c1 = { shape: 0, meal: 0, guess: 0 };
build(countingEngine(c1), store).then(function (mp1) {
  console.log("\n== first build populates the store ==");
  ok("3 meals were designed (real generations)", c1.meal === 3, "meal=" + c1.meal);
  ok("the day shape was generated once", c1.shape === 1, "shape=" + c1.shape);
  ok("store now holds the shape + per-meal responses",
     store.keys().indexOf("shape") >= 0 && store.keys().indexOf("meal:0") >= 0 && store.keys().indexOf("meal:2") >= 0,
     JSON.stringify(store.keys()));
  var foods1 = foodsOf(mp1);

  // 2) Second build, SAME store (now populated): a full resume — NOTHING is
  //    regenerated, yet the plan is identical.
  var c2 = { shape: 0, meal: 0, guess: 0 };
  return build(countingEngine(c2), store).then(function (mp2) {
    console.log("\n== second build resumes fully from the store ==");
    ok("no meals regenerated (served from the store)", c2.meal === 0, "meal=" + c2.meal);
    ok("the shape was not regenerated", c2.shape === 0, "shape=" + c2.shape);
    ok("the resumed plan matches the original", JSON.stringify(foodsOf(mp2)) === JSON.stringify(foods1),
       JSON.stringify(foodsOf(mp2)) + " vs " + JSON.stringify(foods1));
  });
}).then(function () {
  // 3) Partial resume: drop the last meal from the store (as if the build
  //    crashed mid-meal-3). Only that one meal is regenerated.
  console.log("\n== partial resume only regenerates the missing meal ==");
  delete store._m["meal:2"];
  var c3 = { shape: 0, meal: 0, guess: 0 };
  return build(countingEngine(c3), store).then(function (mp3) {
    ok("exactly one meal regenerated (the dropped one)", c3.meal === 1, "meal=" + c3.meal);
    ok("the shape and earlier meals stayed cached", c3.shape === 0, "shape=" + c3.shape);
    ok("the plan still has all 3 meals", mp3.days[0].meals.length === 3, "meals=" + mp3.days[0].meals.length);
  });
}).then(function () {
  console.log("\n" + pass + " passed, " + fail + " failed");
  if (fail) process.exit(1);
}, function (err) {
  console.log("  FAIL- buildPlan threw: " + (err && err.stack || err));
  process.exit(1);
});

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

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
}).catch(function (e) {
  console.log("  FAIL- buildPlan threw: " + e.stack);
  process.exit(1);
});

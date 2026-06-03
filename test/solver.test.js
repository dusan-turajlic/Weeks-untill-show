/*
 * Tests for the deterministic portion solver (Phase 3).
 *
 * Acceptance (from the plan §5 Phase 3 / §8): for a hand-picked food set the
 * solver must hit, with zero LLM involvement and within tolerance:
 *   High day — 1969 kcal / 135 g protein / 68 g fat / 205 g carbs, fibre ≥ 35
 *   Low  day — 1444 kcal / 135 g protein /  68 g fat /  74 g carbs, fibre ≥ 35
 *
 * Run with:  node test/solver.test.js
 */
"use strict";
var solver = require("../meal-plan/solver.js");

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok  - " + name); }
  else { fail++; console.log("  FAIL- " + name + (extra ? "  " + extra : "")); }
}

// Per-100 g macros: { protein, fat, carbs, fiber }. carbs are net of fibre
// (EU/Fineli convention used by the catalog), so high-fibre items don't blow
// the carb target.
var FOODS = {
  chicken: { name: "Chicken breast", protein: 31, fat: 3.6, carbs: 0, fiber: 0 },
  oil:     { name: "Olive oil",      protein: 0,  fat: 100, carbs: 0, fiber: 0 },
  rice:    { name: "Rice, cooked",   protein: 2.7, fat: 0.3, carbs: 28, fiber: 0.4 },
  beans:   { name: "Black beans",    protein: 8.9, fat: 0.5, carbs: 23.7, fiber: 8.7 },
  oats:    { name: "Rolled oats",    protein: 13, fat: 7, carbs: 60, fiber: 10 },
  psyllium:{ name: "Psyllium husk",  protein: 1.5, fat: 0.5, carbs: 5, fiber: 80 }
};

function check(label, targets, foods) {
  var r = solver.solvePortions(targets, foods);
  console.log("\n" + label + " -> " + JSON.stringify(r.totals) +
              "  grams=" + r.grams.map(function (g) { return Math.round(g); }).join("/"));
  ok(label + ": solved (ok)", r.ok, r.note);
  ok(label + ": all grams non-negative", r.grams.every(function (g) { return g >= -1e-6; }));
  ok(label + ": protein >= " + targets.protein, r.totals.protein >= targets.protein - 2,
     "got " + r.totals.protein);
  ok(label + ": fat >= " + targets.fat, r.totals.fat >= targets.fat - 2, "got " + r.totals.fat);
  ok(label + ": fibre >= 35", r.totals.fiber >= 34, "got " + r.totals.fiber);
  ok(label + ": carbs ~ " + targets.carbs, Math.abs(r.totals.carbs - targets.carbs) <= 8,
     "got " + r.totals.carbs);
  ok(label + ": kcal <= goal+tol", r.totals.kcal <= targets.kcal + Math.max(25, targets.kcal * 0.02),
     "got " + r.totals.kcal);
  return r;
}

console.log("== High day ==");
check("High", { kcal: 1969, protein: 135, fat: 68, carbs: 205, fiber: 35 },
      [FOODS.chicken, FOODS.oil, FOODS.rice, FOODS.beans]);

console.log("\n== Low day ==");
check("Low", { kcal: 1444, protein: 135, fat: 68, carbs: 74, fiber: 35 },
      [FOODS.chicken, FOODS.oil, FOODS.oats, FOODS.psyllium]);

// Repair path: a protein-poor food set can't reach 135 g protein, and the
// solver must say so by listing the failing constraint (not silently pass).
console.log("\n== Repair signalling ==");
(function () {
  var r = solver.solvePortions(
    { kcal: 1444, protein: 135, fat: 68, carbs: 74, fiber: 35 },
    [FOODS.oil, FOODS.rice]); // no real protein source
  ok("repair: not ok", !r.ok);
  ok("repair: flags a failed constraint", r.failed.length > 0,
     JSON.stringify(r.failed));
  ok("repair: each failure has constraint+target+actual",
     r.failed.every(function (f) {
       return f.constraint && typeof f.target === "number" && typeof f.actual === "number";
     }));
})();

// mealTotals scales linearly: doubling grams doubles macros.
console.log("\n== mealTotals scaling ==");
(function () {
  var a = solver.mealTotals([FOODS.chicken], [100]);
  var b = solver.mealTotals([FOODS.chicken], [200]);
  ok("100 g chicken protein = 31", Math.abs(a.protein - 31) < 0.01, "got " + a.protein);
  ok("200 g chicken protein = 62", Math.abs(b.protein - 62) < 0.01, "got " + b.protein);
  ok("kcal via Atwater (100 g chicken)",
     a.kcal === Math.round(4 * 31 + 4 * 0 + 9 * 3.6), "got " + a.kcal);
})();

// opts.maxGrams: no single food may exceed its cap; the rest must absorb the
// target so nothing balloons to an inedible 291 g.
console.log("\n== bounded portions (maxGrams) ==");
(function () {
  var foods = [FOODS.psyllium, FOODS.chicken]; // psyllium is the only big fibre source
  var target = { kcal: 600, protein: 50, fat: 6, carbs: 10, fiber: 40 };
  var uncapped = solver.solvePortions(target, foods);
  var capped = solver.solvePortions(target, foods, { maxGrams: 60 });
  ok("uncapped lets one food run high", Math.max.apply(null, uncapped.grams) > 60,
     uncapped.grams.map(Math.round).join(","));
  ok("maxGrams caps every food", capped.grams.every(function (g) { return g <= 60 + 1e-6; }),
     capped.grams.map(Math.round).join(","));
  ok("no maxGrams = original behaviour (unchanged grams)",
     JSON.stringify(solver.solvePortions(target, foods).grams) === JSON.stringify(uncapped.grams));
})();

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);

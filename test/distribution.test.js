/*
 * Tests for the calorie/carb distribution layer (splitDayTargets + normalizeShape).
 * Pure, deterministic — no model, no catalog. Verifies that a day's macros are
 * spread across meals consistently, that the model's "day shape" is honoured
 * (carbs cluster where training is), and that the heuristic fallback leans carbs
 * toward the end of the day.
 *
 * Run with:  node test/distribution.test.js
 */
"use strict";
var planner = require("../meal-plan/planner.js");
var split = planner.splitDayTargets;

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok  - " + name); }
  else { fail++; console.log("  FAIL- " + name + (extra ? "  " + extra : "")); }
}
function near(a, b, eps) { return Math.abs(a - b) <= (eps == null ? 0.5 : eps); }
function sum(a, k) { return a.reduce(function (s, x) { return s + x[k]; }, 0); }

var NAMES = ["Breakfast", "Lunch", "Dinner"];
var DAY = { protein: 150, fat: 60, carbs: 180, fiber: 36 };

// 1) Day totals are preserved exactly, whatever the shape.
(function () {
  console.log("\n== day totals preserved ==");
  var meals = split(DAY, NAMES, null); // null -> heuristic fallback
  ok("protein sums to the day total", near(sum(meals, "protein"), DAY.protein));
  ok("fat sums to the day total", near(sum(meals, "fat"), DAY.fat));
  ok("carbs sum to the day total", near(sum(meals, "carbs"), DAY.carbs));
  ok("fibre sums to the day total", near(sum(meals, "fiber"), DAY.fiber));
})();

// 2) Each meal's kcal is the Atwater sum of its own macros (internally consistent).
(function () {
  console.log("\n== per-meal kcal is internally consistent ==");
  var meals = split(DAY, NAMES, null);
  var consistent = meals.every(function (m) {
    return near(m.kcal, 4 * m.protein + 4 * m.carbs + 9 * m.fat, 1);
  });
  ok("every meal kcal = 4P + 4C + 9F", consistent);
})();

// 3) Morning-training shape: carbs cluster in breakfast + lunch, not dinner.
(function () {
  console.log("\n== morning shape keeps carbs early ==");
  var shape = { meals: [
    { name: "Breakfast", kcal: 1, carb: 3 },
    { name: "Lunch", kcal: 1, carb: 3 },
    { name: "Dinner", kcal: 1.4, carb: 1 }
  ] };
  var m = split(DAY, NAMES, shape);
  ok("breakfast + lunch carry most carbs", m[0].carbs + m[1].carbs > m[2].carbs * 2,
     JSON.stringify(m.map(function (x) { return Math.round(x.carbs); })));
  ok("the carb-heavy meals are flagged high", m[0].carbFocus === "high" && m[1].carbFocus === "high");
  ok("the low-carb dinner is flagged", m[2].carbFocus !== "high");
  // calories still preserved despite different carb vs kcal weights
  ok("day carbs still preserved", near(sum(m, "carbs"), DAY.carbs));
})();

// 4) No shape (no training): the fallback leans carbs toward the end of the day.
(function () {
  console.log("\n== fallback pushes carbs to the day's end ==");
  var m = split(DAY, NAMES, null);
  ok("dinner gets more carbs than breakfast", m[2].carbs > m[0].carbs,
     JSON.stringify(m.map(function (x) { return Math.round(x.carbs); })));
})();

// 4b) No shape but morning training (e.g. iOS, where the shape call is skipped):
//     the deterministic fallback still pulls carbs to the earlier meals.
(function () {
  console.log("\n== workout-aware fallback (morning training, no model call) ==");
  var m = split(DAY, NAMES, null, "morning");
  ok("breakfast gets more carbs than dinner with morning training", m[0].carbs > m[2].carbs,
     JSON.stringify(m.map(function (x) { return Math.round(x.carbs); })));
  var e = split(DAY, NAMES, null, "evening");
  ok("evening training keeps carbs later", e[2].carbs > e[0].carbs,
     JSON.stringify(e.map(function (x) { return Math.round(x.carbs); })));
})();

// 5) Very low-carb day (e.g. a carb-cycling low day): nothing to time — every meal
//    is flagged low-carb so the designer leans on veg + fibre.
(function () {
  console.log("\n== low-carb day flags every meal low ==");
  var low = { protein: 150, fat: 70, carbs: 35, fiber: 35 };
  var m = split(low, NAMES, null);
  ok("all meals carbFocus = low on a 35 g carb day", m.every(function (x) { return x.carbFocus === "low"; }));
  ok("low-day carbs still preserved", near(sum(m, "carbs"), low.carbs));
})();

// 6) Snacks get a lighter share than main meals under the heuristic.
(function () {
  console.log("\n== snacks are lighter ==");
  var names = ["Breakfast", "Lunch", "Snack", "Dinner"];
  var m = split({ protein: 160, fat: 64, carbs: 200, fiber: 40 }, names, null);
  ok("the snack is the smallest meal by kcal",
     m[2].kcal < m[0].kcal && m[2].kcal < m[1].kcal && m[2].kcal < m[3].kcal,
     JSON.stringify(m.map(function (x) { return Math.round(x.kcal); })));
})();

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) process.exit(1);

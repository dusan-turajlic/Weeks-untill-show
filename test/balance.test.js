/*
 * Tests for meal QUALITY on the on-device path — the fix for the "whey + almonds
 * + frozen spinach ×5, with 7 g of chicken" output. Two guards work together:
 *
 *   1. A designer↔critic loop: the model proposes foods, a deterministic critic
 *      rejects supplement-fillers / all-protein plates / repeats and re-asks with
 *      feedback until the plate is a balanced set of whole foods.
 *   2. Portion realism in the solver/assembly: no ingredient below 15 g (no
 *      garnish-dust) and none above 250 g (no 291 g pile of spinach).
 *
 * Run with:  node test/balance.test.js
 */
"use strict";
var planner = require("../meal-plan/planner.js");
var fl = require("../meal-plan/food-lookup.js");

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok  - " + name); }
  else { fail++; console.log("  FAIL- " + name + (extra ? "  " + extra : "")); }
}

// Catalog rows: [code, name, brand, cc, qty, unit, fiber, carbs, fat, protein] /100 g.
var CATALOG = [
  ["w1", "Whey Protein", "B", "fi", 100, "g", 0, 8, 7, 80],
  ["a1", "Almonds", "B", "fi", 100, "g", 12, 22, 49, 21],
  ["s1", "Frozen Spinach", "B", "fi", 100, "g", 2, 1, 0.4, 3],
  ["c1", "Chicken breast", "B", "fi", 100, "g", 0, 0, 3.6, 31],
  ["b1", "Broccoli", "B", "fi", 100, "g", 2.6, 7, 0.4, 2.8],
  ["r1", "Brown rice cooked", "B", "fi", 100, "g", 1.8, 23, 0.9, 2.6],
  ["o1", "Olive oil", "B", "fi", 100, "ml", 0, 0, 100, 0],
  ["e1", "Eggs", "B", "fi", 100, "g", 0, 1.1, 11, 13],
  ["t1", "Oats", "B", "fi", 100, "g", 10, 66, 7, 13],
  ["f1", "Salmon", "B", "fi", 100, "g", 0, 0, 13, 20],
  ["g1", "Green beans", "B", "fi", 100, "g", 3.4, 7, 0.2, 1.8],
  ["p1", "Sweet potato", "B", "fi", 100, "g", 3, 20, 0.1, 1.6]
].map(function (a) { return JSON.stringify(a); }).join("\n");
var catalog = fl.parseCatalog(CATALOG);
var noFetch = function () { return Promise.resolve({ ok: false, status: 404 }); }; // catalog macros back everything

function build(engine) {
  return planner.buildPlan({
    dayTargets: [{ label: "Day", count: 7, kcal: 1800, protein: 140, fat: 60, carbs: 180, fiber: 30 }],
    country: "Finland", prefs: "", breakfast: "savory", mealsPerDay: 3, workout: "morning",
    io: { catalog: catalog, fetch: noFetch }, engine: engine
  });
}
function grams(s) { return parseFloat(String(s).replace(/[^0-9.]/g, "")) || 0; }
function items(mp) {
  var out = [];
  mp.days[0].meals.forEach(function (m) { m.items.forEach(function (it) { out.push(it); }); });
  return out;
}
var SUPP = /whey|casein|protein powder|isolate|gainer|bcaa/i;

// 1) A model that first reaches for the supplement-filler trio, then (after the
//    critic's feedback) plates real whole foods, one balanced meal per slot.
var BAD = ["whey protein", "almonds", "frozen spinach"];
var GOOD = {
  Breakfast: ["eggs", "spinach", "oats", "olive oil"],
  Lunch: ["chicken breast", "broccoli", "brown rice", "olive oil"],
  Dinner: ["salmon", "green beans", "sweet potato", "almonds"]
};
function reformingEngine(log) {
  return {
    designMeal: function (ctx) {
      log.push({ meal: ctx.mealName, feedback: ctx.feedback || null });
      // No feedback = first attempt → the bad filler. With feedback → fix it.
      return Promise.resolve({ foods: ctx.feedback ? GOOD[ctx.mealName] : BAD });
    },
    guessMacros: function () { return Promise.resolve({ macros: [] }); }
  };
}

var log = [];
build(reformingEngine(log)).then(function (mp) {
  console.log("\n== designer↔critic loop reforms a bad plate ==");
  var fedback = log.filter(function (c) { return c.feedback; });
  ok("the critic rejected the filler and re-asked with feedback", fedback.length >= 1, "calls=" + JSON.stringify(log));
  ok("feedback called out the supplement", fedback.some(function (c) { return /supplement|whole food|powder/i.test(c.feedback); }),
     fedback.map(function (c) { return c.feedback; }).join(" || "));

  var its = items(mp);
  ok("no supplement survives into the plan", its.every(function (it) { return !SUPP.test(it.food); }),
     its.map(function (it) { return it.food; }).join(", "));
  ok("every portion is edible: 15 g ≤ amount ≤ 250 g", its.every(function (it) { return grams(it.amount) >= 15 - 0.5 && grams(it.amount) <= 250 + 0.5; }),
     its.map(function (it) { return it.food + " " + it.amount; }).join(", "));
  ok("no 7 g garnish (every item ≥ 15 g)", its.every(function (it) { return grams(it.amount) >= 15 - 0.5; }));
  ok("no 291 g pile (every item ≤ 250 g)", its.every(function (it) { return grams(it.amount) <= 250 + 0.5; }));

  // Each meal is a balanced plate: a real protein AND a non-protein whole food.
  var balanced = mp.days[0].meals.every(function (m) {
    var names = m.items.map(function (it) { return it.food.toLowerCase(); });
    var hasProt = names.some(function (n) { return /chicken|salmon|egg|whey/.test(n); });
    var hasOther = names.some(function (n) { return /spinach|broccoli|rice|oil|oats|bean|potato|almond/.test(n); });
    return m.items.length >= 2 && hasProt && hasOther;
  });
  ok("every meal is a balanced plate (protein + a non-protein whole food)", balanced,
     mp.days[0].meals.map(function (m) { return m.name + ":[" + m.items.map(function (i) { return i.food; }).join(",") + "]"; }).join(" | "));
}).then(function () {
  // 2) De-dupe: a model that returns the SAME (valid) plate for every meal must be
  //    told it's repeating, so the day doesn't become one meal five times.
  console.log("\n== repeats are rejected ==");
  var log2 = [];
  var sameEngine = {
    designMeal: function (ctx) {
      log2.push({ meal: ctx.mealName, feedback: ctx.feedback || null });
      return Promise.resolve({ foods: ["chicken breast", "broccoli", "brown rice", "olive oil"] });
    },
    guessMacros: function () { return Promise.resolve({ macros: [] }); }
  };
  return build(sameEngine).then(function () {
    ok("a later meal was told it repeats an earlier one",
       log2.some(function (c) { return c.feedback && /repeat|monoton|vary/i.test(c.feedback); }),
       log2.map(function (c) { return c.meal + ":" + (c.feedback || "—"); }).join(" | "));
  });
}).then(function () {
  console.log("\n" + pass + " passed, " + fail + " failed");
  if (fail) process.exit(1);
}, function (err) {
  console.log("  FAIL- buildPlan threw: " + (err && err.stack || err));
  process.exit(1);
});

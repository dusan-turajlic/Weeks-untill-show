"use strict";
// Server (Path C) meal-plan: the request body built from buildDayTargets()
// output, and that a server response round-trips the existing import path.
// Dependency-free, extracts the real functions from index.html.
// Run: node test/mealplan-server.test.js
var fs = require("fs");
var path = require("path");

var html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
function region(start, end) {
  var i = html.indexOf(start), j = html.indexOf(end);
  if (i < 0 || j < 0 || j <= i) throw new Error("Could not locate region: " + start);
  return html.slice(i, j);
}

/* jshint evil:true */
var bodyApi = new Function(
  region("// ---- server meal plan: request body", "// ---- server meal plan: end") +
  "\nreturn { mealPlanRequestBody: mealPlanRequestBody };"
)();
var normApi = new Function(
  region("function normalizeMealPlan", "// URL-safe base64") +
  "\nreturn { normalizeMealPlan: normalizeMealPlan };"
)();

var passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name); }
}

console.log("server meal plan: request body");

// Shape mirrors buildDayTargets() output (key/label/count/perWeek/macros).
var dayTargets = [
  { key: "even", label: "Every day", count: 7, perWeek: 7, kcal: 1800, protein: 150, fat: 70, carbs: 120, fiber: 35 },
];
var body = bodyApi.mealPlanRequestBody(
  { country: "Finland", currency: "EUR", mealsPerDay: 3 }, dayTargets
);

check("echoes country and currency", body.country === "Finland" && body.currency === "EUR");
check("defaults a missing budget to 0", body.weeklyBudget === 0);
check("defaults missing prefs to empty string", body.prefs === "");
check("carries mealsPerDay", body.mealsPerDay === 3);
check("maps one dayTarget per input", body.dayTargets.length === 1);
var dt = body.dayTargets[0];
check("maps the macro fields the API expects",
  dt.label === "Every day" && dt.perWeek === 7 && dt.kcal === 1800 &&
  dt.protein === 150 && dt.fat === 70 && dt.carbs === 120 && dt.fiber === 35);
check("drops client-only fields (key, count)", !("key" in dt) && !("count" in dt));

// perWeek falls back to count when only count is present
var bodyB = bodyApi.mealPlanRequestBody(
  { country: "Sweden", currency: "SEK", mealsPerDay: 4, weeklyBudget: 90, prefs: "vegetarian" },
  [{ label: "High day", count: 2, kcal: 2200, protein: 150, fat: 60, carbs: 240, fiber: 35 }]
);
check("perWeek falls back to count", bodyB.dayTargets[0].perWeek === 2);
check("passes through an explicit budget and prefs", bodyB.weeklyBudget === 90 && bodyB.prefs === "vegetarian");

console.log("\nserver meal plan: response import");

var serverPlan = {
  type: "weeks-until-show-meal-plan", version: 1, country: "Finland", currency: "EUR",
  weeklyBudget: 60, summary: "ok",
  days: [{ label: "Every day", perWeek: 7, meals: [], totals: { kcal: 1800, protein: 150, fat: 70, carbs: 120, fiber: 35 } }],
  shoppingList: [], micronutrients: "ok",
};
check("a well-formed server plan imports", normApi.normalizeMealPlan(serverPlan) === serverPlan);
check("a plan with no days is rejected", normApi.normalizeMealPlan({ days: [] }) === null);
check("a non-object is rejected", normApi.normalizeMealPlan("nope") === null);

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);

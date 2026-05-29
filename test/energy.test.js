/*
 * Tests for the calorie / macro / step model.
 *
 * Like offtrack.test.js, this pulls the real formulas straight out of
 * index.html so the tests track the shipped code. Run with:
 *   node test/energy.test.js
 */
"use strict";
var fs = require("fs");
var path = require("path");

var html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

function region(start, end) {
  var i = html.indexOf(start), j = html.indexOf(end);
  if (i < 0 || j < 0 || j <= i) throw new Error("Could not locate region: " + start);
  return html.slice(i, j);
}
// The block holds the constants and the pure formula functions used by
// bodyMetrics()/energyPlan().
var energySrc = region("// ---- energy / macro constants & formulas",
                       "// ---- daily weight log: IndexedDB");

/* jshint evil:true */
var api = new Function(
  energySrc +
  "return { maintMultiplier:maintMultiplier, maintenanceCalories:maintenanceCalories, " +
  "minProtein:minProtein, minFat:minFat, interp:interp, calcKcalPerStep:calcKcalPerStep, " +
  "KCAL_PER_KG:KCAL_PER_KG, KG_TO_LB:KG_TO_LB, MAX_FOOD_DEFICIT:MAX_FOOD_DEFICIT, FIBER_MIN:FIBER_MIN };"
)();

// ---- tiny assert harness ---------------------------------------------------
var passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name); }
}
function near(a, b, tol) { return Math.abs(a - b) <= tol; }

console.log("calorie / macro / step model");

// ---- maintenance multiplier (by weight bracket, in lb) ---------------------
check("male <200lb -> 12×",        api.maintMultiplier("male", 180) === 12);
check("male 200–250lb -> 10.5×",   api.maintMultiplier("male", 220) === 10.5);
check("male 400+lb -> 6×",         api.maintMultiplier("male", 420) === 6);
check("female <150lb -> 13.5×",    api.maintMultiplier("female", 140) === 13.5);
check("female 250–300lb -> 9×",    api.maintMultiplier("female", 280) === 9);
check("brackets are upper-exclusive (200lb male uses next bracket)",
  api.maintMultiplier("male", 200) === 10.5);

// ---- maintenance calories (converts kg -> lb internally) -------------------
// 90 kg = 198.4 lb (<200) -> ×12 = ~2381 kcal
check("90kg male maintenance ≈ 2381 kcal", near(api.maintenanceCalories("male", 90), 198.416 * 12, 1));
// 100 kg = 220.5 lb (200–250) -> ×10.5
check("100kg male maintenance ≈ 2315 kcal", near(api.maintenanceCalories("male", 100), 220.46 * 10.5, 1));

// ---- minimum protein & fat (interpolated by height in cm) ------------------
check("male protein at 175.26cm (5'9\") = 165g", near(api.minProtein("male", 175.26), 165, 1e-6));
check("male fat at 182.88cm (6'0\") = 70g",       near(api.minFat("male", 182.88), 70, 1e-6));
check("female protein at 152.4cm (5'0\") = 100g", near(api.minProtein("female", 152.4), 100, 1e-6));
// halfway between 5'9" (165) and 6'0" (185) for a male -> ~175g protein
check("male protein interpolates between points",
  near(api.minProtein("male", (175.26 + 182.88) / 2), 175, 0.01));
// clamps below/above the table ends
check("protein clamps at the short end", api.minProtein("male", 120) === 135);
check("fat clamps at the tall end",      api.minFat("male", 230) === 93);

// ---- kcal per step ---------------------------------------------------------
var kps = api.calcKcalPerStep(80, 180);
check("kcal/step 80kg/180cm ≈ 0.0298", near(kps, 0.0298, 0.002));
check("heavier person burns more per step",
  api.calcKcalPerStep(100, 180) > api.calcKcalPerStep(70, 180));

// ---- end-to-end deficit / cap / steps split --------------------------------
check("kcal-per-kg constant is 7700", api.KCAL_PER_KG === 7700);
check("food deficit is capped at 700", api.MAX_FOOD_DEFICIT === 700);
check("fibre target is 35g", api.FIBER_MIN === 35);

// Lose 6 kg over 84 days -> need 6*7700/84 ≈ 550/day. Under the cap, so food
// covers it all and steps cover 0.
(function () {
  var need = 6 * api.KCAL_PER_KG / 84;
  var food = Math.min(need, api.MAX_FOOD_DEFICIT);
  var stepDef = Math.max(0, need - food);
  check("6kg/84d (~550) sits under the cap, no steps needed", near(food, 550, 1) && stepDef === 0);
})();

// Lose 10 kg over 84 days -> need ~917/day. Food capped at 700, steps cover ~217.
(function () {
  var need = 10 * api.KCAL_PER_KG / 84;
  var food = Math.min(need, api.MAX_FOOD_DEFICIT);
  var stepDef = need - food;
  var steps = stepDef / kps;
  check("10kg/84d (~917) caps food at 700, steps cover the rest",
    food === 700 && near(stepDef, 217, 2) && steps > 5000);
})();

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);

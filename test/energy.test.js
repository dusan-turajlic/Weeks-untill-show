/*
 * Tests for the energy / body-composition formulas.
 *
 * Like offtrack.test.js, this pulls the real calcBMR()/calcBodyFat()/
 * calcKcalPerStep() source straight out of index.html so the tests track the
 * shipped code. Run with:  node test/energy.test.js
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
// The block holds the constants (LB_TO_KG, KCAL_PER_KG, ACTIVITY) and the three
// pure formula functions used by bodyMetrics()/energyPlan().
var energySrc = region("// ---- energy / body-composition constants & formulas",
                       "// ---- daily weight log: IndexedDB");

/* jshint evil:true */
var api = new Function(
  energySrc +
  "return { calcBMR:calcBMR, calcBodyFat:calcBodyFat, calcKcalPerStep:calcKcalPerStep, " +
  "ACTIVITY:ACTIVITY, KCAL_PER_KG:KCAL_PER_KG, LB_TO_KG:LB_TO_KG };"
)();

// ---- tiny assert harness ---------------------------------------------------
var passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name); }
}
function near(a, b, tol) { return Math.abs(a - b) <= tol; }

console.log("energy / body-composition formulas");

// ---- Mifflin-St Jeor BMR ---------------------------------------------------
// Male 80kg / 180cm / 30yr: 10*80 + 6.25*180 - 5*30 + 5 = 1780
check("BMR male 80kg/180cm/30 = 1780", api.calcBMR(80, 180, 30, true) === 1780);
// Female 60kg / 165cm / 30yr: 600 + 1031.25 - 150 - 161 = 1320.25
check("BMR female 60kg/165cm/30 = 1320.25", near(api.calcBMR(60, 165, 30, false), 1320.25, 1e-6));
// Sex offset is exactly 166 kcal (male +5 vs female -161) for identical inputs.
check("male-vs-female BMR offset is 166",
  near(api.calcBMR(70, 175, 40, true) - api.calcBMR(70, 175, 40, false), 166, 1e-6));

// ---- CUN-BAE body fat % ----------------------------------------------------
var bfM = api.calcBodyFat(80, 180, 30, true);    // ~21–22% for this male
var bfF = api.calcBodyFat(60, 165, 30, false);   // higher for a female at lower BMI
check("body fat male 80kg/180cm/30 ≈ 21.6%", near(bfM, 21.6, 1.0));
check("women estimate higher body fat than men at equal age", bfF > api.calcBodyFat(60, 165, 30, true));
check("body fat is clamped into a plausible range",
  api.calcBodyFat(45, 200, 18, true) >= 3 && api.calcBodyFat(160, 150, 80, false) <= 60);

// ---- kcal per step ---------------------------------------------------------
var kps = api.calcKcalPerStep(80, 180);   // stride .7452m * 80kg * 0.5/1000
check("kcal/step 80kg/180cm ≈ 0.0298", near(kps, 0.0298, 0.002));
check("heavier person burns more per step",
  api.calcKcalPerStep(100, 180) > api.calcKcalPerStep(70, 180));
check("a 500 kcal deficit ≈ a sensible step count (10k–20k)",
  (function(){ var s = 500 / kps; return s > 10000 && s < 20000; })());

// ---- activity multipliers / constants --------------------------------------
check("activity multipliers ascend sedentary→extra",
  api.ACTIVITY.sedentary.mult < api.ACTIVITY.light.mult &&
  api.ACTIVITY.light.mult < api.ACTIVITY.moderate.mult &&
  api.ACTIVITY.moderate.mult < api.ACTIVITY.very.mult &&
  api.ACTIVITY.very.mult < api.ACTIVITY.extra.mult);
check("kcal-per-kg constant is 7700", api.KCAL_PER_KG === 7700);

// ---- end-to-end deficit sanity ---------------------------------------------
// Lose 6 kg over 84 days -> 6*7700/84 ≈ 550 kcal/day deficit.
check("6kg over 84 days ≈ 550 kcal/day deficit",
  near(6 * api.KCAL_PER_KG / 84, 550, 1));

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);

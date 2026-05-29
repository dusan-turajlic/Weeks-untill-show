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
  "minProtein:minProtein, minFat:minFat, interp:interp, calcKcalPerStep:calcKcalPerStep, roundSteps:roundSteps, " +
  "fatFloorG:fatFloorG, cyclePlan:cyclePlan, " +
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

// ---- "prefer not to say" averages the male & female formulas ---------------
check("neutral maintenance = mean of male & female",
  near(api.maintenanceCalories("neutral", 80),
       (api.maintenanceCalories("male", 80) + api.maintenanceCalories("female", 80)) / 2, 1e-9));
check("neutral protein = mean of male & female",
  near(api.minProtein("neutral", 175),
       (api.minProtein("male", 175) + api.minProtein("female", 175)) / 2, 1e-9));
check("neutral fat = mean of male & female",
  near(api.minFat("neutral", 170),
       (api.minFat("male", 170) + api.minFat("female", 170)) / 2, 1e-9));
check("neutral sits between the male & female maintenance values",
  api.maintenanceCalories("neutral", 80) > Math.min(api.maintenanceCalories("male", 80), api.maintenanceCalories("female", 80)) &&
  api.maintenanceCalories("neutral", 80) < Math.max(api.maintenanceCalories("male", 80), api.maintenanceCalories("female", 80)));

// ---- kcal per step ---------------------------------------------------------
var kps = api.calcKcalPerStep(80, 180);
check("kcal/step 80kg/180cm ≈ 0.0298", near(kps, 0.0298, 0.002));
check("heavier person burns more per step",
  api.calcKcalPerStep(100, 180) > api.calcKcalPerStep(70, 180));

// ---- step goals round to the nearest 1,000 ---------------------------------
check("7077 steps -> 7000", api.roundSteps(7077) === 7000);
check("5973 steps -> 6000", api.roundSteps(5973) === 6000);
check("499 steps -> 0",     api.roundSteps(499) === 0);
check("NaN stays NaN",      Number.isNaN(api.roundSteps(NaN)));

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

// ---- carb cycling ----------------------------------------------------------
// cyclePlan({protein, weightKg, intake, maint, pattern, highDays, carbFloor,
//            stepDeficit, kcalPerStep})
// Worked example: 80kg, protein 160g, goal intake 1610 kcal, maintenance 2300.
var P = 160, KG = 80, INTAKE = 1610, MAINT = 2300, FLOOR = 40, FATMIN = 66; // floor = 0.5 g/kg
function plan(over){
  var o = { protein:P, weightKg:KG, intake:INTAKE, maint:MAINT, pattern:"cycle",
            highDays:2, carbFloor:35, fatMin:FATMIN, stepDeficit:0, kcalPerStep:0.03 };
  for(var k in over) o[k] = over[k];
  return api.cyclePlan(o);
}
function highOf(p){ return p.days.filter(function(d){return d.key==="high";})[0]; }
function lowOf(p){ return p.days.filter(function(d){return d.key==="low";})[0]; }
function medOf(p){ return p.days.filter(function(d){return d.key==="med";})[0]; }

check("fat floor is 0.5 g/kg", api.fatFloorG(80) === 40);

// Carb cycle: 1 high + 2 medium + 4 low; low days carry a solid fat amount.
(function () {
  var cy = plan({ pattern:"cycle" });
  check("cycle: 1 high + 2 medium + 4 low days",
    highOf(cy).count === 1 && medOf(cy).count === 2 && lowOf(cy).count === 4);
  check("cycle: weekly average equals goal intake", near(cy.avgKcal, INTAKE, 0.5));
  check("low day: solid fat at 0.7 g/kg (= 56g for 80kg), carbs at the 35g floor",
    near(lowOf(cy).fat, 0.7 * KG, 1e-6) && near(lowOf(cy).carbs, 35, 1e-6));
  check("low-day fat is well above the 0.5 g/kg survival floor", lowOf(cy).fat > FLOOR + 5);
  check("high day: carbs = 35% of calories, fat is the remainder",
    near(highOf(cy).carbs * 4, 0.35 * highOf(cy).kcal, 1e-6) &&
    near(highOf(cy).fat, (highOf(cy).kcal - P * 4 - highOf(cy).carbs * 4) / 9, 1e-6));
  check("medium day: fat = 35% of calories, carbs are the remainder",
    near(medOf(cy).fat * 9, 0.35 * medOf(cy).kcal, 1e-6));
  check("protein constant every day",
    highOf(cy).protein === P && medOf(cy).protein === P && lowOf(cy).protein === P);
  check("high days stay the biggest (high ≥ medium ≥ low calories)",
    highOf(cy).kcal >= medOf(cy).kcal && medOf(cy).kcal >= lowOf(cy).kcal);
  check("carbs descend high > medium > low", highOf(cy).carbs > medOf(cy).carbs && medOf(cy).carbs > lowOf(cy).carbs);
})();

// High/Low: a pure carb shift off the even baseline. Protein & fat stay put on
// every day; carbs are pulled off the low days and stacked onto the high day(s).
// Worked example (80kg, P160, 1610 kcal/day, fat min 66g): even day = C94.
(function () {
  var two = plan({ pattern:"highlow", highDays:2 });
  var one = plan({ pattern:"highlow", highDays:1 });
  var evenC = (INTAKE - P * 4 - FATMIN * 9) / 4;   // baseline carbs = 94 g

  check("high/low (2): 2 high + 5 low days", highOf(two).count === 2 && lowOf(two).count === 5);
  check("high/low (1): 1 high + 6 low days", highOf(one).count === 1 && lowOf(one).count === 6);

  // Protein and fat never move off the even-day values.
  check("high/low: protein & fat identical on high and low days",
    highOf(one).protein === P && lowOf(one).protein === P &&
    near(highOf(one).fat, FATMIN, 1e-6) && near(lowOf(one).fat, FATMIN, 1e-6) &&
    near(highOf(two).fat, FATMIN, 1e-6) && near(lowOf(two).fat, FATMIN, 1e-6));

  // 1 high day: −100 kcal carbs (−25g) off each of 6 lows → +600 kcal (+150g) onto the high.
  check("high/low (1): low-day carbs drop 25g (100 kcal) below the even baseline",
    near(lowOf(one).carbs, evenC - 25, 1e-6));
  check("high/low (1): high day gains 150g carbs (6×100 kcal)",
    near(highOf(one).carbs, evenC + 150, 1e-6));

  // 2 high days: −150 kcal carbs (−37.5g) off each of 5 lows → 750 kcal split over 2 highs (+93.75g each).
  check("high/low (2): low-day carbs drop 37.5g (150 kcal) below the even baseline",
    near(lowOf(two).carbs, evenC - 37.5, 1e-6));
  check("high/low (2): each high day gains 93.75g carbs (5×150 / 2 / 4)",
    near(highOf(two).carbs, evenC + 93.75, 1e-6));

  check("high/low: high days are where the carbs pile up",
    highOf(two).carbs > lowOf(two).carbs && highOf(one).carbs > lowOf(one).carbs);
  check("1 high day packs more carbs into that day than 2 high days", highOf(one).carbs > highOf(two).carbs);
  check("high/low: the shift is calorie-neutral — week still averages goal intake",
    near(two.avgKcal, INTAKE, 1e-6) && near(one.avgKcal, INTAKE, 1e-6));
  check("high/low: no extra steps when no low day hits the carb floor",
    !one.anyRaised && !two.anyRaised);
})();

// High/Low floor fallback: if a low day can't give up the carbs, the high day
// still gets the full bump and the surplus is walked off with steps.
(function () {
  // Push the even baseline carbs near the floor so the 100-kcal cut can't fit.
  var steep = plan({ pattern:"highlow", highDays:1, protein:230 });
  check("high/low floor: low-day carbs never drop below 35g",
    lowOf(steep).carbs >= 35 - 1e-9);
  check("high/low floor: the unfunded carbs are repaid with steps on the high day",
    steep.anyRaised && highOf(steep).steps > 0 && lowOf(steep).steps === 0);
})();

// Solid fat eases down only on a very steep deficit (so highs stay biggest).
(function () {
  var steep = plan({ intake:1100 });  // aggressive: low days would out-eat highs at 0.7 g/kg
  check("steep deficit eases low-day fat below 0.7 g/kg", steep.lowFat < 0.7 * KG);
  check("even on a steep deficit, high days stay ≥ low days",
    highOf(steep).kcal >= lowOf(steep).kcal - 1);
})();

// Steps: same on every day, and any payback for raised days goes on the HIGH day.
(function () {
  var cy = plan({ stepDeficit:0 });
  check("no steps when diet alone hits the goal and nothing is raised",
    cy.days.every(function(d){ return d.steps === 0; }) && !cy.anyRaised);
  var withBase = plan({ stepDeficit:300, kcalPerStep:0.03 }); // 300/0.03 = 10000 steps
  check("base steps are the same on every day", withBase.days.every(function(d){ return d.steps === 10000; }));
})();

// Even pattern just averages the intake.
check("even pattern averages the intake", near(plan({ pattern:"even" }).avgKcal, INTAKE, 1e-9));

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);

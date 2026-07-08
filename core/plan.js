/*
 * Projection + energy-plan derivations. Ported verbatim from index.html's
 * `compute()` / `weeksLeft()` / `bodyMetrics()` / `energyPlan()` (the region
 * between "// ---- compute" and "// ---- meal-plan prompt for an LLM").
 *
 * These read the user's `state` and "today", so they are exposed as a factory
 * that closes over them — exactly how the original app scoped these functions.
 * All arithmetic constants + formulas come from the shared core/energy.js so
 * there is a single source of truth. Dual CommonJS export.
 */
"use strict";

var E = (typeof require !== "undefined")
  ? require("./energy.js")
  : (typeof window !== "undefined" ? window.YdinEnergy : this.YdinEnergy);

var WEEK_MS = 7 * 24 * 60 * 60 * 1000;
var DAY_MS = 24 * 60 * 60 * 1000;

function createPlan(state, today) {
  // Bindings the ported bodies reference by bare name.
  var LB_TO_KG = E.LB_TO_KG, IN_TO_CM = E.IN_TO_CM;
  var KCAL_PER_KG = E.KCAL_PER_KG, KCAL_PROTEIN = E.KCAL_PROTEIN,
      KCAL_FAT = E.KCAL_FAT, KCAL_CARB = E.KCAL_CARB;
  var MAX_FOOD_DEFICIT = E.MAX_FOOD_DEFICIT, MIN_PHASE_STEPS = E.MIN_PHASE_STEPS,
      FIBER_MIN = E.FIBER_MIN;
  var maintenanceCalories = E.maintenanceCalories, minProtein = E.minProtein,
      minFat = E.minFat, calcKcalPerStep = E.calcKcalPerStep;

  function phaseStart() {
    var d = state.startDate ? new Date(state.startDate + "T00:00:00") : null;
    return (d && !isNaN(d)) ? d : today;
  }
  function compute() {
    var W = parseFloat(state.weight);
    var r = parseFloat(state.pct) / 100;
    var start = phaseStart();
    var end = state.endDate ? new Date(state.endDate + "T00:00:00") : null;
    var T = end ? (end - start) / WEEK_MS : NaN;
    var valid = isFinite(W) && isFinite(r) && isFinite(T) && T >= 0;
    var N = valid ? Math.floor(T) : 0;
    var at = function (t) { return Math.max(0, W * Math.pow(1 - r, t)); };
    var rows = [];
    if (valid) { for (var k = 0; k <= N; k++) rows.push({ week: k, weight: at(N - k) }); } // week0 = end date
    var final = valid ? at(N) : NaN;
    return {
      W: W, valid: valid, N: N, rows: rows, final: final, lost: valid ? W - final : NaN,
      lostPct: (valid && W > 0) ? ((W - final) / W * 100) : NaN
    };
  }
  function weeksLeft() {
    var end = state.endDate ? new Date(state.endDate + "T00:00:00") : null;
    if (!end || isNaN(end)) return null;
    var T = (end - today) / WEEK_MS;
    return T >= 0 ? Math.floor(T) : null;
  }
  function bodyMetrics() {
    var W = parseFloat(state.weight), H = parseFloat(state.height);
    var lb = state.unit === "lb";
    var weightKg = lb ? W * LB_TO_KG : W;
    var heightCm = lb ? H * IN_TO_CM : H;
    var sex = state.sex;
    var valid = isFinite(weightKg) && weightKg > 0 && isFinite(heightCm) && heightCm > 0
      && (sex === "male" || sex === "female" || sex === "neutral");
    if (!valid) return { valid: false };
    var maint = maintenanceCalories(sex, weightKg);
    return {
      valid: true, weightKg: weightKg, heightCm: heightCm, sex: sex,
      maint: maint, protein: minProtein(sex, heightCm), fat: minFat(sex, heightCm)
    };
  }
  function energyPlan() {
    var bm = bodyMetrics();
    if (!bm.valid) return { valid: false };
    var c = compute();
    var out = {
      valid: true, bm: bm, days: NaN, lostKg: NaN, totalDeficit: NaN,
      needDeficit: NaN, foodDeficit: NaN, stepDeficit: NaN, kcalPerStep: NaN,
      intake: NaN, steps: NaN, protein: bm.protein, fat: bm.fat,
      carbs: NaN, proteinKcal: bm.protein * KCAL_PROTEIN, fatKcal: bm.fat * KCAL_FAT,
      fiber: FIBER_MIN, macrosOk: true
    };
    if (c.valid) {
      out.lostKg = state.unit === "lb" ? c.lost * LB_TO_KG : c.lost;
      var start = phaseStart(), end = new Date(state.endDate + "T00:00:00");
      out.days = Math.max(1, Math.round((end - start) / DAY_MS));    // length of the phase
      out.totalDeficit = out.lostKg * KCAL_PER_KG;
      out.needDeficit = out.totalDeficit / out.days;               // to hit goal by date
      var kps = calcKcalPerStep(bm.weightKg, bm.heightCm);
      out.kcalPerStep = kps;
      var inPhase = out.lostKg > 0;
      var stepFloor = (inPhase && kps > 0) ? MIN_PHASE_STEPS * kps : 0;
      out.foodDeficit = Math.min(Math.max(0, out.needDeficit - stepFloor), MAX_FOOD_DEFICIT);
      out.stepDeficit = Math.max(stepFloor, out.needDeficit - out.foodDeficit);
      out.intake = bm.maint - out.foodDeficit;
      out.steps = kps > 0 ? out.stepDeficit / kps : NaN;
      var carbKcal = out.intake - out.proteinKcal - out.fatKcal;
      out.macrosOk = carbKcal >= 0;
      out.carbs = Math.max(0, carbKcal) / KCAL_CARB;
    }
    return out;
  }

  return {
    phaseStart: phaseStart, compute: compute, weeksLeft: weeksLeft,
    bodyMetrics: bodyMetrics, energyPlan: energyPlan
  };
}

var api = { createPlan: createPlan, WEEK_MS: WEEK_MS, DAY_MS: DAY_MS };
if (typeof module !== "undefined" && module.exports) module.exports = api;
else (typeof window !== "undefined" ? window : this).YdinPlan = api;

/*
 * Deterministic portion solver (Phase 3 of the meal-plan plan).
 *
 * The LLM — local (Path A) or external (Path B) — only *chooses foods and
 * narrates*. It never does the arithmetic. This module is that arithmetic: given
 * a day-type's macro targets and a set of chosen foods (per-100 g macros), it
 * computes grams per food that hit the targets, then verifies the result and
 * reports which constraints still fail so a repair loop can ask the model for a
 * targeted fix.
 *
 * No dependencies. Works as a browser global (window.YdinSolver) and as a
 * CommonJS module (require) so the Node tests can exercise the real code.
 *
 * Targets and foods are per the data contracts in docs/meal-plan-prompt.md:
 *   targets: { kcal, protein, fat, carbs, fiber }   // grams, kcal/day
 *   foods:   [ { name, code?, protein, fat, carbs, fiber } ]  // grams per 100 g
 *
 * The four macro targets (protein, fat, carbs, fibre) are solved as equalities.
 * kcal is a *derived* ceiling: with carbs/protein/fat at target, Atwater kcal is
 * implied, so we check it rather than solve for it.
 */
(function (root) {
  "use strict";

  // Atwater factors. Fibre is part of carbohydrate by mass and its energy is
  // already inside the carb figure here, so kcal = 4P + 4C + 9F. This matches
  // how the app's calorie model treats carbs and fibre.
  var KCAL_P = 4, KCAL_C = 4, KCAL_F = 9;

  // Default tolerances for verification. Macro minimums (protein, fat, fibre)
  // may overshoot freely; carbs and kcal are two-sided around the target.
  var DEFAULT_TOL = {
    proteinMin: 2,      // g under target still counts as "hit"
    fatMin: 2,
    fiberMin: 1,
    carbsAbs: 8,        // g either side of the carb target
    kcalFrac: 0.02,     // kcal may sit within 2% of the goal
    kcalAbs: 25         // …or this many kcal, whichever is larger
  };

  var MACRO_KEYS = ["protein", "fat", "carbs", "fiber"];

  function num(x) { return typeof x === "number" && isFinite(x) ? x : 0; }

  // ---- linear algebra (small, dependency-free) ----------------------------

  // Solve a square system A x = b by Gaussian elimination with partial
  // pivoting. Returns null if singular. n is small (one column per food).
  function solveLinear(A, b) {
    var n = b.length, i, j, k;
    // Work on copies so callers keep their matrices.
    var M = A.map(function (row, r) { return row.slice().concat([b[r]]); });
    for (i = 0; i < n; i++) {
      // pivot: largest magnitude in column i at or below row i
      var p = i, max = Math.abs(M[i][i]);
      for (k = i + 1; k < n; k++) {
        if (Math.abs(M[k][i]) > max) { max = Math.abs(M[k][i]); p = k; }
      }
      if (max < 1e-9) return null; // singular / under-determined
      if (p !== i) { var tmp = M[i]; M[i] = M[p]; M[p] = tmp; }
      for (k = i + 1; k < n; k++) {
        var factor = M[k][i] / M[i][i];
        for (j = i; j <= n; j++) M[k][j] -= factor * M[i][j];
      }
    }
    var x = new Array(n);
    for (i = n - 1; i >= 0; i--) {
      var s = M[i][n];
      for (j = i + 1; j < n; j++) s -= M[i][j] * x[j];
      x[i] = s / M[i][i];
    }
    return x;
  }

  // Least-squares solve of T g = t (T is targets×foods, g ≥ 0) via the normal
  // equations (TᵀT) g = Tᵀt. For a well-conditioned square feasible system this
  // returns the exact solution; otherwise the best L2 fit. Returns null if the
  // normal matrix is singular.
  function leastSquares(T, t, activeCols) {
    var m = activeCols.length, rows = t.length, i, j, r;
    if (m === 0) return [];
    var AtA = [], Atb = [];
    for (i = 0; i < m; i++) {
      AtA.push(new Array(m).fill(0));
      Atb.push(0);
    }
    for (i = 0; i < m; i++) {
      var ci = activeCols[i];
      for (r = 0; r < rows; r++) Atb[i] += T[r][ci] * t[r];
      for (j = 0; j < m; j++) {
        var cj = activeCols[j];
        var s = 0;
        for (r = 0; r < rows; r++) s += T[r][ci] * T[r][cj];
        AtA[i][j] = s;
      }
    }
    return solveLinear(AtA, Atb);
  }

  // ---- the solver ---------------------------------------------------------

  /**
   * solvePortions(targets, foods, opts) -> {
   *   grams:   [g per food, same order as foods],
   *   totals:  { kcal, protein, fat, carbs, fiber },
   *   ok:      boolean,
   *   failed:  [ { constraint, target, actual, delta } ],   // for the repair loop
   *   note:    string
   * }
   *
   * Strategy: solve the 4 macro equalities (protein, fat, carbs, fibre) for the
   * grams of each food using non-negative least squares (an active-set loop that
   * drops the most-negative food and re-solves). Then verify against the
   * targets+tolerances and report any constraint still out of range.
   */
  function solvePortions(targets, foods, opts) {
    opts = opts || {};
    var tol = Object.assign({}, DEFAULT_TOL, opts.tolerance || {});
    foods = (foods || []).map(function (f) {
      return {
        name: f.name, code: f.code,
        protein: num(f.protein), fat: num(f.fat),
        carbs: num(f.carbs), fiber: num(f.fiber)
      };
    });

    // Target row vector in MACRO_KEYS order, foods as columns: T[macro][food].
    var t = MACRO_KEYS.map(function (k) { return num(targets[k]); });
    var T = MACRO_KEYS.map(function (k) {
      return foods.map(function (f) { return f[k] / 100; });
    });

    // Active-set non-negative least squares: start with every food active, solve,
    // and if any gram is negative, drop the most-negative food (clamp to 0) and
    // re-solve. Bounded by the number of foods.
    var active = foods.map(function (_, i) { return i; });
    var grams = foods.map(function () { return 0; });
    for (var pass = 0; pass < foods.length + 1 && active.length; pass++) {
      var g = leastSquares(T, t, active);
      if (!g) break; // singular — bail, verification will flag the gaps
      var worst = -1, worstVal = 0;
      for (var i = 0; i < active.length; i++) {
        if (g[i] < worstVal) { worstVal = g[i]; worst = i; }
      }
      if (worst === -1) { // all non-negative — accept
        active.forEach(function (col, k) { grams[col] = Math.max(0, g[k]); });
        break;
      }
      active.splice(worst, 1); // drop the most-negative food, re-solve
    }

    var totals = mealTotals(foods, grams);
    var failed = verify(totals, targets, tol);
    return {
      grams: grams,
      totals: totals,
      ok: failed.length === 0,
      failed: failed,
      note: failed.length
        ? "Constraints unmet: " + failed.map(function (f) { return f.constraint; }).join(", ")
        : "All targets met."
    };
  }

  // Sum scaled per-100 g macros into day/meal totals.
  function mealTotals(foods, grams) {
    var tot = { kcal: 0, protein: 0, fat: 0, carbs: 0, fiber: 0 };
    foods.forEach(function (f, i) {
      var s = num(grams[i]) / 100;
      tot.protein += f.protein * s;
      tot.fat += f.fat * s;
      tot.carbs += f.carbs * s;
      tot.fiber += f.fiber * s;
    });
    tot.kcal = KCAL_P * tot.protein + KCAL_C * tot.carbs + KCAL_F * tot.fat;
    // round to a tenth of a gram / whole kcal for stable comparisons
    tot.protein = round(tot.protein); tot.fat = round(tot.fat);
    tot.carbs = round(tot.carbs); tot.fiber = round(tot.fiber);
    tot.kcal = Math.round(tot.kcal);
    return tot;
  }

  /**
   * verify(totals, targets, tol) -> [ failed constraints ]
   * Mirrors the whole-feature acceptance criteria (§8):
   *   kcal ≤ goal, protein ≥ min, fat ≥ min, carbs ≈ target, fibre ≥ floor.
   * Each failure carries enough detail for a repair prompt.
   */
  function verify(totals, targets, tol) {
    tol = Object.assign({}, DEFAULT_TOL, tol || {});
    var out = [];
    var P = num(targets.protein), F = num(targets.fat),
        C = num(targets.carbs), B = num(targets.fiber), K = num(targets.kcal);

    if (P && totals.protein < P - tol.proteinMin) {
      out.push(fail("protein", P, totals.protein));
    }
    if (F && totals.fat < F - tol.fatMin) {
      out.push(fail("fat", F, totals.fat));
    }
    if (B && totals.fiber < B - tol.fiberMin) {
      out.push(fail("fiber", B, totals.fiber));
    }
    if (C && Math.abs(totals.carbs - C) > tol.carbsAbs) {
      out.push(fail("carbs", C, totals.carbs));
    }
    if (K) {
      var kcalTol = Math.max(tol.kcalAbs, K * tol.kcalFrac);
      if (totals.kcal > K + kcalTol) out.push(fail("kcal", K, totals.kcal));
    }
    return out;
  }

  function fail(constraint, target, actual) {
    return { constraint: constraint, target: round(target), actual: round(actual),
             delta: round(actual - target) };
  }

  function round(x) { return Math.round(num(x) * 10) / 10; }

  var api = {
    solvePortions: solvePortions,
    verify: verify,
    mealTotals: mealTotals,
    solveLinear: solveLinear,
    DEFAULT_TOL: DEFAULT_TOL,
    MACRO_KEYS: MACRO_KEYS
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.YdinSolver = api;
})(typeof self !== "undefined" ? self : this);

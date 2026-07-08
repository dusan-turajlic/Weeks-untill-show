/*
 * Tests for the on/off-track indicator.
 *
 * Rather than copy the logic (which would drift from the app), this pulls the
 * real progress()/smoothedRecent()/offTrack() source straight out of index.html
 * and runs it. Run with:  node test/offtrack.test.js
 */
"use strict";
// The real progress()/offTrack() implementations now live in a shared module
// (core/offtrack.js), imported by both the app and this test. `createProgress`
// closes over the caller's state + logHistory, exactly like the old app scope.
var offtrack = require("../core/offtrack.js");
function load(state, logHistory) {
  return offtrack.createProgress(state, logHistory);
}

// ---- fixture generator: N weeks of daily-ish history ending "today" --------
function pad(n) { return String(n).padStart(2, "0"); }
function iso(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function buildLog(targetPct, rateMult) {
  var today = new Date("2026-05-29T00:00:00");
  var dailyRate = 1 - Math.pow(1 - targetPct / 100, 1 / 7);
  var startW = 90, out = [];
  for (var wk = 8; wk >= 1; wk--) {                 // weekly markers, weeks -8..-1
    var d = new Date(today); d.setDate(d.getDate() - wk * 7);
    out.push({ date: iso(d), weight: +(startW * Math.pow(1 - dailyRate * rateMult, 56 - wk * 7) + Math.sin(wk * 1.9) * 0.5).toFixed(1) });
  }
  for (var dd = 6; dd >= 0; dd--) {                 // daily cluster, last 7 days (exercises smoothing)
    var d2 = new Date(today); d2.setDate(d2.getDate() - dd);
    out.push({ date: iso(d2), weight: +(startW * Math.pow(1 - dailyRate * rateMult, 56 - dd) + Math.sin(dd * 2.3) * 0.6).toFixed(1) });
  }
  return out;
}

// ---- tiny assert harness ---------------------------------------------------
var passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name); }
}
function statusFor(pct, rateMult) {
  return load({ pct: String(pct) }, buildLog(pct, rateMult)).offTrack();
}

console.log("on/off-track indicator");

// Following the plan (with daily noise) must NOT trip the alarm.
check("on-plan + noise reads 'ontrack'", statusFor(0.7, 1.0).status === "ontrack");

// Losing far slower than planned is off track.
check("losing ~40% of plan rate reads 'behind'", statusFor(0.7, 0.4).status === "behind");

// Losing faster than planned is ahead.
var ahead = statusFor(0.7, 1.7);
check("losing ~170% of plan rate reads 'ahead'", ahead.status === "ahead");
check("ahead has a negative gap (below the curve)", ahead.gap < 0);

// Gaining weight is off track, with a negative actual pace.
var gaining = statusFor(0.7, -1.0);
check("gaining weight reads 'behind'", gaining.status === "behind");
check("gaining weight reports negative weekly pace", gaining.actualPctWk < 0);

// Noise alone (flat trend, on plan) stays on track — the band absorbs it.
var noisy = load({ pct: "0.7" }, buildLog(0.7, 1.0));
check("smoothed value sits near the plan when on track",
  Math.abs(noisy.offTrack().gap) <= noisy.offTrack().expected * 0.01 + 0.001);

// Guards: too little data / no target rate -> indicator hidden.
check("single entry -> {has:false}", load({ pct: "0.7" }, [{ date: "2026-05-29", weight: 90 }]).offTrack().has === false);
check("empty log -> {has:false}", load({ pct: "0.7" }, []).offTrack().has === false);
check("no target rate (pct 0) -> {has:false}", load({ pct: "0" }, buildLog(0.7, 1.0)).offTrack().has === false);

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);

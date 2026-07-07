/*
 * Shareable-link + URL state codec. Ported from index.html's URL encode/decode
 * helpers. The originals read module-scoped `mealPlan` / `mealPlanPending` /
 * `lastWizAnswers`; here those are passed in explicitly so the module stays
 * pure. Uses browser `location`/`history` only inside readURL/writeURL (guarded).
 * Dual CommonJS export.
 */
"use strict";

var MP = (typeof require !== "undefined")
  ? require("./mealplan.js")
  : (typeof window !== "undefined" ? window.YdinMealPlan : this.YdinMealPlan);
var encodeMealPlan = MP.encodeMealPlan;

// History encodes as compact "YYYYMMDD:weight,YYYYMMDD:weight,..." pairs.
function encodeLog(history) {
  return history.map(function (e) { return e.date.replace(/-/g, "") + ":" + e.weight; }).join(",");
}
function decodeLog(str) {
  if (!str) return [];
  return str.split(",").map(function (tok) {
    var i = tok.indexOf(":"); if (i < 0) return null;
    var d = tok.slice(0, i), w = parseFloat(tok.slice(i + 1));
    if (!/^\d{8}$/.test(d) || !isFinite(w)) return null;
    return { date: d.slice(0, 4) + "-" + d.slice(4, 6) + "-" + d.slice(6, 8), weight: w };
  }).filter(Boolean);
}
function readURL() {
  try {
    var p = new URLSearchParams(location.search);
    if (!p.toString()) return null;
    return {
      pct: p.get("pct"), startDate: p.get("start"), endDate: p.get("end"), unit: p.get("unit"),
      sex: p.get("sex"), height: p.get("height"), pattern: p.get("pattern"), highDays: p.get("highDays"),
      curSteps: p.get("steps"), weight: p.get("weight"), log: p.get("log"), meal: p.get("meal"),
      cc: p.get("cc"), country: p.get("country"), prefs: p.get("prefs"),
      breakfast: p.get("breakfast"), meals: p.get("meals"), split: p.get("split")
    };
  } catch (e) { return null; }
}
// Add the body-metric params, omitting any that are empty to keep links tidy.
function addBodyParams(p, s) {
  if (s.sex) p.set("sex", s.sex);
  if (s.height) p.set("height", s.height);
  if (s.curSteps) p.set("steps", s.curSteps);
  if (s.pattern && s.pattern !== "even") { p.set("pattern", s.pattern); p.set("highDays", s.highDays); }
}
// The imported meal plan, if any, rides along base64-encoded. A pending preview
// (unconfirmed plan) must never leak into a link.
function addMealParam(p, mealPlan, mealPlanPending) {
  if (mealPlanPending) return;
  if (mealPlan) { var m = encodeMealPlan(mealPlan); if (m) p.set("meal", m); }
}
// The plan memory (facts told to the harness) travels with the link so a shared
// plan can be reshaped on another device. Empty fields are omitted, and an
// "even" split is the default so it's dropped, to keep links tidy.
function addMemoryParams(p, m) {
  if (!m) return;
  if (m.cc) p.set("cc", m.cc);
  if (m.country) p.set("country", m.country);
  if (m.prefs) p.set("prefs", m.prefs);
  if (m.breakfast) p.set("breakfast", m.breakfast);
  if (m.mealsPerDay != null && m.mealsPerDay !== "") p.set("meals", m.mealsPerDay);
  if (m.calorieSplit && m.calorieSplit !== "even") p.set("split", m.calorieSplit);
}
function buildParams(s, hist, mealPlan, mealPlanPending, memory) {
  var p = new URLSearchParams();
  p.set("pct", s.pct); p.set("end", s.endDate); p.set("unit", s.unit);
  if (s.startDate) p.set("start", s.startDate);
  addBodyParams(p, s);
  if (hist && hist.length) p.set("log", encodeLog(hist));
  addMealParam(p, mealPlan, mealPlanPending);
  addMemoryParams(p, memory);
  return p;
}
function writeURL(s, hist, mealPlan, mealPlanPending, memory) {
  try {
    var p = buildParams(s, hist, mealPlan, mealPlanPending, memory);
    history.replaceState(null, "", location.pathname + "?" + p.toString() + location.hash);
  } catch (e) { }
}
function buildShareUrl(s, hist, mealPlan, mealPlanPending, memory) {
  var p = buildParams(s, hist, mealPlan, mealPlanPending, memory);
  var base;
  try {
    base = (location.origin && location.origin !== "null")
      ? location.origin + location.pathname
      : location.href.split("?")[0].split("#")[0];
  } catch (e) { base = ""; }
  return base + "?" + p.toString();
}

var api = {
  encodeLog: encodeLog, decodeLog: decodeLog, readURL: readURL,
  addBodyParams: addBodyParams, addMealParam: addMealParam, addMemoryParams: addMemoryParams,
  writeURL: writeURL, buildShareUrl: buildShareUrl
};
if (typeof module !== "undefined" && module.exports) module.exports = api;
else (typeof window !== "undefined" ? window : this).YdinShare = api;

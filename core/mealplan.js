/*
 * Meal-plan parse / validate / (de)serialise. Ported verbatim from index.html's
 * "// ---- meal plan: parse / validate / (de)serialise" region. Pure. Dual
 * CommonJS export. (btoa/atob are used for the URL-safe base64 codec — present
 * in the browser and in modern Node.)
 */
"use strict";

function normalizeMealPlan(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  if (!Array.isArray(obj.days) || !obj.days.length) return null;
  return obj;
}
// URL-safe base64 so the plan can ride in the shareable link without the query
// string mangling +, / or = (and without unicode loss for food names).
function encodeMealPlan(plan) {
  try {
    var b = btoa(unescape(encodeURIComponent(JSON.stringify(plan))));
    return b.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  } catch (e) { return ""; }
}
function decodeMealPlan(s) {
  try {
    var b = String(s).replace(/-/g, "+").replace(/_/g, "/");
    while (b.length % 4) b += "=";
    return normalizeMealPlan(JSON.parse(decodeURIComponent(escape(atob(b)))));
  } catch (e) { return null; }
}

// ---- render + import helpers (ported verbatim from index.html) ------------
function mpInt(n) { return (typeof n === "number" && isFinite(n)) ? Math.round(n) : null; }
function fmtMoney(n, cur) {
  if (!isFinite(n)) return "";
  var v = (Math.round(n * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return cur ? (String(cur) + " " + v) : v;
}
// Prefer the plan's stated day totals; otherwise sum the meal items.
function dayTotals(day) {
  var keys = ["kcal", "protein", "fat", "carbs", "fiber"], t = day.totals;
  if (t && keys.some(function (k) { return isFinite(t[k]); })) {
    return { kcal: mpInt(t.kcal), protein: mpInt(t.protein), fat: mpInt(t.fat), carbs: mpInt(t.carbs), fiber: mpInt(t.fiber) };
  }
  var s = { kcal: 0, protein: 0, fat: 0, carbs: 0, fiber: 0 }, any = false;
  (day.meals || []).forEach(function (m) {
    (m.items || []).forEach(function (it) {
      keys.forEach(function (k) { if (isFinite(it[k])) { s[k] += it[k]; any = true; } });
    });
  });
  return any ? { kcal: Math.round(s.kcal), protein: Math.round(s.protein), fat: Math.round(s.fat), carbs: Math.round(s.carbs), fiber: Math.round(s.fiber) } : null;
}
// Pull JSON out of pasted text: prefer a ```json fence, else the whole string,
// else the outermost {...} or [...].
function extractJson(raw) {
  var txt = String(raw).trim(), fence = txt.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) txt = fence[1].trim();
  try { return { ok: true, value: JSON.parse(txt) }; } catch (e) { /* fall through */ }
  var first = -1, open = "";
  ["{", "["].forEach(function (ch) { var i = txt.indexOf(ch); if (i >= 0 && (first < 0 || i < first)) { first = i; open = ch; } });
  if (first >= 0) {
    var last = txt.lastIndexOf(open === "{" ? "}" : "]");
    if (last > first) { try { return { ok: true, value: JSON.parse(txt.slice(first, last + 1)) }; } catch (e) { /* fall through */ } }
  }
  return { ok: false };
}
function recipesFrom(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.recipes)) return data.recipes;
  if (data && (data.name || Array.isArray(data.steps))) return [data];
  return null;
}
function normalizeRecipes(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(function (r) {
    if (!r || typeof r !== "object") return null;
    var steps = Array.isArray(r.steps) ? r.steps.map(function (s) { return String(s); }).filter(Boolean) : [];
    var out = { name: String(r.name || "Recipe"), steps: steps };
    if (isFinite(r.minutes)) out.minutes = r.minutes;
    if (r.notes) out.notes = String(r.notes);
    return out;
  }).filter(Boolean);
}
// Match a recipe block back to a meal in `mealPlan`: by mealId "di-mi" first,
// else by day label + meal name (case-insensitive). Returns {meal,label} or null.
function findMealForRecipes(mealPlan, data) {
  if (!mealPlan || !Array.isArray(mealPlan.days)) return null;
  var days = mealPlan.days;
  if (typeof data.mealId === "string" && /^\d+-\d+$/.test(data.mealId)) {
    var ix = data.mealId.split("-"), di = +ix[0], mi = +ix[1];
    if (days[di] && days[di].meals && days[di].meals[mi]) {
      return { meal: days[di].meals[mi], label: (days[di].label || "day") + " · " + (days[di].meals[mi].name || "meal") };
    }
  }
  var dn = String(data.day || "").toLowerCase(), mn = String(data.meal || "").toLowerCase();
  if (dn || mn) {
    for (var i = 0; i < days.length; i++) {
      if (dn && String(days[i].label || "").toLowerCase() !== dn) continue;
      var meals = days[i].meals || [];
      for (var j = 0; j < meals.length; j++) {
        if (mn && String(meals[j].name || "").toLowerCase() !== mn) continue;
        return { meal: meals[j], label: (days[i].label || "day") + " · " + (meals[j].name || "meal") };
      }
    }
  }
  return null;
}
function isRecipeShape(data) {
  return !!(data && (data.type === "weeks-until-show-recipes" || Array.isArray(data) || Array.isArray(data.recipes)));
}

var api = {
  normalizeMealPlan: normalizeMealPlan, encodeMealPlan: encodeMealPlan, decodeMealPlan: decodeMealPlan,
  mpInt: mpInt, fmtMoney: fmtMoney, dayTotals: dayTotals, extractJson: extractJson,
  recipesFrom: recipesFrom, normalizeRecipes: normalizeRecipes, findMealForRecipes: findMealForRecipes,
  isRecipeShape: isRecipeShape
};
if (typeof module !== "undefined" && module.exports) module.exports = api;
else (typeof window !== "undefined" ? window : this).YdinMealPlan = api;

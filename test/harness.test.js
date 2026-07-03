/*
 * Tests for the reliability layer added to the on-device planner:
 *   - voteFoods(): consensus across repeated model runs (drops one-off noise).
 *   - buildPlan() fan-out + voting: designMeal asked `votes` times, voted.
 *   - Fuzzy/translation search: an English-designing model + a LOCAL-LANGUAGE
 *     (Finnish) catalog — foods rescued to REAL products via translateFoods.
 *   - Portion realism: eggs/fruit/bread snap to whole/part UNITS and live in one
 *     meal; bulk foods snap to a gram step; no "7 g of egg" slivers.
 *   - Whole-day review: the day is judged as a set (and can be corrected) BEFORE
 *     the catalog is touched; sanitizeReviewedDay folds the fix back safely.
 *   - Deterministic display polish: descriptive meal names, "raw" weights on raw
 *     proteins, and a micro note that names real fibre sources + vitamin-D/omega-3.
 *   - Meal balance: balanceMeals spreads protein AND calories across meals (every
 *     meal a real plate) without changing the day totals; honours the calorie split.
 *
 * No browser, no WebGPU, no live model: a mock engine replays canned outputs.
 * Run with:  node test/harness.test.js
 */
"use strict";
var planner = require("../meal-plan/planner.js");
var fl = require("../meal-plan/food-lookup.js");

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok  - " + name); }
  else { fail++; console.log("  FAIL- " + name + (extra ? "  " + extra : "")); }
}

// ---- 1) voteFoods: pure consensus logic ---------------------------------
(function () {
  var winners = planner.voteFoods([
    ["Chicken breast", "Oats", "Unicorn"],
    ["chicken breast", "oats"],
    ["chicken  breast", "OATS", "Kale"]
  ], { min: 0 });
  ok("vote keeps foods agreed by a majority", winners.length === 2 &&
     /chicken/i.test(winners[0]) && /oats/i.test(winners[1]), winners.join(","));
  ok("vote drops one-off noise", winners.every(function (w) { return !/unicorn|kale/i.test(w); }), winners.join(","));
  var few = planner.voteFoods([["a", "b"], ["c"], ["d"]], { threshold: 3, min: 2 });
  ok("vote backfills to `min` when consensus is thin", few.length === 2, few.join(","));
  var one = planner.voteFoods([["Tofu", "Rice"]]);
  ok("single run passes through", one.length === 2 && one[0] === "Tofu" && one[1] === "Rice", one.join(","));
})();

// ---- 1b) sanitizeReviewedDay: fold a whole-day review onto the design -----
(function () {
  var orig = [{ name: "Breakfast", foods: ["cake"] }, { name: "Lunch", foods: ["chicken", "rice"] }];
  var r = planner.sanitizeReviewedDay([{ name: "breakfast", foods: ["oats", "whey"] }], orig);
  ok("sanitizeReviewedDay swaps a meal's foods by name (case-insensitive)",
     r && r[0].foods.join(",") === "oats,whey");
  ok("sanitizeReviewedDay keeps meals the review didn't touch", r && r[1].foods.join(",") === "chicken,rice");
  ok("sanitizeReviewedDay preserves the original meal count + order",
     r && r.length === 2 && r[0].name === "Breakfast" && r[1].name === "Lunch");
  var mixed = planner.sanitizeReviewedDay([{ name: "Breakfast", foods: ["oats"] }, { name: "Lunch", foods: [] }], orig);
  ok("sanitizeReviewedDay keeps original foods for a meal that came back empty",
     mixed && mixed[0].foods.join(",") === "oats" && mixed[1].foods.join(",") === "chicken,rice");
  ok("sanitizeReviewedDay returns null when nothing usable comes back",
     planner.sanitizeReviewedDay([{ name: "Breakfast", foods: [] }], orig) === null &&
     planner.sanitizeReviewedDay(null, orig) === null && planner.sanitizeReviewedDay([], orig) === null &&
     planner.sanitizeReviewedDay([{ foo: 1 }], orig) === null);
  ok("sanitizeReviewedDay does not mutate the original design", orig[0].foods.join(",") === "cake");
})();

// ---- 1c) deterministic display polish (meal names, raw note, micro note) --
(function () {
  ok("shortFoodWord prefers an English gloss in parentheses",
     planner.shortFoodWord("Rasvaton rahka (fat-free quark)") === "fat-free quark");
  ok("shortFoodWord strips brand/size noise", planner.shortFoodWord("Kaurahiutaleet 1 kg") === "kaurahiutaleet");
  var d = planner.mealDescriptor([
    { food: "Kaurahiutaleet", kcal: 200 }, { food: "Rasvaton rahka (quark)", kcal: 120 }, { food: "Mustikka", kcal: 30 }]);
  ok("mealDescriptor lists the biggest foods, joined with &", d === "kaurahiutaleet, quark & mustikka", d);
  ok("mealDescriptor is empty when there are no items", planner.mealDescriptor([]) === "");

  ok("bulkAmountNote marks raw proteins as raw",
     planner.bulkAmountNote("Broilerin fileesuikale") === " raw" &&
     planner.bulkAmountNote("Naudan jauheliha") === " raw" &&
     planner.bulkAmountNote("Kananrinta") === " raw");
  ok("bulkAmountNote leaves non-proteins alone",
     planner.bulkAmountNote("Kaurahiutaleet") === "" && planner.bulkAmountNote("Rypsiöljy") === "");

  var note = planner.microNote([{ fiber: 36 }], false, [], [], [],
    { country: "Finland", fiberSources: [{ name: "Chia-siemenet", fiber: 7 }, { name: "Pellavarouhe (flax)", fiber: 6 }] });
  ok("microNote names the plan's real fibre sources", /chia/i.test(note) && /~7 g/.test(note), note);
  ok("microNote flags vitamin D at a northern latitude", /Vitamin D/.test(note) && /northern latitudes/.test(note));
  ok("microNote flags omega-3 EPA/DHA and iron/vitamin-C pairing", /EPA\/DHA/.test(note) && /vitamin-C/.test(note));
  var noteSouth = planner.microNote([{ fiber: 36 }], false, [], [], [], { country: "Spain", fiberSources: [] });
  ok("microNote drops the latitude clause outside the north", !/northern latitudes/.test(noteSouth));
})();

// ---- 1d) balanceMeals: even plates without changing day totals -----------
(function () {
  // Worst case: the protein (chicken) is designed into ONE meal, the carb (oats)
  // into another, the fat (oil) into a third. Naive placement → meal 0 is all
  // protein, the others carry none, and calories are lopsided. balanceMeals must
  // spread protein AND even the calories, WITHOUT changing any food's day grams.
  var macros = {
    chicken: { protein: 31, carbs: 0, fat: 4 },
    oats:    { protein: 13, carbs: 60, fat: 7 },
    oil:     { protein: 0,  carbs: 0,  fat: 100 }
  };
  var dayGrams = { chicken: 300, oats: 150, oil: 40 };
  var mealsByCode = { chicken: [0], oats: [1], oil: [2] };
  var noPiece = function () { return false; };
  var perMeal = planner.balanceMeals(dayGrams, macros, noPiece, mealsByCode, [1 / 3, 1 / 3, 1 / 3], 3, 0);

  function sumG(code) { return perMeal.reduce(function (s, m) { return s + (m[code] || 0); }, 0); }
  ok("balanceMeals preserves every food's day grams (macros untouched)",
     sumG("chicken") === 300 && sumG("oats") === 150 && sumG("oil") === 40,
     JSON.stringify(perMeal));
  function protOf(m) { return Object.keys(m).reduce(function (s, c) { return s + m[c] * macros[c].protein / 100; }, 0); }
  function kcalOf(m) { return Object.keys(m).reduce(function (s, c) { var x = macros[c]; return s + m[c] * (4 * x.protein + 4 * x.carbs + 9 * x.fat) / 100; }, 0); }
  var prot = perMeal.map(protOf), kc = perMeal.map(kcalOf);
  ok("balanceMeals spreads protein so every meal carries a real share",
     prot.every(function (p) { return p >= 12; }), prot.map(function (p) { return p.toFixed(0); }).join(","));
  ok("balanceMeals evens calories across meals (no meal dwarfs another)",
     (Math.max.apply(null, kc) - Math.min.apply(null, kc)) / Math.max.apply(null, kc) < 0.35,
     kc.map(function (x) { return x.toFixed(0); }).join(","));

  // Weighted: a dinner-heavy split must tilt calories to the last meal.
  var pm2 = planner.balanceMeals(dayGrams, macros, noPiece, mealsByCode, [0.2, 0.3, 0.5], 3, 0);
  var k2 = pm2.map(kcalOf);
  ok("balanceMeals honours the calorie split (dinner heaviest)", k2[2] > k2[0], k2.map(function (x) { return x.toFixed(0); }).join(","));
})();

// ---- 2) portion realism: pure snap helpers ------------------------------
(function () {
  var egg = planner.pieceInfo("Kananmuna");
  ok("pieceInfo recognises eggs (Finnish)", !!egg && egg.one === "egg");
  ok("pieceInfo recognises bananas", !!planner.pieceInfo("Banaani"));
  ok("pieceInfo ignores eggplant (word-boundary)", planner.pieceInfo("Eggplant curry") === null);
  ok("pieceInfo ignores bulk foods", planner.pieceInfo("chicken breast") === null && planner.pieceInfo("Riisi") === null);

  ok("7 g of egg snaps to a quarter, not grams", (function () {
    var s = planner.snapPiece(egg, 7); return !s.drop && s.pieces === 0.25; })());
  ok("3 g of egg is dropped (below one step)", planner.snapPiece(egg, 3).drop === true);
  ok("55 g of egg snaps to one whole egg", (function () {
    var s = planner.snapPiece(egg, 55); return !s.drop && s.pieces === 1 && s.grams === 50; })());

  ok("pieceAmount reads like a human count", planner.pieceAmount(1, egg) === "1 egg" &&
     planner.pieceAmount(2, egg) === "2 eggs" && planner.pieceAmount(0.5, egg) === "½ egg" &&
     planner.pieceAmount(1.5, egg) === "1½ eggs" && planner.pieceAmount(0.25, egg) === "¼ egg");

  ok("bulk snaps to 5 g and drops sub-10 g slivers",
     planner.snapBulk(42).grams === 40 && planner.snapBulk(12).grams === 10 && planner.snapBulk(7).drop === true);

  var d3 = planner.distributeBulk(200, [0, 1, 2]);
  ok("distributeBulk partitions exactly", d3[0] + d3[1] + d3[2] === 200);
  ok("distributeBulk concentrates a small total into one meal", (function () {
    var d = planner.distributeBulk(12, [0, 1, 2]);
    return Object.keys(d).length === 1 && d[0] === 12; })());
})();

// ---- 2b) reasoning step: classification -> portion descriptor -----------
(function () {
  var can = planner.classToDescriptor({ kind: "unit", unit: "can", unitGrams: 120, minFraction: 0.5 }, "canned tuna");
  ok("classify unit → piece descriptor", !!can && can.grams === 120 && can.step === 0.5 && can.one === "can" && can.many === "cans");
  ok("classify bulk → null (weighed, not counted)", planner.classToDescriptor({ kind: "bulk" }, "rice") === null);
  ok("obvious-bulk food vetoes a mis-called unit", planner.classToDescriptor({ kind: "unit", unitGrams: 15 }, "olive oil") === null);
  ok("wild unit weight with no fallback → null", planner.classToDescriptor({ kind: "unit", unit: "x", unitGrams: 5000 }, "mystery") === null);
  ok("minFraction snaps to ¼/½/whole", (function () {
    var a = planner.classToDescriptor({ kind: "unit", unit: "u", unitGrams: 60, minFraction: 0.3 }, "sausage");
    var b = planner.classToDescriptor({ kind: "unit", unit: "u", unitGrams: 60, minFraction: 2 }, "sausage");
    return a.step === 0.25 && b.step === 1; })());

  var pc = planner.buildPortionClass(
    { foods: [{ name: "canned tuna", kind: "unit", unit: "can", unitGrams: 120, minFraction: 0.5 }, { name: "rice", kind: "bulk" }] },
    [{ code: "t1", name: "canned tuna" }, { code: "r1", name: "rice" }]);
  ok("buildPortionClass keys unit foods by code, omits bulk", !!pc.t1 && pc.t1.one === "can" && !pc.r1);
})();

// ---- 2c) plan memory: an answered question keeps the other facts ---------
// mergeAnswer is what the app calls when the user re-answers a question (e.g.
// changes the calorie split). The whole point of remembering: the diet the model
// was told must survive a split change, not get dropped on the rebuild.
(function () {
  var mem = { prefs: "vegan", country: "Finland", calorieSplit: "even" };
  var next = planner.mergeAnswer(mem, "calorie-split", "dinner");
  ok("split change updates the split", next.calorieSplit === "dinner");
  ok("split change KEEPS the diet the model was told", next.prefs === "vegan");
  ok("split change keeps other remembered facts", next.country === "Finland");
  ok("mergeAnswer does not mutate the input", mem.calorieSplit === "even");
  var noop = planner.mergeAnswer(mem, "unknown-question", "whatever");
  ok("an unknown question leaves memory unchanged",
     noop.prefs === "vegan" && noop.calorieSplit === "even" && Object.keys(noop).length === 3);
  var seeded = planner.mergeAnswer(null, "calorie-split", "lunch");
  ok("mergeAnswer tolerates empty memory", seeded.calorieSplit === "lunch");
})();

// ---- 2c) calorie split + question mechanism (pure) ----------------------
(function () {
  var W = planner.calorieWeights;
  var even = W("even", ["Breakfast", "Lunch", "Dinner"]);
  ok("even split weights all mains equally", Math.abs(even[0] - even[2]) < 1e-9 && Math.abs(even[0] - 1 / 3) < 1e-9);
  var din = W("dinner", ["Breakfast", "Lunch", "Dinner"]);
  ok("dinner split ramps toward the evening", din[2] > din[1] && din[1] > din[0], din.join(","));
  var bfast = W("breakfast", ["Breakfast", "Lunch", "Dinner"]);
  ok("breakfast split front-loads the morning", bfast[0] > bfast[1] && bfast[1] > bfast[2], bfast.join(","));
  var withSnack = W("even", ["Breakfast", "Lunch", "Dinner", "Snack"]);
  ok("snacks are always lighter than mains", withSnack[3] < withSnack[0], withSnack.join(","));

  var d = planner.distributeBulk(200, [0, 1], { 0: 0.25, 1: 0.75 });
  ok("weighted distributeBulk tilts to the heavier meal and sums exactly", d[1] > d[0] && (d[0] + d[1] === 200), JSON.stringify(d));

  ok("sanitizeQuestion drops a question with no real choices", planner.sanitizeQuestion({ prompt: "Type your goal", options: [] }) === null);
  ok("sanitizeQuestion drops a promptless question", planner.sanitizeQuestion({ options: [{ label: "a" }, { label: "b" }] }) === null);
  var sq = planner.sanitizeQuestion({ prompt: "Pick one", options: [{ label: "A" }, { label: "A" }, { label: "B" }] });
  ok("sanitizeQuestion cleans + dedupes options, deriving ids", !!sq && sq.options.length === 2 && sq.options[0].id === "a");
  var cq = planner.buildCalorieSplitQuestion();
  ok("calorie question is options-only with 4 choices", !!cq && cq.id === "calorie-split" && cq.options.length === 4);
  ok("answerToBuildOpts maps a calorie answer to a rebuild patch",
     planner.answerToBuildOpts("calorie-split", "dinner").calorieSplit === "dinner");
})();

// ---- shared mock host ----------------------------------------------------
function macro(kcal, p, f, c) {
  return { breakdown: { macros: { energy_kcal: kcal, proteins: p, fat: f, carbohydrates: c } } };
}
function catalogOf(rows) {
  return fl.parseCatalog(rows.map(function (a) { return JSON.stringify(a); }).join("\n"));
}
function fetchOf(products) {
  return function (url) {
    var m = url.match(/products\/(\w+)\.json$/);
    if (m && products[m[1]]) {
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(products[m[1]]); } });
    }
    return Promise.resolve({ ok: false, status: 404 });
  };
}
// English -> local (Finnish) search terms for the fuzzy layer.
function translatorOf(dict, counter) {
  return function (ctx) {
    if (counter) counter.n++;
    return Promise.resolve({ terms: (ctx.foods || []).map(function (nm) {
      return { name: nm, queries: dict[String(nm).toLowerCase()] || [] };
    }) });
  };
}

// ---- 3) fan-out + voting + translation rescue ---------------------------
function scenarioVoting() {
  var catalog = catalogOf([
    ["k1", "Kananrinta", "Kotimaista", "fi", 100, "g", 0, 0, 3.6, 31],
    ["k2", "Oliivioljy", "Bertolli", "fi", 100, "ml", 0, 0, 100, 0],
    ["k3", "Kaurahiutaleet", "Elovena", "fi", 100, "g", 10, 60, 7, 13],
    ["k4", "Linssit", "Rainbow", "fi", 100, "g", 8, 20, 0.4, 9],
    ["k5", "Riisi", "Uncle", "fi", 100, "g", 0.4, 28, 0.3, 2.7],
    ["k6", "Banaani", "Chiquita", "fi", 100, "g", 2.6, 23, 0.3, 1.1]
  ]);
  var products = {
    k1: Object.assign(macro(165, 31, 3.6, 0), { product_name: "Kananrinta" }),
    k2: Object.assign(macro(884, 0, 100, 0), { product_name: "Oliivioljy" }),
    k3: Object.assign(macro(370, 13, 7, 60), { product_name: "Kaurahiutaleet" }),
    k4: Object.assign(macro(116, 9, 0.4, 20), { product_name: "Linssit" }),
    k5: Object.assign(macro(130, 2.7, 0.3, 28), { product_name: "Riisi" }),
    k6: Object.assign(macro(96, 1.1, 0.3, 23), { product_name: "Banaani" })
  };
  var FI = { "chicken breast": ["kananrinta"], "olive oil": ["oliivioljy"], "rolled oats": ["kaurahiutaleet"],
             "lentils": ["linssit"], "rice": ["riisi"], "banana": ["banaani"] };
  var ENGLISH = Object.keys(FI);
  var designCalls = 0, tr = { n: 0 };
  var engine = {
    designMeal: function () { return Promise.resolve({ foods: ENGLISH.concat(["unicorn steak " + (designCalls++)]) }); },
    translateFoods: translatorOf(FI, tr)
  };
  return planner.buildPlan({
    dayTargets: [{ label: "Every day", count: 7, kcal: 1620, protein: 120, fat: 60, carbs: 150, fiber: 30 }],
    country: "Finland", currency: "EUR", weeklyBudget: 70, prefs: "none", mealsPerDay: 2,
    io: { catalog: catalog, fetch: fetchOf(products) }, engine: engine, votes: 3
  }).then(function (plan) {
    ok("plan built via engine path", plan && plan.days && plan.days.length === 1);
    ok("designMeal fanned out (votes×meals calls)", designCalls === 3 * 2, "calls=" + designCalls);
    ok("translateFoods was used for fuzzy search", tr.n > 0);
    var names = [];
    plan.days[0].meals.forEach(function (m) { m.items.forEach(function (it) { names.push(it.food); }); });
    plan.shoppingList.forEach(function (rr) { rr.items.forEach(function (it) { names.push(it.name); }); });
    ok("voting dropped the one-off noise food", names.every(function (n) { return !/unicorn/i.test(n); }), names.join("|"));
    ok("foods rescued to REAL Finnish products", names.some(function (n) { return /Kananrinta/i.test(n); }), names.join("|"));
    ok("real products aren't flagged AI-estimated", !/AI-estimated/i.test(plan.micronutrients), plan.micronutrients);
    ok("every meal has items", plan.days[0].meals.every(function (m) { return m.items.length > 0; }));
  });
}

// ---- 4) portion realism through the whole pipeline ----------------------
function scenarioPortions() {
  var catalog = catalogOf([
    ["e1", "Kananmuna", "Kotimaista", "fi", 50, "kpl", 0, 1, 11, 13],
    ["o1", "Kaurahiutaleet", "Elovena", "fi", 100, "g", 10, 60, 7, 13],
    ["c1", "Kananrinta", "Kotimaista", "fi", 100, "g", 0, 0, 3.6, 31],
    ["r1", "Riisi", "Uncle", "fi", 100, "g", 0.4, 28, 0.3, 2.7],
    ["l1", "Oliivioljy", "Bertolli", "fi", 100, "ml", 0, 0, 100, 0]
  ]);
  var products = {
    e1: Object.assign(macro(155, 13, 11, 1), { product_name: "Kananmuna" }),
    o1: Object.assign(macro(370, 13, 7, 60), { product_name: "Kaurahiutaleet" }),
    c1: Object.assign(macro(165, 31, 3.6, 0), { product_name: "Kananrinta" }),
    r1: Object.assign(macro(130, 2.7, 0.3, 28), { product_name: "Riisi" }),
    l1: Object.assign(macro(884, 0, 100, 0), { product_name: "Oliivioljy" })
  };
  var FI = { "eggs": ["kananmuna"], "rolled oats": ["kaurahiutaleet"], "chicken breast": ["kananrinta"],
             "rice": ["riisi"], "olive oil": ["oliivioljy"] };
  // Model puts eggs in TWO meals (breakfast + dinner) to prove concentration.
  var byMeal = {
    Breakfast: ["eggs", "rolled oats"],
    Lunch: ["chicken breast", "rice"],
    Dinner: ["chicken breast", "olive oil", "eggs"]
  };
  var engine = {
    designMeal: function (ctx) { return Promise.resolve({ foods: byMeal[ctx.mealName] || ["chicken breast", "rice"] }); },
    translateFoods: translatorOf(FI)
  };
  return planner.buildPlan({
    dayTargets: [{ label: "Every day", count: 7, kcal: 1870, protein: 130, fat: 70, carbs: 180, fiber: 25 }],
    country: "Finland", currency: "EUR", weeklyBudget: 70, prefs: "none", mealsPerDay: 3,
    io: { catalog: catalog, fetch: fetchOf(products) }, engine: engine, votes: 1
  }).then(function (plan) {
    var day = plan.days[0], allItems = [];
    day.meals.forEach(function (m, mi) { m.items.forEach(function (it) { allItems.push({ mi: mi, it: it }); }); });

    var eggs = allItems.filter(function (x) { return /muna|egg/i.test(x.it.food); });
    ok("eggs made it into the plan as a real product", eggs.length > 0, JSON.stringify(day.meals.map(function (m) { return m.items.map(function (i) { return i.food + " " + i.amount; }); })));
    ok("eggs are shown in UNITS, never grams",
       eggs.every(function (x) { return /\begg/i.test(x.it.amount) && !/\bg$/.test(x.it.amount); }),
       eggs.map(function (x) { return x.it.amount; }).join("|"));
    ok("eggs are concentrated in ONE meal (not smeared across meals)",
       (function () { var m = {}; eggs.forEach(function (x) { m[x.mi] = 1; }); return Object.keys(m).length === 1; })(),
       "meals=" + eggs.map(function (x) { return x.mi; }).join(","));

    var gramItems = allItems.filter(function (x) { return /\bg$/.test(x.it.amount); });
    ok("no bulk food is a sub-10 g sliver", gramItems.every(function (x) { return parseFloat(x.it.amount) >= 10; }),
       gramItems.map(function (x) { return x.it.food + " " + x.it.amount; }).join("|"));
    ok("bulk grams are rounded to 5 g", gramItems.every(function (x) { return parseFloat(x.it.amount) % 5 === 0; }),
       gramItems.map(function (x) { return x.it.amount; }).join("|"));

    ok("meal names carry a food descriptor (Breakfast — …)",
       day.meals.every(function (m) { return / — /.test(m.name); }), day.meals.map(function (m) { return m.name; }).join(" | "));
    var chicken = allItems.filter(function (x) { return /kananrinta/i.test(x.it.food); });
    ok("a raw protein is shown as raw weight (120 g raw)",
       chicken.length > 0 && chicken.every(function (x) { return / raw$/.test(x.it.amount); }),
       chicken.map(function (x) { return x.it.amount; }).join("|"));

    var mainKcal = day.meals.filter(function (m) { return !/snack/i.test(m.name); }).map(function (m) { return m.totals.kcal; });
    ok("main meals are calorie-balanced (no meal dwarfs another)",
       Math.max.apply(null, mainKcal) <= 1.8 * Math.min.apply(null, mainKcal), mainKcal.join(","));
    ok("every meal carries protein (a balanced plate, not just balanced calories)",
       day.meals.every(function (m) { return m.totals.protein >= 8; }), day.meals.map(function (m) { return m.totals.protein; }).join(","));

    ok("day-level solve still roughly hits protein", day.totals.protein >= 130 - 12, "got " + day.totals.protein);
    ok("meals are genuinely different (not identical plates)",
       JSON.stringify(day.meals[0].items.map(function (i) { return i.food; })) !==
       JSON.stringify(day.meals[1].items.map(function (i) { return i.food; })));
    // Per-day totals equal the sum of the meal items shown (display matches solver).
    var sumP = 0; day.meals.forEach(function (m) { m.items.forEach(function (it) { sumP += it.protein; }); });
    ok("meal items sum to the day protein total", Math.abs(sumP - day.totals.protein) <= 1.5,
       "items=" + sumP.toFixed(1) + " day=" + day.totals.protein);
  });
}

// ---- 5) reasoning step end-to-end: an unknown food classified as a unit --
function scenarioReasoning() {
  var catalog = catalogOf([
    ["t1", "Tonnikala", "Kotimaista", "fi", 120, "tolkki", 0, 0, 1, 26],
    ["o1", "Kaurahiutaleet", "Elovena", "fi", 100, "g", 10, 60, 7, 13],
    ["r1", "Riisi", "Uncle", "fi", 100, "g", 0.4, 28, 0.3, 2.7],
    ["l1", "Oliivioljy", "Bertolli", "fi", 100, "ml", 0, 0, 100, 0],
    ["b1", "Banaani", "Chiquita", "fi", 120, "kpl", 2.6, 23, 0.3, 1.1]
  ]);
  var products = {
    t1: Object.assign(macro(116, 26, 1, 0), { product_name: "Tonnikala" }),
    o1: Object.assign(macro(370, 13, 7, 60), { product_name: "Kaurahiutaleet" }),
    r1: Object.assign(macro(130, 2.7, 0.3, 28), { product_name: "Riisi" }),
    l1: Object.assign(macro(884, 0, 100, 0), { product_name: "Oliivioljy" }),
    b1: Object.assign(macro(96, 1.1, 0.3, 23), { product_name: "Banaani" })
  };
  var FI = { "canned tuna": ["tonnikala"], "rolled oats": ["kaurahiutaleet"], "rice": ["riisi"],
             "olive oil": ["oliivioljy"], "banana": ["banaani"] };
  var byMeal = { Breakfast: ["rolled oats", "banana"], Lunch: ["canned tuna", "rice", "olive oil"] };
  var classifyInputs = null;
  var engine = {
    designMeal: function (ctx) { return Promise.resolve({ foods: byMeal[ctx.mealName] || ["rice"] }); },
    translateFoods: translatorOf(FI),
    // The reasoning chat: a can of tuna is a UNIT you use whole/half; the rest is bulk.
    classifyFoods: function (ctx) {
      classifyInputs = (ctx.foods || []).slice();
      return Promise.resolve({ foods: (ctx.foods || []).map(function (nm) {
        return /tonnikala|tuna/i.test(nm)
          ? { name: nm, kind: "unit", unit: "can", unitGrams: 120, minFraction: 0.5 }
          : { name: nm, kind: "bulk" };
      }) });
    }
  };
  return planner.buildPlan({
    dayTargets: [{ label: "Every day", count: 7, kcal: 1700, protein: 110, fat: 60, carbs: 190, fiber: 25 }],
    country: "Finland", currency: "EUR", weeklyBudget: 70, prefs: "none", mealsPerDay: 2,
    io: { catalog: catalog, fetch: fetchOf(products) }, engine: engine, votes: 1
  }).then(function (plan) {
    ok("classifyFoods was consulted (reasoning ran)", !!classifyInputs && classifyInputs.length > 0);
    ok("reasoning only sees AMBIGUOUS foods (known pieces skipped)",
       classifyInputs.indexOf("Tonnikala") >= 0 && classifyInputs.indexOf("Banaani") < 0, (classifyInputs || []).join(","));

    var items = [];
    plan.days[0].meals.forEach(function (m) { m.items.forEach(function (it) { items.push(it); }); });
    var tuna = items.filter(function (it) { return /tonnikala/i.test(it.food); });
    ok("the reasoned unit food is shown in its unit, not grams",
       tuna.length > 0 && tuna.every(function (it) { return /\bcan/i.test(it.amount) && !/\bg$/.test(it.amount); }),
       tuna.map(function (it) { return it.amount; }).join("|"));
    var banana = items.filter(function (it) { return /banaani/i.test(it.food); });
    ok("regex fallback still portions a known piece (banana)",
       banana.every(function (it) { return /banana/i.test(it.amount) && !/\bg$/.test(it.amount); }),
       banana.map(function (it) { return it.amount; }).join("|"));
    var gramItems = items.filter(function (it) { return /\bg$/.test(it.amount); });
    ok("still no sub-10 g slivers", gramItems.every(function (it) { return parseFloat(it.amount) >= 10; }),
       gramItems.map(function (it) { return it.food + " " + it.amount; }).join("|"));
  });
}

// ---- 5) planQuestions: model-proposed, sanitized, critic-gated, w/ fallback
function scenarioQuestions() {
  return planner.planQuestions(null, {}).then(function (qs) {
    ok("planQuestions falls back to the calorie question with no engine",
       qs.length === 1 && qs[0].id === "calorie-split");
    var eng1 = {
      proposeQuestions: function () { return Promise.resolve({ questions: [
        { id: "appetite", prompt: "When are you hungriest?", options: [{ label: "Morning" }, { label: "Evening" }] }] }); },
      critiqueQuestion: function () { return Promise.resolve({ ok: true }); }
    };
    return planner.planQuestions(eng1, {}).then(function (qs2) {
      ok("a good model question is kept AND the calorie split is still offered",
         qs2.some(function (q) { return q.id === "appetite"; }) && qs2.some(function (q) { return q.id === "calorie-split"; }));
      var eng2 = { proposeQuestions: function () { return Promise.resolve({ questions: [{ prompt: "Type your favourite food", options: [] }] }); } };
      return planner.planQuestions(eng2, {}).then(function (qs3) {
        ok("an un-pickable (free-text) question is dropped, fallback kept", qs3.length === 1 && qs3[0].id === "calorie-split");
        var eng3 = {
          proposeQuestions: function () { return Promise.resolve({ questions: [{ id: "x", prompt: "Confusing?", options: [{ label: "A" }, { label: "B" }] }] }); },
          critiqueQuestion: function () { return Promise.resolve({ ok: false }); }
        };
        return planner.planQuestions(eng3, {}).then(function (qs4) {
          ok("the question critic can veto a proposed question",
             !qs4.some(function (q) { return q.id === "x"; }) && qs4.some(function (q) { return q.id === "calorie-split"; }));
        });
      });
    });
  });
}

// ---- 6) calorie split end-to-end: the day actually tilts to the evening --
function scenarioCalorie() {
  var catalog = catalogOf([
    ["k1", "Kananrinta", "Kotimaista", "fi", 100, "g", 0, 0, 3.6, 31],
    ["k2", "Oliivioljy", "Bertolli", "fi", 100, "ml", 0, 0, 100, 0],
    ["k5", "Riisi", "Uncle", "fi", 100, "g", 0.4, 28, 0.3, 2.7]
  ]);
  var products = {
    k1: Object.assign(macro(165, 31, 3.6, 0), { product_name: "Kananrinta" }),
    k2: Object.assign(macro(884, 0, 100, 0), { product_name: "Oliivioljy" }),
    k5: Object.assign(macro(130, 2.7, 0.3, 28), { product_name: "Riisi" })
  };
  var FI = { "chicken breast": ["kananrinta"], "olive oil": ["oliivioljy"], "rice": ["riisi"] };
  var foods = ["chicken breast", "rice", "olive oil"]; // same foods each meal → all bulk span all meals
  var targets = {};
  var engine = {
    designMeal: function (ctx) { targets[ctx.mealName] = ctx.target.kcal; return Promise.resolve({ foods: foods }); },
    translateFoods: translatorOf(FI)
  };
  return planner.buildPlan({
    dayTargets: [{ label: "Every day", count: 7, kcal: 1900, protein: 120, fat: 70, carbs: 190, fiber: 20 }],
    country: "Finland", currency: "EUR", weeklyBudget: 70, prefs: "none", mealsPerDay: 3,
    io: { catalog: catalog, fetch: fetchOf(products) }, engine: engine, votes: 1, calorieSplit: "dinner"
  }).then(function (plan) {
    ok("calorie split tilts the per-meal DESIGN targets to the evening",
       targets.Dinner > targets.Breakfast, JSON.stringify(targets));
    // Meal names now carry a descriptor ("Dinner — chicken, rice & …"), so match
    // by the slot prefix rather than an exact key.
    var kcal = {}; plan.days[0].meals.forEach(function (m) { kcal[m.name.split(" — ")[0]] = m.totals.kcal; });
    ok("the assembled dinner carries more calories than breakfast",
       kcal.Dinner > kcal.Breakfast, JSON.stringify(kcal));
  });
}

// ---- 7) meal-coherence critic: incoherent meals are flagged in the note --
function scenarioCritic() {
  var catalog = catalogOf([
    ["k1", "Kananrinta", "Kotimaista", "fi", 100, "g", 0, 0, 3.6, 31],
    ["k2", "Oliivioljy", "Bertolli", "fi", 100, "ml", 0, 0, 100, 0],
    ["k3", "Kaurahiutaleet", "Elovena", "fi", 100, "g", 10, 60, 7, 13],
    ["k5", "Riisi", "Uncle", "fi", 100, "g", 0.4, 28, 0.3, 2.7],
    ["k6", "Banaani", "Chiquita", "fi", 120, "kpl", 2.6, 23, 0.3, 1.1]
  ]);
  var products = {
    k1: Object.assign(macro(165, 31, 3.6, 0), { product_name: "Kananrinta" }),
    k2: Object.assign(macro(884, 0, 100, 0), { product_name: "Oliivioljy" }),
    k3: Object.assign(macro(370, 13, 7, 60), { product_name: "Kaurahiutaleet" }),
    k5: Object.assign(macro(130, 2.7, 0.3, 28), { product_name: "Riisi" }),
    k6: Object.assign(macro(96, 1.1, 0.3, 23), { product_name: "Banaani" })
  };
  var FI = { "rolled oats": ["kaurahiutaleet"], "banana": ["banaani"], "chicken breast": ["kananrinta"],
             "rice": ["riisi"], "olive oil": ["oliivioljy"] };
  var byMeal = { Breakfast: ["rolled oats", "banana"], Lunch: ["chicken breast", "rice", "olive oil"] };
  var reviewed = [];
  var engine = {
    designMeal: function (ctx) { return Promise.resolve({ foods: byMeal[ctx.mealName] || ["rice"] }); },
    translateFoods: translatorOf(FI),
    // Flags Lunch, passes Breakfast — proves only flagged meals reach the note.
    critiqueMeal: function (ctx) {
      reviewed.push({ name: ctx.mealName, items: (ctx.items || []).slice() });
      return Promise.resolve(/lunch/i.test(ctx.mealName)
        ? { ok: false, issues: ["that's a lot of plain oil for one plate"] }
        : { ok: true, issues: [] });
    }
  };
  return planner.buildPlan({
    dayTargets: [{ label: "Every day", count: 7, kcal: 1700, protein: 110, fat: 60, carbs: 190, fiber: 25 }],
    country: "Finland", currency: "EUR", weeklyBudget: 70, prefs: "none", mealsPerDay: 2,
    io: { catalog: catalog, fetch: fetchOf(products) }, engine: engine, votes: 1
  }).then(function (plan) {
    ok("critiqueMeal ran on each meal of the day", reviewed.length === 2 &&
       reviewed.some(function (r) { return /breakfast/i.test(r.name); }) &&
       reviewed.some(function (r) { return /lunch/i.test(r.name); }), reviewed.map(function (r) { return r.name; }).join(","));
    ok("critic receives the meal's items with amounts",
       reviewed.every(function (r) { return r.items.length > 0 && r.items[0].amount; }));
    ok("a flagged meal surfaces in the note", /Meal check/.test(plan.micronutrients) &&
       /Lunch/.test(plan.micronutrients) && /plain oil/.test(plan.micronutrients), plan.micronutrients);
    ok("a meal the critic passed is NOT flagged", !/Breakfast:/.test(plan.micronutrients), plan.micronutrients);
  });
}

// ---- 8) whole-day review: the day is judged as a set BEFORE catalog match --
function scenarioDayReview() {
  var catalog = catalogOf([
    ["o1", "Rolled oats", "Elovena", "en", 100, "g", 10, 60, 7, 13],
    ["w1", "Whey protein", "Star", "en", 100, "g", 0, 6, 4, 80],
    ["c1", "Chicken breast", "Kotimaista", "en", 100, "g", 0, 0, 3.6, 31],
    ["r1", "Rice", "Uncle", "en", 100, "g", 0.4, 28, 0.3, 2.7],
    ["l1", "Olive oil", "Bertolli", "en", 100, "ml", 0, 0, 100, 0],
    ["b1", "Blueberries", "Rainbow", "en", 100, "g", 2.4, 12, 0.3, 0.7]
  ]);
  var products = {
    o1: Object.assign(macro(370, 13, 7, 60), { product_name: "Rolled oats" }),
    w1: Object.assign(macro(390, 80, 6, 4), { product_name: "Whey protein" }),
    c1: Object.assign(macro(165, 31, 3.6, 0), { product_name: "Chicken breast" }),
    r1: Object.assign(macro(130, 2.7, 0.3, 28), { product_name: "Rice" }),
    l1: Object.assign(macro(884, 0, 100, 0), { product_name: "Olive oil" }),
    b1: Object.assign(macro(57, 0.7, 0.3, 12), { product_name: "Blueberries" })
  };
  // The model first designs a nonsense breakfast; the whole-day review catches it
  // and hands back a corrected day (real breakfast staples) BEFORE any matching.
  var byMeal = { Breakfast: ["chocolate cake"], Lunch: ["chicken breast", "rice", "olive oil"] };
  var reviewSeen = null;
  var engine = {
    designMeal: function (ctx) { return Promise.resolve({ foods: byMeal[ctx.mealName] || ["rice"] }); },
    reviewDay: function (ctx) {
      reviewSeen = (ctx.meals || []).map(function (m) { return m.name + ":" + m.foods.join("+"); });
      return Promise.resolve({
        ok: false,
        issues: ["breakfast was cake — swapped for oats, whey and blueberries"],
        meals: [
          { name: "Breakfast", foods: ["rolled oats", "whey protein", "blueberries"] },
          { name: "Lunch", foods: ["chicken breast", "rice", "olive oil"] }
        ]
      });
    }
  };
  return planner.buildPlan({
    dayTargets: [{ label: "Every day", count: 7, kcal: 1800, protein: 140, fat: 60, carbs: 170, fiber: 25 }],
    country: "Finland", currency: "EUR", weeklyBudget: 70, prefs: "none", mealsPerDay: 2,
    io: { catalog: catalog, fetch: fetchOf(products) }, engine: engine, votes: 1
  }).then(function (plan) {
    ok("reviewDay saw the WHOLE day (every meal) before matching",
       !!reviewSeen && reviewSeen.length === 2 && /chocolate cake/i.test(reviewSeen[0]), JSON.stringify(reviewSeen));
    var bfast = plan.days[0].meals[0];
    var names = bfast.items.map(function (i) { return i.food; }).join("|").toLowerCase();
    ok("the reviewed breakfast replaced cake with real staples (oats + whey)",
       /oats/.test(names) && /whey/.test(names) && !/cake/.test(names), names);
    var mealFoods = plan.days[0].meals.reduce(function (a, m) { return a.concat(m.items.map(function (i) { return i.food.toLowerCase(); })); }, []);
    ok("cake never reached the catalog / plate (review ran before matching)",
       mealFoods.every(function (f) { return !/cake/.test(f); }), mealFoods.join("|"));
    ok("the whole-day review note surfaces in the plan",
       /Day check/.test(plan.micronutrients) && /cake/.test(plan.micronutrients), plan.micronutrients);
  });
}

scenarioVoting().then(scenarioPortions).then(scenarioReasoning)
  .then(scenarioQuestions).then(scenarioCalorie).then(scenarioCritic).then(scenarioDayReview).then(function () {
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
}).catch(function (err) {
  console.error("scenario threw:", err && err.stack || err);
  process.exit(1);
});

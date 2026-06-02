/*
 * Tests for the on-device WebLLM engine's generation path (streaming + the
 * no-token stall watchdog). No real CDN import, no GPU: a fake `webllm` module
 * is injected via createWebLLMEngine({ webllm }), with tiny timeouts so the
 * watchdog fires instantly.
 *
 * Covers the exact failure the user hit: the model loads ("Finish loading on
 * WebGPU - apple") and then the first generation emits no tokens and never
 * settles. The watchdog must interrupt + reject so suggestFoods rejects and the
 * planner falls back to staples (emitting "aiskip" so that model is blocklisted).
 *
 * Run with:  node test/webllm.test.js
 */
"use strict";
var planner = require("../meal-plan/planner.js");
var fl = require("../meal-plan/food-lookup.js");

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok  - " + name); }
  else { fail++; console.log("  FAIL- " + name + (extra ? "  " + extra : "")); }
}

// Wrap a next() function as an async-iterable, matching WebLLM's streaming shape.
function asyncIter(nextFn) {
  return { [Symbol.asyncIterator]: function () { return { next: nextFn }; } };
}

// Fake @mlc-ai/web-llm. `opts.chunks` are streamed as token deltas; `opts.stall`
// makes generation never emit and never finish (the hang we're guarding against).
function fakeWebLLM(opts) {
  opts = opts || {};
  var mod = {
    prebuiltAppConfig: { model_list: [] },
    CreateMLCEngine: function (model, cfg) {
      if (cfg && cfg.initProgressCallback) {
        cfg.initProgressCallback({ progress: 1, text: "Finish loading on WebGPU - test" });
      }
      var engine = {
        interrupted: false,
        interruptGenerate: function () { this.interrupted = true; },
        chat: { completions: { create: function (args) {
          if (opts.stall) return Promise.resolve(asyncIter(function () { return new Promise(function () {}); }));
          // opts.reply(messages) lets a test answer each call differently (needed
          // now that every meal — and the macro guess — is its own generation).
          var chunks;
          if (opts.reply) {
            var r = opts.reply((args && args.messages) || []);
            chunks = Array.isArray(r) ? r.slice() : [String(r)];
          } else {
            chunks = (opts.chunks || []).slice();
          }
          return Promise.resolve(asyncIter(function () {
            if (chunks.length) {
              return Promise.resolve({ done: false, value: { choices: [{ delta: { content: chunks.shift() } }] } });
            }
            return Promise.resolve({ done: true });
          }));
        } } }
      };
      mod._engine = engine; // expose for assertions
      return Promise.resolve(engine);
    }
  };
  return mod;
}

// Route the per-meal architecture's calls: a designMeal call (one per meal) is
// answered from spec.meals[<meal name>] (or spec.meals._default); a guessMacros
// call (recognised by its "nutrition database" system prompt) is answered per
// food, in order, via spec.macro(name) — returning null falls back to a default.
function mealReply(spec) {
  return function (messages) {
    var sys = (messages[0] && messages[0].content) || "";
    var usr = (messages[1] && messages[1].content) || "";
    if (/nutrition database/i.test(sys)) {
      var foods = usr.split("\n")
        .map(function (l) { return (l.match(/^\s*\d+\.\s*(.+?)\s*$/) || [])[1]; })
        .filter(Boolean);
      var macro = spec.macro || function () { return null; };
      return JSON.stringify({ macros: foods.map(function (f) {
        var m = macro(f) || { kcal: 150, protein: 8, fat: 5, carbs: 15, fiber: 3 };
        return { name: f, kcal: m.kcal, protein: m.protein, fat: m.fat, carbs: m.carbs, fiber: m.fiber };
      }) });
    }
    var meal = (usr.match(/^Meal:\s*(.+)$/m) || [])[1] || "";
    var foods = (spec.meals && (spec.meals[meal] || spec.meals._default)) || [];
    return JSON.stringify({ foods: foods });
  };
}

var fast = { model: "Test-q4f32_1-MLC", pollMs: 10, genStallMs: 40, stallMs: 1000 };

function run() {
  // 1) Happy path: prose-wrapped, code-fenced, chunked JSON still parses, and
  //    suggestFoods returns the food names.
  var web1 = fakeWebLLM({ chunks: [
    "Sure! Here are the foods:\n```json\n{\"foods\": [\"chicken breast\",",
    " \"olive oil\", \"brown rice\",", " \"lentils\"]}\n```"
  ] });
  var eng1 = planner.createWebLLMEngine(Object.assign({ webllm: web1 }, fast));
  return eng1.suggestFoods({ country: "Finland", prefs: "no pork", mealsPerDay: 3,
    dayTargets: [{ kcal: 1900, protein: 135, fat: 68, carbs: 200, fiber: 35 }] })
  .then(function (foods) {
    ok("streamed prose+fenced JSON parses to foods",
       Array.isArray(foods) && foods.length === 4 && foods[0] === "chicken breast", JSON.stringify(foods));

    // 2) Stall watchdog: generation never emits -> rejects, and the engine was
    //    interrupted to free the GPU.
    var web2 = fakeWebLLM({ stall: true });
    var eng2 = planner.createWebLLMEngine(Object.assign({ webllm: web2 }, fast));
    return eng2.suggestFoods({ country: "Finland", dayTargets: [{ protein: 135 }] })
      .then(function () { ok("stalled generation rejects", false, "resolved instead of rejecting"); },
            function (err) {
              ok("stalled generation rejects", /no output|stalled/i.test(err.message), err.message);
              ok("engine was interrupted on stall", web2._engine && web2._engine.interrupted === true);
            });
  })
  .then(function () {
    // 3) End-to-end: a stalling engine handed to buildPlan must NOT hang — it
    //    falls back to staples, emits "aiskip", and still produces a valid plan.
    var CATALOG = [
      ["c1", "Chicken breast", "Farm", "fi", 100, "g", 0, 0, 3.6, 31],
      ["c2", "Olive oil", "Bertolli", "fi", 100, "ml", 0, 0, 100, 0],
      ["c3", "Rice cooked", "Uncle", "fi", 100, "g", 0.4, 28, 0.3, 2.7],
      ["c4", "Black beans", "Bonduelle", "fi", 100, "g", 8.7, 23.7, 0.5, 8.9],
      ["c5", "Psyllium husk", "Health", "fi", 100, "g", 80, 5, 0.5, 1.5]
    ].map(function (a) { return JSON.stringify(a); }).join("\n");
    var PRODUCTS = {
      c1: { product_name: "Chicken breast", breakdown: { macros: { energy_kcal: 165, proteins: 31, fat: 3.6, carbohydrates: 0 } } },
      c2: { product_name: "Olive oil", breakdown: { macros: { energy_kcal: 884, proteins: 0, fat: 100, carbohydrates: 0 } } },
      c3: { product_name: "Rice", breakdown: { macros: { energy_kcal: 130, proteins: 2.7, fat: 0.3, carbohydrates: 28 } } },
      c4: { product_name: "Black beans", breakdown: { macros: { energy_kcal: 132, proteins: 8.9, fat: 0.5, carbohydrates: 23.7 } } },
      c5: { product_name: "Psyllium", breakdown: { macros: { energy_kcal: 40, proteins: 1.5, fat: 0.5, carbohydrates: 5 } } }
    };
    function fakeFetch(url) {
      var m = url.match(/products\/(\w+)\.json$/);
      if (m && PRODUCTS[m[1]]) return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(PRODUCTS[m[1]]); } });
      return Promise.resolve({ ok: false, status: 404 });
    }
    var catalog = fl.parseCatalog(CATALOG);
    var stallEngine = planner.createWebLLMEngine(Object.assign({ webllm: fakeWebLLM({ stall: true }) }, fast));
    return planner.buildPlan({
      dayTargets: [{ key: "low", label: "Low day", count: 7, kcal: 1444, protein: 135, fat: 68, carbs: 74, fiber: 35 }],
      country: "Finland", currency: "EUR", weeklyBudget: 70, prefs: "", mealsPerDay: 3,
      io: { catalog: catalog, fetch: fakeFetch }, engine: stallEngine
    }).then(function () {
      ok("stalling engine -> buildPlan rejects (no hang, no staple plan)", false, "resolved instead of rejecting");
    }, function (err) {
      // The watchdog turns the hang into a clean rejection (so the app can walk
      // to the next model) rather than spinning forever or degrading to staples.
      ok("stalling engine -> buildPlan rejects (no hang, no staple plan)", !!err);
      ok("rejection flagged aiFailure (app walks to next model)", err && err.aiFailure === true);
    }).then(function () {
      // 4) Per-meal design: one dedicated prompt PER meal. Each meal is solved to
      //    its own balanced, substantial plate (the fix for "same food every meal").
      var designEngine = planner.createWebLLMEngine(Object.assign({ webllm: fakeWebLLM({ reply: mealReply({ meals: {
        Breakfast: ["chicken breast", "black beans"],
        Lunch: ["chicken breast", "rice cooked", "olive oil"],
        Dinner: ["chicken breast", "psyllium husk", "olive oil"]
      } }) }) }, fast));
      return planner.buildPlan({
        dayTargets: [{ key: "low", label: "Low day", count: 7, kcal: 1444, protein: 135, fat: 68, carbs: 74, fiber: 35 }],
        country: "Finland", prefs: "", breakfast: "savory", mealsPerDay: 3,
        io: { catalog: catalog, fetch: fakeFetch }, engine: designEngine
      }).then(function (mp) {
        var d0 = mp.days[0];
        var perMeal = d0.meals.map(function (m) { return m.items.map(function (it) { return it.food; }).sort().join(","); });
        var mealKcal = d0.meals.map(function (m) { return m.totals.kcal; });
        ok("per-meal: produces every requested meal", d0.meals.length === 3, "meals=" + d0.meals.length);
        ok("per-meal: each meal is substantial (>=200 kcal, no lone nibble)",
           mealKcal.every(function (k) { return k >= 200; }), mealKcal.join(","));
        ok("per-meal: each meal carries protein (balanced plate)",
           d0.meals.every(function (m) { return m.totals.protein >= 10; }),
           d0.meals.map(function (m) { return m.totals.protein; }).join(","));
        ok("per-meal: meals are not all identical",
           perMeal.length > 1 && !perMeal.every(function (s) { return s === perMeal[0]; }), JSON.stringify(perMeal));
        ok("per-meal: day still hits protein target", d0.totals.protein >= 130, "got " + d0.totals.protein);
        ok("per-meal: per-meal totals sum to the day total",
           Math.abs(d0.meals.reduce(function (a, m) { return a + m.totals.protein; }, 0) - d0.totals.protein) <= 2);
      }).then(function () {
        // 5) Diet-aware repair: a vegetarian whose meals are protein-short must get
        //    a PLANT protein bolted on, NEVER chicken — even though chicken is the
        //    richest protein in the catalog.
        var VC = [
          ["t1", "Tofu", "B", "fi", 100, "g", 1.5, 1.9, 8, 15],
          ["t2", "Chicken breast", "F", "fi", 100, "g", 0, 0, 3.6, 31],
          ["t3", "Spinach", "G", "fi", 100, "g", 2.2, 3.6, 0.4, 2.9],
          ["t4", "Oats", "M", "fi", 100, "g", 10, 66, 7, 13],
          ["t5", "Olive oil", "B", "fi", 100, "ml", 0, 0, 100, 0]
        ].map(function (a) { return JSON.stringify(a); }).join("\n");
        var VP = {
          t1: { product_name: "Tofu", breakdown: { macros: { energy_kcal: 144, proteins: 15, fat: 8, carbohydrates: 1.9 } } },
          t2: { product_name: "Chicken breast", breakdown: { macros: { energy_kcal: 165, proteins: 31, fat: 3.6, carbohydrates: 0 } } },
          t3: { product_name: "Spinach", breakdown: { macros: { energy_kcal: 23, proteins: 2.9, fat: 0.4, carbohydrates: 3.6 } } },
          t4: { product_name: "Oats", breakdown: { macros: { energy_kcal: 389, proteins: 13, fat: 7, carbohydrates: 66 } } },
          t5: { product_name: "Olive oil", breakdown: { macros: { energy_kcal: 884, proteins: 0, fat: 100, carbohydrates: 0 } } }
        };
        function vfetch(url) {
          var m = url.match(/products\/(\w+)\.json$/);
          return Promise.resolve(m && VP[m[1]] ? { ok: true, status: 200, json: function () { return Promise.resolve(VP[m[1]]); } } : { ok: false, status: 404 });
        }
        var vegEngine = planner.createWebLLMEngine(Object.assign({ webllm: fakeWebLLM({ reply: mealReply({
          meals: { _default: ["oats", "spinach", "olive oil"] } // protein-light -> forces diet-aware repair
        }) }) }, fast));
        return planner.buildPlan({
          dayTargets: [{ label: "Day", count: 7, kcal: 1600, protein: 110, fat: 55, carbs: 150, fiber: 35 }],
          country: "Finland", prefs: "vegetarian", breakfast: "savory", mealsPerDay: 3,
          io: { catalog: fl.parseCatalog(VC), fetch: vfetch }, engine: vegEngine
        }).then(function (vp) {
          var foods = [];
          vp.days[0].meals.forEach(function (m) { m.items.forEach(function (it) { foods.push(it.food); }); });
          ok("veg: no chicken anywhere (diet-aware repair)",
             foods.every(function (f) { return !/chicken/i.test(f); }), foods.join("|"));
          ok("veg: a plant protein (tofu) was used instead",
             foods.some(function (f) { return /tofu/i.test(f); }), foods.join("|"));
        });
      }).then(function () {
        // 6) When product fetch fails but the catalog has macros, every item must
        //    still show the catalog's calories — NEVER a 0-kcal line.
        var VC = [
          ["t1", "Tofu", "B", "fi", 100, "g", 1.5, 1.9, 8, 15],
          ["t3", "Spinach", "G", "fi", 100, "g", 2.2, 3.6, 0.4, 2.9],
          ["t4", "Oats", "M", "fi", 100, "g", 10, 66, 7, 13],
          ["t5", "Olive oil", "B", "fi", 100, "ml", 0, 0, 100, 0]
        ].map(function (a) { return JSON.stringify(a); }).join("\n");
        var allMiss = function () { return Promise.resolve({ ok: false, status: 404 }); };
        var eng = planner.createWebLLMEngine(Object.assign({ webllm: fakeWebLLM({ reply: mealReply({
          meals: { _default: ["oats", "spinach", "tofu"] }
        }) }) }, fast));
        return planner.buildPlan({
          dayTargets: [{ label: "Day", count: 7, kcal: 1600, protein: 110, fat: 55, carbs: 150, fiber: 35 }],
          country: "Finland", prefs: "vegetarian", breakfast: "savory", mealsPerDay: 3,
          io: { catalog: fl.parseCatalog(VC), fetch: allMiss }, engine: eng
        }).then(function (mp) {
          var items = [];
          mp.days[0].meals.forEach(function (m) { m.items.forEach(function (it) { items.push(it); }); });
          ok("no-fetch: every item shows calories from the catalog (no 0-kcal lines)",
             items.length > 0 && items.every(function (it) { return it.kcal > 0; }),
             items.map(function (it) { return it.food + ":" + it.kcal; }).join("|"));
          ok("no-fetch: plan flags the macros as estimated (catalog-derived)",
             /estimated/i.test(mp.micronutrients || ""), mp.micronutrients);
        });
      }).then(function () {
        // 7) AI macro fallback: a meal names a food the catalog DOESN'T stock. Instead
        //    of dropping it, the planner asks the model for its per-100 g macros and
        //    uses the food anyway — it appears in the plan with real calories.
        var VC = [
          ["o1", "Oats", "M", "fi", 100, "g", 10, 66, 7, 13],
          ["o2", "Spinach", "G", "fi", 100, "g", 2.2, 3.6, 0.4, 2.9]
        ].map(function (a) { return JSON.stringify(a); }).join("\n");
        var fetchOats = function (url) {
          var m = url.match(/products\/(\w+)\.json$/);
          return Promise.resolve(m && m[1] === "o1"
            ? { ok: true, status: 200, json: function () { return Promise.resolve({ product_name: "Oats", breakdown: { macros: { energy_kcal: 389, proteins: 13, fat: 7, carbohydrates: 66 } } }); } }
            : { ok: false, status: 404 });
        };
        var eng = planner.createWebLLMEngine(Object.assign({ webllm: fakeWebLLM({ reply: mealReply({
          meals: { _default: ["oats", "grandma's kimchi pancake"] },
          macro: function (name) { return /kimchi/i.test(name) ? { kcal: 180, protein: 6, fat: 7, carbs: 22, fiber: 3 } : null; }
        }) }) }, fast));
        return planner.buildPlan({
          dayTargets: [{ label: "Day", count: 7, kcal: 1500, protein: 90, fat: 50, carbs: 170, fiber: 30 }],
          country: "Korea", prefs: "", breakfast: "savory", mealsPerDay: 3,
          io: { catalog: fl.parseCatalog(VC), fetch: fetchOats }, engine: eng
        }).then(function (mp) {
          var items = [];
          mp.days[0].meals.forEach(function (m) { m.items.forEach(function (it) { items.push(it); }); });
          var pancake = items.filter(function (it) { return /kimchi pancake/i.test(it.food); });
          ok("ai-macro: the off-catalog food still appears (not dropped)", pancake.length > 0,
             items.map(function (it) { return it.food; }).join("|"));
          ok("ai-macro: it carries the AI-estimated calories (>0)",
             pancake.length > 0 && pancake.every(function (it) { return it.kcal > 0; }),
             pancake.map(function (it) { return it.food + ":" + it.kcal; }).join("|"));
          ok("ai-macro: plan flagged estimated", /estimated/i.test(mp.micronutrients || ""), mp.micronutrients);
        });
      }).then(function () {
        // 8) Variety: each meal's prompt is told which foods earlier meals used, so
        //    later meals pick different foods (no cross-meal conversation needed).
        var VC = [
          ["v1", "Oats", "M", "fi", 100, "g", 10, 66, 7, 13],
          ["v2", "Spinach", "G", "fi", 100, "g", 2.2, 3.6, 0.4, 2.9],
          ["v3", "Tofu", "B", "fi", 100, "g", 1.5, 1.9, 8, 15],
          ["v4", "Brown rice", "M", "fi", 100, "g", 1.8, 23, 0.9, 2.6],
          ["v5", "Olive oil", "B", "fi", 100, "ml", 0, 0, 100, 0]
        ].map(function (a) { return JSON.stringify(a); }).join("\n");
        var prompts = [];
        var recording = fakeWebLLM({ reply: function (messages) {
          var usr = (messages[1] && messages[1].content) || "";
          prompts.push(usr);
          if (/nutrition database/i.test((messages[0] && messages[0].content) || "")) return JSON.stringify({ macros: [] });
          var meal = (usr.match(/^Meal:\s*(.+)$/m) || [])[1] || "";
          var foods = ({ Breakfast: ["oats", "spinach"], Lunch: ["tofu", "brown rice"], Dinner: ["olive oil", "oats"] })[meal] || [];
          return JSON.stringify({ foods: foods });
        } });
        var eng = planner.createWebLLMEngine(Object.assign({ webllm: recording }, fast));
        return planner.buildPlan({
          dayTargets: [{ label: "Day", count: 7, kcal: 1600, protein: 90, fat: 55, carbs: 180, fiber: 30 }],
          country: "Finland", prefs: "", breakfast: "savory", mealsPerDay: 3,
          io: { catalog: fl.parseCatalog(VC), fetch: function () { return Promise.resolve({ ok: false, status: 404 }); } }, engine: eng
        }).then(function () {
          var lunchPrompt = prompts.filter(function (p) { return /^Meal:\s*Lunch/m.test(p); })[0] || "";
          var breakfastPrompt = prompts.filter(function (p) { return /^Meal:\s*Breakfast/m.test(p); })[0] || "";
          ok("variety: first meal has no 'already used' line", !/already used earlier today/i.test(breakfastPrompt));
          ok("variety: later meals are told the foods earlier meals used",
             /already used earlier today/i.test(lunchPrompt) && /oats/i.test(lunchPrompt), lunchPrompt.split("\n").slice(-3).join(" | "));
        });
      });
    });
  });
}

run().then(function () {
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
}).catch(function (e) {
  console.log("  FAIL- test threw: " + (e && e.stack || e));
  process.exit(1);
});

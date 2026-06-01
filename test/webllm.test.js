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
        chat: { completions: { create: function () {
          if (opts.stall) return Promise.resolve(asyncIter(function () { return new Promise(function () {}); }));
          var chunks = (opts.chunks || []).slice();
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
      // 4) Model-designed meals, solved PER MEAL: each meal is a real, balanced,
      //    substantial plate (the fix for "same food every meal" AND "25 g almonds").
      var mealJSON = ['{"meals":[',
        '{"name":"Breakfast","foods":["chicken breast","black beans"]},',
        '{"name":"Lunch","foods":["chicken breast","rice cooked","olive oil"]},',
        '{"name":"Dinner","foods":["chicken breast","psyllium husk","olive oil"]}',
        ']}'];
      var designEngine = planner.createWebLLMEngine(Object.assign({ webllm: fakeWebLLM({ chunks: mealJSON }) }, fast));
      return planner.buildPlan({
        dayTargets: [{ key: "low", label: "Low day", count: 7, kcal: 1444, protein: 135, fat: 68, carbs: 74, fiber: 35 }],
        country: "Finland", prefs: "", tastes: "Mediterranean", breakfast: "savory", mealsPerDay: 3,
        io: { catalog: catalog, fetch: fakeFetch }, engine: designEngine
      }).then(function (mp) {
        var d0 = mp.days[0];
        var perMeal = d0.meals.map(function (m) { return m.items.map(function (it) { return it.food; }).sort().join(","); });
        var mealKcal = d0.meals.map(function (m) { return m.totals.kcal; });
        ok("layout: produces every requested meal", d0.meals.length === 3, "meals=" + d0.meals.length);
        ok("layout: each meal is substantial (>=200 kcal, no lone nibble)",
           mealKcal.every(function (k) { return k >= 200; }), mealKcal.join(","));
        ok("layout: each meal carries protein (balanced plate)",
           d0.meals.every(function (m) { return m.totals.protein >= 10; }),
           d0.meals.map(function (m) { return m.totals.protein; }).join(","));
        ok("layout: meals are not all identical",
           perMeal.length > 1 && !perMeal.every(function (s) { return s === perMeal[0]; }), JSON.stringify(perMeal));
        ok("layout: day still hits protein target", d0.totals.protein >= 130, "got " + d0.totals.protein);
        ok("layout: per-meal totals sum to the day total",
           Math.abs(d0.meals.reduce(function (a, m) { return a + m.totals.protein; }, 0) - d0.totals.protein) <= 2);
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

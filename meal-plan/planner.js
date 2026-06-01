/*
 * On-device meal planner (Path A orchestration — Phases 2 & 4).
 *
 * Ties the shared core together: the (optional) on-device LLM only *chooses
 * foods and narrates*; the catalog supplies real products and the solver does
 * every gram of arithmetic. Given the wizard answers + the pre-computed per-day
 * targets, buildPlan() produces the app's import JSON.
 *
 * Two layers, deliberately separable so the deterministic half is Node-testable
 * without a browser, WebGPU, or a live model:
 *   - buildPlan(opts)        : pure orchestration (catalog → solver → JSON).
 *                              Works with or without a model `engine`.
 *   - createWebLLMEngine(...) : browser-only; dynamically imports @mlc-ai/web-llm,
 *                              downloads the model, and exposes suggestFoods/
 *                              summarize used (optionally) by buildPlan.
 *
 * No build step. Browser global window.YdinPlanner; CommonJS for tests.
 */
(function (root) {
  "use strict";

  var FL = (typeof require !== "undefined") ? require("./food-lookup.js") : root.YdinFoodLookup;
  var SOLVER = (typeof require !== "undefined") ? require("./solver.js") : root.YdinSolver;

  // A generic, omnivore staple set used when no model is available (or the model
  // declines to choose). Spans protein / fat / carb / fibre roles so the solver
  // has the degrees of freedom to hit the targets. With a model present these
  // are only a fallback — the model's choices (which honour dietary prefs) win.
  var DEFAULT_STAPLES = [
    "chicken breast", "eggs", "greek yogurt", "tuna", "tofu",
    "rolled oats", "brown rice", "potato", "whole wheat bread", "banana",
    "olive oil", "almonds", "peanut butter",
    "black beans", "lentils", "broccoli", "spinach", "carrots"
  ];

  function num(x) { var n = typeof x === "string" ? parseFloat(x) : x;
                    return typeof n === "number" && isFinite(n) ? n : 0; }
  function round(x) { return Math.round(num(x) * 10) / 10; }

  // Browsers' DecompressionStream supports gzip/deflate but (almost universally)
  // NOT brotli, and the catalog .br objects ship with no Content-Encoding — so we
  // decompress in JS, loaded lazily from a CDN only when needed.
  //
  // We use a PURE-JS decompressor (foliojs `brotli`). WASM brotli builds proved
  // unreliable from CDNs — failing to initialise ("(void 0) is not a function")
  // or throwing Emscripten binding errors ("Cannot pass non-string to
  // std::string"). Pure JS has none of that. Output is normalised to Uint8Array.
  var _brotliDecodeP = null;
  function findDecompressFn(m) {
    var cands = [m && m.default, m && m.decompress,
                 m && m.default && m.default.decompress, m];
    for (var i = 0; i < cands.length; i++) {
      if (typeof cands[i] === "function") return cands[i];
    }
    return null;
  }
  function loadBrotliDecode() {
    if (_brotliDecodeP) return _brotliDecodeP;
    var urls = [
      "https://esm.sh/brotli/decompress",
      "https://esm.run/brotli/decompress",
      "https://esm.sh/brotli",
      "https://cdn.jsdelivr.net/npm/brotli@1.3.3/decompress.js/+esm"
    ];
    function attempt(url) {
      return function () {
        return import(/* webpackIgnore: true */ url).then(function (m) {
          var fn = findDecompressFn(m);
          if (!fn) throw new Error("brotli: no decompress() at " + url);
          return function (u8) { return new Uint8Array(fn(u8)); };
        });
      };
    }
    _brotliDecodeP = urls.reduce(function (chain, url) {
      return chain.catch(attempt(url));
    }, Promise.reject()).catch(function () {
      throw new Error("Couldn't load a brotli decoder from any CDN (offline or blocked).");
    });
    return _brotliDecodeP;
  }
  function browserBrotli(u8) {
    return loadBrotliDecode().then(function (decode) { return decode(u8); });
  }

  // Turn a catalog record + (optional) fetched product into the per-100 g macro
  // row the solver needs. Product macros win for P/F/C; fibre comes from the
  // catalog index (product breakdowns often omit it).
  function macroRow(rec, product) {
    var m = (product && product.breakdown && product.breakdown.macros) || {};
    return {
      code: rec.code,
      name: (product && product.product_name) || rec.name || rec.code,
      protein: m.proteins != null ? num(m.proteins) : num(rec.protein),
      fat: m.fat != null ? num(m.fat) : num(rec.fat),
      carbs: m.carbohydrates != null ? num(m.carbohydrates) : num(rec.carbs),
      fiber: num(rec.fiber)
    };
  }

  // Gather a candidate food pool by searching the catalog for each query and
  // taking the best hit. Returns unique catalog records (deduped by code).
  function gatherFoods(catalog, queries) {
    var seen = {}, out = [];
    (queries || []).forEach(function (q) {
      var hit = FL.searchFoods(catalog, q, 1)[0];
      if (hit && hit.code && !seen[hit.code]) { seen[hit.code] = 1; out.push(hit); }
    });
    return out;
  }

  // Split a day's solved foods across `meals` meals. Deterministic: each food's
  // grams are divided evenly across the meals, so every meal is nutritionally
  // balanced. Foods under ~5 g are dropped as noise.
  function splitIntoMeals(solvedFoods, products, mealsPerDay) {
    var n = Math.max(1, mealsPerDay | 0);
    var kept = solvedFoods.filter(function (f) { return f.grams >= 5; });
    var meals = [];
    var names = ["Breakfast", "Lunch", "Dinner", "Snack", "Second snack", "Supper"];
    for (var i = 0; i < n; i++) {
      var items = kept.map(function (f) {
        var grams = round(f.grams / n);
        var t = FL.buildMealTotals([{ code: f.code, grams: grams, fiber100: f.fiber100 }], products).totals;
        return {
          food: f.name, amount: grams + " g",
          kcal: Math.round(t.kcal), protein: round(t.protein),
          fat: round(t.fat), carbs: round(t.carbs), fiber: round(t.fiber)
        };
      });
      meals.push({ name: n <= names.length ? names[i] : "Meal " + (i + 1), items: items });
    }
    return meals;
  }

  // Build a shopping list grouped by brand (a stand-in "retailer" — real
  // retailer names + prices are Phase 5's web-search layer; here prices are
  // left at 0 and flagged in the summary).
  function shoppingList(solvedFoods, recsByCode) {
    var groups = {};
    solvedFoods.filter(function (f) { return f.grams >= 5; }).forEach(function (f) {
      var rec = recsByCode[f.code] || {};
      var retailer = rec.brand || "Local supermarket";
      (groups[retailer] = groups[retailer] || []).push({
        name: f.name, qty: Math.round(f.grams) + " g", price: 0
      });
    });
    return Object.keys(groups).map(function (r) { return { retailer: r, items: groups[r] }; });
  }

  // A short, honest micronutrient note from the deterministic totals.
  function microNote(dayTotalsList, estimated, unmet) {
    var bits = [];
    bits.push("Macros and micros are summed deterministically from the catalog; fibre meets the daily floor.");
    if (estimated) bits.push("Some micronutrient values are AI-estimated (flagged in the product data) — treat them as approximate.");
    if (unmet.length) bits.push("Heads up: " + unmet.join("; ") + ". Adjust a portion or swap a food, or use the copy-prompt path for a finer plan.");
    bits.push("Retailer names and prices aren't priced on-device — use the copy-prompt path or add the web-search layer for budget detail.");
    return bits.join(" ");
  }

  /**
   * buildPlan(opts) -> Promise<plan JSON in the app import shape>
   *
   * opts:
   *   dayTargets : [{ key,label,count|perWeek, kcal,protein,fat,carbs,fiber }]
   *   country, currency, weeklyBudget, prefs, mealsPerDay
   *   io         : food-lookup context { base, fetch, brotliDecode, cache, catalog }
   *   engine     : optional { suggestFoods(ctx)->Promise<string[]>, summarize?(meta)->Promise<string> }
   *   staples    : optional fallback query list
   *   onProgress : optional (stage, detail) => void
   *   repairRounds : optional max repair iterations (default 2)
   */
  function buildPlan(opts) {
    opts = opts || {};
    var io = opts.io || {};
    var report = opts.onProgress || function () {};
    var mealsPerDay = Math.max(1, (opts.mealsPerDay | 0) || 3);
    var staples = opts.staples || DEFAULT_STAPLES;
    var repairRounds = opts.repairRounds == null ? 2 : opts.repairRounds;

    // Brotli isn't decodable natively in the browser — supply the wasm fallback
    // unless the caller already wired one (the Node tests inject their own).
    if (!io.brotliDecode && typeof window !== "undefined") io.brotliDecode = browserBrotli;

    report("catalog", "Loading the " + (opts.country || "country") + " food catalog…");
    var catP = io.catalog ? Promise.resolve(io.catalog)
                          : FL.loadCountryCatalog(opts.cc || "", io);

    return catP.then(function (catalog) {
      io.catalog = catalog;

      // 1) Choose foods — model first, staples as the safety net.
      report("choose", "Choosing foods…");
      var queriesP = opts.engine && opts.engine.suggestFoods
        ? Promise.resolve(opts.engine.suggestFoods({
            dayTargets: opts.dayTargets, prefs: opts.prefs,
            country: opts.country, mealsPerDay: mealsPerDay
          })).then(function (list) {
            return (list && list.length) ? list.concat(staples) : staples;
          }).catch(function () { return staples; })
        : Promise.resolve(staples);

      return queriesP.then(function (queries) {
        var recs = gatherFoods(catalog, queries);
        if (!recs.length) throw new Error("No matching foods found in the catalog for this country.");
        var recsByCode = {};
        recs.forEach(function (r) { recsByCode[r.code] = r; });

        report("fetch", "Fetching nutrition for " + recs.length + " foods…");
        return FL.fetchProducts(recs.map(function (r) { return r.code; }), io).then(function (products) {
          var foods = recs.map(function (r) { return macroRow(r, products[r.code]); });

          // 2) Solve each day type; repair by adding a macro-rich food if needed.
          report("solve", "Sizing portions to hit every target…");
          var unmet = [];
          var days = opts.dayTargets.map(function (target) {
            var res = SOLVER.solvePortions(target, foods);
            for (var round = 0; round < repairRounds && !res.ok; round++) {
              var added = false;
              res.failed.forEach(function (fc) {
                var q = REPAIR_QUERY[fc.constraint];
                if (!q) return;
                var extra = gatherFoods(catalog, q).filter(function (r) { return !foodHas(foods, r.code); });
                extra.forEach(function (r) { foods.push(macroRow(r, products[r.code])); });
                if (extra.length) added = true;
              });
              if (!added) break;
              // products for any newly added foods may be missing macros; that's fine —
              // macroRow already fell back to catalog macros.
              res = SOLVER.solvePortions(target, foods);
            }

            var solved = foods.map(function (f, i) {
              return { code: f.code, name: f.name, grams: res.grams[i], fiber100: f.fiber };
            });
            var dayItems = solved.filter(function (s) { return s.grams >= 5; })
                                 .map(function (s) { return { code: s.code, grams: s.grams, fiber100: s.fiber100 }; });
            var dayTot = FL.buildMealTotals(dayItems, products);
            if (!res.ok) {
              unmet.push((target.label || "a day") + ": " +
                res.failed.map(function (fc) { return fc.constraint + " " + fc.actual + "/" + fc.target; }).join(", "));
            }
            return {
              label: target.label || "Every day",
              perWeek: target.perWeek || target.count || 7,
              meals: splitIntoMeals(solved, products, mealsPerDay),
              totals: {
                kcal: dayTot.totals.kcal, protein: dayTot.totals.protein,
                fat: dayTot.totals.fat, carbs: dayTot.totals.carbs, fiber: dayTot.totals.fiber
              },
              _solved: solved, _estimated: dayTot.estimated
            };
          });

          // 3) Assemble the import JSON.
          report("assemble", "Writing up your plan…");
          var allSolved = days[0]._solved; // food set is shared across day types
          var estimated = days.some(function (d) { return d._estimated; });
          var summaryP = opts.engine && opts.engine.summarize
            ? Promise.resolve(opts.engine.summarize({
                country: opts.country, dayTargets: opts.dayTargets, prefs: opts.prefs
              })).catch(function () { return ""; })
            : Promise.resolve("");

          return summaryP.then(function (modelSummary) {
            var plan = {
              type: "weeks-until-show-meal-plan",
              version: 1,
              country: opts.country || "",
              currency: opts.currency || "",
              weeklyBudget: num(opts.weeklyBudget),
              summary: modelSummary ||
                ("On-device plan for " + (opts.country || "you") + ": " + mealsPerDay +
                 " meals/day across " + days.length + " day type" + (days.length > 1 ? "s" : "") +
                 ", portioned to your targets." + (opts.prefs ? " Preferences: " + opts.prefs + "." : "")),
              days: days.map(function (d) {
                return { label: d.label, perWeek: d.perWeek, meals: d.meals, totals: d.totals };
              }),
              shoppingList: shoppingList(allSolved, recsByCode),
              micronutrients: microNote(days.map(function (d) { return d.totals; }), estimated, unmet)
            };
            report("done", unmet.length ? "Plan ready (some targets approximate)." : "Plan ready.");
            return plan;
          });
        });
      });
    });
  }

  function foodHas(foods, code) {
    for (var i = 0; i < foods.length; i++) if (foods[i].code === code) return true;
    return false;
  }

  // Foods to search for when a given constraint can't be met with the current pool.
  var REPAIR_QUERY = {
    protein: ["chicken breast", "whey protein", "egg whites", "tuna", "tofu"],
    fat: ["olive oil", "almonds", "peanut butter"],
    carbs: ["white rice", "potato", "banana", "pasta"],
    fiber: ["psyllium husk", "wheat bran", "lentils", "chia seeds", "black beans"]
  };

  // ---- browser-only: WebLLM engine ----------------------------------------
  // Dynamically imports @mlc-ai/web-llm (CDN ESM) so the heavy model code only
  // loads when the user starts an on-device build. Returns an engine with the
  // minimal, structured calls buildPlan needs.
  var WEBLLM_CDN = "https://esm.run/@mlc-ai/web-llm";
  var DEFAULT_MODEL = "Llama-3.2-3B-Instruct-q4f16_1-MLC";
  var FALLBACK_MODEL = "Llama-3.2-1B-Instruct-q4f16_1-MLC";

  function createWebLLMEngine(options) {
    options = options || {};
    var onProgress = options.onProgress || function () {};
    var model = options.model || DEFAULT_MODEL;

    // Lazy: the heavy WebLLM code + model only download when a method is first
    // called (i.e. after the catalog has loaded), never on Path B / no-WebGPU.
    // Dynamic import() works fine in a classic script.
    var loadP = null;
    function load() {
      if (loadP) return loadP;
      loadP = import(/* webpackIgnore: true */ WEBLLM_CDN).then(function (webllm) {
        function start(m) {
          return webllm.CreateMLCEngine(m, {
            initProgressCallback: function (p) {
              onProgress("download", p && p.text ? p.text : ("Downloading model… " +
                Math.round((p && p.progress || 0) * 100) + "%"));
            }
          });
        }
        return start(model).catch(function () {
          onProgress("download", "Falling back to a smaller model…");
          return start(FALLBACK_MODEL);
        });
      });
      return loadP;
    }

    function chatJSON(system, user, schema) {
      return load().then(function (engine) {
        return engine.chat.completions.create({
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
          temperature: 0.4,
          response_format: { type: "json_object" },
          max_tokens: 600
        }).then(function (r) {
          var txt = r.choices && r.choices[0] && r.choices[0].message.content || "{}";
          try { return JSON.parse(txt); } catch (e) { return {}; }
        });
      });
    }

    return {
      suggestFoods: function (ctx) {
        var t = (ctx.dayTargets && ctx.dayTargets[0]) || {};
        var sys = "You are a nutritionist choosing real, locally available whole foods. " +
          "Respect the user's dietary preferences strictly. You DO NOT do any arithmetic — " +
          "only name foods. Reply as JSON: {\"foods\": [\"food name\", ...]} with 10–16 foods " +
          "spanning protein, healthy fats, slow carbs and high-fibre items.";
        var usr = "Country: " + (ctx.country || "unknown") + "\n" +
          "Dietary preferences/restrictions: " + (ctx.prefs || "none") + "\n" +
          "Per-day targets: ~" + Math.round(t.kcal || 0) + " kcal, " +
          Math.round(t.protein || 0) + " g protein, " + Math.round(t.fat || 0) +
          " g fat, " + Math.round(t.carbs || 0) + " g carbs, fibre ≥ " +
          Math.round(t.fiber || 35) + " g.\nMeals per day: " + (ctx.mealsPerDay || 3) +
          ".\nName foods only — portions are computed separately.";
        return chatJSON(sys, usr).then(function (o) {
          return Array.isArray(o.foods) ? o.foods.filter(function (x) { return typeof x === "string"; }) : [];
        });
      },
      summarize: function (meta) {
        var sys = "Write ONE warm, concrete sentence (max 30 words) summarising a meal plan. No numbers needed.";
        var usr = "Country: " + (meta.country || "") + ". Preferences: " + (meta.prefs || "none") +
          ". Day types: " + (meta.dayTargets || []).map(function (d) { return d.label; }).join(", ") + ".";
        return load().then(function (engine) {
          return engine.chat.completions.create({
            messages: [{ role: "system", content: sys }, { role: "user", content: usr }],
            temperature: 0.6, max_tokens: 80
          }).then(function (r) {
            return (r.choices && r.choices[0] && r.choices[0].message.content || "").trim();
          });
        }).catch(function () { return ""; });
      },
      warm: function () { return load().then(function () { return true; }); },
      dispose: function () { return load().then(function (e) { return e.unload && e.unload(); }).catch(function(){}); }
    };
  }

  var api = {
    buildPlan: buildPlan,
    createWebLLMEngine: createWebLLMEngine,
    browserBrotli: browserBrotli,
    DEFAULT_STAPLES: DEFAULT_STAPLES,
    macroRow: macroRow,
    splitIntoMeals: splitIntoMeals,
    gatherFoods: gatherFoods,
    DEFAULT_MODEL: DEFAULT_MODEL
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.YdinPlanner = api;
})(typeof self !== "undefined" ? self : this);

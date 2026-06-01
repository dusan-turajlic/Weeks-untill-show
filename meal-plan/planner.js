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

  var MEAL_NAMES = ["Breakfast", "Lunch", "Dinner", "Snack", "Second snack", "Supper"];
  function defaultMealNames(n) {
    var a = [];
    for (var i = 0; i < n; i++) a.push(i < MEAL_NAMES.length ? MEAL_NAMES[i] : "Meal " + (i + 1));
    return a;
  }

  // Split a day's solved foods across `meals` meals. Deterministic: each food's
  // grams are divided evenly across the meals, so every meal is nutritionally
  // balanced. Foods under ~5 g are dropped as noise.
  // NOTE: this even-split makes every meal identical, so it's only the fallback
  // for the engine-less / flat-list path. The model path uses a real per-meal
  // layout (buildMealsFromLayout) so meals are genuinely different.
  function splitIntoMeals(solvedFoods, products, mealsPerDay) {
    var n = Math.max(1, mealsPerDay | 0);
    var kept = solvedFoods.filter(function (f) { return f.grams >= 5; });
    var meals = [];
    var names = defaultMealNames(n);
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

  // Build a real, balanced day from a model-designed layout by solving EACH meal
  // to its own share of the day's targets — so every meal is a proper plate
  // (protein + carbs + fat + fibre), never one tiny food. `mealCodes[mi]` is the
  // list of catalog codes the model put in meal mi. Snacks get a lighter share.
  // Returns { meals, totals, estimated, unmet, gramsByCode }.
  function assembleLayoutDay(dayTarget, names, mealCodes, products, catalog, recsByCode, repairRounds, prefs) {
    var weights = names.map(function (nm) { return /snack/i.test(nm) ? 0.6 : 1; });
    var totalW = weights.reduce(function (a, b) { return a + b; }, 0) || 1;
    var outMeals = [], unmet = [], estimated = false, gramsByCode = {};

    names.forEach(function (nm, mi) {
      var w = weights[mi] / totalW;
      var sub = {
        label: nm, kcal: (dayTarget.kcal || 0) * w, protein: (dayTarget.protein || 0) * w,
        fat: (dayTarget.fat || 0) * w, carbs: (dayTarget.carbs || 0) * w,
        fiber: (dayTarget.fiber || 35) * w
      };
      // Drop foods with no usable macros (blank catalog line + failed product
      // fetch) — they'd otherwise show as a 0-kcal "food" the solver inflates.
      var codes = [], foods = [];
      (mealCodes[mi] || []).forEach(function (c) {
        var f = macroRow(recsByCode[c], products[c]);
        if (num(f.protein) + num(f.fat) + num(f.carbs) > 0.5) { codes.push(c); foods.push(f); }
      });
      if (!foods.length) return;

      // Solve this meal; if a macro is short, add a DIET-APPROPRIATE food to it.
      var res = SOLVER.solvePortions(sub, foods);
      for (var r = 0; r < repairRounds && !res.ok; r++) {
        var added = false;
        res.failed.forEach(function (fc) {
          var q = repairQueries(fc.constraint, prefs); if (!q.length) return;
          var extra = gatherFoods(catalog, q).filter(function (rec) { return codes.indexOf(rec.code) < 0; });
          extra.forEach(function (rec) {
            codes.push(rec.code);
            if (!recsByCode[rec.code]) recsByCode[rec.code] = rec;
            foods.push(macroRow(rec, products[rec.code]));
          });
          if (extra.length) added = true;
        });
        if (!added) break;
        res = SOLVER.solvePortions(sub, foods);
      }
      if (!res.ok) {
        unmet.push((dayTarget.label || "a day") + " · " + nm + ": " +
          res.failed.map(function (fc) { return fc.constraint + " " + fc.actual + "/" + fc.target; }).join(", "));
      }

      var items = [];
      foods.forEach(function (f, i) {
        var g = res.grams[i];
        if (g < 5) return;
        gramsByCode[f.code] = (gramsByCode[f.code] || 0) + g;
        var t = FL.buildMealTotals([{ code: f.code, grams: g, fiber100: f.fiber }], products);
        if (t.estimated) estimated = true;
        items.push({
          food: f.name, amount: Math.round(g) + " g",
          kcal: Math.round(t.totals.kcal), protein: round(t.totals.protein),
          fat: round(t.totals.fat), carbs: round(t.totals.carbs), fiber: round(t.totals.fiber)
        });
      });
      if (items.length) {
        var mt = items.reduce(function (a, it) {
          a.kcal += it.kcal; a.protein += it.protein; a.fat += it.fat; a.carbs += it.carbs; a.fiber += it.fiber; return a;
        }, { kcal: 0, protein: 0, fat: 0, carbs: 0, fiber: 0 });
        outMeals.push({ name: nm, items: items, totals: {
          kcal: Math.round(mt.kcal), protein: round(mt.protein), fat: round(mt.fat), carbs: round(mt.carbs), fiber: round(mt.fiber)
        } });
      }
    });

    var dayItems = Object.keys(gramsByCode).map(function (c) {
      return { code: c, grams: gramsByCode[c], fiber100: (recsByCode[c] && num(recsByCode[c].fiber)) || 0 };
    });
    var dayTot = FL.buildMealTotals(dayItems, products);
    return {
      meals: outMeals,
      totals: { kcal: dayTot.totals.kcal, protein: dayTot.totals.protein, fat: dayTot.totals.fat,
                carbs: dayTot.totals.carbs, fiber: dayTot.totals.fiber },
      estimated: estimated || dayTot.estimated, unmet: unmet, gramsByCode: gramsByCode
    };
  }

  // Build a shopping list grouped by brand (a stand-in "retailer" — real
  // retailer names + prices are Phase 5's web-search layer; here prices are
  // not priced — on-device has no price data, so we omit price entirely rather
  // than show a misleading 0 (the UI then renders no price and no total).
  function shoppingList(solvedFoods, recsByCode) {
    var groups = {};
    solvedFoods.filter(function (f) { return f.grams >= 5; }).forEach(function (f) {
      var rec = recsByCode[f.code] || {};
      var retailer = rec.brand || "Local supermarket";
      (groups[retailer] = groups[retailer] || []).push({
        name: f.name, qty: Math.round(f.grams) + " g", price: null
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

      // 1) Decide the foods. With an engine the model is authoritative — there is
      // NO staple fallback: any failure rejects (flagged aiFailure) so the caller
      // can blocklist that model and try the next. suggestMeals designs DISTINCT
      // meals (which foods go in each meal); suggestFoods is the older flat-list
      // path; the staples list is only for engine-less (library) calls.
      report("choose", "Designing your meals…");
      var nMeals = mealsPerDay;
      var mealNames = defaultMealNames(nMeals);
      function aiReject(err) { err = err || new Error("On-device AI failed."); err.aiFailure = true; throw err; }
      function flatSelect(queries) {
        var recs = gatherFoods(catalog, queries);
        if (!recs.length) throw new Error("No matching foods found in the catalog for this country.");
        var recsByCode = {};
        recs.forEach(function (r) { recsByCode[r.code] = r; });
        return { recs: recs, recsByCode: recsByCode, layout: null };
      }

      var selectP;
      if (opts.engine && opts.engine.suggestMeals) {
        selectP = Promise.resolve(opts.engine.suggestMeals({
            dayTargets: opts.dayTargets, prefs: opts.prefs,
            breakfast: opts.breakfast, country: opts.country,
            mealsPerDay: nMeals, mealNames: mealNames
          })).then(function (design) {
            var dm = design && design.meals;
            if (!Array.isArray(dm) || !dm.length) aiReject(new Error("The model returned no meals."));
            // Resolve each meal's food names against the catalog, keeping a
            // per-meal code list so each meal can be solved on its own.
            var names = [], mealCodes = [], recsByCode = {}, recs = [], seen = {};
            dm.forEach(function (m, mi) {
              names.push((m && typeof m.name === "string" && m.name.trim()) ? m.name.trim()
                         : (mealNames[mi] || ("Meal " + (mi + 1))));
              var codes = [];
              ((m && m.foods) || []).forEach(function (nm) {
                if (typeof nm !== "string" || !nm.trim()) return;
                var hit = FL.searchFoods(catalog, nm, 1)[0];
                if (hit && hit.code) {
                  if (codes.indexOf(hit.code) < 0) codes.push(hit.code);
                  if (!seen[hit.code]) { seen[hit.code] = 1; recsByCode[hit.code] = hit; recs.push(hit); }
                }
              });
              mealCodes.push(codes);
            });
            if (!recs.length) aiReject(new Error("None of the model's foods matched the catalog."));
            return { recs: recs, recsByCode: recsByCode, layout: { names: names, mealCodes: mealCodes } };
          }, aiReject);
      } else if (opts.engine && opts.engine.suggestFoods) {
        selectP = Promise.resolve(opts.engine.suggestFoods({
            dayTargets: opts.dayTargets, prefs: opts.prefs,
            country: opts.country, mealsPerDay: nMeals
          })).then(function (list) {
            var q = (list || []).filter(function (x) { return typeof x === "string" && x.trim(); });
            if (!q.length) aiReject(new Error("The model returned no foods."));
            return q;
          }, aiReject).then(flatSelect);
      } else {
        selectP = Promise.resolve(staples).then(flatSelect);
      }

      return selectP.then(function (sel) {
        var recs = sel.recs, recsByCode = sel.recsByCode, layout = sel.layout;

        report("fetch", "Fetching nutrition for " + recs.length + " foods…");
        return FL.fetchProducts(recs.map(function (r) { return r.code; }), io).then(function (products) {

          // 2) Size portions. The model-meal path solves EACH meal to its share of
          // the day's targets (so every meal is a balanced plate); the flat path
          // solves the day as a whole and splits it.
          report("solve", "Sizing portions to hit every target…");
          var unmet = [];
          var days = opts.dayTargets.map(function (target) {
            if (layout) {
              var d = assembleLayoutDay(target, layout.names, layout.mealCodes, products,
                                        catalog, recsByCode, repairRounds, opts.prefs);
              if (d.unmet.length) unmet.push.apply(unmet, d.unmet);
              return {
                label: target.label || "Every day",
                perWeek: target.perWeek || target.count || 7,
                meals: d.meals, totals: d.totals,
                _gramsByCode: d.gramsByCode, _estimated: d.estimated
              };
            }

            // Flat fallback (engine-less / suggestFoods): solve the whole day.
            var foods = recs.map(function (r) { return macroRow(r, products[r.code]); })
              .filter(function (f) { return num(f.protein) + num(f.fat) + num(f.carbs) > 0.5; });
            var res = SOLVER.solvePortions(target, foods);
            for (var round = 0; round < repairRounds && !res.ok; round++) {
              var added = false;
              res.failed.forEach(function (fc) {
                var q = repairQueries(fc.constraint, opts.prefs);
                if (!q.length) return;
                var extra = gatherFoods(catalog, q).filter(function (r) { return !foodHas(foods, r.code); });
                extra.forEach(function (r) { foods.push(macroRow(r, products[r.code])); });
                if (extra.length) added = true;
              });
              if (!added) break;
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
              meals: splitIntoMeals(solved, products, nMeals),
              totals: {
                kcal: dayTot.totals.kcal, protein: dayTot.totals.protein,
                fat: dayTot.totals.fat, carbs: dayTot.totals.carbs, fiber: dayTot.totals.fiber
              },
              _solved: solved, _estimated: dayTot.estimated
            };
          });

          // 3) Assemble the import JSON.
          report("assemble", "Writing up your plan…");
          var allSolved = days[0]._solved ||
            Object.keys(days[0]._gramsByCode || {}).map(function (c) {
              return { code: c, name: (recsByCode[c] && recsByCode[c].name) || c, grams: days[0]._gramsByCode[c] };
            });
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

  // Foods to search for when a constraint can't be met. Each is tagged so repair
  // can RESPECT the diet — never bolt chicken/fish/dairy onto a vegetarian/vegan
  // meal. Plant options are listed first so even unrestricted plans lean healthy
  // rather than defaulting to meat.
  var REPAIR_FOODS = {
    protein: [
      { q: "tofu", tags: ["soy"] }, { q: "lentils", tags: [] }, { q: "chickpeas", tags: [] },
      { q: "greek yogurt", tags: ["dairy"] }, { q: "whey protein", tags: ["dairy"] },
      { q: "eggs", tags: ["egg"] }, { q: "tuna", tags: ["fish"] }, { q: "chicken breast", tags: ["meat"] }
    ],
    fat: [ { q: "olive oil", tags: [] }, { q: "almonds", tags: ["nut"] }, { q: "peanut butter", tags: ["nut"] } ],
    carbs: [ { q: "brown rice", tags: [] }, { q: "oats", tags: [] }, { q: "potato", tags: [] }, { q: "banana", tags: [] } ],
    fiber: [ { q: "lentils", tags: [] }, { q: "black beans", tags: [] }, { q: "chia seeds", tags: [] },
             { q: "psyllium husk", tags: [] }, { q: "wheat bran", tags: [] } ]
  };
  // Which food tags a free-text preferences string forbids.
  function dietBans(prefs) {
    var p = (prefs || "").toLowerCase(), b = {};
    if (/\bvegan\b/.test(p)) { b.meat = b.fish = b.dairy = b.egg = 1; }
    else if (/\bvegetarian\b/.test(p)) { b.meat = b.fish = 1; }
    else if (/\bpescatarian\b/.test(p)) { b.meat = 1; }
    if (/no\s+(meat|chicken|poultry)/.test(p)) b.meat = 1; // (specific meats like "no pork" still allow poultry)
    if (/no\s+(fish|seafood|shellfish)/.test(p)) b.fish = 1;
    if (/no\s+dairy|dairy[- ]?free|lactose/.test(p)) b.dairy = 1;
    if (/no\s+egg|egg[- ]?free/.test(p)) b.egg = 1;
    if (/no\s+(nut|peanut|almond)|nut[- ]?free/.test(p)) b.nut = 1;
    if (/no\s+soy|soy[- ]?free/.test(p)) b.soy = 1;
    return b;
  }
  // Repair queries for a constraint, filtered to what the diet allows.
  function repairQueries(constraint, prefs) {
    var bans = dietBans(prefs);
    return (REPAIR_FOODS[constraint] || []).filter(function (f) {
      return !f.tags.some(function (t) { return bans[t]; });
    }).map(function (f) { return f.q; });
  }

  // ---- browser-only: WebLLM engine ----------------------------------------
  // Dynamically imports @mlc-ai/web-llm (CDN ESM) so the heavy model code only
  // loads when the user starts an on-device build. Returns an engine with the
  // minimal, structured calls buildPlan needs.
  var WEBLLM_CDN = "https://esm.run/@mlc-ai/web-llm";
  // If model init makes no progress for this long, treat it as stuck and bail to
  // the deterministic staple plan. WebLLM can hang on some GPUs (e.g. Apple) with
  // an internal "Cannot pass non-string to std::string" while its load promise
  // never settles — the watchdog is the escape hatch.
  // These are "no progress for this long" windows, NOT total-time caps: a build
  // may legitimately run well over a minute as long as something is happening.
  // Download is alive while its % advances; generation is alive while tokens
  // stream. Only a genuine silence this long counts as stuck.
  var STALL_MS = 60000;
  // Once the model has loaded, generation must also keep communicating. WebLLM
  // can finish loading ("Finish loading on WebGPU - …") and then hang on the very
  // first generation on some GPUs (notably Apple) — emitting no tokens and never
  // settling. We stream the reply so each token is a heartbeat; if none arrives
  // for this long we interrupt and reject, so the caller can blocklist this model
  // and try the next one.
  var GEN_STALL_MS = 60000;

  // Preferred model bases, BIGGEST-capable-first. Tiny models choose foods
  // incoherently, so we pick the most capable model that fits the device's VRAM
  // budget and walk DOWN only as needed (selectModel + the runtime blocklist do
  // the degrading). Only clean general instruct chat models — deliberately NOT
  // the Coder/Math/Vision/Base variants or the R1 distills (those emit long
  // <think> traces that wreck our short JSON reply). Each base exists in both
  // q4f16_1 (needs shader-f16) and q4f32_1 (no shader-f16); VRAM figures below are
  // the f16 / f32 requirements from WebLLM's prebuiltAppConfig.
  var MODEL_PREFERENCE = [
    "Qwen2.5-7B-Instruct",    // 5107 / 5900 MB — best quality that still fits ~6 GB
    "Llama-3.1-8B-Instruct",  // 5001 / 6101 MB
    "Phi-3.5-mini-instruct",  // 3672 / 5483 MB (3.8B)
    "Qwen2.5-3B-Instruct",    // 2505 / 2894 MB
    "Llama-3.2-3B-Instruct",  // 2264 / 2952 MB
    "Qwen2.5-1.5B-Instruct",  // 1630 / 1889 MB
    "Llama-3.2-1B-Instruct",  //  879 / 1129 MB
    "Qwen2.5-0.5B-Instruct"   //  945 / 1060 MB — last resort
  ];

  // Detect what this device's WebGPU adapter actually supports. The decisive
  // signal is the `shader-f16` feature: q4f16 models REQUIRE it (Apple GPUs in
  // Chromium often lack it — the likely root of the std::string failure). Also
  // surface the storage-buffer limits so we never pick a model the GPU can't bind.
  function detectGpuCaps() {
    if (typeof navigator === "undefined" || !navigator.gpu) return Promise.resolve(null);
    return navigator.gpu.requestAdapter().then(function (adapter) {
      if (!adapter) return null;
      var feats = [];
      try { adapter.features.forEach(function (f) { feats.push(f); }); } catch (e) {}
      var lim = adapter.limits || {};
      var info = adapter.info || {};
      return {
        shaderF16: feats.indexOf("shader-f16") >= 0,
        features: feats,
        maxStorageBufferBindingSize: lim.maxStorageBufferBindingSize || 0,
        maxBufferSize: lim.maxBufferSize || 0,
        vendor: (info.vendor || "") + "", architecture: (info.architecture || "") + ""
      };
    }).catch(function () { return null; });
  }

  // Rough VRAM budget (MB). WebGPU exposes no VRAM figure, so use system memory as
  // a proxy (spec-capped at 8 GB) and a tight cap on mobile, where big models OOM
  // and crash the tab.
  function browserEnv() {
    var nav = typeof navigator !== "undefined" ? navigator : {};
    var ua = nav.userAgent || "";
    var isMobile = /Mobi|Android|iPhone|iPod/i.test(ua) || /iPad/i.test(ua) ||
                   (/Macintosh/.test(ua) && (nav.maxTouchPoints || 0) > 1);
    return { isMobile: isMobile, deviceMemory: nav.deviceMemory || 0 };
  }
  function computeBudgetMB(env) {
    env = env || {};
    if (env.isMobile) return 1300;
    // Desktop/laptop: be generous so the biggest coherent model is reachable
    // (~6 GB lets a 7B run in f16). navigator.deviceMemory is spec-capped at 8 and
    // unreported on Safari — assume capable (8) when unknown rather than blocking
    // big models; the load watchdog + model walk recover if we over-reach.
    var dm = env.deviceMemory || 8; // GB
    return Math.max(3000, Math.min(dm, 8) * 750);
  }

  // Pure, testable: choose the best model_id from WebLLM's prebuilt list for a
  // device's capabilities. Walks MODEL_PREFERENCE, trying f16 then f32 (or only
  // f32 without shader-f16), and applies the feature / buffer / VRAM / blocklist
  // gates. Returns null if nothing fits.
  function selectModel(modelList, caps, opts) {
    opts = opts || {}; caps = caps || {};
    var prefs = opts.preference || MODEL_PREFERENCE;
    var blocklist = opts.blocklist || [];
    var budget = opts.budgetMB || 0;
    var feats = caps.features || [];
    var quants = (caps.shaderF16 && !opts.preferF32) ? ["q4f16_1", "q4f32_1"] : ["q4f32_1"];
    var byId = {};
    (modelList || []).forEach(function (m) { byId[m.model_id] = m; });

    for (var i = 0; i < prefs.length; i++) {
      for (var j = 0; j < quants.length; j++) {
        var id = prefs[i] + "-" + quants[j] + "-MLC";
        var rec = byId[id];
        if (!rec || blocklist.indexOf(id) >= 0) continue;
        if (/q4f16/.test(id) && !caps.shaderF16) continue;             // f16 needs shader-f16
        if (rec.required_features && !rec.required_features.every(function (f) {
              return f === "shader-f16" ? caps.shaderF16 : feats.indexOf(f) >= 0;
            })) continue;
        if (rec.buffer_size_required_bytes) {                          // GPU must be able to bind it
          if (caps.maxStorageBufferBindingSize && rec.buffer_size_required_bytes > caps.maxStorageBufferBindingSize) continue;
          if (caps.maxBufferSize && rec.buffer_size_required_bytes > caps.maxBufferSize) continue;
        }
        if (budget && rec.vram_required_MB && rec.vram_required_MB > budget) continue;
        return id;
      }
    }
    return null;
  }

  function createWebLLMEngine(options) {
    options = options || {};
    var onProgress = options.onProgress || function () {};
    var chosenModel = null;
    // Overridable timeouts + a WebLLM injection seam, so the streaming/watchdog
    // logic is unit-testable in Node without the real CDN import or a GPU.
    var loadStallMs = options.stallMs || STALL_MS;
    var genStallMs = options.genStallMs || GEN_STALL_MS;
    var pollMs = options.pollMs || 2000;
    function importWebLLM() {
      if (options.webllm) return Promise.resolve(options.webllm);
      return import(/* webpackIgnore: true */ WEBLLM_CDN);
    }

    // Lazy: the heavy WebLLM code + model only download when a method is first
    // called (i.e. after the catalog has loaded), never on Path B / no-WebGPU.
    var loadP = null;
    function load() {
      if (loadP) return loadP;
      loadP = new Promise(function (resolve, reject) {
        var settled = false, lastTick = Date.now(), watch;
        function finish(ok, val) {
          if (settled) return;
          settled = true;
          clearInterval(watch);
          ok ? resolve(val) : reject(val);
        }
        watch = setInterval(function () {
          if (Date.now() - lastTick > loadStallMs) {
            finish(false, new Error("On-device AI stalled while loading the model on this device."));
          }
        }, pollMs);
        function progress(p) {
          lastTick = Date.now();
          onProgress("download", p && p.text ? p.text : ("Downloading model… " +
            Math.round((p && p.progress || 0) * 100) + "%"));
        }
        importWebLLM().then(function (webllm) {
          return detectGpuCaps().then(function (caps) {
            var budgetMB = computeBudgetMB(browserEnv());
            var list = webllm.prebuiltAppConfig && webllm.prebuiltAppConfig.model_list;
            var picked = options.model || selectModel(list, caps, {
              blocklist: options.blocklist || [], preferF32: options.preferF32, budgetMB: budgetMB
            });
            if (!picked) {
              throw new Error("No on-device model fits this device" +
                (caps && !caps.shaderF16 ? " (no shader-f16 support; tried 32-bit models)" : "") + ".");
            }
            chosenModel = picked;
            lastTick = Date.now();
            if (options.onPick) { try { options.onPick(picked, caps); } catch (e) {} }
            onProgress("download", "Preparing " + picked + "…");
            return webllm.CreateMLCEngine(picked, { initProgressCallback: progress });
          });
        }).then(function (engine) { finish(true, engine); },
                function (err) { finish(false, err); });
      });
      return loadP;
    }

    // Stream a chat completion with a no-token stall watchdog. We deliberately do
    // NOT pass response_format:{type:"json_object"}: the grammar-constrained path
    // is what hangs on some GPUs after load. Streaming gives a per-token heartbeat
    // so a truly stuck generation rejects (and is interrupted) instead of spinning
    // forever; callers parse JSON leniently from the returned text.
    function streamChat(engine, messages, opts) {
      opts = opts || {};
      var label = opts.label || "Working";
      return new Promise(function (resolve, reject) {
        var text = "", nTok = 0, settled = false, lastTok = Date.now(), watch;
        function finish(err) {
          if (settled) return;
          settled = true;
          clearInterval(watch);
          try { if (engine.interruptGenerate) engine.interruptGenerate(); } catch (e) {}
          err ? reject(err) : resolve(text);
        }
        watch = setInterval(function () {
          if (Date.now() - lastTok > genStallMs) {
            finish(new Error("On-device AI produced no output (stalled after loading)."));
          }
        }, pollMs);
        Promise.resolve().then(function () {
          return engine.chat.completions.create({
            messages: messages,
            temperature: opts.temperature == null ? 0.4 : opts.temperature,
            max_tokens: opts.max_tokens || 600,
            stream: true
          });
        }).then(function (stream) {
          var it = stream[Symbol.asyncIterator] ? stream[Symbol.asyncIterator]() : stream;
          (function pump() {
            it.next().then(function (res) {
              if (settled) return;
              if (res.done) { finish(null); return; }
              lastTok = Date.now();
              var d = res.value && res.value.choices && res.value.choices[0] && res.value.choices[0].delta;
              if (d && d.content) {
                text += d.content; nTok++;
                onProgress("generate", label + "… (" + nTok + " tokens)");
              }
              pump();
            }, finish);
          })();
        }, finish);
      });
    }

    // Lenient JSON: small models often wrap the object in prose or a code fence,
    // so fall back to the first {...} span before giving up.
    function parseLooseJSON(txt) {
      if (!txt) return {};
      try { return JSON.parse(txt); } catch (e) {}
      var a = txt.indexOf("{"), b = txt.lastIndexOf("}");
      if (a >= 0 && b > a) { try { return JSON.parse(txt.slice(a, b + 1)); } catch (e) {} }
      return {};
    }

    function chatJSON(system, user, label, maxTokens) {
      return load().then(function (engine) {
        return streamChat(engine, [
          { role: "system", content: system },
          { role: "user", content: user }
        ], { temperature: 0.4, max_tokens: maxTokens || 600, label: label }).then(parseLooseJSON);
      });
    }

    return {
      // Design balanced meals (which foods go in each meal), honouring the user's
      // breakfast style and dietary restrictions. The model only names foods per
      // meal — the solver sizes portions afterwards.
      suggestMeals: function (ctx) {
        var t = (ctx.dayTargets && ctx.dayTargets[0]) || {};
        var names = (ctx.mealNames && ctx.mealNames.length) ? ctx.mealNames : [];
        var n = ctx.mealsPerDay || names.length || 3;
        var sys = "You are a chef and nutritionist designing ONE day of meals from real, " +
          "locally available whole foods. Design EXACTLY " + n + " meals" +
          (names.length ? " named: " + names.join(", ") : "") + ". Rules: " +
          "(1) EVERY meal must be a complete, balanced plate — a protein source, at least one " +
          "vegetable or fruit, a slow/whole-food carbohydrate, and a healthy fat. NEVER a single " +
          "ingredient or a lone nibble (no meal that is just 'almonds'). A snack may be smaller but " +
          "still combines 2–3 foods. (2) Maximise MICRONUTRIENT density and health: lean on leafy " +
          "greens, colourful vegetables, legumes, whole grains, fish, eggs and dairy, and VARY the " +
          "foods across meals for broad vitamin/mineral coverage. (3) Make each meal a coherent dish — " +
          "foods that genuinely go together. (4) Respect dietary restrictions strictly. (5) Use 3–5 " +
          "whole-food ingredients per meal. (6) You ONLY name foods — no amounts, no numbers, no " +
          "arithmetic (portions are computed separately). " +
          "Output ONLY JSON, no prose or code fences: " +
          "{\"meals\":[{\"name\":\"" + (names[0] || "Breakfast") + "\",\"foods\":[\"food\",\"food\",\"food\"]}, …]}";
        var usr = "Country: " + (ctx.country || "unknown") + "\n" +
          "Breakfast style: " + (ctx.breakfast || "no preference") + "\n" +
          "Dietary restrictions / allergies (strict): " + (ctx.prefs || "none") + "\n" +
          "Meals to design: " + (names.length ? names.join(", ") : (n + " meals")) + "\n" +
          "The whole day must be high in protein (~" + Math.round(t.protein || 0) +
          " g) and fibre (≥ " + Math.round(t.fiber || 35) +
          " g), so spread enough protein- and fibre-rich foods across the meals.";
        return chatJSON(sys, usr, "The model is designing your meals", 1000).then(function (o) {
          var meals = Array.isArray(o.meals) ? o.meals : [];
          return { meals: meals.map(function (m) {
            return { name: (m && m.name) || "", foods: (m && Array.isArray(m.foods)) ? m.foods : [] };
          }) };
        });
      },
      suggestFoods: function (ctx) {
        var t = (ctx.dayTargets && ctx.dayTargets[0]) || {};
        var sys = "You are a nutritionist choosing real, locally available whole foods. " +
          "Respect the user's dietary preferences strictly. You DO NOT do any arithmetic — " +
          "only name foods. Output ONLY a JSON object, no prose or code fences: " +
          "{\"foods\": [\"food name\", ...]} with 10–16 foods " +
          "spanning protein, healthy fats, slow carbs and high-fibre items.";
        var usr = "Country: " + (ctx.country || "unknown") + "\n" +
          "Dietary preferences/restrictions: " + (ctx.prefs || "none") + "\n" +
          "Per-day targets: ~" + Math.round(t.kcal || 0) + " kcal, " +
          Math.round(t.protein || 0) + " g protein, " + Math.round(t.fat || 0) +
          " g fat, " + Math.round(t.carbs || 0) + " g carbs, fibre ≥ " +
          Math.round(t.fiber || 35) + " g.\nMeals per day: " + (ctx.mealsPerDay || 3) +
          ".\nName foods only — portions are computed separately.";
        return chatJSON(sys, usr, "The model is choosing foods").then(function (o) {
          return Array.isArray(o.foods) ? o.foods.filter(function (x) { return typeof x === "string"; }) : [];
        });
      },
      summarize: function (meta) {
        var sys = "Write ONE warm, concrete sentence (max 30 words) summarising a meal plan. No numbers needed.";
        var usr = "Country: " + (meta.country || "") + ". Preferences: " + (meta.prefs || "none") +
          ". Day types: " + (meta.dayTargets || []).map(function (d) { return d.label; }).join(", ") + ".";
        return load().then(function (engine) {
          return streamChat(engine, [
            { role: "system", content: sys }, { role: "user", content: usr }
          ], { temperature: 0.6, max_tokens: 80, label: "Writing your plan summary" }).then(function (txt) {
            return (txt || "").trim();
          });
        }).catch(function () { return ""; });
      },
      warm: function () { return load().then(function () { return true; }); },
      getModel: function () { return chosenModel; },
      dispose: function () { return load().then(function (e) { return e.unload && e.unload(); }).catch(function(){}); }
    };
  }

  var api = {
    buildPlan: buildPlan,
    createWebLLMEngine: createWebLLMEngine,
    selectModel: selectModel,
    detectGpuCaps: detectGpuCaps,
    computeBudgetMB: computeBudgetMB,
    browserEnv: browserEnv,
    MODEL_PREFERENCE: MODEL_PREFERENCE,
    browserBrotli: browserBrotli,
    DEFAULT_STAPLES: DEFAULT_STAPLES,
    macroRow: macroRow,
    splitIntoMeals: splitIntoMeals,
    gatherFoods: gatherFoods
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.YdinPlanner = api;
})(typeof self !== "undefined" ? self : this);

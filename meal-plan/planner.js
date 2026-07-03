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

  // ---- reliability helpers: fan-out + voting ------------------------------
  // Run fn(i) n times SEQUENTIALLY (a single WebLLM engine serves one generation
  // at a time, so parallel calls would just queue or clash) and collect the
  // fulfilled results. Individual rejections are skipped — one flaky small-model
  // call shouldn't sink the whole vote — so the result may be shorter than n, and
  // empty only if EVERY attempt failed (which the caller can treat as a real
  // failure). Locally tokens are free, so asking K times is the cheapest
  // reliability we have.
  function repeatSeq(n, fn) {
    var out = [], p = Promise.resolve();
    for (var i = 0; i < Math.max(1, n | 0); i++) {
      (function (idx) {
        p = p.then(function () {
          return Promise.resolve(fn(idx)).then(
            function (r) { out.push(r); }, function () {});
        });
      })(i);
    }
    return p.then(function () { return out; });
  }

  // Consensus over several runs of the same food-naming prompt. A small model is
  // phrasing- and seed-sensitive; the SAME food named by most runs is real, while
  // one-off names are usually noise/hallucination. Foods named by >= threshold of
  // the runs win, kept in first-seen order; if that leaves fewer than opts.min,
  // backfill with the next most-agreed names so a meal is never starved. Grouping
  // is case/space-insensitive; the most common spelling of each winner is returned.
  function voteFoods(lists, opts) {
    opts = opts || {};
    lists = (lists || []).filter(function (l) { return Array.isArray(l); });
    var k = lists.length || 1;
    var threshold = opts.threshold || Math.ceil(k / 2);
    var min = opts.min || 0;
    function keyOf(s) { return String(s == null ? "" : s).trim().toLowerCase().replace(/\s+/g, " "); }
    var info = {}, order = [];
    lists.forEach(function (list) {
      var seenThisRun = {};
      (list || []).forEach(function (name) {
        if (typeof name !== "string" || !name.trim()) return;
        var key = keyOf(name); if (!key) return;
        if (!info[key]) { info[key] = { count: 0, spellings: {}, first: order.length }; order.push(key); }
        var sp = name.trim();
        info[key].spellings[sp] = (info[key].spellings[sp] || 0) + 1;
        if (!seenThisRun[key]) { seenThisRun[key] = 1; info[key].count++; } // one run = one vote
      });
    });
    function bestSpelling(key) {
      var sp = info[key].spellings, best = key, bn = -1;
      Object.keys(sp).forEach(function (s) { if (sp[s] > bn) { bn = sp[s]; best = s; } });
      return best;
    }
    var winners = order.filter(function (key) { return info[key].count >= threshold; });
    if (winners.length < min) {
      var have = {}; winners.forEach(function (w) { have[w] = 1; });
      order.filter(function (key) { return !have[key]; })
        .sort(function (a, b) { return info[b].count - info[a].count || info[a].first - info[b].first; })
        .slice(0, min - winners.length)
        .forEach(function (key) { winners.push(key); });
    }
    winners.sort(function (a, b) { return info[a].first - info[b].first; });
    return winners.map(bestSpelling);
  }

  // First catalog hit across a list of candidate queries — used so a food can be
  // searched under several names (e.g. English + local-language translations)
  // and matched to a real product under whichever spelling the catalog uses.
  function bestHit(catalog, queries) {
    for (var i = 0; i < (queries || []).length; i++) {
      var q = queries[i];
      if (typeof q !== "string" || !q.trim()) continue;
      var hit = FL.searchFoods(catalog, q, 1)[0];
      if (hit && hit.code) return hit;
    }
    return null;
  }

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

  // A product-shaped object built from the catalog line's own macros, used as the
  // displayed nutrition when a real product fetch is missing or macro-less. The
  // solver already falls back to catalog macros (macroRow), but buildMealTotals —
  // which produces the per-item kcal SHOWN to the user — reads products[code]
  // only, so without this a food whose fetch failed renders at 0 kcal even though
  // the catalog knows its macros. Flagged ai_guesses so the UI marks it estimated.
  function catalogProduct(rec) {
    if (!rec) return null;
    var kcal = rec.kcalEst != null ? num(rec.kcalEst)
             : Math.round(4 * num(rec.protein) + 4 * num(rec.carbs) + 9 * num(rec.fat));
    return {
      product_name: rec.name || rec.code,
      breakdown: { macros: {
        energy_kcal: kcal, proteins: num(rec.protein),
        fat: num(rec.fat), carbohydrates: num(rec.carbs), fiber: num(rec.fiber)
      } },
      ai_guesses: true
    };
  }
  function hasMacros(m) { return !!m && num(m.proteins) + num(m.fat) + num(m.carbohydrates) > 0.5; }

  // Guarantee products[rec.code] carries usable macros: keep a real fetched product
  // when it has them, otherwise back it with the catalog line. Leaves the entry
  // missing only when neither source has macros (so the food gets filtered out).
  function ensureProduct(products, rec) {
    if (!rec || !rec.code) return;
    var p = products[rec.code];
    if (hasMacros(p && p.breakdown && p.breakdown.macros)) return;
    var cp = catalogProduct(rec);
    if (cp && hasMacros(cp.breakdown.macros)) products[rec.code] = cp;
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

  // Per-meal prompt guidance: what THIS meal is, what a single such meal looks
  // like, and how to compose it. Drives the dedicated per-meal design prompt so
  // breakfast reads like breakfast and a snack stays a snack.
  function mealGuidance(name, breakfast) {
    var n = (name || "").toLowerCase();
    if (/break|morning/.test(n)) return {
      isBreakfast: true, kind: "breakfast", count: "3–5",
      desc: "A breakfast to start the day" + (breakfast ? " (" + breakfast + " style)" : "") + ".",
      compose: "a protein, a slow/whole-grain carbohydrate, some fruit or vegetables, and a healthy " +
               "fat (e.g. eggs + oats + berries + nuts, or yoghurt + fruit + seeds, or beans + eggs + greens)"
    };
    if (/snack/.test(n)) return {
      isBreakfast: false, kind: "snack", count: "2–3",
      desc: "A light snack between meals — smaller than a main meal.",
      compose: "2–3 foods that pair well, carrying some protein or fibre (e.g. fruit + nuts, " +
               "yoghurt + seeds, or vegetable sticks + hummus)"
    };
    return {
      isBreakfast: false, kind: "main meal", count: "3–5",
      desc: "A main meal — a full, balanced plate.",
      compose: "a protein source, plenty of vegetables, a whole-food carbohydrate, and a healthy fat " +
               "(e.g. fish + rice + greens + olive oil, or chicken + potatoes + salad, or lentils + grains + vegetables)"
    };
  }

  // A model macro guess is per-100 g; clamp it to sane ranges and reconcile kcal
  // with Atwater so a hallucinated number can't poison the solver. Returns null
  // when there's nothing usable.
  function sanitizeGuess(g) {
    if (!g) return null;
    function clamp(x, hi) { x = num(x); return x < 0 ? 0 : (x > hi ? hi : x); }
    var p = clamp(g.protein, 100), f = clamp(g.fat, 100), c = clamp(g.carbs, 100), fib = clamp(g.fiber, 80);
    if (p + f + c < 0.5) return null;
    var atwater = 4 * p + 4 * c + 9 * f, kcal = num(g.kcal);
    if (!(kcal > 0) || Math.abs(kcal - atwater) > 0.5 * atwater + 50) kcal = atwater;
    return { protein: p, fat: f, carbs: c, fiber: fib, kcal: Math.round(kcal) };
  }
  function aiCode(name) {
    return "ai:" + String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
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

  // ---- human portion realism ----------------------------------------------
  // A person doesn't eat 7 g of egg. Some foods only come in whole/part PIECES;
  // `grams` is one piece and `step` is the smallest sensible fraction of it
  // (¼ egg, ½ banana, whole slice). Matched by name (English + common Finnish).
  // Everything else is "bulk" — eaten by weight and snapped to a gram step.
  var PIECE_FOODS = [
    { re: /\b(egg|eggs|muna|munat|kananmuna|kananmunat)\b/i, grams: 50,  step: 0.25, one: "egg",   many: "eggs" },
    { re: /\b(banana|bananas|banaani|banaanit)\b/i,         grams: 120, step: 0.5,  one: "banana", many: "bananas" },
    { re: /\b(apple|omena|orange|appelsiini|pear|päärynä|paaryna|peach|persikka|kiwi|kiivi)\b/i,
                                                            grams: 150, step: 0.5,  one: "piece",  many: "pieces" },
    { re: /\b(bread|toast|leipä|leipa|ruisleipä|ruisleipa|näkkileipä|nakkileipa|crispbread|slice|viipale)\b/i,
                                                            grams: 35,  step: 0.5,  one: "slice",  many: "slices" },
    { re: /\b(tortilla|wrap|pita|rieska)\b/i,               grams: 60,  step: 1,    one: "wrap",   many: "wraps" },
    { re: /\b(rice ?cake|riisikakku)\b/i,                   grams: 9,   step: 1,    one: "cake",   many: "cakes" }
  ];
  var BULK_STEP = 5;   // round bulk foods to the nearest 5 g …
  var BULK_MIN = 10;   // … and drop a bulk food under 10 g (a sliver no one weighs)

  function pieceInfo(name) {
    var n = String(name || "");
    for (var i = 0; i < PIECE_FOODS.length; i++) if (PIECE_FOODS[i].re.test(n)) return PIECE_FOODS[i];
    return null;
  }
  var FRAC_GLYPH = { "0.25": "¼", "0.5": "½", "0.75": "¾" };
  // "1 egg", "2 eggs", "½ banana", "1½ slices" — a count a human can actually serve.
  function pieceAmount(pieces, info) {
    var whole = Math.floor(pieces + 1e-9);
    var frac = Math.round((pieces - whole) * 100) / 100;
    var glyph = FRAC_GLYPH[String(frac)] || "";
    var qty = whole > 0 ? (whole + glyph) : (glyph || "0");
    var plural = pieces > 1 + 1e-9;
    return qty + " " + (plural ? info.many : info.one);
  }
  // Snap continuous grams to a valid piece count (≥ one step, else drop).
  function snapPiece(info, grams) {
    var pieces = Math.round((num(grams) / info.grams) / info.step) * info.step;
    pieces = Math.round(pieces * 100) / 100;
    if (pieces < info.step - 1e-9) return { drop: true, pieces: 0, grams: 0 };
    return { drop: false, pieces: pieces, grams: pieces * info.grams };
  }
  // Snap continuous grams to the bulk step (drop a sub-minimum sliver).
  function snapBulk(grams) {
    var g = Math.round(num(grams) / BULK_STEP) * BULK_STEP;
    if (g < BULK_MIN) return { drop: true, grams: 0 };
    return { drop: false, grams: g };
  }
  // Split a bulk food's day grams across the meals it belongs to, EXACTLY (shares
  // sum to the day total). `weights` (optional, per meal index) tilts the split so
  // the user's calorie distribution is honoured — a dinner-heavy day sends more of
  // each shared food to the evening meal. Small totals concentrate into the
  // heaviest meal instead of smearing into slivers; that meal absorbs the remainder.
  function distributeBulk(total, meals, weights) {
    var out = {};
    if (meals.length <= 1) { out[meals[0] != null ? meals[0] : 0] = total; return out; }
    var ws = meals.map(function (mi) { var w = weights && weights[mi]; return w > 0 ? w : 1; });
    var wsum = ws.reduce(function (a, b) { return a + b; }, 0) || meals.length;
    var heavy = meals[0], hb = -Infinity;
    meals.forEach(function (mi, k) { if (ws[k] > hb) { hb = ws[k]; heavy = mi; } });
    var sum = 0;
    meals.forEach(function (mi, k) {
      var g = Math.floor((total * ws[k] / wsum) / BULK_STEP) * BULK_STEP;
      if (g >= BULK_MIN) { out[mi] = g; sum += g; }
    });
    out[heavy] = (out[heavy] || 0) + (total - sum); // heaviest meal absorbs remainder + dropped shares
    return out;
  }
  function emptyTotals() { return { kcal: 0, protein: 0, fat: 0, carbs: 0, fiber: 0 }; }

  // ---- reasoning step: how is each food actually portioned? ----------------
  // The hardcoded PIECE_FOODS list only knows a handful of foods. A model can
  // REASON about the rest: is this bought loose / in a package you weigh any
  // amount from (rice, oil, yoghurt, mince → "bulk"), or is it a whole item you
  // use whole or in simple fractions (egg in a shell, banana, a can, a sausage →
  // "unit")? engine.classifyFoods returns that judgement; the code below turns it
  // into the same portion descriptor snapPiece/distribute already understand, with
  // guardrails so a hallucinated "unit" on an obviously-bulk food is vetoed.
  var ALLOWED_FRACTIONS = [0.25, 0.5, 1];
  function snapFraction(x) {
    x = num(x); if (!(x > 0)) return 1;
    var best = 1, bd = Infinity;
    ALLOWED_FRACTIONS.forEach(function (a) { var d = Math.abs(a - x); if (d < bd) { bd = d; best = a; } });
    return best;
  }
  function pluralizeNoun(w) {
    w = String(w || "piece").trim() || "piece";
    return /(s|x|ch|sh)$/i.test(w) ? w + "es" : w + "s";
  }
  // Sold loose / weighed from a package — never a whole "unit", whatever the model says.
  var OBVIOUS_BULK = /\b(oil|butter|margarine|flour|sugar|honey|syrup|jam|rice|pasta|noodles?|oats?|porridge|milk|cream|yog[hu]?[u]?rt|quark|mince|minced|ground|sauce|paste|powder|spread|hummus|nut butter|peanut butter|seeds?|couscous|quinoa|bulgur|granola|muesli|cheese)\b/i;
  // Turn one classification into a piece descriptor, or null (⇒ bulk). Clamps a
  // wild unit weight, snaps the fraction to ¼/½/whole, and vetoes obvious bulk.
  function classToDescriptor(c, name) {
    if (!c || c.kind !== "unit" || OBVIOUS_BULK.test(name)) return null;
    var grams = num(c.unitGrams);
    if (!(grams >= 5 && grams <= 600)) { var pi = pieceInfo(name); grams = pi ? pi.grams : 0; }
    if (!(grams > 0)) return null; // no sane unit weight → treat as bulk
    var pj = pieceInfo(name);
    var unit = (typeof c.unit === "string" && c.unit.trim()) ? c.unit.trim().toLowerCase() : (pj ? pj.one : "piece");
    return { grams: grams, step: snapFraction(c.minFraction), one: unit, many: pluralizeNoun(unit) };
  }
  // Map a classifyFoods result onto codes: [{code,name}] -> { code -> descriptor }
  // (only PIECE/unit foods get an entry; bulk foods are simply absent).
  function buildPortionClass(classifications, foodsList) {
    var arr = (classifications && classifications.foods) || [];
    function pick(nm, i) {
      var low = String(nm).toLowerCase();
      for (var k = 0; k < arr.length; k++) {
        var an = arr[k] && arr[k].name ? String(arr[k].name).toLowerCase() : "";
        if (an && (an === low || an.indexOf(low) >= 0 || low.indexOf(an) >= 0)) return arr[k];
      }
      return arr[i];
    }
    var out = {};
    (foodsList || []).forEach(function (f, i) {
      var d = classToDescriptor(pick(f.name, i), f.name);
      if (d) out[f.code] = d;
    });
    return out;
  }

  // Run fn over each item SEQUENTIALLY (one engine, one generation at a time),
  // collecting results in order; an individual failure resolves to `onErr`.
  function seqMap(items, fn, onErr) {
    var out = [], p = Promise.resolve();
    (items || []).forEach(function (x, i) {
      p = p.then(function () {
        return Promise.resolve(fn(x, i)).then(function (r) { out.push(r); },
          function () { out.push(typeof onErr === "function" ? onErr(x, i) : onErr); });
      });
    });
    return p.then(function () { return out; });
  }

  // ---- calorie distribution across meals ----------------------------------
  // The user chooses how the day's calories lean; we turn that into a normalized
  // weight per meal (snacks always lighter) that drives BOTH the per-meal design
  // targets (so the model designs a bigger dinner) and how shared foods distribute.
  var CALORIE_SPLITS = [
    { id: "even",      label: "Evenly across the day",         hint: "Balanced meals" },
    { id: "breakfast", label: "Front-load the morning",        hint: "Bigger breakfast, lighter evening" },
    { id: "lunch",     label: "Biggest meal at midday",        hint: "Lunch is the main meal" },
    { id: "dinner",    label: "Save calories for the evening", hint: "Lighter day, bigger dinner" }
  ];
  function calorieSplitLabel(id) {
    for (var i = 0; i < CALORIE_SPLITS.length; i++) if (CALORIE_SPLITS[i].id === id) return CALORIE_SPLITS[i].label;
    return CALORIE_SPLITS[0].label;
  }
  // Normalized per-meal weight for a split choice. Snacks are always ~half a main;
  // main meals tilt along the day (dinner ramps up toward evening, breakfast down,
  // lunch peaks in the middle). "even" (or unknown) leaves mains equal.
  function calorieWeights(choice, mealNames) {
    var names = mealNames || [];
    var mains = [];
    names.forEach(function (nm, i) { if (!/snack/i.test(nm)) mains.push(i); });
    var w = names.map(function (nm) { return /snack/i.test(nm) ? 0.5 : 1; });
    var n = mains.length;
    if (n >= 2 && choice && choice !== "even") {
      mains.forEach(function (idx, k) {
        var t = n > 1 ? k / (n - 1) : 0.5; // 0 = first main … 1 = last main
        var f = 1;
        if (choice === "dinner") f = 0.7 + 0.8 * t;
        else if (choice === "breakfast") f = 1.5 - 0.8 * t;
        else if (choice === "lunch") f = 1.5 - 1.6 * Math.abs(t - 0.5);
        w[idx] = f;
      });
    }
    var sum = w.reduce(function (a, b) { return a + b; }, 0) || 1;
    return w.map(function (x) { return x / sum; });
  }

  // ---- ask-the-user questions (always options, never free text) ------------
  // A question is { id, prompt, options:[{id,label,hint}] }. sanitizeQuestion is
  // the deterministic gate that GUARANTEES the "options only, no typing" rule the
  // UI relies on: it drops any question without ≥2 clean option choices and keeps
  // only fields the UI renders. Used both for the fallback and to validate
  // whatever the model proposes.
  function sanitizeQuestion(q) {
    if (!q || typeof q !== "object") return null;
    var prompt = typeof q.prompt === "string" ? q.prompt.trim() : "";
    if (!prompt) return null;
    var seen = {}, options = [];
    (Array.isArray(q.options) ? q.options : []).forEach(function (o) {
      var label = o && typeof o.label === "string" ? o.label.trim() : "";
      var id = o && typeof o.id === "string" && o.id.trim() ? o.id.trim()
             : label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      if (!label || !id || seen[id]) return;
      seen[id] = 1;
      options.push({ id: id, label: label, hint: (o && typeof o.hint === "string") ? o.hint.trim() : "" });
    });
    if (options.length < 2) return null; // no real choice → not askable at all
    return { id: (typeof q.id === "string" && q.id.trim()) || "q", prompt: prompt, options: options.slice(0, 6) };
  }
  // The always-available, deterministic calorie-distribution question.
  function buildCalorieSplitQuestion() {
    return sanitizeQuestion({
      id: "calorie-split",
      prompt: "How would you like your calories spread across the day?",
      options: CALORIE_SPLITS.map(function (s) { return { id: s.id, label: s.label, hint: s.hint }; })
    });
  }
  // Turn an answered question into a patch to merge into buildPlan opts (so the
  // plan is rebuilt to the choice — the whole diet is reshaped before we re-solve).
  function answerToBuildOpts(questionId, optionId) {
    if (questionId === "calorie-split") return { calorieSplit: optionId };
    return {};
  }
  // Decide which options-only questions to circle back and ask. Tries the model
  // (proposeQuestions), sanitizes each candidate, then — if the engine offers one
  // — runs each through the model's own question critic (critiqueQuestion) before
  // it's ever shown. The deterministic calorie-split question is ALWAYS offered so
  // the feature works offline / on iOS / when the model declines.
  function planQuestions(engine, ctx) {
    ctx = ctx || {};
    var fallback = [buildCalorieSplitQuestion()];
    if (!engine || !engine.proposeQuestions) return Promise.resolve(fallback);
    return Promise.resolve(engine.proposeQuestions(ctx)).then(function (res) {
      var cleaned = ((res && res.questions) || []).map(sanitizeQuestion).filter(Boolean);
      if (!cleaned.length) return fallback;
      if (!engine.critiqueQuestion) return withFallback(cleaned, fallback);
      return seqMap(cleaned, function (q) {
        return Promise.resolve(engine.critiqueQuestion({ question: q }))
          .then(function (v) { return (v && v.ok !== false) ? q : null; },
                function () { return q; }); // critic failed → keep the sanitized question
      }, null).then(function (kept) { return withFallback(kept.filter(Boolean), fallback); });
    }, function () { return fallback; });
  }
  function withFallback(questions, fallback) {
    var ids = {}; questions.forEach(function (q) { ids[q.id] = 1; });
    fallback.forEach(function (q) { if (!ids[q.id]) questions.push(q); });
    return questions.length ? questions : fallback;
  }

  // Build a real, USABLE day from a model-designed layout. Unlike an even
  // per-meal split (which forces every meal to carry a sliver of each food just
  // to balance on its own — the source of "7 g of egg"), this balances at the
  // DAY level, then snaps foods to human portions and distributes them across
  // meals unevenly: piece foods (eggs, fruit, bread) move in whole/part units and
  // live in ONE meal; bulk foods flex around them. `mealCodes[mi]` is the codes
  // the model put in meal mi. Returns { meals, totals, estimated, unmet, gramsByCode }.
  function assembleLayoutDay(dayTarget, names, mealCodes, products, catalog, recsByCode, repairRounds, prefs, portionClass, mealWeights) {
    var unmet = [], estimated = false;
    function nameOf(c) { return (products[c] && products[c].product_name) || (recsByCode[c] && recsByCode[c].name) || c; }
    function fiberOf(c) { return (recsByCode[c] && num(recsByCode[c].fiber)) || 0; }
    // The model's reasoning wins; the hardcoded regex is the fallback prior.
    function pieceFor(c) { return (portionClass && portionClass[c]) || pieceInfo(nameOf(c)); }
    function foodsFor(codes) { return codes.map(function (c) { return macroRow(recsByCode[c], products[c]); }); }

    // Which meal a repair-added food should live in: the first non-snack meal.
    var mainMeal = 0;
    for (var mm = 0; mm < names.length; mm++) { if (!/snack/i.test(names[mm])) { mainMeal = mm; break; } }

    // 1) Union of usable foods for the day + which meal(s) each was placed in.
    var mealsByCode = {}, order = [];
    names.forEach(function (nm, mi) {
      (mealCodes[mi] || []).forEach(function (c) {
        var f = macroRow(recsByCode[c], products[c]);
        if (num(f.protein) + num(f.fat) + num(f.carbs) <= 0.5) return; // no macros → skip
        if (!mealsByCode[c]) { mealsByCode[c] = []; order.push(c); }
        if (mealsByCode[c].indexOf(mi) < 0) mealsByCode[c].push(mi);
      });
    });
    if (!order.length) return { meals: [], totals: emptyTotals(), estimated: false, unmet: unmet, gramsByCode: {} };

    // Add diet-appropriate foods for any failed constraint; assign them to the
    // main meal. Mutates `list` (+ recsByCode/products/mealsByCode). Returns added?.
    function addRepair(failed, list) {
      var added = false;
      failed.forEach(function (fc) {
        var q = repairQueries(fc.constraint, prefs); if (!q.length) return;
        var extra = gatherFoods(catalog, q).filter(function (rec) { return list.indexOf(rec.code) < 0; });
        extra.forEach(function (rec) {
          list.push(rec.code);
          if (!recsByCode[rec.code]) recsByCode[rec.code] = rec;
          ensureProduct(products, rec); // repair foods are never fetched — back them with catalog macros
          if (!mealsByCode[rec.code]) mealsByCode[rec.code] = [mainMeal];
        });
        if (extra.length) added = true;
      });
      return added;
    }

    // 2) Solve the whole DAY (continuous grams), repairing short macros.
    var res = SOLVER.solvePortions(dayTarget, foodsFor(order));
    for (var r = 0; r < repairRounds && !res.ok; r++) {
      if (!addRepair(res.failed, order)) break;
      res = SOLVER.solvePortions(dayTarget, foodsFor(order));
    }
    var rawGrams = {};
    order.forEach(function (c, i) { rawGrams[c] = res.grams[i]; });

    // 3) Portion realism. Snap PIECE foods to whole/part units and FIX them; then
    // re-solve the BULK foods for the macros that remain, and snap those to a gram
    // step. Eggs move in units and the rest of the day flexes around them.
    var pieceCodes = order.filter(function (c) { return pieceFor(c); });
    var bulkCodes = order.filter(function (c) { return !pieceFor(c); });

    var dayGrams = {}, dayPieces = {};
    pieceCodes.forEach(function (c) {
      var s = snapPiece(pieceFor(c), rawGrams[c]);
      if (s.drop) { delete mealsByCode[c]; return; }
      dayGrams[c] = s.grams; dayPieces[c] = s.pieces;
    });

    var fixedCodes = Object.keys(dayGrams);
    var contrib = SOLVER.mealTotals(foodsFor(fixedCodes), fixedCodes.map(function (c) { return dayGrams[c]; }));
    var residual = {
      kcal: Math.max(0, num(dayTarget.kcal) - contrib.kcal),
      protein: Math.max(0, num(dayTarget.protein) - contrib.protein),
      fat: Math.max(0, num(dayTarget.fat) - contrib.fat),
      carbs: Math.max(0, num(dayTarget.carbs) - contrib.carbs),
      fiber: Math.max(0, num(dayTarget.fiber) - contrib.fiber)
    };
    var bres = SOLVER.solvePortions(residual, foodsFor(bulkCodes));
    for (var rb = 0; rb < repairRounds && !bres.ok; rb++) {
      if (!addRepair(bres.failed, bulkCodes)) break;
      bres = SOLVER.solvePortions(residual, foodsFor(bulkCodes));
    }
    bulkCodes.forEach(function (c, i) {
      var s = snapBulk(bres.grams[i]);
      if (s.drop) { delete mealsByCode[c]; return; }
      dayGrams[c] = s.grams;
    });

    // 4) Distribute each snapped day total across the meals it belongs to. Piece
    // foods go whole into ONE meal (their first placement) — 2 eggs at breakfast,
    // not ½ an egg in four meals; bulk foods split across their meals.
    var perMeal = names.map(function () { return {}; }); // mi -> code -> grams
    var gramsByCode = {};
    Object.keys(dayGrams).forEach(function (c) {
      var meals = (mealsByCode[c] || []); if (!meals.length) meals = [mainMeal];
      var alloc;
      if (pieceFor(c)) { alloc = {}; alloc[meals[0]] = dayGrams[c]; } // pieces stay meal-appropriate
      else alloc = distributeBulk(dayGrams[c], meals, mealWeights);   // bulk tilts by the calorie split
      Object.keys(alloc).forEach(function (mi) {
        var g = alloc[mi]; if (!(g > 0)) return;
        perMeal[mi][c] = (perMeal[mi][c] || 0) + g;
        gramsByCode[c] = (gramsByCode[c] || 0) + g;
      });
    });

    // 5) Build each meal's items (with human amounts) and totals; drop empty meals.
    var outMeals = [];
    names.forEach(function (nm, mi) {
      var codes = Object.keys(perMeal[mi]); if (!codes.length) return;
      var items = [];
      codes.forEach(function (c) {
        var g = perMeal[mi][c], info = pieceFor(c);
        var amount = info ? pieceAmount(Math.round((g / info.grams) / info.step) * info.step, info) : (Math.round(g) + " g");
        var t = FL.buildMealTotals([{ code: c, grams: g, fiber100: fiberOf(c) }], products);
        if (t.estimated) estimated = true;
        items.push({
          food: nameOf(c), amount: amount,
          kcal: Math.round(t.totals.kcal), protein: round(t.totals.protein),
          fat: round(t.totals.fat), carbs: round(t.totals.carbs), fiber: round(t.totals.fiber)
        });
      });
      var mt = items.reduce(function (a, it) {
        a.kcal += it.kcal; a.protein += it.protein; a.fat += it.fat; a.carbs += it.carbs; a.fiber += it.fiber; return a;
      }, emptyTotals());
      outMeals.push({ name: nm, items: items, totals: {
        kcal: Math.round(mt.kcal), protein: round(mt.protein), fat: round(mt.fat), carbs: round(mt.carbs), fiber: round(mt.fiber)
      } });
    });

    // 6) Day totals from the final (snapped, distributed) grams, then verify —
    // report honestly if snapping to real portions left a macro out of range.
    var dayItems = Object.keys(gramsByCode).map(function (c) {
      return { code: c, grams: gramsByCode[c], fiber100: fiberOf(c) };
    });
    var dayTot = FL.buildMealTotals(dayItems, products);
    var totals = { kcal: dayTot.totals.kcal, protein: dayTot.totals.protein, fat: dayTot.totals.fat,
                   carbs: dayTot.totals.carbs, fiber: dayTot.totals.fiber };
    var failed = SOLVER.verify(totals, dayTarget);
    if (failed.length) {
      unmet.push((dayTarget.label || "a day") + ": " +
        failed.map(function (fc) { return fc.constraint + " " + fc.actual + "/" + fc.target; }).join(", "));
    }
    return { meals: outMeals, totals: totals, estimated: estimated || dayTot.estimated,
             unmet: unmet, gramsByCode: gramsByCode };
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
      // can blocklist that model and try the next. designMeal builds the day ONE
      // meal at a time (each its own prompt); suggestFoods is the older flat-list
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
      if (opts.engine && opts.engine.designMeal) {
        // Per-meal design: one dedicated model call PER meal (stateless — each gets
        // a fresh context, so we never hit the model's limit). Each call is told
        // what that meal is, its share of the day's macros, and which foods earlier
        // meals already used (for variety). Foods are matched to the catalog; any
        // the catalog lacks are queued for ONE batched AI macro guess afterwards,
        // so the model can name real local dishes we don't stock.
        var t0 = (opts.dayTargets && opts.dayTargets[0]) || {};
        // Per-meal weights come from the user's calorie split (default even), so the
        // model designs a bigger dinner when they've asked to save calories for the
        // evening. Normalized (sums to 1), so totalW is 1.
        var weights = calorieWeights(opts.calorieSplit, mealNames);
        var totalW = weights.reduce(function (a, b) { return a + b; }, 0) || 1;
        var names = [], mealCodes = [], recsByCode = {}, recs = [], seen = {};
        var usedFoods = [], unmatched = [];

        // How many times to ask the model per meal, then vote on the consensus
        // foods. >1 turns a shaky small-model pick into a stable one; 1 keeps the
        // old single-shot behaviour (and library/test parity). Free locally.
        var votes = Math.max(1, (opts.votes | 0) || 1);

        var chainP = Promise.resolve();
        mealNames.forEach(function (nm, mi) {
          chainP = chainP.then(function () {
            var w = weights[mi] / totalW;
            var mealTarget = {
              kcal: (t0.kcal || 0) * w, protein: (t0.protein || 0) * w, fat: (t0.fat || 0) * w,
              carbs: (t0.carbs || 0) * w, fiber: (t0.fiber || 35) * w
            };
            // Fan out: ask designMeal `votes` times (each a fresh, stateless call),
            // then keep the foods most runs agreed on. Sequential — one engine.
            return repeatSeq(votes, function (vi) {
              report("choose", "Designing " + nm + " (" + (mi + 1) + "/" + mealNames.length + ")" +
                (votes > 1 ? " · take " + (vi + 1) + "/" + votes : "") + "…");
              return Promise.resolve(opts.engine.designMeal({
                mealName: nm, target: mealTarget, country: opts.country,
                prefs: opts.prefs, breakfast: opts.breakfast, usedFoods: usedFoods.slice()
              })).then(function (res) {
                return ((res && res.foods) || []).filter(function (x) { return typeof x === "string"; });
              });
            }).then(function (lists) {
              // Every attempt failed → a real model failure for this meal; reject so
              // the caller can blocklist this model and try the next (was the old
              // single-shot behaviour too).
              if (!lists.length) throw new Error("The model produced no foods for " + nm + ".");
              var foods = votes > 1 ? voteFoods(lists, { min: 2 }) : lists[0];
              names.push(nm);
              var codes = [];
              foods.forEach(function (fname) {
                if (typeof fname !== "string" || !fname.trim()) return;
                fname = fname.trim();
                usedFoods.push(fname);
                var hit = FL.searchFoods(catalog, fname, 1)[0];
                if (hit && hit.code) {
                  if (codes.indexOf(hit.code) < 0) codes.push(hit.code);
                  if (!seen[hit.code]) { seen[hit.code] = 1; recsByCode[hit.code] = hit; recs.push(hit); }
                } else {
                  var code = aiCode(fname);
                  if (codes.indexOf(code) < 0) codes.push(code);
                  unmatched.push({ code: code, name: fname });
                }
              });
              mealCodes.push(codes);
            });
          });
        });

        selectP = chainP.then(function () {
          if (!names.length) aiReject(new Error("The model designed no meals."));
          // De-dupe unmatched foods, then resolve them with ONE macro-guess call.
          var byCode = {}, order = [];
          unmatched.forEach(function (u) { if (!byCode[u.code]) { byCode[u.code] = u.name; order.push(u.code); } });
          var guessedProducts = {};

          // Fuzzy/translation search. The model designs in English but the catalog
          // is in the country's language (e.g. Finnish), so a real product like
          // "Kananrinta" scores zero on "chicken breast" and is lost to an AI macro
          // guess. Ask the model for local-language search terms, re-search, and
          // PROMOTE any food that now matches to its real catalog product (barcode,
          // micros, price) — remapping its ai: code across the meal layout. Only the
          // genuinely unstocked foods fall through to guessMacros below.
          report("choose", "Matching foods to local products…");
          var translateP = (order.length && opts.engine.translateFoods)
            ? Promise.resolve(opts.engine.translateFoods({
                foods: order.map(function (c) { return byCode[c]; }), country: opts.country
              })).then(function (t) {
                var termsBy = {};
                ((t && t.terms) || []).forEach(function (e) {
                  if (e && e.name) termsBy[String(e.name).toLowerCase()] =
                    (e.queries || []).filter(function (x) { return typeof x === "string" && x.trim(); });
                });
                var remap = {}, rescued = {};
                order.forEach(function (code) {
                  var nm = byCode[code];
                  var hit = bestHit(catalog, (termsBy[String(nm).toLowerCase()] || []).concat([nm]));
                  if (hit && hit.code) {
                    remap[code] = hit.code; rescued[code] = 1;
                    if (!seen[hit.code]) { seen[hit.code] = 1; recsByCode[hit.code] = hit; recs.push(hit); }
                  }
                });
                if (Object.keys(remap).length) {
                  mealCodes = mealCodes.map(function (cl) {
                    var out = [];
                    cl.forEach(function (c) { var real = remap[c] || c; if (out.indexOf(real) < 0) out.push(real); });
                    return out;
                  });
                  order = order.filter(function (c) { return !rescued[c]; }); // matched → don't guess
                }
              }, function () { /* translation failed — all fall through to guessMacros */ })
            : Promise.resolve();

          return translateP.then(function () {
          var guessP = (order.length && opts.engine.guessMacros)
            ? Promise.resolve(opts.engine.guessMacros({
                foods: order.map(function (c) { return byCode[c]; }),
                country: opts.country, prefs: opts.prefs
              })).then(function (g) {
                var arr = (g && g.macros) || [];
                // Map each requested food to its guess: prefer a name match (guards
                // against the model reordering its answers), else fall back to order.
                function pick(nm, i) {
                  var low = nm.toLowerCase();
                  for (var k = 0; k < arr.length; k++) {
                    var an = arr[k] && arr[k].name ? String(arr[k].name).toLowerCase() : "";
                    if (an && (an === low || an.indexOf(low) >= 0 || low.indexOf(an) >= 0)) return arr[k];
                  }
                  return arr[i];
                }
                order.forEach(function (code, i) {
                  var nm = byCode[code];
                  var m = sanitizeGuess(pick(nm, i));
                  if (!m) return;
                  var rec = { code: code, name: nm, protein: m.protein, fat: m.fat,
                              carbs: m.carbs, fiber: m.fiber, kcalEst: m.kcal };
                  if (!seen[code]) { seen[code] = 1; recsByCode[code] = rec; recs.push(rec); }
                  guessedProducts[code] = { product_name: nm, ai_guesses: true,
                    breakdown: { macros: { energy_kcal: m.kcal, proteins: m.protein,
                      fat: m.fat, carbohydrates: m.carbs, fiber: m.fiber } } };
                });
              }, function () { /* guess failed — those foods get pruned below */ })
            : Promise.resolve();
          return guessP.then(function () {
            // Drop any food we could neither match nor guess (keeps codes solvable).
            mealCodes = mealCodes.map(function (cl) {
              return cl.filter(function (c) { return recsByCode[c]; });
            });
            // Safety net for weak models (the tiny model iOS forces on us): if a meal
            // came out empty/sparse because its foods didn't match the catalog and the
            // macro guesses were unusable, seed DIET-SAFE catalog staples so every meal
            // is still a real, solvable plate (the model's own matches are kept on top).
            var seed = gatherFoods(catalog,
              repairQueries("protein", opts.prefs)
                .concat(repairQueries("carbs", opts.prefs))
                .concat(repairQueries("fat", opts.prefs))
                .concat(repairQueries("fiber", opts.prefs)));
            var si = 0;
            if (seed.length) {
              mealCodes = mealCodes.map(function (cl) {
                var guard = 0;
                while (cl.length < 2 && guard++ < seed.length) {
                  var r = seed[si++ % seed.length];
                  if (cl.indexOf(r.code) < 0) {
                    cl.push(r.code);
                    if (!recsByCode[r.code]) { recsByCode[r.code] = r; recs.push(r); }
                  }
                }
                return cl;
              });
            }
            if (!recs.length) aiReject(new Error("No catalog foods are available for this country."));
            return { recs: recs, recsByCode: recsByCode,
                     layout: { names: names, mealCodes: mealCodes }, guessedProducts: guessedProducts };
          });
          });
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
        var guessedProducts = sel.guessedProducts || {};

        // Only real catalog codes go to the product API; AI-guessed foods (ai:…)
        // carry their own macros and are merged straight in.
        var fetchCodes = recs.filter(function (r) { return r.code.indexOf("ai:") !== 0; })
                             .map(function (r) { return r.code; });
        report("fetch", "Fetching nutrition for " + fetchCodes.length + " foods…");
        return FL.fetchProducts(fetchCodes, io).then(function (products) {
          Object.keys(guessedProducts).forEach(function (c) { products[c] = guessedProducts[c]; });

          // Back any food whose fetch failed with its catalog macros, so the
          // numbers shown match the numbers the solver sized against (no 0-kcal items).
          recs.forEach(function (r) { ensureProduct(products, r); });

          // Reasoning step: ask the model how each ingredient is actually bought and
          // portioned — a whole "unit" you use whole or in simple fractions (egg in a
          // shell, banana, a can) vs "bulk" you weigh out of a package (rice, oil,
          // yoghurt). Only foods the hardcoded heuristic can't already place are sent
          // (known pieces + obvious bulk skip the model, to save calls). The result
          // OVERRIDES the regex when sizing portions, so a food the list never knew
          // about can't come back as "7 g of egg". Layout path only; on any failure
          // we fall back to the heuristic.
          var portionClass = {};
          var classifyList = layout ? recs.map(function (r) {
            return { code: r.code, name: (products[r.code] && products[r.code].product_name) || r.name || r.code };
          }).filter(function (f) { return !pieceInfo(f.name) && !OBVIOUS_BULK.test(f.name); }) : [];
          var classifyP = (classifyList.length && opts.engine && opts.engine.classifyFoods)
            ? (report("check", "Checking each ingredient can be portioned sensibly…"),
               Promise.resolve(opts.engine.classifyFoods({
                 foods: classifyList.map(function (f) { return f.name; }), country: opts.country
               })).then(function (c) { portionClass = buildPortionClass(c, classifyList); }, function () {}))
            : Promise.resolve();

          return classifyP.then(function () {
          // 2) Size portions. The model-meal path solves EACH meal to its share of
          // the day's targets (so every meal is a balanced plate); the flat path
          // solves the day as a whole and splits it.
          report("solve", "Sizing portions to hit every target…");
          var unmet = [];
          var days = opts.dayTargets.map(function (target) {
            if (layout) {
              var d = assembleLayoutDay(target, layout.names, layout.mealCodes, products,
                                        catalog, recsByCode, repairRounds, opts.prefs, portionClass,
                                        calorieWeights(opts.calorieSplit, layout.names));
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
                extra.forEach(function (r) { ensureProduct(products, r); foods.push(macroRow(r, products[r.code])); });
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
    "Qwen2.5-0.5B-Instruct",  //  945 / 1060 MB
    "SmolLM2-360M-Instruct"   //  ~376 MB weights — tiny; the only thing iOS Safari's
                              //  per-tab memory cap will reliably LOAD (see IOS_PREFERENCE).
                              //  Weak, but enough to name a few foods.
  ];

  // iOS Safari OOM-crashes loading anything bigger than the tiny tier, AND the crash
  // is an uncatchable tab reload — so on iOS we ONLY ever offer these. Critically,
  // this stops the model-walk from "escalating" to a 1B after a hiccup (which would
  // just crash the tab); when this list is exhausted, selection returns null and the
  // app falls back to the copy-prompt path instead of downloading a doomed model.
  var IOS_PREFERENCE = [
    "SmolLM2-360M-Instruct",  // ~376 MB — the one that actually loads in Safari
    "SmolLM2-135M-Instruct"   // ~140 MB — last-ditch if 360M is exhausted; very weak
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
    // iPadOS reports as "Macintosh" but has touch points; treat it as iOS too.
    var isIOS = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints || 0) > 1);
    var isMobile = isIOS || /Mobi|Android/i.test(ua);
    return { isMobile: isMobile, isIOS: isIOS, deviceMemory: nav.deviceMemory || 0 };
  }
  function computeBudgetMB(env) {
    env = env || {};
    var dm = env.deviceMemory || 0; // GB; 0 = unreported (iOS Safari, Firefox)
    if (env.isMobile) {
      // Phones share GPU memory with the OS and kill the tab aggressively, so only
      // a fraction of total RAM is really usable for model weights — and a model's
      // live footprint (weights + KV cache + activations + the browser itself) runs
      // well above its `vram_required_MB`. deviceMemory (Android Chrome) is the one
      // signal we get; iOS Safari never reports it, so assume a modest phone. These
      // tiers are deliberately tight — over-reaching here is what OOM-crashes the tab.
      if (!dm) return 1200;   // unknown (iOS Safari): allow only a 1B, with capped context
      if (dm <= 2) return 800;   // very low-end — even a 1B won't fit → copy-prompt
      if (dm <= 3) return 1200;
      if (dm <= 4) return 1500;
      if (dm <= 6) return 2200;
      return 3000;            // 8 GB+ phones (recent flagships)
    }
    // Desktop/laptop: be generous so the biggest coherent model is reachable
    // (~6 GB lets a 7B run in f16). deviceMemory is spec-capped at 8 and unreported
    // on Safari — assume capable (8) when unknown rather than blocking big models;
    // the load watchdog + model walk recover if we over-reach.
    return Math.max(3000, Math.min(dm || 8, 8) * 750);
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
    // A model's live footprint exceeds its reported vram_required_MB (KV cache,
    // activations, staging, the browser). safetyFactor (>1 on mobile) reserves for
    // that, so the chosen model has real headroom instead of fitting only on paper.
    var safety = opts.safetyFactor || 1;
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
        if (budget && rec.vram_required_MB && rec.vram_required_MB * safety > budget) continue;
        return id;
      }
    }
    return null;
  }

  // Answer "what will this device run?" — inspect memory + WebGPU caps and report
  // which model would be chosen, the budget, and why (so the UI can show it, or warn
  // before an OOM). `modelList` is webllm.prebuiltAppConfig.model_list. Pass
  // opts.env / opts.caps to keep it pure (tests); otherwise they're auto-detected.
  function recommendModel(modelList, opts) {
    opts = opts || {};
    var env = opts.env || browserEnv();
    var budgetMB = opts.budgetMB || computeBudgetMB(env);
    var capsP = opts.caps !== undefined ? Promise.resolve(opts.caps) : detectGpuCaps();
    return Promise.resolve(capsP).then(function (caps) {
      var base = { budgetMB: budgetMB, deviceMemory: env.deviceMemory || 0,
                   isMobile: !!env.isMobile, isIOS: !!env.isIOS, shaderF16: !!(caps && caps.shaderF16) };
      // No WebGPU adapter at all → nothing can run on-device, regardless of budget.
      if (!caps) return Object.assign(base, { model: null,
        reason: "No WebGPU adapter — on-device AI can't run; use the copy-prompt path." });
      // iOS: only the tiny tier (Safari's tab cap is the limit, not the budget), and
      // it must NOT escalate to a 1B — so restrict the preference to IOS_PREFERENCE.
      var model = env.isIOS
        ? selectModel(modelList, caps, { preference: IOS_PREFERENCE, blocklist: opts.blocklist || [],
            preferF32: opts.preferF32, budgetMB: budgetMB, safetyFactor: 1.3 })
        : selectModel(modelList, caps, { blocklist: opts.blocklist || [], preferF32: opts.preferF32,
            budgetMB: budgetMB, safetyFactor: env.isMobile ? 1.3 : 1 });
      return Object.assign(base, { model: model,
        reason: model ? null : (env.isIOS ? "This iPhone can only run a tiny on-device model and none is available — use the copy-prompt path."
          : ("No model fits this device's ~" + budgetMB + " MB budget" +
             (env.deviceMemory ? " (~" + env.deviceMemory + " GB RAM)" : "") + " — use the copy-prompt path.")) });
    });
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
            var env = options.env || browserEnv(); // options.env is a test seam
            var budgetMB = computeBudgetMB(env);
            var list = webllm.prebuiltAppConfig && webllm.prebuiltAppConfig.model_list;
            // iOS: Safari's per-tab memory cap (not the model budget) is the limit and
            // OOM crashes the tab uncatchably — so restrict to the tiny IOS_PREFERENCE
            // tier. This also stops the model-walk from escalating to a 1B after a
            // hiccup (which would just crash); exhausting the tier returns null and the
            // app surfaces the copy-prompt path instead.
            var picked = options.model || (env.isIOS
              ? selectModel(list, caps, { preference: IOS_PREFERENCE, blocklist: options.blocklist || [],
                  preferF32: options.preferF32, budgetMB: budgetMB, safetyFactor: 1.3 })
              : selectModel(list, caps, { blocklist: options.blocklist || [], preferF32: options.preferF32,
                  budgetMB: budgetMB, safetyFactor: env.isMobile ? 1.3 : 1 }));
            if (!picked) {
              throw new Error("No on-device model fits this device" +
                (env.isMobile ? " (memory is tight on this phone" +
                  (env.deviceMemory ? " — ~" + env.deviceMemory + " GB RAM" : "") + ")" :
                 (caps && !caps.shaderF16 ? " (no shader-f16 support; tried 32-bit models)" : "")) + ".");
            }
            chosenModel = picked;
            lastTick = Date.now();
            if (options.onPick) {
              try { options.onPick(picked, caps, { deviceMemory: env.deviceMemory, budgetMB: budgetMB, isMobile: env.isMobile, isIOS: env.isIOS }); } catch (e) {}
            }
            onProgress("download", "Preparing " + picked + "…");
            // Two memory levers, tightest on iOS where Safari's tab cap is unforgiving:
            //  • context_window_size caps the KV cache (and our prompts are short).
            //  • prefill_chunk_size caps the activation tensors built while the prompt
            //    is processed — a big transient spike and a prime OOM trigger; a small
            //    chunk trades a little prefill speed for a much lower peak.
            var ctx = options.contextWindowSize || (env.isIOS ? 1024 : (env.isMobile ? 2048 : 0));
            var chatOpts = ctx ? { context_window_size: ctx } : undefined;
            if (env.isIOS) {
              chatOpts = chatOpts || {};
              chatOpts.prefill_chunk_size = options.prefillChunkSize || 256;
            } else if (options.prefillChunkSize) {
              chatOpts = chatOpts || {};
              chatOpts.prefill_chunk_size = options.prefillChunkSize;
            }
            return webllm.CreateMLCEngine(picked, { initProgressCallback: progress }, chatOpts);
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
      // Design ONE meal at a time, each with its own dedicated, meal-aware prompt.
      // The model names the ingredients for that single meal (no amounts — the
      // solver sizes portions); `usedFoods` from earlier meals is passed in so the
      // day stays varied without any cross-meal conversation state.
      designMeal: function (ctx) {
        var nm = ctx.mealName || "Meal";
        var t = ctx.target || {};
        var g = mealGuidance(nm, ctx.breakfast);
        var sys = "You are a chef and nutritionist designing ONE meal: a " + g.kind + ". " + g.desc + " " +
          "Picture what this single meal realistically looks like on a plate, then list its whole-food " +
          "ingredients. Rules: (1) It must be ONE coherent " + g.kind + " — foods that genuinely go " +
          "together, not a random assortment. (2) Build it from " + g.compose + ". (3) Favour " +
          "micronutrient-dense whole foods — colourful vegetables or fruit, legumes, whole grains, " +
          "good proteins and fats. (4) Respect dietary restrictions strictly. (5) Name " + g.count + " " +
          "ingredients. (6) Name foods ONLY — no amounts, no numbers, no arithmetic. " +
          "Output ONLY JSON, no prose or code fences: {\"foods\":[\"ingredient\",\"ingredient\",\"ingredient\"]}";
        var usr = "Meal: " + nm + "\nCountry: " + (ctx.country || "unknown") + "\n" +
          (g.isBreakfast ? "Breakfast style: " + (ctx.breakfast || "no preference") + "\n" : "") +
          "Dietary restrictions / allergies (strict): " + (ctx.prefs || "none") + "\n" +
          "Aim for roughly " + Math.round(t.kcal || 0) + " kcal, " + Math.round(t.protein || 0) +
          " g protein, " + Math.round(t.carbs || 0) + " g carbs, " + Math.round(t.fat || 0) +
          " g fat and " + Math.round(t.fiber || 0) + " g fibre in this meal, so pick foods substantial " +
          "and protein-/fibre-rich enough to reach that.\n" +
          ((ctx.usedFoods && ctx.usedFoods.length)
            ? "Already used earlier today — choose DIFFERENT foods for variety: " + ctx.usedFoods.join(", ") + "\n"
            : "") +
          "Design the " + nm + " now.";
        return chatJSON(sys, usr, "Designing " + nm, 500).then(function (o) {
          return { foods: Array.isArray(o.foods) ? o.foods.filter(function (x) { return typeof x === "string"; }) : [] };
        });
      },
      // Fallback nutrition for foods the catalog/product API can't price: ask the
      // model for typical per-100 g macros (the planner clamps + Atwater-checks them).
      // ONE food per call, each a fresh, tiny prompt with a hard token cap: a single
      // small JSON object is something even the 360M model iOS forces on us produces
      // reliably and fast — a batched array made it ramble toward the cap and stall.
      guessMacros: function (ctx) {
        var foods = (ctx.foods || []).filter(function (x) { return typeof x === "string" && x.trim(); }).slice(0, 8);
        if (!foods.length) return Promise.resolve({ macros: [] });
        var sys = "You are a nutrition database. Give typical macros per 100 g of the ONE named food " +
          "as normally eaten. Output ONLY JSON, no prose or code fences: " +
          "{\"kcal\":0,\"protein\":0,\"fat\":0,\"carbs\":0,\"fiber\":0}. protein/fat/carbs/fiber are grams " +
          "per 100 g; kcal is energy per 100 g. Be realistic.";
        var out = [];
        var p = Promise.resolve();
        foods.forEach(function (food) {
          p = p.then(function () {
            return chatJSON(sys, "Food: " + food, "Estimating " + food, 80).then(function (o) {
              out.push({ name: food, kcal: o.kcal, protein: o.protein, fat: o.fat, carbs: o.carbs, fiber: o.fiber });
            }, function () { out.push({ name: food }); }); // a failed/empty one is sanitized away by the planner
          });
        });
        return p.then(function () { return { macros: out }; });
      },
      // Fuzzy/translation search helper: map an English food name to the term(s) it
      // is sold under in the user's country, so the catalog (in the local language)
      // can be searched under a name that actually matches. ONE food per call — a
      // single tiny JSON object is what even the 360M model iOS forces on us
      // produces reliably; a batched array rambles toward the cap and stalls.
      translateFoods: function (ctx) {
        var foods = (ctx.foods || []).filter(function (x) { return typeof x === "string" && x.trim(); }).slice(0, 12);
        if (!foods.length) return Promise.resolve({ terms: [] });
        var country = ctx.country || "the local market";
        var sys = "You translate a food into what it is called on grocery products in a given country, " +
          "for searching a local product catalog. Give the LOCAL-LANGUAGE generic name(s) and common " +
          "synonyms as printed on packaging (brand-neutral). Output ONLY JSON, no prose or code fences: " +
          "{\"queries\":[\"term\",\"term\"]} — 2–4 short terms, most likely first.";
        var out = [];
        var p = Promise.resolve();
        foods.forEach(function (food) {
          p = p.then(function () {
            return chatJSON(sys, "Country: " + country + "\nFood (English): " + food, "Translating " + food, 80)
              .then(function (o) {
                var qs = Array.isArray(o.queries)
                  ? o.queries.filter(function (x) { return typeof x === "string" && x.trim(); }) : [];
                out.push({ name: food, queries: qs });
              }, function () { out.push({ name: food, queries: [] }); });
          });
        });
        return p.then(function () { return { terms: out }; });
      },
      // Reasoning step: judge how each food is bought/portioned so the planner can
      // size it like a human would. ONE food per call (a single tiny JSON object is
      // what even the 360M model produces reliably). Skipped on iOS — the heuristic
      // covers the common pieces and every extra generation is memory risk in Safari.
      classifyFoods: function (ctx) {
        if ((options.env || browserEnv()).isIOS) return Promise.resolve({ foods: [] });
        var foods = (ctx.foods || []).filter(function (x) { return typeof x === "string" && x.trim(); }).slice(0, 20);
        if (!foods.length) return Promise.resolve({ foods: [] });
        var country = ctx.country || "unknown";
        var sys = "You reason about how a food is bought and portioned in a kitchen. Decide if it is a " +
          "\"unit\" — a whole item you use whole or in simple fractions (an egg in its shell, a banana, a " +
          "slice of bread, a can of tuna, a sausage) — or \"bulk\" — sold loose or in a package you weigh any " +
          "amount from (rice, oats, oil, yoghurt, mince). For a unit, give the typical weight of ONE item in " +
          "grams and the smallest sensible fraction a person would use (0.25, 0.5, or 1 for whole-only). " +
          "Output ONLY JSON, no prose or code fences: " +
          "{\"kind\":\"unit\",\"unit\":\"egg\",\"unitGrams\":50,\"minFraction\":0.25}.";
        var out = [];
        var p = Promise.resolve();
        foods.forEach(function (food) {
          p = p.then(function () {
            return chatJSON(sys, "Country: " + country + "\nFood: " + food, "Checking " + food, 90).then(function (o) {
              out.push({ name: food, kind: o.kind, unit: o.unit, unitGrams: o.unitGrams, minFraction: o.minFraction });
            }, function () { out.push({ name: food }); });
          });
        });
        return p.then(function () { return { foods: out }; });
      },
      // Circle-back questions: propose ways the user could tailor the plan, as
      // multiple-choice ONLY (the planner sanitizes + gates these, and always adds
      // the deterministic calorie-split question, so a weak answer can't break the
      // "no typing" rule). Skipped on iOS.
      proposeQuestions: function (ctx) {
        if ((options.env || browserEnv()).isIOS) return Promise.resolve({ questions: [] });
        var sys = "You suggest ONE short follow-up question to help tailor a meal plan, answerable ONLY by " +
          "picking from a few fixed choices — never by typing. Good topics: how to spread calories across the " +
          "day, appetite in the morning, cooking time on weeknights. Give 3–4 distinct choices. Output ONLY " +
          "JSON, no prose or code fences: {\"questions\":[{\"id\":\"slug\",\"prompt\":\"...\"," +
          "\"options\":[{\"id\":\"slug\",\"label\":\"...\",\"hint\":\"...\"}]}]}.";
        var usr = "Country: " + (ctx.country || "unknown") + "\nDiet: " + (ctx.prefs || "none") +
          "\nMeals per day: " + (ctx.mealsPerDay || 3) + "\nPropose one useful multiple-choice question.";
        return chatJSON(sys, usr, "Thinking of a question to ask you", 400).then(function (o) {
          return { questions: (o && Array.isArray(o.questions)) ? o.questions : [] };
        }, function () { return { questions: [] }; });
      },
      // Question critic: sanity-check a proposed question before it's shown — is it
      // clear, genuinely useful, and answerable purely by picking an option?
      critiqueQuestion: function (ctx) {
        var q = ctx && ctx.question;
        if (!q) return Promise.resolve({ ok: false });
        var opts = (q.options || []).map(function (o) { return o.label; }).join(" | ");
        var sys = "You review ONE multiple-choice question for a meal-plan app. Reply ok:false if it is " +
          "confusing, useless, leading, or would need typed input; otherwise ok:true. Output ONLY JSON, no " +
          "prose or code fences: {\"ok\":true}.";
        return chatJSON(sys, "Question: " + q.prompt + "\nChoices: " + opts, "Reviewing the question", 60)
          .then(function (o) { return { ok: !o || o.ok !== false }; }, function () { return { ok: true }; });
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
        // Skip on iOS: it's one more generation, and every generation is memory risk
        // in Safari's tight tab budget. buildPlan falls back to a templated summary.
        if ((options.env || browserEnv()).isIOS) return Promise.resolve("");
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
      // Free the model if (and only if) it was actually loaded. Calling load() here
      // would otherwise START a download just to unload it — and on a retry that runs
      // concurrently with the next attempt's load (two model loads = a hang/OOM).
      dispose: function () {
        if (!loadP) return Promise.resolve();
        return loadP.then(function (e) { return e && e.unload && e.unload(); }).catch(function () {});
      }
    };
  }

  var api = {
    buildPlan: buildPlan,
    createWebLLMEngine: createWebLLMEngine,
    selectModel: selectModel,
    detectGpuCaps: detectGpuCaps,
    computeBudgetMB: computeBudgetMB,
    recommendModel: recommendModel,
    browserEnv: browserEnv,
    MODEL_PREFERENCE: MODEL_PREFERENCE,
    browserBrotli: browserBrotli,
    DEFAULT_STAPLES: DEFAULT_STAPLES,
    macroRow: macroRow,
    splitIntoMeals: splitIntoMeals,
    gatherFoods: gatherFoods,
    voteFoods: voteFoods,
    repeatSeq: repeatSeq,
    bestHit: bestHit,
    pieceInfo: pieceInfo,
    pieceAmount: pieceAmount,
    snapPiece: snapPiece,
    snapBulk: snapBulk,
    distributeBulk: distributeBulk,
    classToDescriptor: classToDescriptor,
    buildPortionClass: buildPortionClass,
    calorieWeights: calorieWeights,
    calorieSplitLabel: calorieSplitLabel,
    CALORIE_SPLITS: CALORIE_SPLITS,
    sanitizeQuestion: sanitizeQuestion,
    buildCalorieSplitQuestion: buildCalorieSplitQuestion,
    answerToBuildOpts: answerToBuildOpts,
    planQuestions: planQuestions
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.YdinPlanner = api;
})(typeof self !== "undefined" ? self : this);

/*
 * Catalog module (Phases 0 + 1 of the meal-plan plan).
 *
 * Source of truth for "what foods exist in this country, and their nutrition".
 * The catalog is the per-country index produced by the open-food-facts mirror
 * (github.com/YdinFit/open-food-facts-mirror-ydin) and served from R2 at
 * catalog.ydin.app. This module loads + searches that index and fetches full
 * product JSONs, then sums them deterministically with buildMealTotals.
 *
 * It is path-independent: the on-device model (Path A) calls it via FOOD_TOOLS /
 * dispatchTool; the copy-prompt path (Path B) and an MCP server can reuse the
 * same pure functions. No dependencies. Works as a browser global
 * (window.YdinFoodLookup) and a CommonJS module so Node tests run the real code.
 *
 * DATA CONTRACTS — verified against the producer repo, NOT assumed:
 *
 *  Catalog line  indexes/catalogs/{cc}/catalog.jsonl.br  (brotli JSONL)
 *    Each line is a positional JSON ARRAY (src/lib.rs CatalogEntry::serialize):
 *      [code, name, brand, country, serving_size, serving_unit,
 *       fiber, carbs, fat, protein]
 *    The fiber/carbs/fat/protein figures are per 100 g. There is NO kcal in the
 *    index — kcal comes from the product JSON, or Atwater (4P+4C+9F) as a fallback.
 *
 *  Product JSON  products/{barcode}.json  (confirmed from ai-guesstimate.mjs):
 *    { product_name, brands, ingredients_text,
 *      breakdown: { macros:{energy_kcal,fat,proteins,carbohydrates},
 *                   vitamins:{…}, minerals:{…}, amino_acids:{…} },
 *      ai_guesses?: { model, timestamp } }   // present => micros are ESTIMATED
 *    All breakdown values are per 100 g. Scale by grams/100.
 */
(function (root) {
  "use strict";

  var DEFAULT_BASE = "https://catalog.ydin.app";

  // ---- Phase 0: capability gate -------------------------------------------

  // Resolves true if a WebGPU adapter is available (Path A is offerable),
  // false otherwise (fall back to the copy-prompt path). Never throws.
  function detectWebGPU() {
    try {
      if (typeof navigator === "undefined" || !navigator.gpu) return Promise.resolve(false);
      return navigator.gpu.requestAdapter()
        .then(function (a) { return !!a; })
        .catch(function () { return false; });
    } catch (e) { return Promise.resolve(false); }
  }

  // ---- catalog parsing (pure) ---------------------------------------------

  var FIELDS = ["code", "name", "brand", "country",
                "servingSize", "servingUnit", "fiber", "carbs", "fat", "protein"];

  // Parse one JSONL line (positional array) into a named record. Tolerant of
  // blank lines and malformed JSON (returns null so callers can skip).
  function parseCatalogLine(line) {
    if (!line) return null;
    var arr;
    try { arr = JSON.parse(line); } catch (e) { return null; }
    if (!Array.isArray(arr) || !arr[0]) return null;
    var rec = {};
    for (var i = 0; i < FIELDS.length; i++) rec[FIELDS[i]] = arr[i] == null ? null : arr[i];
    // Derive an Atwater kcal estimate for the index (real kcal lives in the product).
    rec.kcalEst = Math.round(4 * num(rec.protein) + 4 * num(rec.carbs) + 9 * num(rec.fat));
    return rec;
  }

  // Parse a whole decoded catalog (newline-delimited JSON) into an array of
  // records. Skips blank/garbage lines.
  function parseCatalog(text) {
    var out = [], lines = String(text).split("\n");
    for (var i = 0; i < lines.length; i++) {
      var rec = parseCatalogLine(lines[i].trim());
      if (rec) out.push(rec);
    }
    return out;
  }

  // ---- search (pure, built-in fuzzy scorer) -------------------------------
  // Start simple per the plan (§3): a token/substring scorer over name+brand.
  // Upgrade to Fuse.js later only if this misses.

  function normalize(s) {
    return String(s == null ? "" : s).toLowerCase()
      .normalize ? String(s == null ? "" : s).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
                 : String(s == null ? "" : s).toLowerCase();
  }

  function scoreMatch(rec, q) {
    var hay = normalize(rec.name) + " " + normalize(rec.brand);
    if (!q) return 0;
    var terms = q.split(/\s+/).filter(Boolean), score = 0;
    for (var i = 0; i < terms.length; i++) {
      var t = terms[i], idx = hay.indexOf(t);
      if (idx < 0) return 0;                 // every term must appear
      score += 10;
      if (idx === 0) score += 6;             // prefix bonus
      else if (hay[idx - 1] === " ") score += 4; // word-start bonus
    }
    score -= Math.min(8, hay.length / 40);   // gently prefer shorter names
    return score;
  }

  // searchFoods(catalog, query, limit) -> ranked records. `catalog` is the
  // array from parseCatalog/loadCountryCatalog.
  function searchFoods(catalog, query, limit) {
    var q = normalize(query);
    var scored = [];
    for (var i = 0; i < (catalog || []).length; i++) {
      var s = scoreMatch(catalog[i], q);
      if (s > 0) scored.push({ rec: catalog[i], s: s });
    }
    scored.sort(function (a, b) { return b.s - a.s; });
    return scored.slice(0, limit || 20).map(function (x) { return x.rec; });
  }

  // ---- buildMealTotals (pure) ---------------------------------------------
  // The deterministic summation the model is forbidden from doing. Items are
  // [{code, grams}]; products is a map code -> product JSON (from fetchProducts).
  // Scales every per-100 g macro AND micronutrient by grams/100 and sums them.
  // Sets `estimated:true` if ANY contributing product carries ai_guesses, and
  // lists which items lacked a product (so callers can fetch/repair).
  var MICRO_GROUPS = ["vitamins", "minerals", "amino_acids"];

  function buildMealTotals(items, products) {
    products = products || {};
    var totals = { kcal: 0, protein: 0, fat: 0, carbs: 0, fiber: 0 };
    var micros = { vitamins: {}, minerals: {}, amino_acids: {} };
    var estimated = false, missing = [], lines = [];

    (items || []).forEach(function (it) {
      var grams = num(it.grams), s = grams / 100, p = products[it.code];
      if (!p) { missing.push(it.code); return; }
      var b = p.breakdown || {}, m = b.macros || {};
      var line = {
        code: it.code,
        name: p.product_name || it.name || it.code,
        grams: grams,
        kcal: round(num(m.energy_kcal) * s),
        protein: round(num(m.proteins) * s),
        fat: round(num(m.fat) * s),
        carbs: round(num(m.carbohydrates) * s)
      };
      totals.kcal += num(m.energy_kcal) * s;
      totals.protein += num(m.proteins) * s;
      totals.fat += num(m.fat) * s;
      totals.carbs += num(m.carbohydrates) * s;
      // Fibre is tracked in the catalog index, not always in the product
      // breakdown — use the product's macros.fiber if present, else the
      // per-100 g fibre the caller passes through on the item (it.fiber100).
      var fiber100 = m.fiber != null ? num(m.fiber)
                   : (it.fiber100 != null ? num(it.fiber100) : 0);
      if (fiber100) { totals.fiber += fiber100 * s; line.fiber = round(fiber100 * s); }

      MICRO_GROUPS.forEach(function (g) {
        var src = b[g] || {};
        Object.keys(src).forEach(function (k) {
          if (src[k] == null) return;
          micros[g][k] = round(num(micros[g][k]) + num(src[k]) * s);
        });
      });
      if (p.ai_guesses) estimated = true;
      lines.push(line);
    });

    ["kcal", "protein", "fat", "carbs", "fiber"].forEach(function (k) {
      totals[k] = k === "kcal" ? Math.round(totals[k]) : round(totals[k]);
    });

    return { totals: totals, micros: micros, items: lines,
             estimated: estimated, missing: missing };
  }

  // ---- browser-only I/O: brotli decode, catalog load, product fetch -------
  // These degrade to clear errors under Node (no fetch/DecompressionStream).

  // Decompress a brotli byte stream. Native DecompressionStream("brotli") is
  // tried first; callers may pass a wasm fallback via opts.brotliDecode (e.g.
  // brotli-wasm) for browsers without native brotli.
  function decodeBrotli(bytes, opts) {
    opts = opts || {};
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    function toText(out) {
      return (out instanceof Uint8Array || ArrayBuffer.isView(out))
        ? new TextDecoder().decode(out) : String(out);
    }
    // Caller-provided decoder (pure-JS in the app). brotliDecode may be async.
    function viaProvided() {
      if (typeof opts.brotliDecode !== "function") return Promise.reject(new Error("no brotli decoder"));
      return Promise.resolve(opts.brotliDecode(u8)).then(toText);
    }
    // Native DecompressionStream("brotli"): rare and inconsistent across
    // browsers (often unsupported, sometimes errors mid-pipe), so it's the
    // fallback. Every failure — sync or async — is contained in this promise.
    function viaNative() {
      return new Promise(function (resolve, reject) {
        try {
          if (typeof DecompressionStream === "undefined") throw new Error("no DecompressionStream");
          var ds = new DecompressionStream("brotli");
          var stream = new Response(u8).body.pipeThrough(ds);
          new Response(stream).text().then(resolve, reject);
        } catch (e) { reject(e); }
      });
    }
    // Prefer the (reliable, pure-JS) provided decoder; fall back to native.
    return viaProvided().catch(function () { return viaNative(); });
  }

  // loadCountryCatalog(cc, opts) -> Promise<catalog array>.
  // opts: { base, fetch, brotliDecode, cache } — `cache` is an optional
  // get/set store (IndexedDB-backed in the app) keyed by country code.
  function loadCountryCatalog(cc, opts) {
    opts = opts || {};
    cc = String(cc || "").toLowerCase();
    var base = opts.base || DEFAULT_BASE;
    var doFetch = opts.fetch || (typeof fetch !== "undefined" ? fetch.bind(root) : null);
    if (!doFetch) return Promise.reject(new Error("fetch unavailable"));

    var fromCache = opts.cache && opts.cache.get
      ? Promise.resolve(opts.cache.get(cc)).catch(function () { return null; })
      : Promise.resolve(null);

    return fromCache.then(function (cached) {
      if (cached) return parseCatalog(cached);
      var url = base + "/indexes/catalogs/" + cc + "/catalog.jsonl.br";
      return doFetch(url).then(function (res) {
        if (!res.ok) throw new Error("Catalog " + cc + " HTTP " + res.status);
        return res.arrayBuffer();
      }).then(function (buf) {
        return decodeBrotli(new Uint8Array(buf), opts);
      }).then(function (text) {
        if (opts.cache && opts.cache.set) { try { opts.cache.set(cc, text); } catch (e) {} }
        return parseCatalog(text);
      });
    });
  }

  // fetchProducts(codes, opts) -> Promise<{code: productJSON}>. Static objects;
  // cache hard (opts.cache: Cache API or a get/set map). Bounded concurrency.
  function fetchProducts(codes, opts) {
    opts = opts || {};
    var base = opts.base || DEFAULT_BASE;
    var doFetch = opts.fetch || (typeof fetch !== "undefined" ? fetch.bind(root) : null);
    if (!doFetch) return Promise.reject(new Error("fetch unavailable"));
    var limit = opts.concurrency || 6;
    var unique = Array.from(new Set((codes || []).filter(Boolean)));
    var out = {}, i = 0;

    function one(code) {
      var get = opts.cache && opts.cache.get
        ? Promise.resolve(opts.cache.get(code)).catch(function () { return null; })
        : Promise.resolve(null);
      return get.then(function (cached) {
        if (cached) { out[code] = cached; return; }
        return doFetch(base + "/products/" + code + ".json").then(function (res) {
          if (!res.ok) throw new Error("Product " + code + " HTTP " + res.status);
          return res.json();
        }).then(function (json) {
          out[code] = json;
          if (opts.cache && opts.cache.set) { try { opts.cache.set(code, json); } catch (e) {} }
        }).catch(function () { /* leave missing; buildMealTotals reports it */ });
      });
    }

    function worker() {
      if (i >= unique.length) return Promise.resolve();
      return one(unique[i++]).then(worker);
    }
    var workers = [];
    for (var w = 0; w < Math.min(limit, unique.length); w++) workers.push(worker());
    return Promise.all(workers).then(function () { return out; });
  }

  function fetchProduct(code, opts) {
    return fetchProducts([code], opts).then(function (m) { return m[code] || null; });
  }

  // ---- WebLLM / MCP tool surface ------------------------------------------
  // The on-device model calls these by name (OpenAI-compatible tool schema).
  // The model only *picks foods and reads totals* — never computes them.

  var FOOD_TOOLS = [
    {
      type: "function",
      function: {
        name: "search_foods",
        description: "Search the user's country food catalog for real products by name. " +
          "Returns barcodes you can pass to build_meal_totals. Use this to choose foods.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Food name to search, e.g. 'rolled oats'" },
            limit: { type: "integer", description: "Max results (default 10)" }
          },
          required: ["query"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "build_meal_totals",
        description: "Deterministically sum the nutrition of chosen foods at given gram amounts. " +
          "ALWAYS use this for any arithmetic — never add macros yourself. Returns totals, " +
          "per-item lines, micronutrients, and whether any value is AI-estimated.",
        parameters: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  code: { type: "string", description: "Product barcode from search_foods" },
                  grams: { type: "number" }
                },
                required: ["code", "grams"]
              }
            }
          },
          required: ["items"]
        }
      }
    }
  ];

  // dispatchTool(cc, name, args, ctx) -> Promise<result>. ctx carries the
  // loaded catalog + fetch/cache options so tools share one I/O config.
  function dispatchTool(cc, name, args, ctx) {
    ctx = ctx || {};
    args = args || {};
    if (name === "search_foods") {
      var cat = ctx.catalog
        ? Promise.resolve(ctx.catalog)
        : loadCountryCatalog(cc, ctx);
      return cat.then(function (catalog) {
        ctx.catalog = catalog;
        return searchFoods(catalog, args.query, args.limit || 10).map(function (r) {
          return { code: r.code, name: r.name, brand: r.brand,
                   per100g: { protein: r.protein, fat: r.fat, carbs: r.carbs, fiber: r.fiber } };
        });
      });
    }
    if (name === "build_meal_totals") {
      var codes = (args.items || []).map(function (it) { return it.code; });
      return fetchProducts(codes, ctx).then(function (products) {
        return buildMealTotals(args.items, products);
      });
    }
    return Promise.reject(new Error("Unknown tool: " + name));
  }

  // ---- small helpers ------------------------------------------------------
  function num(x) { var n = typeof x === "string" ? parseFloat(x) : x;
                    return typeof n === "number" && isFinite(n) ? n : 0; }
  function round(x) { return Math.round(num(x) * 100) / 100; }

  var api = {
    DEFAULT_BASE: DEFAULT_BASE,
    detectWebGPU: detectWebGPU,
    parseCatalogLine: parseCatalogLine,
    parseCatalog: parseCatalog,
    searchFoods: searchFoods,
    scoreMatch: scoreMatch,
    buildMealTotals: buildMealTotals,
    decodeBrotli: decodeBrotli,
    loadCountryCatalog: loadCountryCatalog,
    fetchProducts: fetchProducts,
    fetchProduct: fetchProduct,
    FOOD_TOOLS: FOOD_TOOLS,
    dispatchTool: dispatchTool,
    FIELDS: FIELDS
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.YdinFoodLookup = api;
})(typeof self !== "undefined" ? self : this);

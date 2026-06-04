/*
 * Tests for the catalog module (Phases 0 + 1).
 *
 * Acceptance (plan §5 Phase 1):
 *   searchFoods('fi','milk')-style query returns real candidates; buildMealTotals
 *   returns scaled, summed macros+micros and sets `estimated` when any item
 *   carries ai_guesses.
 *
 * Network is stubbed with an injected fetch so the real load/fetch/dispatch
 * paths run under Node. Run with:  node test/foodlookup.test.js
 */
"use strict";
var fl = require("../meal-plan/food-lookup.js");

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok  - " + name); }
  else { fail++; console.log("  FAIL- " + name + (extra ? "  " + extra : "")); }
}

// Catalog lines are positional arrays:
// [code, name, brand, country, serving_size, serving_unit, fiber, carbs, fat, protein]
var CATALOG_TEXT = [
  '["737628064502","Whole milk","Valio","fi",100,"ml",0,4.8,3.5,3.3]',
  '["111","Skimmed milk","Arla","fi",100,"ml",0,5,0.1,3.4]',
  '["222","Rolled oats","Elovena","fi",100,"g",10,60,7,13]',
  '',                                       // blank line — must be skipped
  'not json',                               // garbage — must be skipped
  '["333","Olive oil","Bertolli","fi",100,"ml",0,0,100,0]'
].join("\n");

// ---- parsing ----
console.log("== parse ==");
var cat = fl.parseCatalog(CATALOG_TEXT);
ok("parses valid lines, skips blank/garbage", cat.length === 4, "len=" + cat.length);
ok("positional mapping: code", cat[0].code === "737628064502");
ok("positional mapping: name", cat[0].name === "Whole milk");
ok("positional mapping: protein@idx9", cat[0].protein === 3.3, "got " + cat[0].protein);
ok("derives Atwater kcalEst", cat[0].kcalEst === Math.round(4 * 3.3 + 4 * 4.8 + 9 * 3.5),
   "got " + cat[0].kcalEst);

// ---- search ----
console.log("\n== search ==");
var milk = fl.searchFoods(cat, "milk", 10);
ok("'milk' returns candidates", milk.length === 2, "len=" + milk.length);
ok("'milk' candidates are milks", milk.every(function (r) { return /milk/i.test(r.name); }));
ok("multi-term 'whole milk' ranks the exact one first", fl.searchFoods(cat, "whole milk")[0].name === "Whole milk");
ok("descriptive 'grilled whole milk' still finds it (cooking words ignored)",
   (fl.searchFoods(cat, "grilled whole milk")[0] || {}).name === "Whole milk");
ok("no match returns empty", fl.searchFoods(cat, "zzzz").length === 0);

// searchFoodsMulti: a food found by its English name OR a local-language synonym.
// This is the language bridge — the model names "rolled oats" but a Finnish shelf
// says "kaurahiutaleet"; matching must succeed via the local term.
var FI = fl.parseCatalog([
  '["k1","Kaurahiutaleet","Elovena","fi",100,"g",10,60,7,13]',  // = rolled oats
  '["k2","Broilerin rintafilee","Kariniemen","fi",100,"g",0,0,2,23]', // = chicken breast
  '["k3","Rasvaton maitojuoma","Valio","fi",100,"ml",0,5,0.1,3.4]'    // = skimmed milk
].join("\n"));
ok("English-only query misses the Finnish shelf (the bug)", fl.searchFoods(FI, "rolled oats").length === 0);
ok("multi-search finds it via the local synonym",
   (fl.searchFoodsMulti(FI, ["rolled oats", "kaurahiutaleet", "kaura"], 1)[0] || {}).code === "k1");
ok("multi-search still works when only the English term is given a match elsewhere",
   (fl.searchFoodsMulti(FI, ["chicken breast", "broileri", "kanan rintafilee"], 1)[0] || {}).code === "k2");
ok("multi-search with no usable term returns empty", fl.searchFoodsMulti(FI, ["zzz", "qqq"], 1).length === 0);
ok("multi-search tolerates an empty/blank query list", fl.searchFoodsMulti(FI, ["", null], 1).length === 0);

// ---- buildMealTotals ----
console.log("\n== buildMealTotals ==");
var products = {
  "222": { // measured oats
    product_name: "Rolled oats", brands: "Elovena",
    breakdown: {
      macros: { energy_kcal: 379, fat: 7, proteins: 13, carbohydrates: 60, fiber: 10 },
      vitamins: { vitamin_b1: 0.5 },
      minerals: { iron: 4, magnesium: 140 },
      amino_acids: { leucine: 1.0 }
    }
  },
  "111": { // AI-estimated skimmed milk
    product_name: "Skimmed milk", brands: "Arla",
    breakdown: {
      macros: { energy_kcal: 35, fat: 0.1, proteins: 3.4, carbohydrates: 5 },
      minerals: { calcium: 120, iron: 0 }
    },
    ai_guesses: { model: "gpt-4o-mini", timestamp: "2026-01-01T00:00:00Z" }
  }
};
var totals = fl.buildMealTotals([{ code: "222", grams: 50 }, { code: "111", grams: 200 }], products);
// 50 g oats -> macros * 0.5 ; 200 g milk -> * 2
ok("protein summed+scaled", Math.abs(totals.totals.protein - (13 * 0.5 + 3.4 * 2)) < 0.01,
   "got " + totals.totals.protein);
ok("kcal summed+scaled", totals.totals.kcal === Math.round(379 * 0.5 + 35 * 2),
   "got " + totals.totals.kcal);
ok("fibre from oats only", Math.abs(totals.totals.fiber - (10 * 0.5)) < 0.01,
   "got " + totals.totals.fiber);
ok("micros: iron summed (oats 4*0.5 + milk 0*2)", Math.abs(totals.micros.minerals.iron - 2) < 0.01,
   "got " + totals.micros.minerals.iron);
ok("micros: calcium scaled (milk 120*2)", Math.abs(totals.micros.minerals.calcium - 240) < 0.01,
   "got " + totals.micros.minerals.calcium);
ok("estimated flag true (milk has ai_guesses)", totals.estimated === true);
ok("missing reported for unknown code",
   fl.buildMealTotals([{ code: "999", grams: 100 }], products).missing.length === 1);

// ---- decodeBrotli accepts an async (promise-returning) wasm decoder ----------
console.log("\n== decodeBrotli async fallback ==");
(function () {
  var plain = '["x","Async food",null,"fi",100,"g",1,2,3,4]';
  // No native brotli in Node for these bytes -> falls back to our async decoder,
  // which mimics a wasm module that loads/returns asynchronously.
  return fl.decodeBrotli(Buffer.from("ignored"), {
    brotliDecode: function () {
      return Promise.resolve(Buffer.from(plain, "utf8"));
    }
  }).then(function (text) {
    var cat = fl.parseCatalog(text);
    ok("async brotliDecode resolves to parseable text", cat.length === 1 && cat[0].name === "Async food",
       JSON.stringify(cat));
  });
})().then(runDispatch);

function runDispatch() {
// ---- dispatchTool end to end, with injected fetch + brotli (no live host) ----
console.log("\n== dispatchTool (injected I/O) ==");
function fakeFetch(url) {
  if (/catalog\.jsonl\.br$/.test(url)) {
    // pretend the bytes are already plain text; our injected brotliDecode is identity
    var bytes = Buffer.from(CATALOG_TEXT, "utf8");
    return Promise.resolve({ ok: true, status: 200,
      arrayBuffer: function () { return Promise.resolve(bytes); } });
  }
  var m = url.match(/products\/(\w+)\.json$/);
  if (m && products[m[1]]) {
    return Promise.resolve({ ok: true, status: 200,
      json: function () { return Promise.resolve(products[m[1]]); } });
  }
  return Promise.resolve({ ok: false, status: 404 });
}
var ctx = { fetch: fakeFetch, brotliDecode: function (u8) { return u8; } };

fl.dispatchTool("fi", "search_foods", { query: "oats" }, ctx).then(function (res) {
  ok("search_foods tool returns coded candidates", res.length === 1 && res[0].code === "222",
     JSON.stringify(res));
  return fl.dispatchTool("fi", "build_meal_totals",
    { items: [{ code: "222", grams: 100 }] }, ctx);
}).then(function (res) {
  ok("build_meal_totals tool sums via fetched product",
     res.totals.protein === 13 && res.totals.kcal === 379, JSON.stringify(res.totals));
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
}).catch(function (e) {
  console.log("  FAIL- dispatch threw: " + e.message);
  console.log("\n" + pass + " passed, " + (fail + 1) + " failed");
  process.exit(1);
});
}

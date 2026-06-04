/*
 * Tests for portionLabel — annotating a gram amount with a human unit so a plate
 * reads "70 g (~2 slices)" instead of just "70 g". Grams stay the source of truth;
 * the hint is added only when a food is eaten in discrete pieces and the rounded
 * unit count honestly reflects the grams. Halves are allowed for splittable foods
 * (½ banana) but never for things you can't split (½ egg).
 *
 * Run with:  node test/portion.test.js
 */
"use strict";
var planner = require("../meal-plan/planner.js");
var P = planner.portionLabel;

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok  - " + name); }
  else { fail++; console.log("  FAIL- " + name + (extra ? "  got: " + extra : "")); }
}

console.log("== guesstimate table (no catalog unit) ==");
ok("bread → slices", P("Wholegrain bread", null, 70) === "70 g (~2 slices)", P("Wholegrain bread", null, 70));
ok("one slice is singular", P("Rye bread", null, 35) === "35 g (~1 slice)", P("Rye bread", null, 35));
ok("eggs → eggs", P("Eggs", null, 100) === "100 g (~2 eggs)", P("Eggs", null, 100));
ok("one egg is singular", P("Boiled egg", null, 50) === "50 g (~1 egg)", P("Boiled egg", null, 50));
ok("banana allows a half", P("Banana", null, 177) === "177 g (~1½ bananas)", P("Banana", null, 177));
ok("one banana is singular", P("Banana", null, 118) === "118 g (~1 banana)", P("Banana", null, 118));

console.log("\n== honesty + non-discrete foods ==");
ok("a continuous food stays plain grams", P("Chicken breast", null, 150) === "150 g", P("Chicken breast", null, 150));
ok("12 g of egg is NOT labelled '1 egg'", P("Egg", null, 12) === "12 g", P("Egg", null, 12));
ok("rounds to the nearest whole egg", P("Eggs", null, 95) === "95 g (~2 eggs)", P("Eggs", null, 95));

console.log("\n== false-positive guards ==");
ok("eggplant is not eggs", P("Eggplant", null, 100) === "100 g", P("Eggplant", null, 100));
ok("banana bread is not bananas", /slice|^100 g$/.test(P("Banana bread", null, 70)) && !/banana\)/.test(P("Banana bread", null, 70)), P("Banana bread", null, 70));
ok("apple juice is not apples", P("Apple juice", null, 200) === "200 g", P("Apple juice", null, 200));

console.log("\n== catalog servingUnit wins when present ==");
ok("discrete catalog unit is used", P("Mystery loaf", { servingUnit: "slice", servingSize: 40 }, 80) === "80 g (~2 slices)",
   P("Mystery loaf", { servingUnit: "slice", servingSize: 40 }, 80));
ok("mass serving unit is ignored", P("Chicken", { servingUnit: "g", servingSize: 100 }, 150) === "150 g",
   P("Chicken", { servingUnit: "g", servingSize: 100 }, 150));
ok("implausible per-unit weight is ignored", P("Thing", { servingUnit: "pack", servingSize: 5000 }, 150) === "150 g",
   P("Thing", { servingUnit: "pack", servingSize: 5000 }, 150));

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);

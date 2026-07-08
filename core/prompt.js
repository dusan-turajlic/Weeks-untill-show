/*
 * LLM meal-plan / recipe / fix-up prompt builders + canonical JSON schemas.
 * Ported verbatim from index.html's "// ---- meal-plan prompt for an LLM"
 * region. Exposed as a factory closing over the caller's live state + plan
 * derivations, exactly how the app scoped these. Dual CommonJS export.
 */
"use strict";

var E = (typeof require !== "undefined") ? require("./energy.js") : (typeof window !== "undefined" ? window.YdinEnergy : this.YdinEnergy);
var F = (typeof require !== "undefined") ? require("./format.js") : (typeof window !== "undefined" ? window.YdinFormat : this.YdinFormat);

var fmt = F.fmt, fmt0 = F.fmt0, prettyDate = F.prettyDate;
var cyclePlan = E.cyclePlan;

var PLAN_SCHEMA = [
  "{",
  '  "type": "weeks-until-show-meal-plan",',
  '  "version": 1,',
  '  "country": "<my country>",',
  '  "currency": "<ISO code, e.g. EUR>",',
  '  "weeklyBudget": 0,',
  '  "summary": "<one or two sentence overview>",',
  '  "days": [',
  '    {',
  '      "label": "<e.g. Every day, or High day>",',
  '      "perWeek": 7,',
  '      "meals": [',
  '        { "name": "<e.g. Breakfast>", "items": [',
  '          { "food": "<product>", "amount": "<e.g. 80 g>", "kcal": 0, "protein": 0, "fat": 0, "carbs": 0, "fiber": 0 }',
  '        ] }',
  '      ],',
  '      "totals": { "kcal": 0, "protein": 0, "fat": 0, "carbs": 0, "fiber": 0 }',
  '    }',
  '  ],',
  '  "shoppingList": [',
  '    { "retailer": "<store name>", "items": [ { "name": "<product>", "qty": "1", "price": 0 } ] }',
  '  ],',
  '  "micronutrients": "<note on coverage, any shortfalls, and how fibre hits the floor>"',
  "}"
].join("\n");
var RECIPE_SCHEMA = [
  "{",
  '  "type": "weeks-until-show-recipes",',
  '  "mealId": "<the id I gave you, e.g. 0-1>",',
  '  "day": "<day label>",',
  '  "meal": "<meal name>",',
  '  "recipes": [',
  '    { "name": "<recipe name>", "minutes": 0, "steps": ["<step 1>", "<step 2>"], "notes": "<optional>" }',
  '  ]',
  "}"
].join("\n");

// deps: { state, plan, mealPlan, dayTotals }
//   state    — the live state object
//   plan     — a createPlan(state, today) instance (energyPlan/compute/weeksLeft)
//   mealPlan — the current imported plan (for recipe prompts), may be null
//   dayTotals— function(day) -> totals (for recipe prompts), may be omitted
function createPrompt(deps) {
  var state = deps.state, plan = deps.plan, dayTotals = deps.dayTotals;
  function getMealPlan() { return deps.mealPlan; }

  function dietStyleLabel() {
    if (state.pattern === "highlow") {
      var hd = parseInt(state.highDays, 10) === 1 ? 1 : 2;
      return "High / low carb (" + hd + " high-carb day" + (hd > 1 ? "s" : "") + " per week, protein held constant)";
    }
    if (state.pattern === "cycle") return "Carb cycling (high / medium / low carb days)";
    return "Even (the same calories and macros every day)";
  }

  function buildMealPlanPrompt() {
    var e = plan.energyPlan(); if (!e.valid) return "";
    var c = plan.compute(), bm = e.bm;
    var wU = state.unit, hU = state.unit === "lb" ? "in" : "cm";
    var hasGoal = isFinite(e.intake), cycling = hasGoal && e.macrosOk && state.pattern !== "even";
    var wl = plan.weeksLeft(), L = [];

    L.push("You are an expert nutritionist and meal-planning assistant. Help me build a meal plan around the targets below. These targets are already calculated — treat them as fixed inputs, not something to recompute.");
    L.push("");
    L.push("## My stats and targets");
    L.push("- Plan length: " + e.days + " days" + (wl != null ? " (~" + wl + " weeks)" : "") + ", ending " + prettyDate(state.endDate));
    if (isFinite(c.W)) L.push("- Current weight: " + fmt(c.W) + " " + wU);
    if (hasGoal && isFinite(c.final)) L.push("- Goal weight by the end date: " + fmt(c.final) + " " + wU);
    if (state.height !== "") L.push("- Height: " + state.height + " " + hU);
    L.push("- Maintenance energy: " + fmt0(bm.maint) + " kcal/day");
    if (hasGoal) L.push("- Daily calorie goal: " + fmt0(e.intake) + " kcal/day (a " + fmt0(e.foodDeficit) + " kcal/day deficit from food)");
    L.push("- Daily macro targets:");
    L.push("    - Protein: " + fmt0(e.protein) + " g (minimum — hit every day)");
    L.push("    - Fat: " + fmt0(e.fat) + " g (minimum — hit every day)");
    if (hasGoal && e.macrosOk) L.push("    - Carbs: ~" + fmt0(e.carbs) + " g");
    L.push("    - Fibre: at least " + e.fiber + " g per day");
    L.push("");
    if (cycling) {
      var hd = parseInt(state.highDays, 10) === 1 ? 1 : 2;
      var cp = cyclePlan({
        protein: e.protein, weightKg: bm.weightKg, intake: e.intake, maint: bm.maint,
        pattern: state.pattern, highDays: hd, carbFloor: e.fiber, fatMin: e.fat,
        stepDeficit: e.stepDeficit, kcalPerStep: e.kcalPerStep
      });
      L.push("### Calorie / macro style: " + dietStyleLabel());
      L.push("This is a cycling plan — match each day type's macros. The daily figures above are the weekly average.");
      cp.days.forEach(function (d) {
        L.push("- " + d.label + " day ×" + d.count + "/week: " + fmt0(d.kcal) + " kcal · " + fmt0(d.protein) + " g protein · " + fmt0(d.fat) + " g fat · " + fmt0(d.carbs) + " g carbs");
      });
    } else {
      L.push("Calorie / macro style: " + dietStyleLabel() + ".");
    }
    L.push("");
    L.push("## Non-negotiable nutrition rules");
    L.push("1. Micronutrient density is a TOP priority. Pick whole foods that maximise vitamins and minerals — pay special attention to iron, calcium, magnesium, potassium, zinc, iodine, B12, folate, vitamin D and omega-3. Call out any micronutrient likely to fall short and suggest a fix.");
    L.push("2. Fibre must be at least " + e.fiber + " g per day.");
    L.push("3. Hit the protein and fat minimums every day and stay within the calorie goal.");
    L.push("");
    L.push("## Before building anything, ASK ME these questions and wait for my answers");
    L.push("1. **Which country / region do I live in?** Use this to pull realistic, locally available products from the Open Food Facts database (openfoodfacts.org), and to know which major supermarket chains I can actually shop at.");
    L.push("2. **What is my weekly food budget?** (tell me the currency and amount). Build the plan to fit it, and base costs on CURRENT, real local prices — look them up (web search / the retailers' present pricing); do NOT guess from memory or use outdated figures. Do NOT default to expensive staples like salmon and beef on a tight budget; scale the protein and fat sources to what the budget realistically allows today.");
    L.push("3. **What are my dietary preferences and restrictions?** For example: vegetarian, vegan, pescatarian, halal, kosher, any food allergies or intolerances, and foods I simply dislike.");
    L.push("   - IMPORTANT: these preferences are completely separate from the calorie / macro style above. I might (for example) be vegan *and* carb cycling — the two are independent. Do not infer my restrictions from my calorie plan, and do not change my calorie plan because of my restrictions.");
    L.push("4. **How many meals per day do I want?** (e.g. 3 main meals, or 4–5 smaller ones). Split each day's calories and macros across exactly that many meals.");
    L.push("");
    L.push("## Then produce");
    L.push("1. A meal plan that hits every target above" + (cycling ? " for each day type" : "") + ", split into the number of meals I asked for, using products that actually exist in my country (cross-check against Open Food Facts).");
    L.push("2. A consolidated weekly shopping list. For each item, note which major retailer(s) in my country stock it, with current real prices (look them up — don't estimate from old knowledge), and keep the total within my stated budget.");
    L.push("3. A short summary of the micronutrient coverage and how the plan reaches at least " + e.fiber + " g of fibre per day.");
    L.push("");
    L.push("## Finally, output the plan as JSON so I can import it into my app");
    L.push("Once I'm happy with the plan, print it once more as a single fenced ```json code block (nothing but JSON inside the fence) in exactly this shape. Use plain numbers for every kcal / macro / price field (no units inside the numbers — put units in the `amount` strings). Give per-day figures for each day type, one entry in `meals` per meal I asked for, and group the shopping list by retailer.");
    L.push("```json");
    L.push(PLAN_SCHEMA);
    L.push("```");
    return L.join("\n");
  }

  function buildRecipePrompt(di, mi) {
    var mealPlan = getMealPlan();
    if (!mealPlan || !mealPlan.days) return "";
    var d = mealPlan.days[di], m = d && d.meals && d.meals[mi];
    if (!m) return "";
    var t = dayTotals ? dayTotals({ meals: [m] }) : null, L = [];
    L.push("You are a recipe assistant. I have ONE fixed meal with set ingredients and macros. The ingredients, amounts, calories and macros must stay exactly the same — only the recipe (method, cuisine, flavour) may change, so I get variety without changing my nutrition.");
    L.push("");
    L.push("## The meal — do not change any of this");
    L.push("- Meal: " + (m.name || "Meal") + " (" + (d.label || "day") + ")");
    if (t) L.push("- Goal for this meal: " + t.kcal + " kcal · " + t.protein + " g protein · " + t.fat + " g fat · " + t.carbs + " g carbs" + (t.fiber != null ? " · " + t.fiber + " g fibre" : ""));
    L.push("- Ingredients (exact amounts):");
    (m.items || []).forEach(function (it) {
      var macro = [];
      if (isFinite(it.kcal)) macro.push(Math.round(it.kcal) + " kcal");
      var pf = [];
      if (isFinite(it.protein)) pf.push("P" + Math.round(it.protein));
      if (isFinite(it.fat)) pf.push("F" + Math.round(it.fat));
      if (isFinite(it.carbs)) pf.push("C" + Math.round(it.carbs));
      if (pf.length) macro.push(pf.join(" "));
      L.push("    - " + (it.food || it.name || "") + (it.amount ? " — " + it.amount : "") + (macro.length ? " (" + macro.join(" · ") + ")" : ""));
    });
    L.push("");
    L.push("## Rules");
    L.push("- Every recipe must use exactly these ingredients in these amounts — no additions, swaps or removals. Water, salt, pepper and basic spices are fine and don't count.");
    L.push("- Calories and macros are identical for every recipe (they come from the ingredients above). Do not recalculate or change them.");
    L.push("- Vary the cooking method, cuisine and flavour so each recipe feels like a genuinely different meal.");
    L.push("- Respect any dietary preferences and restrictions I told you when we built the plan.");
    L.push("");
    L.push("## Give me 3–5 recipes, then output them as JSON so I can save them");
    L.push("After listing the recipes for me to read, print a single fenced ```json code block (nothing but JSON inside) in exactly this shape. Keep the mealId, day and meal exactly as given so my app can file them against the right meal:");
    L.push("```json");
    L.push(RECIPE_SCHEMA.replace('"<the id I gave you, e.g. 0-1>"', JSON.stringify(di + "-" + mi))
      .replace('"<day label>"', JSON.stringify(d.label || ""))
      .replace('"<meal name>"', JSON.stringify(m.name || "")));
    L.push("```");
    return L.join("\n");
  }

  function fixupPlanPrompt(reason) {
    return "The JSON I pasted into my meal-plan app couldn't be imported.\n\nProblem: " + reason +
      "\n\nPlease output the FULL plan again as a single fenced ```json code block and nothing else — no prose inside the fence. " +
      "Match this structure exactly, use plain numbers for every kcal/macro/price field (no units inside the numbers), and make sure \"days\" is a non-empty array:\n\n" + PLAN_SCHEMA;
  }
  function fixupRecipePrompt(reason) {
    return "The recipe JSON I pasted into my meal-plan app couldn't be imported.\n\nProblem: " + reason +
      "\n\nPlease output the recipes again as a single fenced ```json code block and nothing else. " +
      "Keep the same mealId, day and meal you were given, include a non-empty \"recipes\" array, and match this structure exactly:\n\n" + RECIPE_SCHEMA;
  }
  function fixupGenericPrompt() {
    return "The text I pasted into my meal-plan app wasn't valid JSON it could read.\n\n" +
      "Please print ONLY a single fenced ```json code block (including the surrounding { }), with no text inside the fence, " +
      "matching the structure you used before. If it's a meal plan it must have a non-empty \"days\" array; " +
      "if it's recipes it must have \"type\": \"weeks-until-show-recipes\" and a \"recipes\" array.";
  }

  return {
    dietStyleLabel: dietStyleLabel, buildMealPlanPrompt: buildMealPlanPrompt,
    buildRecipePrompt: buildRecipePrompt, fixupPlanPrompt: fixupPlanPrompt,
    fixupRecipePrompt: fixupRecipePrompt, fixupGenericPrompt: fixupGenericPrompt
  };
}

var api = { createPrompt: createPrompt, PLAN_SCHEMA: PLAN_SCHEMA, RECIPE_SCHEMA: RECIPE_SCHEMA };
if (typeof module !== "undefined" && module.exports) module.exports = api;
else (typeof window !== "undefined" ? window : this).YdinPrompt = api;

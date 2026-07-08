/*
 * Calorie / macro / carb-cycling model. Extracted verbatim from the original
 * index.html so the shipped app and the Node tests share one source of truth.
 * Pure functions only — no DOM, no state. Dual CommonJS export.
 */
"use strict";

// ---- energy / macro constants & formulas --------------------------------
  var LB_TO_KG = 0.45359237, KG_TO_LB = 1/LB_TO_KG, IN_TO_CM = 2.54;
  var KCAL_PER_KG = 7700;            // ~energy in 1 kg of body weight (mostly fat)
  var KCAL_FAT = 9, KCAL_PROTEIN = 4, KCAL_CARB = 4;
  var MAX_FOOD_DEFICIT = 700;        // never cut more than this from food; steps cover the rest
  var MIN_PHASE_STEPS = 2000;        // a dieting phase always adds at least this many daily steps
  var FIBER_MIN = 35;                // g/day of fibre to aim for (counted within carbs)

  // Maintenance calories = bodyweight(lb) × a multiplier that tapers as weight
  // rises. Brackets are sex-specific; we use the midpoint of each range.
  // [upper-bound-lb (Infinity = top bracket), multiplier]
  var MAINT_MULT = {
    male:[[200,12],[250,10.5],[300,9],[400,7.5],[Infinity,6]],
    female:[[150,13.5],[200,11.5],[250,10.5],[300,9],[400,7.5],[Infinity,6]]
  };
  function maintMultiplier(sex, weightLb){
    var t = MAINT_MULT[sex] || MAINT_MULT.male;
    for(var i=0;i<t.length;i++){ if(weightLb < t[i][0]) return t[i][1]; }
    return t[t.length-1][1];
  }
  // "Prefer not to say" runs the male and female versions and averages them, so
  // every sex-keyed figure has a single, neutral path.
  function bySex(sex, fn){
    return sex==="neutral" ? (fn("male") + fn("female"))/2 : fn(sex);
  }
  function maintenanceCalories(sex, weightKg){
    var lb = weightKg * KG_TO_LB;
    return lb * bySex(sex, function(s){ return maintMultiplier(s, lb); });
  }

  // Minimum daily protein & fat (g) to protect muscle and hormones, keyed to
  // height. Reference points are in cm; we linearly interpolate (and clamp at
  // the ends). 1 in = 2.54 cm, so e.g. 5'9" = 175.26 cm.
  var MIN_PROTEIN = {
    male:[[160.02,135],[167.64,150],[175.26,165],[182.88,185],[190.5,205],[198.12,230]],
    female:[[144.78,90],[152.4,100],[160.02,115],[167.64,130],[175.26,145],[182.88,165]]
  };
  var MIN_FAT = {
    male:[[160.02,45],[167.64,52],[175.26,60],[182.88,70],[190.5,81],[198.12,93]],
    female:[[144.78,45],[152.4,50],[160.02,57],[167.64,65],[175.26,74],[182.88,85]]
  };
  function interp(table, x){
    if(x <= table[0][0]) return table[0][1];
    var last = table[table.length-1];
    if(x >= last[0]) return last[1];
    for(var i=1;i<table.length;i++){
      if(x <= table[i][0]){
        var a=table[i-1], b=table[i], f=(x-a[0])/(b[0]-a[0]);
        return a[1] + f*(b[1]-a[1]);
      }
    }
    return last[1];
  }
  function minProtein(sex, heightCm){ return bySex(sex, function(s){ return interp(MIN_PROTEIN[s], heightCm); }); }
  function minFat(sex, heightCm){ return bySex(sex, function(s){ return interp(MIN_FAT[s], heightCm); }); }

  // Net kcal burned per step. Stride ≈ 0.414·height; walking costs ≈0.5 kcal
  // per kg per km net of rest. Heavier/taller people burn more per step.
  function calcKcalPerStep(weightKg, heightCm){
    var strideM = (heightCm/100) * 0.414;
    return 0.5 * weightKg * strideM / 1000;
  }
  // Step goals are fuzzy estimates, so present them to the nearest 1,000.
  function roundSteps(n){ return isFinite(n) ? Math.round(n/1000)*1000 : NaN; }

  // ---- carb cycling --------------------------------------------------------
  // Lowest safe daily fat: the literature converges on ~0.5 g/kg/day during a
  // diet (to protect hormones and cover essential fatty acids). Cycling pins
  // fat at this floor every day to free as many calories as possible for carbs.
  var FAT_FLOOR_PER_KG = 0.5;
  function fatFloorG(weightKg){ return FAT_FLOOR_PER_KG * weightKg; }

  // Two eating patterns redistribute the same weekly calories across day types.
  // Protein and fat are held constant every day; only carbs move around.
  //
  //   • Carb cycle — low days carry their fat at LOW_FAT_PER_KG g/kg (above the
  //     0.5 g/kg floor) with carbs on the 35 g floor, which fixes their
  //     calories; the high & medium days split whatever's left (high = 35%
  //     carbs, medium = 35% fat). If a steep deficit would make low days
  //     out-eat the highs, low-day fat eases toward the floor.
  //   • High/Low — a pure carb shift off the even baseline: cut a fixed chunk
  //     of carbs from every low day and pile it onto the high day(s) as carbs.
  //     One high day cuts HIGHLOW_CUT_1H kcal/low-day; two high days cut
  //     HIGHLOW_CUT_2H each. Protein never moves; the week still totals
  //     7×intake. If a low day can't give up that many carbs without breaking
  //     the 35 g floor, we first trim the HIGH day's fat (from its height
  //     minimum down to HIGH_FAT_MIN_PER_KG g/kg) to make room for the carbs,
  //     and only what's left after that is walked off with steps on the high
  //     day.
  var CARB_CAL_SHARE = 0.35, FAT_CAL_SHARE = 0.35, LOW_FAT_PER_KG = 0.7;
  var HIGHLOW_CUT_1H = 100, HIGHLOW_CUT_2H = 150;   // carbs (kcal) pulled per low day
  var HIGH_FAT_MIN_PER_KG = 0.6;                     // how low a high day's fat may be trimmed

  function dayCounts(pattern, highDays){
    var h = highDays===1 ? 1 : 2;
    if(pattern==="highlow") return {high:h, med:0, low:7-h};
    if(pattern==="cycle")   return {high:1, med:2, low:4};
    return {high:0, med:0, low:7};
  }

  // Protein is fixed; one macro is set by the day type and the other is the
  // remainder. Fat never drops below the safe floor and carbs never below 35 g;
  // if a day is too low to hold protein + floor-fat + 35 g carbs, it rises to
  // that minimum feasible day and the surplus (`raisedBy`) is repaid with steps.
  //   carb35 (high) — carbs = 35% of calories, fat is the rest
  //   fat35 (medium)— fat = 35% of calories, carbs are the rest
  //   fixedFat (low/even) — fat = a set target, carbs are the rest
  function splitMacros(targetKcal, P, fatFloor, carbFloor, mode, fatSet){
    var fat, carbs;
    if(mode==="carb35"){ carbs = CARB_CAL_SHARE*targetKcal/4; fat = (targetKcal - 4*P - 4*carbs)/9; }
    else if(mode==="fat35"){ fat = FAT_CAL_SHARE*targetKcal/9; carbs = (targetKcal - 4*P - 9*fat)/4; }
    else { fat = fatSet; carbs = (targetKcal - 4*P - 9*fat)/4; }
    if(fat < fatFloor){ fat = fatFloor; carbs = (targetKcal - 4*P - 9*fatFloor)/4; }
    var kcal = targetKcal;
    if(carbs < carbFloor){
      carbs = carbFloor; fat = (targetKcal - 4*P - 4*carbFloor)/9;
      if(fat < fatFloor){ fat = fatFloor; kcal = 4*P + 9*fatFloor + 4*carbFloor; }
    }
    return { protein:P, fat:fat, carbs:carbs, kcal:kcal, raisedBy: kcal - targetKcal };
  }

  function cyclePlan(o){
    var P=o.protein, kg=o.weightKg, I=o.intake;
    var fatFloor=fatFloorG(kg), carbFloor=o.carbFloor||35;
    var baseStepEnergy=o.stepDeficit||0, kps=o.kcalPerStep||0;
    var n=dayCounts(o.pattern, o.highDays);

    // Even (or no high days): one day type at the goal intake, original split.
    if(n.high===0){
      var m0=splitMacros(I, P, fatFloor, carbFloor, "fixedFat", o.fatMin);
      return { pattern:o.pattern, fatFloor:fatFloor, carbFloor:carbFloor, lowFat:m0.fat,
               anyRaised:false, avgKcal:m0.kcal,
               days:[{key:"med", label:"Every day", count:7, kcal:m0.kcal, protein:m0.protein,
                      fat:m0.fat, carbs:m0.carbs, raised:false,
                      steps:(kps>0 ? roundSteps(baseStepEnergy/kps) : NaN)}] };
    }

    // High/Low — carb shift off the even baseline. Protein stays put; we pull a
    // fixed chunk of carbs from each low day and stack it onto the high day(s).
    // If the lows hit the 35 g carb floor before funding the full bump, trim the
    // high day's fat (down to a 0.6 g/kg minimum) to make room; only what's
    // still unfunded after that gets walked off with steps on the high day.
    if(o.pattern==="highlow"){
      var base = splitMacros(I, P, fatFloor, carbFloor, "fixedFat", o.fatMin); // even day
      var cut  = (n.high===1 ? HIGHLOW_CUT_1H : HIGHLOW_CUT_2H);               // kcal off each low day
      var lowCarbs   = Math.max(carbFloor, base.carbs - cut/4);
      var pulledPerLow = (base.carbs - lowCarbs)*4;          // kcal actually taken from a low day
      var pool       = cut * n.low;                          // carbs (kcal) the high day(s) get
      var shortfall  = pool - pulledPerLow*n.low;            // bump the lows couldn't fund

      // Trim high-day fat (height min → 0.6 g/kg) to absorb the shortfall first.
      var highFat = base.fat, highFatMin = Math.max(fatFloor, HIGH_FAT_MIN_PER_KG*kg);
      if(shortfall > 0 && highFat > highFatMin){
        var fatUsed = Math.min(shortfall, (highFat - highFatMin)*9*n.high);
        highFat   -= (fatUsed/n.high)/9;
        shortfall -= fatUsed;                                // remainder (if any) → steps
      }

      var highCarbs  = base.carbs + (pool/n.high)/4;
      var lowKcal    = 4*P + 9*base.fat + 4*lowCarbs;
      var highKcal   = 4*P + 9*highFat  + 4*highCarbs;
      var hlDays = [
        {key:"high",label:"High",count:n.high,kcal:highKcal,protein:P,fat:highFat, carbs:highCarbs,raised:false},
        {key:"low", label:"Low", count:n.low, kcal:lowKcal, protein:P,fat:base.fat,carbs:lowCarbs, raised:base.raisedBy>0.5}
      ];
      var hlExtraPerHigh = shortfall>0 ? shortfall/n.high : 0;
      hlDays.forEach(function(d){
        d.stepEnergy = baseStepEnergy + (d.key==="high" ? hlExtraPerHigh : 0);
        d.steps = kps>0 ? roundSteps(d.stepEnergy/kps) : NaN;
      });
      var hlWeekly = hlDays.reduce(function(s,d){ return s + d.kcal*d.count; }, 0);
      return { pattern:"highlow", days:hlDays, fatFloor:fatFloor, carbFloor:carbFloor,
               lowFat:base.fat, highFat:highFat, fatTrimmed:base.fat-highFat>0.5,
               anyRaised:shortfall>0.5, avgKcal:hlWeekly/7 };
    }

    // Carb cycle — low-day fat kept high, eased down only if it would make low
    // days out-eat the highs; high/medium split the leftover calories.
    var wSum = n.high*0.95 + n.med*0.85;
    var lowFat = Math.max(fatFloor, LOW_FAT_PER_KG*kg);
    function targets(lf){
      var lowKcal = 4*P + 9*lf + 4*carbFloor;          // high fat + floor carbs fixes low days
      var R = 7*I - n.low*lowKcal;                     // calories left for high + medium
      return { lowKcal:lowKcal, highKcal:R*0.95/wSum, medKcal:R*0.85/wSum };
    }
    var t = targets(lowFat);
    while(lowFat > fatFloor && t.highKcal <= t.lowKcal + 1){ lowFat -= 1; t = targets(lowFat); }

    // High/Low makes high days HIGH-CARB: fat to the floor, everything else
    // carbs. Carb cycle keeps 35%-carb high days and 35%-fat medium days.
    var defs=[];
    if(n.high) defs.push({key:"high",label:"High", count:n.high, kcal:t.highKcal, mode:"carb35", fatSet:o.fatMin});
    if(n.med)  defs.push({key:"med", label:"Medium",count:n.med,  kcal:t.medKcal,  mode:"fat35",  fatSet:o.fatMin});
    defs.push({key:"low", label:"Low", count:n.low, kcal:t.lowKcal, mode:"fixedFat", fatSet:lowFat});

    var days = defs.map(function(d){
      var m=splitMacros(d.kcal, P, fatFloor, carbFloor, d.mode, d.fatSet);
      return { key:d.key, label:d.label, count:d.count, kcal:m.kcal, protein:m.protein,
               fat:m.fat, carbs:m.carbs, raised:m.raisedBy>0.5, raisedBy:Math.max(0,m.raisedBy) };
    });
    // surplus from any raised day is repaid with steps on the HIGH day(s)
    var weeklyExtra = days.reduce(function(s,d){ return s + d.raisedBy*d.count; }, 0);
    var highCount   = days.reduce(function(s,d){ return s + (d.key==="high"?d.count:0); }, 0);
    var extraPerHigh = highCount>0 ? weeklyExtra/highCount : 0;
    days.forEach(function(d){
      d.stepEnergy = baseStepEnergy + (d.key==="high" ? extraPerHigh : 0);
      d.steps = kps>0 ? roundSteps(d.stepEnergy/kps) : NaN;
    });
    var weeklyKcal = days.reduce(function(s,d){ return s + d.kcal*d.count; }, 0);
    var lowDay = days.filter(function(d){return d.key==="low";})[0];
    return { pattern:o.pattern, days:days, fatFloor:fatFloor, carbFloor:carbFloor,
             lowFat: lowDay ? lowDay.fat : lowFat, anyRaised: weeklyExtra>0.5, avgKcal: weeklyKcal/7 };
  }

  
  var api = {
    maintMultiplier: maintMultiplier, bySex: bySex, maintenanceCalories: maintenanceCalories,
    interp: interp, minProtein: minProtein, minFat: minFat,
    calcKcalPerStep: calcKcalPerStep, roundSteps: roundSteps,
    fatFloorG: fatFloorG, dayCounts: dayCounts, splitMacros: splitMacros, cyclePlan: cyclePlan,
    LB_TO_KG: LB_TO_KG, KG_TO_LB: KG_TO_LB, IN_TO_CM: IN_TO_CM,
    KCAL_PER_KG: KCAL_PER_KG, KCAL_FAT: KCAL_FAT, KCAL_PROTEIN: KCAL_PROTEIN, KCAL_CARB: KCAL_CARB,
    MAX_FOOD_DEFICIT: MAX_FOOD_DEFICIT, MIN_PHASE_STEPS: MIN_PHASE_STEPS, FIBER_MIN: FIBER_MIN,
    FAT_FLOOR_PER_KG: FAT_FLOOR_PER_KG, LOW_FAT_PER_KG: LOW_FAT_PER_KG,
    CARB_CAL_SHARE: CARB_CAL_SHARE, FAT_CAL_SHARE: FAT_CAL_SHARE,
    HIGHLOW_CUT_1H: HIGHLOW_CUT_1H, HIGHLOW_CUT_2H: HIGHLOW_CUT_2H,
    HIGH_FAT_MIN_PER_KG: HIGH_FAT_MIN_PER_KG
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else (typeof window !== "undefined" ? window : this).YdinEnergy = api;

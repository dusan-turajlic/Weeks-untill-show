/*
 * Actual-progress + on/off-track indicator. Extracted verbatim from index.html.
 * These read the daily log and the plan, so they are exposed as a factory that
 * closes over the caller's state + logHistory (exactly how the app scopes them).
 * Dual CommonJS export.
 */
"use strict";

var DAY_MS = 24 * 60 * 60 * 1000;

function createProgress(state, logHistory) {
// ---- actual progress from the daily log ---------------------------------
  function progress(){
    if(logHistory.length===0) return {has:false};
    var first=logHistory[0], last=logHistory[logHistory.length-1];
    var days=Math.round((new Date(last.date+"T00:00:00") - new Date(first.date+"T00:00:00"))/DAY_MS);
    var change=first.weight-last.weight;          // positive = lost
    var weeks=days/7;
    return {has:true, first:first, last:last, days:days, count:logHistory.length,
            change:change, perWeek:weeks>0?change/weeks:0,
            pctChange:first.weight>0?change/first.weight*100:0};
  }

  // ---- on/off-track indicator --------------------------------------------
  // Trailing average of the most recent `windowDays` of entries, anchored on
  // the latest log date. Smooths out normal day-to-day fluctuation.
  function smoothedRecent(entries, windowDays){
    if(entries.length===0) return NaN;
    var last=entries[entries.length-1];
    var cutoff=new Date(last.date+"T00:00:00").getTime()-(windowDays-1)*DAY_MS;
    var sum=0, n=0;
    for(var i=entries.length-1;i>=0;i--){
      if(new Date(entries[i].date+"T00:00:00").getTime()>=cutoff){ sum+=entries[i].weight; n++; }
      else break;
    }
    return n>0 ? sum/n : last.weight;
  }

  // Compares your smoothed current weight against where the plan (start weight
  // losing pct% per week, compounded) says you should be by now, with a
  // tolerance band so normal fluctuation reads as "on track".
  var SMOOTH_DAYS=7, BAND_FRAC=0.01;   // balanced sensitivity
  function offTrack(){
    var p=progress(), r=parseFloat(state.pct)/100;
    if(!p.has || logHistory.length<2 || !isFinite(r) || r<=0 || p.days<=0) return {has:false};
    var weeks=p.days/7;
    var expected=p.first.weight*Math.pow(1-r,weeks);   // plan position now
    var smooth=smoothedRecent(logHistory,SMOOTH_DAYS);  // actual, denoised
    var gap=smooth-expected;                             // + = above plan (behind)
    var band=expected*BAND_FRAC;
    var status=gap>band ? "behind" : gap<-band ? "ahead" : "ontrack";
    // effective weekly compounded loss rate actually achieved, vs target
    var actualPctWk=(1-Math.pow(p.last.weight/p.first.weight,1/weeks))*100;
    return {has:true, status:status, gap:gap, smooth:smooth, expected:expected,
            targetPctWk:r*100, actualPctWk:actualPctWk};
  }

  
  return { progress: progress, offTrack: offTrack, BAND_FRAC: BAND_FRAC };
}

var api = { createProgress: createProgress, DAY_MS: DAY_MS };
if (typeof module !== "undefined" && module.exports) module.exports = api;
else (typeof window !== "undefined" ? window : this).YdinOffTrack = api;

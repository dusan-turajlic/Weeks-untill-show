"use client";

/*
 * On-device meal-plan build (Path A) — a faithful port of index.html's
 * runBuild()/attempt()/buildDeterministic() plus the build-timeline state
 * machine. The planner (meal-plan/planner.js) is used exactly as-is: it owns
 * WebLLM engine creation, the model walk, and the deterministic solver. This
 * hook is pure orchestration + the user-facing timeline.
 *
 * CLAUDE.md invariant preserved: every device attempts the real WebLLM model
 * FIRST (attempt()); the deterministic build is only the fallback when no model
 * can load. No mobile short-circuit.
 */

import { useCallback, useMemo, useReducer, useRef, useState } from "react";
import Planner from "@/meal-plan/planner.js";
import * as FLmod from "@/meal-plan/food-lookup.js";
import * as Plan from "@/core/plan.js";
import * as Energy from "@/core/energy.js";
import { useApp } from "@/components/store";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const FL: Any = FLmod;

const LS_BADMODELS = "wp:mp:badmodels";
const LS_MODELREADY = "wp:mp:modelready";
const LS_BUILDTIME = "wp:mp:buildms";

const BUILD_STEPS = [
  { id: "init", title: "Getting your kitchen ready", detail: "Setting up…", bar: true },
  { id: "design", title: "Designing your meals", detail: "Choosing foods that fit your day." },
  { id: "foods", title: "Finding your local foods", detail: "Matching each food to your country's catalog." },
  { id: "portion", title: "Sizing your portions", detail: "Tuning amounts to hit every macro & fibre target." },
  { id: "writeup", title: "Writing up your plan", detail: "Checking each meal reads like real food." },
  { id: "ready", title: "Ready for your review", detail: "Your plan is ready — take a look." },
];
const STAGE_STEP: Record<string, string> = {
  start: "init", retry: "init", catalog: "init", download: "init", model: "init",
  choose: "design",
  guess: "foods", translate: "foods", fetch: "foods", check: "foods",
  solve: "portion",
  review: "writeup", assemble: "writeup", summarize: "writeup",
  done: "ready",
};
const INIT_PHRASES_FIRST = [
  "Setting things up for the first time — this can take a few minutes.",
  "This one-time setup happens only on your first plan.",
  "Getting everything ready to run privately on your device…",
  "Almost set — this only happens once, then it's instant.",
];
const INIT_PHRASES_RETURN = [
  "Warming up your on-device chef…",
  "Getting your kitchen ready…",
  "Nearly there…",
];

export interface TimelineStep {
  id: string;
  title: string;
  state: "done" | "active" | "upcoming" | "error";
  detail: string;
  frac: number | null;
}

function loadBadModels(): string[] {
  try { const a = JSON.parse(localStorage.getItem(LS_BADMODELS) || "[]"); return Array.isArray(a) ? a : []; } catch { return []; }
}
function blockModel(id: string) {
  if (!id) return; const a = loadBadModels();
  if (a.indexOf(id) < 0) { a.push(id); try { localStorage.setItem(LS_BADMODELS, JSON.stringify(a)); } catch { /* ignore */ } }
}
function loadBuildTimes(): number[] {
  try { const a = JSON.parse(localStorage.getItem(LS_BUILDTIME) || "[]"); return Array.isArray(a) ? a.filter(isFinite) : []; } catch { return []; }
}
function recordBuildTime(ms: number) {
  if (!isFinite(ms) || ms <= 0) return;
  const a = loadBuildTimes(); a.push(Math.round(ms)); while (a.length > 5) a.shift();
  try { localStorage.setItem(LS_BUILDTIME, JSON.stringify(a)); } catch { /* ignore */ }
}
function estimateText(): string {
  const a = loadBuildTimes(); if (!a.length) return "";
  const avg = a.reduce((x, y) => x + y, 0) / a.length; let sec = Math.round(avg / 1000);
  if (sec < 20) return "";
  if (sec < 90) { sec = Math.round(sec / 5) * 5; return "Usually about " + sec + " seconds"; }
  const m = Math.round(sec / 30) / 2; return "Usually about " + m + " minute" + (m === 1 ? "" : "s");
}

function nowMs(): number { return new Date().getTime(); }

export function useOnDeviceBuild() {
  const app = useApp();
  const [, force] = useReducer((x: number) => x + 1, 0);
  const [buildOpen, setBuildOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRetry, setShowRetry] = useState(false);
  const [title, setTitle] = useState("Preparing your plan");

  // Mutable build-timeline state (mirrors the original `buildTL`), kept in a ref
  // so frequent progress events don't churn React state; force() repaints.
  const tl = useRef<Any>({
    cur: null as string | null, sawLoad: false, loaded: false, err: false,
    phraseTimer: null as ReturnType<typeof setInterval> | null, phraseIx: 0,
    line: {} as Record<string, string>, result: {} as Record<string, string>, frac: {} as Record<string, number | null>,
    mealsPerDay: 0, startMs: 0, wasCached: false,
  });
  const activeRef = useRef(false);        // buildActive
  const watchdogRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastTickRef = useRef(0);

  const mpCache = useRef<Any>({ _c: {} as Record<string, Any>, get(k: string) { return this._c[k]; }, set(k: string, v: Any) { this._c[k] = v; } });

  // ---- day targets (same maths as buildMealPlanPrompt) --------------------
  const buildDayTargets = useCallback((): Any[] | null => {
    const state = app.state;
    const plan = Plan.createPlan(state, app.today);
    const e = plan.energyPlan();
    if (!e.valid) return null;
    const bm = e.bm, hasGoal = isFinite(e.intake);
    const cycling = hasGoal && e.macrosOk && state.pattern !== "even";
    if (cycling) {
      const hd = parseInt(state.highDays, 10) === 1 ? 1 : 2;
      const cp = Energy.cyclePlan({
        protein: e.protein, weightKg: bm.weightKg, intake: e.intake, maint: bm.maint,
        pattern: state.pattern, highDays: hd, carbFloor: e.fiber, fatMin: e.fat,
        stepDeficit: e.stepDeficit, kcalPerStep: e.kcalPerStep,
      });
      return cp.days.map((d: Any) => ({
        key: d.key, label: d.label + " day", count: d.count, perWeek: d.count,
        kcal: Math.round(d.kcal), protein: Math.round(d.protein), fat: Math.round(d.fat),
        carbs: Math.round(d.carbs), fiber: e.fiber,
      }));
    }
    return [{
      key: "even", label: "Every day", count: 7, perWeek: 7,
      kcal: Math.round(isFinite(e.intake) ? e.intake : bm.maint),
      protein: Math.round(e.protein), fat: Math.round(e.fat),
      carbs: Math.round(isFinite(e.carbs) ? e.carbs : 0), fiber: e.fiber,
    }];
  }, [app.state, app.today]);

  // ---- timeline helpers ---------------------------------------------------
  const stopInitPhrases = useCallback(() => {
    if (tl.current.phraseTimer) { clearInterval(tl.current.phraseTimer); tl.current.phraseTimer = null; }
  }, []);
  const startInitPhrases = useCallback(() => {
    if (tl.current.phraseTimer) return;
    const first = !localStorage.getItem(LS_MODELREADY);
    const phrases = first ? INIT_PHRASES_FIRST : INIT_PHRASES_RETURN;
    tl.current.phraseIx = 0;
    tl.current.line.init = phrases[0];
    force();
    tl.current.phraseTimer = setInterval(() => {
      if (tl.current.cur !== "init") { stopInitPhrases(); return; }
      tl.current.phraseIx = (tl.current.phraseIx + 1) % phrases.length;
      tl.current.line.init = phrases[tl.current.phraseIx];
      force();
    }, 3600);
  }, [stopInitPhrases]);

  const resetBuildTimeline = useCallback(() => {
    tl.current.cur = "init"; tl.current.sawLoad = false; tl.current.loaded = false; tl.current.err = false;
    tl.current.line = {}; tl.current.result = {}; tl.current.frac = {};
    if (tl.current.mealsPerDay > 0) {
      tl.current.result.design = tl.current.mealsPerDay + " meal" + (tl.current.mealsPerDay === 1 ? "" : "s") + " designed";
    }
    stopInitPhrases();
    force();
    startInitPhrases();
  }, [startInitPhrases, stopInitPhrases]);

  const advanceStep = useCallback((id: string) => {
    const ni = BUILD_STEPS.findIndex((s) => s.id === id); if (ni < 0) return;
    const ci = tl.current.cur ? BUILD_STEPS.findIndex((s) => s.id === tl.current.cur) : -1;
    if (ni <= ci) return;
    tl.current.cur = id; force();
  }, []);

  const setBuildProgress = useCallback((stage: string, detail: string, frac: number | null) => {
    const t = tl.current;
    if (t.err) return;
    if (stage === "retry") { resetBuildTimeline(); return; }
    if (stage === "catalog") {
      advanceStep("init");
      if (detail && /foods/i.test(detail)) { t.result.init = detail; force(); }
      return;
    }
    if (stage === "download" || stage === "model") {
      t.sawLoad = true; advanceStep("init"); startInitPhrases();
      t.frac.init = (frac == null || !isFinite(frac)) ? null : frac; force();
      return;
    }
    if (stage === "generate") {
      if (!t.loaded) { t.loaded = true; try { localStorage.setItem(LS_MODELREADY, "1"); } catch { /* ignore */ } }
      if (t.cur === "init") { stopInitPhrases(); if (!t.result.init) t.result.init = "Your on-device model is ready"; advanceStep("design"); }
      return;
    }
    const target = STAGE_STEP[stage];
    if (!target) return;
    if (target === "design" && !t.sawLoad && !t.loaded) { advanceStep("init"); return; }
    if (target !== "init") {
      t.loaded = true; stopInitPhrases();
      if (!t.result.init) t.result.init = "Your on-device model is ready";
      try { localStorage.setItem(LS_MODELREADY, "1"); } catch { /* ignore */ }
    }
    advanceStep(target);
    if (target !== "init") {
      if (detail) t.line[target] = detail;
      t.frac[target] = (frac == null || !isFinite(frac)) ? null : frac;
      force();
    }
  }, [advanceStep, resetBuildTimeline, startInitPhrases, stopInitPhrases]);

  const showBuildError = useCallback((msg: string) => {
    activeRef.current = false; tl.current.err = true; stopInitPhrases();
    setTitle("Couldn’t finish on-device");
    setError(msg); setShowRetry(true); setBuildOpen(true); force();
  }, [stopInitPhrases]);

  // ---- run ----------------------------------------------------------------
  const runBuild = useCallback((ans: Any) => {
    const dayTargets = buildDayTargets();
    if (!dayTargets) return;
    activeRef.current = true;
    setError(null); setShowRetry(false); setTitle("Preparing your plan"); setBuildOpen(true);
    tl.current.mealsPerDay = Math.max(1, (ans.mealsPerDay | 0) || 3);
    tl.current.wasCached = !!localStorage.getItem(LS_MODELREADY);
    tl.current.startMs = nowMs();
    resetBuildTimeline();
    setBuildProgress("start", "Setting up…", null);

    const io = { base: FL.DEFAULT_BASE, cache: mpCache.current };
    const tried: string[] = [];
    const aiErr = "Couldn’t get an on-device model to run on this device — your GPU may be unsupported, or memory is too tight. Tap Try again, or use the copy-prompt path (it always works).";

    lastTickRef.current = nowMs();
    const bump = () => { lastTickRef.current = nowMs(); };
    const stopWatch = () => { if (watchdogRef.current) clearInterval(watchdogRef.current); watchdogRef.current = null; };
    watchdogRef.current = setInterval(() => {
      if (!activeRef.current) { stopWatch(); return; }
      if (nowMs() - lastTickRef.current > 150000) {
        stopWatch(); activeRef.current = false;
        showBuildError("The on-device build stalled with no progress — your connection or this device may be the cause. Tap Try again, or use the copy-prompt path (it always works).");
      }
    }, 5000);

    const onSuccess = (plan: Any, lite: boolean) => {
      const norm = plan;
      if (!norm || !Array.isArray(norm.days) || !norm.days.length) {
        showBuildError("The plan came back without any days. Tap Try again, or use the copy-prompt path."); return;
      }
      activeRef.current = false; stopInitPhrases();
      if (tl.current.wasCached && tl.current.startMs) recordBuildTime(nowMs() - tl.current.startMs);
      void lite;
      app.setMeal({ mealPlan: norm, mealDay: 0, mealEditor: null, mealPlanPending: true });
      tl.current.cur = "ready"; force();
      setBuildOpen(false); app.setTab("meal");
    };

    const buildDeterministic = () => {
      setBuildProgress("choose", "Building your plan…", null);
      const io2 = { base: FL.DEFAULT_BASE, cache: mpCache.current };
      Planner.buildPlan({
        dayTargets, cc: ans.cc, country: ans.country, prefs: ans.prefs,
        breakfast: ans.breakfast, mealsPerDay: ans.mealsPerDay, calorieSplit: ans.calorieSplit, io: io2,
        onProgress: (stage: string, detail: string, frac: number | null) => { bump(); setBuildProgress(stage, detail, frac == null ? null : frac); },
      }).then((plan: Any) => { stopWatch(); onSuccess(plan, true); })
        .catch((err: Any) => {
          stopWatch();
          showBuildError((err && err.message) ? err.message : "Couldn’t build the plan — the country catalog may be unreachable. The copy-prompt path always works.");
        });
    };

    const attempt = () => {
      let currentModel: string | null = null;
      let engine: Any;
      const disposeEngine = () => {
        try {
          if (!(engine && engine.dispose)) return Promise.resolve();
          return Promise.race([
            Promise.resolve(engine.dispose()).catch(() => { }),
            new Promise<void>((r) => setTimeout(r, 4000)),
          ]);
        } catch { return Promise.resolve(); }
      };
      try {
        engine = Planner.createWebLLMEngine({
          blocklist: loadBadModels().concat(tried),
          onPick: (id: string, _caps: Any, info: Any) => {
            bump(); currentModel = id;
            const mem = (info && info.deviceMemory) ? " · ~" + info.deviceMemory + " GB RAM" : "";
            setBuildProgress("model", "Preparing " + id + mem + "…", null);
          },
          onProgress: (stage: string, txt: string, frac: number | null) => { bump(); setBuildProgress(stage, txt, frac); },
        });
      } catch { stopWatch(); showBuildError(aiErr); return; }

      const env = Planner.browserEnv();
      const votes = env.isIOS ? 1 : (env.isMobile ? 2 : 3);
      Planner.buildPlan({
        dayTargets, cc: ans.cc, country: ans.country, prefs: ans.prefs,
        breakfast: ans.breakfast, mealsPerDay: ans.mealsPerDay, calorieSplit: ans.calorieSplit,
        io, engine, votes,
        onProgress: (stage: string, detail: string, frac: number | null) => { bump(); setBuildProgress(stage, detail, frac == null ? null : frac); },
      }).then((plan: Any) => {
        return disposeEngine().then(() => { stopWatch(); onSuccess(plan, false); });
      }).catch((err: Any) => {
        return disposeEngine().then(() => {
          if (err && err.aiFailure && currentModel) {
            blockModel(currentModel); tried.push(currentModel);
            if (tried.length < 8) {
              bump(); setBuildProgress("retry", "That model didn’t respond — trying a different on-device model…", null);
              attempt(); return;
            }
            bump(); buildDeterministic(); return;
          }
          if (err && (err.aiFailure || /No on-device model fits/i.test(err.message || ""))) {
            bump(); buildDeterministic(); return;
          }
          stopWatch();
          showBuildError((err && err.message) ? err.message : "Something went wrong building on-device. The country catalog may be unreachable — the copy-prompt path always works.");
        });
      });
    };

    // Mobile is a first-class target for the on-device MODEL — attempt it first.
    attempt();
  }, [app, buildDayTargets, resetBuildTimeline, setBuildProgress, showBuildError, stopInitPhrases]);

  const closeBuild = useCallback(() => {
    activeRef.current = false; stopInitPhrases();
    if (watchdogRef.current) { clearInterval(watchdogRef.current); watchdogRef.current = null; }
    setBuildOpen(false);
  }, [stopInitPhrases]);

  const retry = useCallback(() => {
    try { localStorage.removeItem(LS_BADMODELS); } catch { /* ignore */ }
    if (app.lastWizAnswers) runBuild(app.lastWizAnswers);
  }, [app.lastWizAnswers, runBuild]);

  // ---- derived timeline for the modal -------------------------------------
  const t = tl.current;
  const curIx = t.cur ? BUILD_STEPS.findIndex((s) => s.id === t.cur) : -1;
  const timeline: TimelineStep[] = BUILD_STEPS.map((s, i) => {
    const allDone = t.cur === "ready";
    const state: TimelineStep["state"] = t.err && i === curIx ? "error"
      : allDone ? "done" : i < curIx ? "done" : i === curIx ? "active" : "upcoming";
    const detail = state === "done" ? (t.result[s.id] || t.line[s.id] || s.detail || "") : (t.line[s.id] || s.detail || "");
    const f = t.frac[s.id];
    return { id: s.id, title: s.title, state, detail: t.err && i === curIx ? "Stopped here." : detail, frac: f == null || !isFinite(f) ? null : f };
  });
  const meta = useMemo(() => {
    const total = BUILD_STEPS.length;
    const est = t.wasCached ? estimateText() : "";
    return (est ? est + " · " : "") + "Step " + Math.min(curIx + 1, total) + " of " + total;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curIx, t.wasCached]);

  return {
    buildOpen, error, showRetry, title, timeline, meta,
    canBuild: () => !!buildDayTargets(),
    runBuild, closeBuild, retry,
  };
}

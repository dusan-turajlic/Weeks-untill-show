"use client";

/*
 * On-device build UI (Path A): the WebGPU gate, the build wizard, and the build
 * timeline modal. Exposes a context so the "Build a plan on this device" button
 * (on the Projection tab) and the calorie-split rebuild picker (on the Meal tab)
 * can trigger the flow. Orchestration lives in useOnDeviceBuild.
 */

import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import Planner from "@/meal-plan/planner.js";
import * as FLmod from "@/meal-plan/food-lookup.js";
import { useApp } from "@/components/store";
import { useOnDeviceBuild, type TimelineStep } from "@/hooks/useOnDeviceBuild";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const FL: Any = FLmod;

const WIZ_COUNTRIES: [string, string, string][] = [
  ["fi", "Finland", "EUR"], ["se", "Sweden", "SEK"], ["no", "Norway", "NOK"], ["dk", "Denmark", "DKK"],
  ["gb", "United Kingdom", "GBP"], ["ie", "Ireland", "EUR"], ["de", "Germany", "EUR"], ["fr", "France", "EUR"],
  ["es", "Spain", "EUR"], ["it", "Italy", "EUR"], ["nl", "Netherlands", "EUR"], ["be", "Belgium", "EUR"],
  ["pl", "Poland", "PLN"], ["pt", "Portugal", "EUR"], ["us", "United States", "USD"], ["ca", "Canada", "CAD"],
  ["au", "Australia", "AUD"], ["nz", "New Zealand", "NZD"],
];

interface BuildContextValue {
  openWizard: () => void;
  applyAnswer: (questionId: string, optionId: string) => void;
}
const BuildContext = createContext<BuildContextValue | null>(null);
export function useBuild(): BuildContextValue {
  const ctx = useContext(BuildContext);
  if (!ctx) throw new Error("useBuild must be used within <BuildProvider>");
  return ctx;
}

export function BuildProvider({ children }: { children: React.ReactNode }) {
  const app = useApp();
  const build = useOnDeviceBuild();

  const [wizOpen, setWizOpen] = useState(false);
  const [cc, setCc] = useState("");
  const [prefs, setPrefs] = useState("");
  const [breakfast, setBreakfast] = useState("savory");
  const [meals, setMeals] = useState(3);
  const [mobileWarn, setMobileWarn] = useState(false);

  // WebGPU gate — reveal the on-device button when the GPU is usable (and always
  // on iOS, where the probe is unreliable). Sets data-webgpu, which the ported
  // CSS keys off (#mealLocalBtn is display:none until then).
  useEffect(() => {
    const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
    const isIOS = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1);
    const gpuPresent = typeof navigator !== "undefined" && !!(navigator as Any).gpu;
    const show = () => { document.documentElement.dataset.webgpu = "1"; };
    if (isIOS || gpuPresent) show();
    if (FL && FL.detectWebGPU) { FL.detectWebGPU().then((has: boolean) => { if (has) show(); }).catch(() => { }); }
  }, []);

  const openWizard = () => {
    if (!build.canBuild()) {
      alert("Add your details on the Projection tab first, so I have your targets.");
      return;
    }
    try { const env = Planner.browserEnv(); setMobileWarn(!!env.isMobile); } catch { /* ignore */ }
    const mem = app.lastWizAnswers as Any;
    if (mem) {
      if (mem.cc) setCc(mem.cc);
      if (mem.prefs) setPrefs(mem.prefs);
      if (mem.breakfast) setBreakfast(mem.breakfast);
      if (mem.mealsPerDay) setMeals(parseInt(mem.mealsPerDay, 10) || 3);
    }
    setWizOpen(true);
  };

  const startBuild = () => {
    const country = (WIZ_COUNTRIES.find((c) => c[0] === cc) || [cc, cc, ""])[1];
    const answers = { cc, country, prefs: prefs.trim(), breakfast, mealsPerDay: meals };
    app.setMeal({ lastWizAnswers: answers }); // persist plan memory
    setWizOpen(false);
    build.runBuild(answers);
  };

  const applyAnswer = (questionId: string, optionId: string) => {
    const next = Planner.mergeAnswer(app.lastWizAnswers, questionId, optionId);
    app.setMeal({ lastWizAnswers: next });
    build.runBuild(next);
  };

  return (
    <BuildContext.Provider value={{ openWizard, applyAnswer }}>
      {children}
      <WizardModal
        open={wizOpen}
        cc={cc} prefs={prefs} breakfast={breakfast} meals={meals} mobileWarn={mobileWarn}
        onCc={setCc} onPrefs={setPrefs} onBreakfast={setBreakfast} onMeals={setMeals}
        onCancel={() => setWizOpen(false)} onStart={startBuild}
      />
      <BuildModal
        open={build.buildOpen} title={build.title} timeline={build.timeline}
        meta={build.meta} error={build.error} showRetry={build.showRetry}
        onClose={build.closeBuild} onRetry={build.retry}
      />
    </BuildContext.Provider>
  );
}

function WizardModal(props: {
  open: boolean; cc: string; prefs: string; breakfast: string; meals: number; mobileWarn: boolean;
  onCc: (v: string) => void; onPrefs: (v: string) => void; onBreakfast: (v: string) => void; onMeals: (v: number) => void;
  onCancel: () => void; onStart: () => void;
}) {
  const selectStyle: React.CSSProperties = { flex: 1, border: "none", outline: "none", background: "transparent", fontSize: 18, fontFamily: "var(--serif)", color: "var(--ink)", padding: "11px 0" };
  return (
    <div className="modal full" id="wizModal" hidden={!props.open} onClick={(e) => { if (e.target === e.currentTarget) props.onCancel(); }}>
      <div className="sheet wide" role="dialog" aria-modal="true" aria-labelledby="wizTitle">
        <div className="sheetinner">
          <h2 id="wizTitle">Build a plan on this device</h2>
          <p className="sub" style={{ margin: "0 0 4px" }}>Private — an in-browser AI picks foods from your country&apos;s catalog and the on-device solver sizes every portion to hit your macro &amp; fibre targets. Nothing leaves this device. This plan is <strong>nutrition-only — it is not price-aware</strong> (an offline model can&apos;t know current prices); for a budget- and price-based plan, use <strong>Copy prompt</strong> instead. The model downloads once (up to a few GB) and runs locally, so the first build can take several minutes.</p>
          <div>
            <label className="field"><span className="flabel">Country</span>
              <div className="ibox">
                <select style={selectStyle} value={props.cc} onChange={(e) => props.onCc(e.target.value)}>
                  {WIZ_COUNTRIES.map((c) => <option key={c[0]} value={c[0]} data-curr={c[2]}>{c[1]}</option>)}
                </select>
              </div>
            </label>
            <label className="field"><span className="flabel">Dietary preferences / restrictions</span>
              <div className="ibox"><input type="text" placeholder="e.g. vegetarian, halal, no nuts (optional)" value={props.prefs} onChange={(e) => props.onPrefs(e.target.value)} /></div>
            </label>
            <label className="field"><span className="flabel">Breakfast style</span>
              <div className="seg" role="group">
                {(["savory", "sweet", "either"] as const).map((v) => (
                  <button key={v} type="button" className={props.breakfast === v ? "on" : undefined} onClick={() => props.onBreakfast(v)}>{v[0].toUpperCase() + v.slice(1)}</button>
                ))}
              </div>
            </label>
            <label className="field"><span className="flabel">Meals per day</span>
              <div className="seg" role="group">
                {[3, 4, 5, 2].map((n) => (
                  <button key={n} type="button" className={props.meals === n ? "on" : undefined} onClick={() => props.onMeals(n)}>{n} meals</button>
                ))}
              </div>
            </label>
            <p className="hint">Needs the catalog and the model to be reachable online the first time. The plan hits your nutrition targets but does not price the shopping list. {props.mobileWarn ? <span>Heads up: the bigger model can run out of memory on phones — a laptop/desktop is more reliable.</span> : null}</p>
          </div>
          <div className="actions">
            <button type="button" className="mbtn cancel" onClick={props.onCancel}>Cancel</button>
            <button type="button" className="mbtn go" onClick={props.onStart}>Build my plan</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function TimelineIcon() {
  return <svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" /></svg>;
}
function ClockIcon() {
  return <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
}

function BuildModal(props: {
  open: boolean; title: string; timeline: TimelineStep[]; meta: string; error: string | null; showRetry: boolean;
  onClose: () => void; onRetry: () => void;
}) {
  const metaRef = useRef<HTMLParagraphElement>(null);
  return (
    <div className="modal" id="buildModal" hidden={!props.open}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="buildTitle">
        <h2 id="buildTitle">{props.title}</h2>
        <p className="sub" style={{ margin: "0 0 4px" }}>Everything runs privately on this device.</p>
        <p className="tlmeta" ref={metaRef}><ClockIcon /><span>{props.meta}</span></p>
        <ol className="tl">
          {props.timeline.map((s) => (
            <li className="tlstep" key={s.id} data-step={s.id} data-state={s.state}>
              <span className="tlmark"><TimelineIcon /></span>
              <div className="tlbody">
                <div className="tltitle">{s.title}</div>
                <div className="tldetail">{s.detail}</div>
                <div className="tlbar">
                  <div className={"tlbarfill" + (s.frac == null ? " indet" : "")} style={s.frac == null ? undefined : { width: Math.max(3, Math.min(100, Math.round(s.frac * 100))) + "%" }} />
                </div>
              </div>
            </li>
          ))}
        </ol>
        {props.error ? <pre className="fix">{props.error}</pre> : null}
        <div className="actions">
          <button type="button" className="mbtn cancel" onClick={props.onClose}>Close</button>
          {props.showRetry ? <button type="button" className="mbtn go" onClick={props.onRetry}>Try again</button> : null}
        </div>
      </div>
    </div>
  );
}

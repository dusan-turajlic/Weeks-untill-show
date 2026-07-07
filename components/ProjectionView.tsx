"use client";

/*
 * Projection view — the JSX port of the original index.html projection render().
 * All arithmetic comes from the shared core modules; this file only lays out the
 * same cards, in the same order, with the same classes, and wires inputs to the
 * store. SVG charts reproduce the original point math exactly.
 *
 * Every component is defined at module scope (never nested inside another
 * component's body) so React keeps them mounted across renders — inputs keep
 * focus and the copy buttons keep their transient state.
 */

import React, { useMemo, useRef, useState } from "react";
import * as Plan from "@/core/plan.js";
import * as Energy from "@/core/energy.js";
import * as Offtrack from "@/core/offtrack.js";
import * as Format from "@/core/format.js";
import * as Prompt from "@/core/prompt.js";
import * as Share from "@/core/share.js";
import { copyText } from "@/lib/clipboard";
import { useApp, SEX_LABEL } from "@/components/store";

const { fmt, fmt0, prettyDate } = Format;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// A hook that derives the plan + progress from the current store state.
function useDerived() {
  const app = useApp();
  const plan = useMemo(() => Plan.createPlan(app.state, app.today), [app.state, app.today]);
  const prog = useMemo(() => Offtrack.createProgress(app.state, app.logHistory), [app.state, app.logHistory]);
  return { app, plan, prog };
}

// ---- SVG charts (ported point math) ---------------------------------------
function ChartSVG({ rows }: { rows: Any[] }) {
  if (rows.length < 2)
    return <div className="muted">Pick a date at least a week out to see the trajectory.</div>;
  const pr = rows.slice().reverse();
  const w = 600, h = 200, padL = 46, padR = 16, padT = 14, padB = 26;
  const n = pr.length - 1;
  const ws = pr.map((p) => p.weight);
  let minW = Math.min(...ws), maxW = Math.max(...ws);
  if (minW === maxW) { minW -= 1; maxW += 1; }
  const pad = (maxW - minW) * 0.12; minW -= pad; maxW += pad;
  const X = (i: number) => padL + (i / n) * (w - padL - padR);
  const Y = (v: number) => padT + (1 - (v - minW) / (maxW - minW)) * (h - padT - padB);
  const pts = pr.map((p, i) => X(i).toFixed(1) + "," + Y(p.weight).toFixed(1));
  const line = "M" + pts.join(" L");
  const area = "M" + pts.join(" L") + " L" + X(n).toFixed(1) + "," + (h - padB) + " L" + X(0).toFixed(1) + "," + (h - padB) + " Z";
  const grid: React.ReactNode[] = [];
  for (let g = 0; g <= 2; g++) {
    const gv = minW + (maxW - minW) * (g / 2), gy = Y(gv);
    grid.push(<line key={"gl" + g} x1={padL} y1={gy.toFixed(1)} x2={w - padR} y2={gy.toFixed(1)} stroke="var(--line)" />);
    grid.push(<text key={"gt" + g} x={padL - 6} y={(gy + 3).toFixed(1)} textAnchor="end" fontSize="10" fill="var(--inkSoft)">{gv.toFixed(1)}</text>);
  }
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img">
      <defs>
        <linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.32" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {grid}
      <path d={area} fill="url(#grad)" />
      <path d={line} fill="none" stroke="var(--accentDeep)" strokeWidth="2.5" strokeLinejoin="round" />
      <text x={X(0)} y={h - 8} textAnchor="start" fontSize="10" fill="var(--inkSoft)">{"wk " + pr[0].week + " · start"}</text>
      <text x={X(n)} y={h - 8} textAnchor="end" fontSize="10" fill="var(--inkSoft)">{"wk " + pr[n].week + " · end"}</text>
    </svg>
  );
}

function HistoryChartSVG({ entries }: { entries: Any[] }) {
  if (entries.length < 2) return null;
  const w = 600, h = 180, padL = 46, padR = 16, padT = 14, padB = 26;
  const t0 = new Date(entries[0].date + "T00:00:00").getTime();
  const t1 = new Date(entries[entries.length - 1].date + "T00:00:00").getTime();
  const span = Math.max(1, t1 - t0);
  const ws = entries.map((e) => e.weight);
  let minW = Math.min(...ws), maxW = Math.max(...ws);
  if (minW === maxW) { minW -= 1; maxW += 1; }
  const pad = (maxW - minW) * 0.12; minW -= pad; maxW += pad;
  const X = (d: string) => padL + ((new Date(d + "T00:00:00").getTime() - t0) / span) * (w - padL - padR);
  const Y = (v: number) => padT + (1 - (v - minW) / (maxW - minW)) * (h - padT - padB);
  const pts = entries.map((e) => X(e.date).toFixed(1) + "," + Y(e.weight).toFixed(1));
  const line = "M" + pts.join(" L");
  const area = "M" + pts.join(" L") + " L" + X(entries[entries.length - 1].date).toFixed(1) + "," + (h - padB) +
    " L" + X(entries[0].date).toFixed(1) + "," + (h - padB) + " Z";
  const grid: React.ReactNode[] = [];
  for (let g = 0; g <= 2; g++) {
    const gv = minW + (maxW - minW) * (g / 2), gy = Y(gv);
    grid.push(<line key={"hgl" + g} x1={padL} y1={gy.toFixed(1)} x2={w - padR} y2={gy.toFixed(1)} stroke="var(--line)" />);
    grid.push(<text key={"hgt" + g} x={padL - 6} y={(gy + 3).toFixed(1)} textAnchor="end" fontSize="10" fill="var(--inkSoft)">{gv.toFixed(1)}</text>);
  }
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img">
      <defs>
        <linearGradient id="hgrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.30" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {grid}
      <path d={area} fill="url(#hgrad)" />
      <path d={line} fill="none" stroke="var(--accentDeep)" strokeWidth="2.5" strokeLinejoin="round" />
      {entries.map((e, i) => (
        <circle key={"d" + i} cx={X(e.date).toFixed(1)} cy={Y(e.weight).toFixed(1)} r="2.6" fill="var(--accentDeep)" />
      ))}
      <text x={X(entries[0].date).toFixed(1)} y={h - 8} textAnchor="start" fontSize="10" fill="var(--inkSoft)">{prettyDate(entries[0].date)}</text>
      <text x={X(entries[entries.length - 1].date).toFixed(1)} y={h - 8} textAnchor="end" fontSize="10" fill="var(--inkSoft)">{prettyDate(entries[entries.length - 1].date)}</text>
    </svg>
  );
}

function ProjectionTable({ rows, W, unit }: { rows: Any[]; W: number; unit: string }) {
  if (rows.length < 2) return <div className="muted">No weeks to show yet.</div>;
  return (
    <div className="tscroll">
      <table>
        <thead><tr><th>Week</th><th>Weight ({unit})</th><th>Lost</th></tr></thead>
        <tbody>
          {rows.map((p) => {
            const lost = p.week === rows.length - 1 ? "—" : "-" + fmt(W - p.weight);
            return (
              <tr key={p.week} className={p.week === 0 ? "end" : undefined}>
                <td>{p.week}</td>
                <td className="w">{fmt(p.weight)}</td>
                <td className="l">{lost}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Stat({ k, v, cls }: { k: string; v: React.ReactNode; cls?: string }) {
  return (
    <div className="pstat">
      <div className="k">{k}</div>
      <div className={"v" + (cls ? " " + cls : "")}>{v}</div>
    </div>
  );
}

// ---- cards ----------------------------------------------------------------
function Hero() {
  const { app, plan } = useDerived();
  const { state, today } = app;
  const wl = plan.weeksLeft();
  const startD = plan.phaseStart();
  const notStarted = startD.getTime() > today.getTime();
  const weeksToStart = Math.floor((startD.getTime() - today.getTime()) / WEEK_MS);
  return (
    <div className="hero">
      <div className="hero-main">
        <span className="num">{notStarted ? weeksToStart : wl != null ? wl : "—"}</span>
        <span className="lbl">
          {notStarted
            ? weeksToStart === 1 ? "week until diet starts" : "weeks until diet starts"
            : wl === 1 ? "week left" : "weeks left"}
        </span>
      </div>
      <div className="hero-date">
        <span className="cap">{notStarted ? "starts" : "until"}</span>
        <span className="dval">
          {notStarted ? prettyDate(state.startDate) : wl != null ? prettyDate(state.endDate) : "—"}
        </span>
      </div>
    </div>
  );
}

function AboutCard() {
  const app = useApp();
  const { state } = app;
  const aboutComplete = !!state.sex && state.height !== "";
  const collapsed = !app.aboutOpen && aboutComplete;
  const hsuffix = state.unit === "lb" ? "in" : "cm";
  return (
    <div className="card">
      <div className="abouthead">
        <div className="cardtitle">About you</div>
        {collapsed ? <button className="linkbtn" onClick={() => app.setAboutOpen(true)}>Edit</button> : null}
      </div>
      {collapsed ? (
        <div className="aboutsum">
          <span className="chip">{SEX_LABEL[state.sex] || "—"}</span>
          <span className="chip">{state.height !== "" ? state.height + " " + hsuffix : "—"}</span>
          {state.curSteps !== "" ? <span className="chip">{fmt0(parseInt(state.curSteps, 10))} steps/day</span> : null}
        </div>
      ) : (
        <div>
          <p className="sub" style={{ margin: "2px 0 4px" }}>Set this once — your sex and height fix your calorie, protein and fat targets.</p>
          <label className="field">
            <span className="flabel">Sex</span>
            <div className="seg">
              <button className={state.sex === "male" ? "on" : undefined} onClick={() => app.setSex("male")}>Male</button>
              <button className={state.sex === "female" ? "on" : undefined} onClick={() => app.setSex("female")}>Female</button>
              <button className={"wide" + (state.sex === "neutral" ? " on" : "")} onClick={() => app.setSex("neutral")}>Prefer not to say</button>
            </div>
          </label>
          <label className="field">
            <span className="flabel">Height</span>
            <div className="ibox">
              <input inputMode="decimal" placeholder="0" value={state.height}
                onChange={(ev) => app.setState({ height: Format.clampDecimals(ev.target.value) })} />
              <span className="suffix">{hsuffix}</span>
            </div>
            <span className="hint">Sets your minimum protein &amp; fat targets.</span>
          </label>
          <label className="field">
            <span className="flabel">Daily steps now</span>
            <div className="ibox">
              <input inputMode="numeric" placeholder="0" value={state.curSteps}
                onChange={(ev) => app.setState({ curSteps: ev.target.value.replace(/[^0-9]/g, "").slice(0, 6) })} />
              <span className="suffix">steps</span>
            </div>
            <span className="hint">Optional — your current daily average, so the plan can show your total step target.</span>
          </label>
          <button className="donebtn" disabled={!aboutComplete} onClick={() => { if (aboutComplete) app.setAboutOpen(false); }}>Done</button>
        </div>
      )}
    </div>
  );
}

function WeightCard() {
  const app = useApp();
  const { state, logHistory, todayStr } = app;
  const todayEntry = logHistory.some((x) => x.date === todayStr);
  return (
    <div className="card">
      <div className="units">
        <button className={state.unit === "kg" ? "on" : undefined} onClick={() => app.setUnit("kg")}>kg</button>
        <button className={state.unit === "lb" ? "on" : undefined} onClick={() => app.setUnit("lb")}>lb</button>
      </div>
      <label className="field">
        <span className="flabel">Today&apos;s weight</span>
        <div className="ibox">
          <input inputMode="decimal" placeholder="0.00" value={state.weight}
            onChange={(ev) => app.logWeight(ev.target.value)} />
          <span className="suffix">{state.unit}</span>
        </div>
        <span className="hint">
          {todayEntry
            ? "Saved for today (" + prettyDate(todayStr) + ") — edit any time to update."
            : "Log today's weight (" + prettyDate(todayStr) + ") to see your projection."}
        </span>
      </label>
    </div>
  );
}

function PlanCard() {
  const { app, plan } = useDerived();
  const { state, todayStr } = app;
  const collapsed = !app.planOpen && state.planConfirmed;
  const startD = plan.phaseStart();
  const endD = state.endDate ? new Date(state.endDate + "T00:00:00") : null;
  const phaseT = endD && !isNaN(endD.getTime()) ? (endD.getTime() - startD.getTime()) / WEEK_MS : NaN;
  const phaseN = isFinite(phaseT) && phaseT >= 0 ? Math.floor(phaseT) : null;
  return (
    <div className="card">
      <div className="abouthead">
        <div className="cardtitle">Your plan</div>
        {collapsed ? <button className="linkbtn" onClick={() => app.setPlanOpen(true)}>Edit</button> : null}
      </div>
      {collapsed ? (
        <div className="aboutsum">
          <span className="chip">{state.pct !== "" ? state.pct : "—"} %/week</span>
          <span className="chip">{prettyDate(state.startDate)} → {prettyDate(state.endDate)}</span>
        </div>
      ) : (
        <div>
          <p className="sub" style={{ margin: "2px 0 4px" }}>Set your rate of fat loss and the dates once — afterwards you just log today&apos;s weight.</p>
          <label className="field">
            <span className="flabel">Weekly loss</span>
            <div className="ibox">
              <input inputMode="decimal" placeholder="0.00" value={state.pct}
                onChange={(ev) => app.setState({ pct: Format.clampDecimals(ev.target.value) })} />
              <span className="suffix">%</span>
            </div>
          </label>
          <label className="field">
            <span className="flabel">Start date</span>
            <div className="ibox">
              <input type="date" value={state.startDate} onChange={(ev) => app.setStartDate(ev.target.value)} />
            </div>
            <span className="hint">When your dieting phase begins — defaults to today.</span>
          </label>
          <label className="field">
            <span className="flabel">End date</span>
            <div className="ibox">
              <input type="date" min={state.startDate || todayStr} value={state.endDate} onChange={(ev) => app.setEndDate(ev.target.value)} />
            </div>
            <span className="hint">{phaseN != null ? phaseN + " weeks from your start date (" + state.startDate + ")" : "Pick a date on or after your start date"}</span>
          </label>
          <button className="donebtn" onClick={() => app.confirmPlan()}>Done</button>
        </div>
      )}
    </div>
  );
}

function ResultCard() {
  const { app, plan } = useDerived();
  const c = plan.compute();
  return (
    <div className="result">
      <div className="cap">Projected weight on <span>{prettyDate(app.state.endDate)}</span></div>
      <div className="big"><span>{c.valid ? fmt(c.final) : "—"}</span> <small>{app.state.unit}</small></div>
      <div className="stats">
        <div><div className="k">Total lost</div><div className="v"><span>{c.valid ? fmt(c.lost) : "—"}</span> <span>{app.state.unit}</span></div></div>
        <div><div className="k">% of start</div><div className="v"><span>{c.valid ? fmt(c.lostPct) : "—"}</span>%</div></div>
      </div>
    </div>
  );
}

function TrackBanner({ off, unit, bandFrac }: { off: Any; unit: string; bandFrac: number }) {
  const label = off.status === "behind" ? "Off track" : off.status === "ahead" ? "Ahead of plan" : "On track";
  const gap = fmt(Math.abs(off.gap));
  let pace: string;
  if (off.actualPctWk < 0) pace = " · gaining " + fmt(Math.abs(off.actualPctWk)) + "%/wk vs " + fmt(off.targetPctWk) + "% target";
  else if (off.actualPctWk < 0.005) pace = " · holding steady vs " + fmt(off.targetPctWk) + "%/wk target";
  else pace = " · losing " + fmt(off.actualPctWk) + "%/wk vs " + fmt(off.targetPctWk) + "% target";
  const lead = off.status === "behind"
    ? gap + " " + unit + " above where your plan expects you today"
    : off.status === "ahead"
      ? gap + " " + unit + " below plan — ahead of schedule"
      : "Right on your projected curve (within " + fmt(off.expected * bandFrac) + " " + unit + ")";
  return (
    <div className={"track track-" + off.status}>
      <span className="tdot"></span>
      <div className="tbody">
        <div className="tstatus">{label}</div>
        <div className="tdetail">{lead}{pace}</div>
      </div>
    </div>
  );
}

function ProgressCard() {
  const { app, prog } = useDerived();
  const { state, logHistory } = app;
  const p = prog.progress();
  if (!p.has) return null;
  const unit = state.unit;
  const dir = p.change > 0 ? "down" : p.change < 0 ? "up" : "";
  const sign = p.change > 0 ? "−" : p.change < 0 ? "+" : "";
  const off = prog.offTrack();
  return (
    <div className="card">
      <div className="phead">
        <span className="ptitle">Your progress</span>
        <span className="pspan">{p.count}{p.count === 1 ? " entry" : " entries"} · since {prettyDate(p.first.date)}</span>
      </div>
      {off.has ? <TrackBanner off={off} unit={unit} bandFrac={prog.BAND_FRAC} /> : null}
      <div className="pgrid">
        <Stat k="Starting weight" v={<>{fmt(p.first.weight)} <small>{unit}</small></>} />
        <Stat k="Latest weight" v={<>{fmt(p.last.weight)} <small>{unit}</small></>} />
        <Stat k="Total change" v={<>{sign}{fmt(Math.abs(p.change))} <small>{unit}</small></>} cls={dir} />
        <Stat k="Avg / week" v={<>{sign}{fmt(Math.abs(p.perWeek))} <small>{unit}</small></>} cls={dir} />
      </div>
      {logHistory.length >= 2
        ? <div className="chartbox"><HistoryChartSVG entries={logHistory} /></div>
        : <span className="hint">Log another day to see your trend.</span>}
    </div>
  );
}

function MacrosGrid({ e, title }: { e: Any; title: string }) {
  const hasGoal = isFinite(e.intake);
  return (
    <>
      <div className="cardtitle" style={{ fontSize: 17 }}>{title}</div>
      <div className="pgrid" style={{ marginTop: 6 }}>
        <Stat k="Protein" v={<>{fmt0(e.protein)} <small>g</small></>} />
        <Stat k="Fat" v={<>{fmt0(e.fat)} <small>g</small></>} />
        <Stat k="Carbs" v={<>{hasGoal && e.macrosOk ? fmt0(e.carbs) : "—"} <small>g</small></>} />
        <Stat k="Fibre" v={<>≥{e.fiber} <small>g (of carbs)</small></>} />
      </div>
    </>
  );
}

function StepsSection({ e, curSteps }: { e: Any; curSteps: string }) {
  const stepsK = Energy.roundSteps(e.steps);
  const cur = parseInt(curSteps, 10), hasCur = isFinite(cur) && cur > 0;
  const stepNote = stepsK > 0
    ? (hasCur
      ? "Your " + fmt0(cur) + "/day average plus the walking that covers the rest of the deficit. A " + fmt0(Energy.MIN_PHASE_STEPS) + "-step daily baseline is always included while dieting (taken out of food first, so your goal is unchanged)."
      : "Added on top of your current daily average. A " + fmt0(Energy.MIN_PHASE_STEPS) + "-step daily baseline is always included while dieting (taken out of food first), plus enough to cover the rest of the deficit.")
    : "Your food deficit already covers your goal — extra steps are optional but recommended.";
  return (
    <>
      <div className="cardtitle" style={{ fontSize: 17, marginTop: 14 }}>Daily steps</div>
      <div className="pgrid" style={{ marginTop: 6 }}>
        {hasCur ? (
          <>
            <Stat k="Target / day" v={<>{fmt0(cur + Math.max(0, stepsK))} <small>steps total</small></>} />
            <Stat k="To add" v={<>{stepsK > 0 ? "+" + fmt0(stepsK) : "0"} <small>over {fmt0(cur)} now</small></>} />
          </>
        ) : (
          <>
            <Stat k="Steps / day" v={<>+{fmt0(stepsK)} <small>to your daily average</small></>} />
            <Stat k="Over" v={<>{e.days} <small>days</small></>} />
          </>
        )}
      </div>
      <span className="hint">{stepNote}</span>
    </>
  );
}

function CycleTable({ cp, cur }: { cp: Any; cur: number }) {
  const hasCur = isFinite(cur) && cur > 0;
  const anyAdded = cp.days.some((d: Any) => isFinite(d.steps) && d.steps > 0);
  const showSteps = anyAdded || hasCur;
  return (
    <table className="mtable">
      <thead>
        <tr>
          <th>Day</th><th>kcal</th><th>P&nbsp;(g)</th><th>F&nbsp;(g)</th><th>C&nbsp;(g)</th>
          {showSteps ? <th>Steps{hasCur ? "/day" : ""}</th> : null}
        </tr>
      </thead>
      <tbody>
        {cp.days.map((d: Any, i: number) => {
          const cls = d.key === "high" ? "high" : d.key === "low" ? "low" : "";
          const added = isFinite(d.steps) && d.steps > 0 ? d.steps : 0;
          const steps = hasCur ? fmt0(cur + added) : added > 0 ? "+" + fmt0(added) : "—";
          return (
            <tr key={i} className={cls || undefined}>
              <td className="day">{d.label} <span className="n">×{d.count}</span></td>
              <td className="kc">{fmt0(d.kcal)}</td>
              <td>{fmt0(d.protein)}</td>
              <td>{fmt0(d.fat)}</td>
              <td>{fmt0(d.carbs)}</td>
              {showSteps ? <td>{steps}</td> : null}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function EatingPattern({ e, bm }: { e: Any; bm: Any }) {
  const app = useApp();
  const { state } = app;
  const setPattern = (p: string) => app.setState({ pattern: p as Any });
  const setHighDays = (n: number) => app.setState({ highDays: String(n) });
  const patternTabs = (
    <div className="tabs" role="tablist">
      <button role="tab" className={state.pattern === "even" ? "on" : undefined} aria-selected={state.pattern === "even"} onClick={() => setPattern("even")}>Even</button>
      <button role="tab" className={state.pattern === "highlow" ? "on" : undefined} aria-selected={state.pattern === "highlow"} onClick={() => setPattern("highlow")}>High / Low</button>
      <button role="tab" className={state.pattern === "cycle" ? "on" : undefined} aria-selected={state.pattern === "cycle"} onClick={() => setPattern("cycle")}>Carb cycle</button>
    </div>
  );

  if (state.pattern === "even") {
    return (
      <>
        <div className="cardtitle" style={{ fontSize: 17 }}>Eating pattern</div>
        {patternTabs}
        <span className="hint">The same calories and macros every day.</span>
        <MacrosGrid e={e} title="Daily macros" />
        <StepsSection e={e} curSteps={state.curSteps} />
      </>
    );
  }

  const hd = parseInt(state.highDays, 10) === 1 ? 1 : 2;
  const cp = Energy.cyclePlan({
    protein: e.protein, weightKg: bm.weightKg, intake: e.intake, maint: bm.maint,
    pattern: state.pattern, highDays: hd, carbFloor: e.fiber, fatMin: e.fat,
    stepDeficit: e.stepDeficit, kcalPerStep: e.kcalPerStep,
  });
  const hiDay = cp.days.filter((d: Any) => d.key === "high")[0];
  const loDay = cp.days.filter((d: Any) => d.key === "low")[0];
  let macroText: string, steepEase = false;
  if (state.pattern === "cycle") {
    macroText = "Low days carry a solid ~" + fmt0(cp.lowFat) + "g fat (" + Energy.LOW_FAT_PER_KG + " g/kg) at the " + e.fiber +
      "g carb floor; high days are 35% carbs and medium days 35% fat, taking whatever calories are left";
    steepEase = cp.lowFat < Energy.LOW_FAT_PER_KG * bm.weightKg - 0.5;
  } else {
    const cut = hd === 1 ? 100 : 150;
    macroText = "Protein stays the same every day — only carbs move. Each low day drops " + cut +
      " kcal of carbs (to ~" + fmt0(loDay ? loDay.carbs : 0) + "g) and that goes onto the high day" + (hd === 1 ? "" : "s") +
      " (~" + fmt0(hiDay ? hiDay.carbs : 0) + "g carbs" + (hd === 1 ? "" : " each") + ")";
  }
  const cur = parseInt(state.curSteps, 10), hasCur = isFinite(cur) && cur > 0;

  return (
    <>
      <div className="cardtitle" style={{ fontSize: 17 }}>Eating pattern</div>
      {patternTabs}
      {state.pattern === "highlow" ? (
        <div className="subtabs">
          <span className="lbl">High-carb days</span>
          <button className={hd === 1 ? "on" : undefined} onClick={() => setHighDays(1)}>1 day</button>
          <button className={hd === 2 ? "on" : undefined} onClick={() => setHighDays(2)}>2 days</button>
        </div>
      ) : null}
      <CycleTable cp={cp} cur={cur} />
      <span className="hint">
        {macroText}. The week still averages your {fmt0(e.intake)} kcal goal.
        {hasCur ? " The Steps column is your total daily target (your ~" + fmt0(cur) + "/day average plus any added)." : ""}
        {steepEase ? " (Your deficit is steep enough that low-day fat had to ease below " + Energy.LOW_FAT_PER_KG + " g/kg so the high days stay the biggest.)" : ""}
        {cp.fatTrimmed ? " The low days hit the " + e.fiber + "g carb floor, so the high day’s fat was trimmed to ~" + fmt0(cp.highFat) + "g to make room for the carbs" + (cp.anyRaised ? ", and the rest is walked off with steps." : ".") : ""}
        {cp.anyRaised && !cp.fatTrimmed ? " Some low days couldn’t give up that many carbs without breaking the " + e.fiber + "g floor, so the extra is walked off with steps on the high day." : ""}
      </span>
    </>
  );
}

function MealPromptButtons() {
  const { app, plan } = useDerived();
  const [label, setLabel] = useState("Copy meal-plan prompt for AI");
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCopy = () => {
    const prompt = Prompt.createPrompt({ state: app.state, plan }).buildMealPlanPrompt();
    copyText(prompt, (ok) => {
      setDone(true);
      setLabel(ok ? "Prompt copied — paste into any AI" : "Press Ctrl/Cmd+C to copy");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => { setDone(false); setLabel("Copy meal-plan prompt for AI"); }, 2200);
    });
  };
  return (
    <>
      <button type="button" className={"promptbtn" + (done ? " done" : "")} onClick={onCopy}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" />
        </svg>
        <span>{label}</span>
      </button>
      <button type="button" id="mealLocalBtn" className="promptbtn" style={{ marginTop: 10 }} onClick={() => app.setTab("meal")}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2v4M12 18v4M2 12h4M18 12h4" /><rect x="7" y="7" width="10" height="10" rx="2" />
        </svg>
        <span>Build a plan on this device (private)</span>
      </button>
    </>
  );
}

function EnergyCard() {
  const { app, plan } = useDerived();
  const { state } = app;
  const e = plan.energyPlan();
  if (!e.valid) {
    return (
      <div id="energyCard">
        <div className="card">
          <div className="cardtitle">Calories &amp; macros</div>
          <div className="muted">Pick your sex and enter your height above to see your maintenance calories, the intake and macros for your goal, and the daily steps it needs.</div>
        </div>
      </div>
    );
  }
  const bm = e.bm, hasGoal = isFinite(e.intake);
  const cycling = hasGoal && e.macrosOk && state.pattern !== "even";

  const head = hasGoal ? (
    <div className="result" style={{ marginTop: 0 }}>
      <div className="cap">Eat this to reach your goal{cycling ? " · daily average" : ""}</div>
      <div className="big">{fmt0(e.intake)} <small>kcal/day</small></div>
      <div className="stats">
        <div><div className="k">Maintenance</div><div className="v">{fmt0(bm.maint)} <span>kcal</span></div></div>
        <div><div className="k">Food deficit</div><div className="v">−{fmt0(e.foodDeficit)} <span>kcal</span></div></div>
      </div>
    </div>
  ) : (
    <div className="result" style={{ marginTop: 0 }}>
      <div className="cap">Daily maintenance</div>
      <div className="big">{fmt0(bm.maint)} <small>kcal/day</small></div>
      <div className="stats"><div><div className="k">Goal intake</div><div className="v">log your weight &amp; rate</div></div></div>
    </div>
  );

  let body: React.ReactNode;
  if (!hasGoal) {
    body = <MacrosGrid e={e} title="Daily macros (minimums)" />;
  } else if (!e.macrosOk) {
    body = (
      <>
        <MacrosGrid e={e} title="Daily macros" />
        <div className="warn">At {fmt0(e.intake)} kcal you can&apos;t fit your minimum protein ({fmt0(e.protein)}g) and fat ({fmt0(e.fat)}g). Lower the weekly % or push the end date out so there&apos;s room for carbs.</div>
      </>
    );
  } else {
    body = <EatingPattern e={e} bm={bm} />;
  }

  return (
    <div id="energyCard">
      {head}
      <div className="card">
        {body}
        <p className="note" style={{ marginTop: 14 }}>
          Maintenance = bodyweight in lb × a sex/weight multiplier; protein &amp; fat targets come from your height. Goal calories = maintenance − the deficit to hit your date (food deficit capped at {Energy.MAX_FOOD_DEFICIT} kcal, with a {fmt0(Energy.MIN_PHASE_STEPS)}-step daily minimum and steps covering any more; ~{Energy.KCAL_PER_KG.toLocaleString()} kcal per kg). These are estimates, not medical advice.
        </p>
        <MealPromptButtons />
      </div>
    </div>
  );
}

function ShareButton() {
  const app = useApp();
  const [label, setLabel] = useState("Copy shareable link");
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCopy = () => {
    const url = Share.buildShareUrl(app.state, app.logHistory, app.mealPlan, app.mealPlanPending, app.lastWizAnswers);
    copyText(url, (ok) => {
      setDone(true);
      setLabel(ok ? "Link copied" : "Press Ctrl/Cmd+C to copy");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => { setDone(false); setLabel("Copy shareable link"); }, 2000);
    });
  };
  return (
    <div className="share">
      <button type="button" className={done ? "done" : undefined} onClick={onCopy}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 13a5 5 0 0 0 7.07 0l1.41-1.41a5 5 0 0 0-7.07-7.07L10 6" />
          <path d="M14 11a5 5 0 0 0-7.07 0L5.5 12.4a5 5 0 0 0 7.07 7.07L14 18" />
        </svg>
        <span>{label}</span>
      </button>
    </div>
  );
}

function ChartCard() {
  const { plan } = useDerived();
  const c = plan.compute();
  return (
    <div className="card chartbox">
      {c.valid ? <ChartSVG rows={c.rows} /> : <div className="muted">Log today&apos;s weight to project your trajectory.</div>}
    </div>
  );
}

function TableCard() {
  const { plan, app } = useDerived();
  const c = plan.compute();
  return (
    <div className="card tablecard">
      {c.valid ? <ProjectionTable rows={c.rows} W={c.W} unit={app.state.unit} /> : <div className="muted">Log today&apos;s weight to see the week-by-week table.</div>}
    </div>
  );
}

function Note() {
  const { plan } = useDerived();
  const app = useApp();
  const startD = plan.phaseStart();
  const endD = app.state.endDate ? new Date(app.state.endDate + "T00:00:00") : null;
  const phaseT = endD && !isNaN(endD.getTime()) ? (endD.getTime() - startD.getTime()) / WEEK_MS : NaN;
  const phaseN = isFinite(phaseT) && phaseT >= 0 ? Math.floor(phaseT) : null;
  return (
    <p className="note">
      Week 0 is your end date; higher week numbers count back toward your start date (week {phaseN != null ? phaseN : "—"}).
      Each step compounds the loss %, and only whole weeks are shown. Each day&apos;s weight is stored on your
      device and you&apos;re asked again the next day. The shareable link carries your settings and full weight
      history — bookmark or share it to keep or move your data.
    </p>
  );
}

export default function ProjectionView() {
  return (
    <div id="projectionView">
      <div className="eyebrow">Projection</div>
      <h1>Weight Over Time</h1>
      <p className="sub">Losing the set % each week, compounding on your current weight.</p>
      <Hero />
      <AboutCard />
      <WeightCard />
      <PlanCard />
      <EnergyCard />
      <ResultCard />
      <ProgressCard />
      <ChartCard />
      <TableCard />
      <ShareButton />
      <Note />
    </div>
  );
}

"use client";

/*
 * Meal-plan view — JSX port of index.html's meal tab: import a plan or recipe
 * JSON, render the plan (preview banner, overview, day tabs, meals, shopping
 * list, micronutrients), add/remove recipes per meal, and keep/discard a
 * freshly-built preview. Import parsing + all number handling reuse the shared
 * core/mealplan.js helpers; React escapes every string by default.
 *
 * The on-device build wizard (WebLLM) is wired in a later step; the "Build on
 * this device" entry lives on the Projection tab today.
 */

import React, { useMemo, useRef, useState } from "react";
import * as MealCodec from "@/core/mealplan.js";
import * as Plan from "@/core/plan.js";
import * as Prompt from "@/core/prompt.js";
import { copyText } from "@/lib/clipboard";
import { useApp } from "@/components/store";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const { dayTotals, fmtMoney } = MealCodec;
const LS_MEAL = "wp:mealplan";

function readStoredMealPlan(): Any {
  try {
    const ls = localStorage.getItem(LS_MEAL);
    if (ls) return MealCodec.normalizeMealPlan(JSON.parse(ls));
  } catch {
    /* ignore */
  }
  return null;
}

// Immutably append recipes to meal (di, mi).
function withRecipes(plan: Any, di: number, mi: number, recipes: Any[], replace = false): Any {
  const days = plan.days.map((d: Any, i: number) =>
    i !== di ? d : {
      ...d,
      meals: (d.meals || []).map((m: Any, j: number) =>
        j !== mi ? m : { ...m, recipes: replace ? recipes : (m.recipes || []).concat(recipes) }
      ),
    }
  );
  return { ...plan, days };
}

interface Notice { open: boolean; msg: string; fixup: string }

function TotalsRow({ t, cls }: { t: Any; cls?: string }) {
  if (!t) return null;
  return (
    <div className={"mptot" + (cls ? " " + cls : "")}>
      <span><b>{t.kcal}</b> kcal</span>
      <span><b>{t.protein}</b> g protein</span>
      <span><b>{t.fat}</b> g fat</span>
      <span><b>{t.carbs}</b> g carbs</span>
      {t.fiber != null ? <span><b>{t.fiber}</b> g fibre</span> : null}
    </div>
  );
}

function MealItems({ m }: { m: Any }) {
  return (
    <>
      {(m.items || []).map((it: Any, i: number) => {
        const macro: string[] = [];
        if (isFinite(it.kcal)) macro.push(Math.round(it.kcal) + " kcal");
        const pf: string[] = [];
        if (isFinite(it.protein)) pf.push("P" + Math.round(it.protein));
        if (isFinite(it.fat)) pf.push("F" + Math.round(it.fat));
        if (isFinite(it.carbs)) pf.push("C" + Math.round(it.carbs));
        if (pf.length) macro.push(pf.join(" "));
        return (
          <div className="mpitem" key={i}>
            <div className="f">{it.food || it.name || ""}{it.amount ? <> <span className="a">{it.amount}</span></> : null}</div>
            {macro.length ? <div className="m">{macro.join(" · ")}</div> : null}
          </div>
        );
      })}
    </>
  );
}

export default function MealView() {
  const app = useApp();
  const { mealPlan, mealPlanPending, mealDay, mealEditor } = app;

  const [importText, setImportText] = useState("");
  const [importOk, setImportOk] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>({ open: false, msg: "", fixup: "" });
  const [recAddText, setRecAddText] = useState<Record<string, string>>({});

  const plan = useMemo(() => Plan.createPlan(app.state, app.today), [app.state, app.today]);
  const prompt = useMemo(
    () => Prompt.createPrompt({ state: app.state, plan, mealPlan, dayTotals }),
    [app.state, plan, mealPlan]
  );

  const showNotice = (msg: string, fixup: string) => setNotice({ open: true, msg, fixup });

  function handleImport() {
    const raw = importText.trim();
    if (!raw) { showNotice("There's nothing to import yet — paste the JSON the AI gave you, then tap Import.", prompt.fixupGenericPrompt()); return; }
    const got = MealCodec.extractJson(raw);
    if (!got.ok) { showNotice("I couldn't find valid JSON in what you pasted. Copy the whole code block the AI printed (including the surrounding { } ) and try again.", prompt.fixupGenericPrompt()); return; }
    const data = got.value;
    if (MealCodec.isRecipeShape(data)) {
      if (!mealPlan) { showNotice("Import a meal plan first, then add recipes to one of its meals.", prompt.fixupGenericPrompt()); return; }
      const recipes = MealCodec.normalizeRecipes(MealCodec.recipesFrom(data));
      if (!recipes.length) { showNotice("That looks like a recipe block, but it has no recipes I could read.", prompt.fixupRecipePrompt("The \"recipes\" array was missing or empty.")); return; }
      const hit = MealCodec.findMealForRecipes(mealPlan, data);
      if (!hit) { showNotice("I couldn't match those recipes to a meal in your plan. Use the “Add recipe” button on the meal itself, or keep the mealId/day/meal the prompt gave you.", prompt.fixupRecipePrompt("The mealId / day / meal didn't match any meal in the plan.")); return; }
      // find indices for immutable update
      let di = -1, mi = -1;
      mealPlan.days.forEach((d: Any, i: number) => (d.meals || []).forEach((m: Any, j: number) => { if (m === hit.meal) { di = i; mi = j; } }));
      const next = withRecipes(mealPlan, di, mi, recipes);
      app.setMeal({ mealPlan: next });
      setImportText("");
      setImportOk("Added " + recipes.length + " recipe" + (recipes.length > 1 ? "s" : "") + " to " + hit.label + ".");
      return;
    }
    const p = MealCodec.normalizeMealPlan(data);
    if (!p) { showNotice("That JSON loaded, but it has no \"days\" list, so there's no plan to show.", prompt.fixupPlanPrompt("The JSON had no non-empty \"days\" array.")); return; }
    // An explicit paste is a deliberate commit — no preview gate.
    app.setMeal({ mealPlan: p, mealDay: 0, mealEditor: null, mealPlanPending: false });
    setImportText("");
    setImportOk("Plan imported and saved to this device.");
  }

  function addRecipesToMeal(di: number, mi: number) {
    const id = di + "-" + mi;
    const raw = (recAddText[id] || "").trim();
    if (!raw) { showNotice("Paste the recipe JSON the AI gave you first.", prompt.fixupRecipePrompt("Nothing was pasted.")); return; }
    const got = MealCodec.extractJson(raw);
    if (!got.ok) { showNotice("I couldn't read any JSON there. Copy the whole recipe code block the AI printed and try again.", prompt.fixupRecipePrompt("The pasted text wasn't valid JSON.")); return; }
    const recipes = MealCodec.normalizeRecipes(MealCodec.recipesFrom(got.value));
    if (!recipes.length) { showNotice("That didn't contain any recipes I could read.", prompt.fixupRecipePrompt("No usable recipes were found in the JSON.")); return; }
    const meal = mealPlan?.days?.[di]?.meals?.[mi];
    const next = withRecipes(mealPlan, di, mi, recipes);
    app.setMeal({ mealPlan: next, mealEditor: null });
    setRecAddText((prev) => ({ ...prev, [id]: "" }));
    setImportOk("Added " + recipes.length + " recipe" + (recipes.length > 1 ? "s" : "") + " to " + (meal?.name || "the meal") + ".");
  }

  function keepPending() {
    app.setMeal({ mealPlanPending: false });
  }
  function discardPending() {
    app.setMeal({ mealPlan: readStoredMealPlan(), mealPlanPending: false, mealDay: 0, mealEditor: null });
  }
  function removePlan() {
    app.setMeal({ mealPlan: null, mealPlanPending: false, mealDay: 0, mealEditor: null });
  }

  const days: Any[] = mealPlan && Array.isArray(mealPlan.days) ? mealPlan.days : [];
  const sel = Math.min(Math.max(0, mealDay | 0), days.length - 1);
  const day = days[sel];
  const cur = mealPlan?.currency || "";

  return (
    <div id="mealView">
      <div className="eyebrow">Meal plan</div>
      <h1>Your Meal Plan</h1>
      <p className="sub">Build a plan with the AI prompt from the Projection tab, then paste its JSON here to import and save it.</p>

      <div className="card">
        <div className="cardtitle">Import a plan</div>
        <p className="sub" style={{ margin: "2px 0 10px" }}>Paste the plan JSON the AI produced (the whole code block is fine). It&apos;s saved on this device and travels in your shareable link. To add recipes, use the <b>Add recipe</b> button on each meal below.</p>
        <textarea className="mealta" spellCheck={false} placeholder="Paste the AI’s JSON here…" value={importText} onChange={(e) => setImportText(e.target.value)} />
        <button type="button" className="donebtn" onClick={handleImport}>Import plan</button>
        {importOk ? <span className="hint mealmsg ok">{importOk}</span> : null}
      </div>

      {mealPlan ? (
        <div id="mealPlanCard">
          {mealPlanPending ? (
            <div className="card previewbar">
              <div className="pvhead"><span className="pvdot"></span><div className="cardtitle" style={{ margin: 0 }}>Preview — not saved yet</div></div>
              <p className="sub" style={{ marginTop: 8 }}>Have a look through the plan below. Nothing is saved to this device until you keep it.</p>
              <div className="pvactions">
                <button type="button" className="pvbtn discard" onClick={discardPending}>Discard</button>
                <button type="button" className="pvbtn keep" onClick={keepPending}>Keep this plan</button>
              </div>
            </div>
          ) : null}

          <div className="card">
            <div className="abouthead">
              <div className="cardtitle">Imported plan</div>
              <button type="button" className="linkbtn danger" onClick={removePlan}>Remove</button>
            </div>
            {(mealPlan.country || (isFinite(mealPlan.weeklyBudget) && mealPlan.weeklyBudget > 0)) ? (
              <div className="mpmeta">
                {mealPlan.country ? <span className="chip">{mealPlan.country}</span> : null}
                {isFinite(mealPlan.weeklyBudget) && mealPlan.weeklyBudget > 0 ? <span className="chip">Budget {fmtMoney(mealPlan.weeklyBudget, mealPlan.currency || "")}/wk</span> : null}
              </div>
            ) : null}
            {mealPlan.summary ? <p className="sub" style={{ marginTop: 10, whiteSpace: "pre-wrap" }}>{mealPlan.summary}</p> : null}
          </div>

          {days.length > 1 ? (
            <div className="tabs mealdaytabs" role="tablist">
              {days.map((d: Any, i: number) => (
                <button key={i} type="button" className={i === sel ? "on" : undefined} onClick={() => app.setMeal({ mealDay: i })}>{d.label || "Day " + (i + 1)}</button>
              ))}
            </div>
          ) : null}

          {day ? (
            <>
              <div className="card">
                <div className="mpday-head">
                  <span className="t">{day.label || "Day"}</span>
                  {isFinite(day.perWeek) ? <span className="c">×{day.perWeek} / week</span> : null}
                </div>
                <TotalsRow t={dayTotals(day)} />
              </div>
              {(day.meals || []).map((m: Any, mi: number) => {
                const id = sel + "-" + mi;
                return (
                  <div className="card mpmealhead" key={id}>
                    <div className="abouthead">
                      <div className="cardtitle">{m.name || "Meal"}</div>
                      <div className="mpacts">
                        <button type="button" className="linkbtn" onClick={() => copyText(prompt.buildRecipePrompt(sel, mi), () => { })}>Copy prompt</button>
                        <button type="button" className="linkbtn" onClick={() => app.setMeal({ mealEditor: mealEditor === id ? null : id })}>Add recipe</button>
                      </div>
                    </div>
                    <TotalsRow t={dayTotals({ meals: [m] })} cls="sm" />
                    <MealItems m={m} />
                    {Array.isArray(m.recipes) && m.recipes.length ? (
                      <div className="mprecipes">
                        <div className="mprecipes-h">
                          <span>Recipes ({m.recipes.length})</span>
                          <button type="button" className="linkbtn danger" onClick={() => app.setMeal({ mealPlan: withRecipes(mealPlan, sel, mi, [], true) })}>Remove all</button>
                        </div>
                        {m.recipes.map((r: Any, ri: number) => (
                          <details className="mprecipe" key={ri}>
                            <summary>{r.name || "Recipe"}{isFinite(r.minutes) && r.minutes > 0 ? <span className="a"> · {Math.round(r.minutes)} min</span> : null}</summary>
                            {Array.isArray(r.steps) && r.steps.length ? <ol>{r.steps.map((s: Any, si: number) => <li key={si}>{s}</li>)}</ol> : null}
                            {r.notes ? <p className="sub" style={{ whiteSpace: "pre-wrap" }}>{r.notes}</p> : null}
                          </details>
                        ))}
                      </div>
                    ) : null}
                    {mealEditor === id ? (
                      <div className="mpadd">
                        <div className="mpmeal-n">Add recipe</div>
                        <p className="hint" style={{ margin: "0 0 6px" }}>Tap “Copy prompt”, paste it into your AI, then paste the recipe JSON it returns here.</p>
                        <textarea className="mealta" spellCheck={false} placeholder="Paste the recipe JSON here…" value={recAddText[id] || ""} onChange={(e) => setRecAddText((prev) => ({ ...prev, [id]: e.target.value }))} />
                        <div className="mpadd-row">
                          <button type="button" className="linkbtn" onClick={() => app.setMeal({ mealEditor: null })}>Cancel</button>
                          <button type="button" className="save" onClick={() => addRecipesToMeal(sel, mi)}>Save recipes</button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </>
          ) : null}

          {Array.isArray(mealPlan.shoppingList) && mealPlan.shoppingList.length ? (
            <div className="card mpshop">
              <div className="cardtitle">Shopping list</div>
              {(() => {
                let grand = 0, haveGrand = false;
                const groups = mealPlan.shoppingList.map((g: Any, gi: number) => {
                  const rows = (g.items || []).map((it: Any, ii: number) => {
                    let priceTxt = "";
                    if (isFinite(it.price)) { priceTxt = fmtMoney(it.price, cur); grand += it.price; haveGrand = true; }
                    else if (it.price) priceTxt = String(it.price);
                    return (
                      <div className="mprow" key={ii}>
                        <span>{it.name || ""}{it.qty ? <> <span className="a" style={{ color: "var(--inkSoft)", fontSize: 12 }}>×{it.qty}</span></> : null}</span>
                        {priceTxt ? <span className="p">{priceTxt}</span> : null}
                      </div>
                    );
                  });
                  return <React.Fragment key={gi}><div className="ret">{g.retailer || "Store"}</div>{rows}</React.Fragment>;
                });
                return (
                  <>
                    {groups}
                    {haveGrand ? <div className="mptotal"><span>Estimated total</span><span>{fmtMoney(grand, cur)}</span></div> : null}
                  </>
                );
              })()}
            </div>
          ) : null}

          {mealPlan.micronutrients ? (
            <div className="card">
              <div className="cardtitle">Micronutrients &amp; fibre</div>
              <p className="sub" style={{ marginTop: 6, whiteSpace: "pre-wrap" }}>{mealPlan.micronutrients}</p>
            </div>
          ) : null}
        </div>
      ) : null}

      <NoticeModal notice={notice} onClose={() => setNotice({ open: false, msg: "", fixup: "" })} />
    </div>
  );
}

function NoticeModal({ notice, onClose }: { notice: Notice; onClose: () => void }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [copied, setCopied] = useState(false);
  const onCopy = () => {
    copyText(notice.fixup, (ok) => {
      setCopied(ok);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    });
  };
  return (
    <div className="modal" hidden={!notice.open} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet wide" role="dialog" aria-modal="true" aria-labelledby="noticeTitle">
        <h2 id="noticeTitle">Couldn’t import that</h2>
        <p>{notice.msg}</p>
        <pre className="fix">{notice.fixup}</pre>
        <div className="actions">
          <button type="button" className="mbtn cancel" onClick={onClose}>Close</button>
          <button type="button" className="mbtn go" onClick={onCopy}>{copied ? "Copied" : "Copy fix-up prompt"}</button>
        </div>
      </div>
    </div>
  );
}

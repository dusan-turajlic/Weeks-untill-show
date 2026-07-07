"use client";

/*
 * App store: the single source of truth for the client. Mirrors the original
 * index.html IIFE's `state` + `logHistory` + `mealPlan` + wizard memory, plus
 * the small UI flags (which tab, whether the one-time forms are open). All
 * persistence (settings/meal-plan/plan-memory in localStorage, weight log in
 * IndexedDB, and the shareable URL) runs through the same points the original
 * `persist()` did.
 *
 * Hydration is client-only (URL + localStorage + IndexedDB), so nothing here
 * runs on the server — the provider fills real data in a mount effect and gates
 * rendering behind `ready` to avoid SSR/client mismatches.
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
} from "react";

import * as Format from "@/core/format.js";
import * as Share from "@/core/share.js";
import * as MealPlanCodec from "@/core/mealplan.js";
import WeightLog from "@/core/weightlog.js";

// ---- constants (from index.html) ------------------------------------------
const DEFAULT_PHASE_WEEKS = 16;
const LS_SETTINGS = "wp:settings";
const LS_MEAL = "wp:mealplan";
const LS_PLANMEM = "wp:planmemory";
export const SEX_LABEL: Record<string, string> = {
  male: "Male",
  female: "Female",
  neutral: "Prefer not to say",
};

// ---- types ----------------------------------------------------------------
export type Unit = "kg" | "lb";
export type Sex = "" | "male" | "female" | "neutral";
export type Pattern = "even" | "highlow" | "cycle";

export interface AppState {
  weight: string;
  pct: string;
  startDate: string;
  endDate: string;
  unit: Unit;
  sex: Sex;
  height: string;
  pattern: Pattern;
  highDays: string;
  curSteps: string;
  planConfirmed: boolean;
}

export interface LogEntry {
  date: string;
  weight: number;
}

// The wizard/plan-memory bag is loosely typed — it round-trips to localStorage
// and the URL and is consumed by the (untyped) planner modules.
export type WizAnswers = Record<string, unknown> | null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MealPlan = any;

export interface AppData {
  state: AppState;
  logHistory: LogEntry[];
  mealPlan: MealPlan;
  mealPlanPending: boolean;
  mealDay: number;
  mealEditor: string | null;
  lastWizAnswers: WizAnswers;
  tab: "projection" | "meal";
  aboutOpen: boolean;
  planOpen: boolean;
}

// ---- localStorage helpers (client only) -----------------------------------
function loadSettings(): Partial<AppState> | null {
  try {
    return JSON.parse(localStorage.getItem(LS_SETTINGS) || "null");
  } catch {
    return null;
  }
}
function saveSettings(s: AppState) {
  try {
    localStorage.setItem(
      LS_SETTINGS,
      JSON.stringify({
        pct: s.pct,
        startDate: s.startDate,
        endDate: s.endDate,
        unit: s.unit,
        sex: s.sex,
        height: s.height,
        pattern: s.pattern,
        highDays: s.highDays,
        curSteps: s.curSteps,
        planConfirmed: s.planConfirmed,
      })
    );
  } catch {
    /* ignore quota / privacy-mode errors */
  }
}
function loadPlanMemory(): WizAnswers {
  try {
    return JSON.parse(localStorage.getItem(LS_PLANMEM) || "null");
  } catch {
    return null;
  }
}
function savePlanMemory(m: WizAnswers) {
  try {
    if (m) localStorage.setItem(LS_PLANMEM, JSON.stringify(m));
    else localStorage.removeItem(LS_PLANMEM);
  } catch {
    /* ignore */
  }
}
function saveMealPlan(mealPlan: MealPlan, pending: boolean) {
  // A pending preview is deliberately NOT committed — leave whatever is stored
  // untouched until the user keeps it.
  if (pending) return;
  try {
    if (mealPlan) localStorage.setItem(LS_MEAL, JSON.stringify(mealPlan));
    else localStorage.removeItem(LS_MEAL);
  } catch {
    /* ignore */
  }
}

// ---- context --------------------------------------------------------------
interface AppContextValue extends AppData {
  ready: boolean;
  today: Date;
  todayStr: string;
  // mutators
  setState: (patch: Partial<AppState>) => void;
  logWeight: (raw: string) => void;
  setStartDate: (v: string) => void;
  setEndDate: (v: string) => void;
  setUnit: (u: Unit) => void;
  setSex: (s: Sex) => void;
  setAboutOpen: (v: boolean) => void;
  setPlanOpen: (v: boolean) => void;
  confirmPlan: () => void;
  setTab: (t: "projection" | "meal") => void;
  setMeal: (patch: Partial<Pick<AppData, "mealPlan" | "mealPlanPending" | "mealDay" | "mealEditor" | "lastWizAnswers">>) => void;
  clearAllData: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside <AppProvider>");
  return ctx;
}

function defaultState(todayStr: string): AppState {
  const today = new Date(todayStr + "T00:00:00");
  return {
    weight: "",
    pct: "1",
    startDate: todayStr,
    endDate: Format.toDateStr(Format.addDays(today, DEFAULT_PHASE_WEEKS * 7)),
    unit: "kg",
    sex: "",
    height: "",
    pattern: "even",
    highDays: "2",
    curSteps: "",
    planConfirmed: true,
  };
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  // today is fixed for the session; computed once on mount (client only).
  const todayRef = useRef<Date>(new Date(0));
  const todayStrRef = useRef<string>("1970-01-01");

  const [data, setData] = useState<AppData>(() => ({
    state: defaultState("1970-01-01"),
    logHistory: [],
    mealPlan: null,
    mealPlanPending: false,
    mealDay: 0,
    mealEditor: null,
    lastWizAnswers: null,
    tab: "projection",
    aboutOpen: false,
    planOpen: false,
  }));

  // persist() — same four sinks as the original, driven off the latest data.
  const persist = useCallback((d: AppData) => {
    saveSettings(d.state);
    saveMealPlan(d.mealPlan, d.mealPlanPending);
    savePlanMemory(d.lastWizAnswers);
    Share.writeURL(
      d.state,
      d.logHistory,
      d.mealPlan,
      d.mealPlanPending,
      d.lastWizAnswers
    );
  }, []);

  // Commit a functional update AND persist the result in one go, mirroring the
  // original "mutate state → persist() → render()" sequence.
  const commit = useCallback(
    (fn: (prev: AppData) => AppData) => {
      setData((prev) => {
        const next = fn(prev);
        persist(next);
        return next;
      });
    },
    [persist]
  );

  // ---- hydration (client only) --------------------------------------------
  useEffect(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = Format.toDateStr(today);
    todayRef.current = today;
    todayStrRef.current = todayStr;

    const urlData = Share.readURL();
    const lsSettings = loadSettings();

    // Local settings win once the device has been used; a shared link only seeds
    // a device that has none yet.
    function pick(key: string, dflt: string): string {
      const sk = key === "end" ? "endDate" : key === "start" ? "startDate" : key;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ls: any = lsSettings;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const url: any = urlData;
      if (ls && ls[sk] != null && ls[sk] !== "") return ls[sk];
      if (url && url[sk] != null && url[sk] !== "") return url[sk];
      return dflt;
    }

    const base = defaultState(todayStr);
    const state: AppState = {
      ...base,
      pct: pick("pct", "1"),
      startDate: pick("start", todayStr),
      endDate: pick("end", base.endDate),
      unit: (pick("unit", "kg") as Unit),
      sex: (pick("sex", "") as Sex),
      height: pick("height", ""),
      pattern: (pick("pattern", "even") as Pattern),
      highDays: pick("highDays", "2"),
      curSteps: pick("curSteps", ""),
      planConfirmed: !!(lsSettings && lsSettings.planConfirmed !== false),
    };

    // meal plan: local copy wins, else the shared link seeds it.
    let mealPlan: MealPlan = null;
    try {
      const ls = localStorage.getItem(LS_MEAL);
      if (ls) mealPlan = MealPlanCodec.normalizeMealPlan(JSON.parse(ls));
    } catch {
      /* ignore */
    }
    if (!mealPlan && urlData && urlData.meal) {
      mealPlan = MealPlanCodec.decodeMealPlan(urlData.meal);
    }

    // plan memory (wizard answers): local wins, else seed from the link.
    let lastWizAnswers: WizAnswers = loadPlanMemory();
    if (!lastWizAnswers && urlData && (urlData.cc || urlData.prefs || urlData.country)) {
      lastWizAnswers = {
        cc: urlData.cc || "",
        country: urlData.country || "",
        prefs: urlData.prefs || "",
        breakfast: urlData.breakfast || "",
        mealsPerDay: urlData.meals || "",
        calorieSplit: urlData.split || "even",
      };
    }

    const planOpen = !state.planConfirmed;
    const aboutComplete = !!state.sex && state.height !== "";

    // Load the weight history, then seed from a shared link if the device is
    // empty, and fill today's weight field from the log.
    WeightLog.getAll()
      .then((hist: LogEntry[]) => {
        if ((!hist || !hist.length) && urlData && urlData.log) {
          const seeded = Share.decodeLog(urlData.log);
          if (seeded.length) {
            return WeightLog.putMany(seeded).then(() => WeightLog.getAll());
          }
        }
        return hist;
      })
      .then((hist: LogEntry[]) => {
        const logHistory = hist || [];
        const todayEntry = logHistory.filter((e) => e.date === todayStr).pop();
        const weight = todayEntry ? String(todayEntry.weight) : "";
        setData({
          state: { ...state, weight },
          logHistory,
          mealPlan,
          mealPlanPending: false,
          mealDay: 0,
          mealEditor: null,
          lastWizAnswers,
          tab: "projection",
          aboutOpen: !aboutComplete,
          planOpen,
        });
        setReady(true);
      })
      .catch(() => {
        setData((prev) => ({
          ...prev,
          state,
          mealPlan,
          lastWizAnswers,
          aboutOpen: !aboutComplete,
          planOpen,
        }));
        setReady(true);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- mutators ------------------------------------------------------------
  const setState = useCallback(
    (patch: Partial<AppState>) => {
      commit((prev) => ({ ...prev, state: { ...prev.state, ...patch } }));
    },
    [commit]
  );

  const logWeight = useCallback(
    (raw: string) => {
      const cleaned = Format.clampDecimals(raw);
      const todayStr = todayStrRef.current;
      const n = parseFloat(cleaned);
      commit((prev) => {
        let logHistory = prev.logHistory;
        if (cleaned !== "" && isFinite(n)) {
          WeightLog.put(todayStr, n);
          const idx = logHistory.findIndex((e) => e.date === todayStr);
          if (idx >= 0) {
            logHistory = logHistory.map((e, i) =>
              i === idx ? { ...e, weight: n } : e
            );
          } else {
            logHistory = [...logHistory, { date: todayStr, weight: n }].sort(
              (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
            );
          }
        } else {
          WeightLog.remove(todayStr);
          logHistory = logHistory.filter((e) => e.date !== todayStr);
        }
        return { ...prev, logHistory, state: { ...prev.state, weight: cleaned } };
      });
    },
    [commit]
  );

  const setStartDate = useCallback(
    (v: string) => {
      commit((prev) => {
        const s = v ? new Date(v + "T00:00:00") : null;
        let endDate = prev.state.endDate;
        // Moving the start date carries the end date with it (16-week phase).
        if (s && !isNaN(s.getTime())) {
          endDate = Format.toDateStr(Format.addDays(s, DEFAULT_PHASE_WEEKS * 7));
        }
        return { ...prev, state: { ...prev.state, startDate: v, endDate } };
      });
    },
    [commit]
  );
  const setEndDate = useCallback(
    (v: string) => setState({ endDate: v }),
    [setState]
  );
  const setUnit = useCallback((u: Unit) => setState({ unit: u }), [setState]);
  const setSex = useCallback((s: Sex) => setState({ sex: s }), [setState]);

  const setAboutOpen = useCallback(
    (v: boolean) => setData((prev) => ({ ...prev, aboutOpen: v })),
    []
  );
  const setPlanOpen = useCallback(
    (v: boolean) => setData((prev) => ({ ...prev, planOpen: v })),
    []
  );
  const confirmPlan = useCallback(() => {
    commit((prev) => ({
      ...prev,
      planOpen: false,
      state: { ...prev.state, planConfirmed: true },
    }));
  }, [commit]);

  const setTab = useCallback(
    (t: "projection" | "meal") => setData((prev) => ({ ...prev, tab: t })),
    []
  );

  const setMeal = useCallback(
    (
      patch: Partial<
        Pick<
          AppData,
          "mealPlan" | "mealPlanPending" | "mealDay" | "mealEditor" | "lastWizAnswers"
        >
      >
    ) => {
      commit((prev) => ({ ...prev, ...patch }));
    },
    [commit]
  );

  const clearAllData = useCallback(() => {
    WeightLog.clear().then(() => {
      try {
        localStorage.removeItem(LS_SETTINGS);
        localStorage.removeItem(LS_MEAL);
        localStorage.removeItem(LS_PLANMEM);
      } catch {
        /* ignore */
      }
      const todayStr = todayStrRef.current;
      try {
        history.replaceState(null, "", location.pathname);
      } catch {
        /* ignore */
      }
      setData((prev) => ({
        ...prev,
        state: { ...defaultState(todayStr), planConfirmed: false },
        logHistory: [],
        mealPlan: null,
        mealPlanPending: false,
        mealDay: 0,
        mealEditor: null,
        lastWizAnswers: null,
        aboutOpen: true,
        planOpen: true,
      }));
    });
  }, []);

  const value: AppContextValue = {
    ...data,
    ready,
    today: todayRef.current,
    todayStr: todayStrRef.current,
    setState,
    logWeight,
    setStartDate,
    setEndDate,
    setUnit,
    setSex,
    setAboutOpen,
    setPlanOpen,
    confirmPlan,
    setTab,
    setMeal,
    clearAllData,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

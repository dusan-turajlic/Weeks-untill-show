/*
 * Ambient declarations for the plain-JS shared-core modules and the meal-plan
 * modules. They ship as CommonJS (dual browser/Node) and are imported by the
 * React app; typing them loosely as `any` keeps the interop friction-free while
 * leaving the JS as the single source of truth (and still testable under Node).
 */

// Shared calorie / projection / meal-plan core (repo /core)
declare module "@/core/energy.js";
declare module "@/core/offtrack.js";
declare module "@/core/plan.js";
declare module "@/core/format.js";
declare module "@/core/mealplan.js";
declare module "@/core/share.js";
declare module "@/core/weightlog.js";
declare module "@/core/prompt.js";

// On-device planner core (repo /meal-plan) — includes the WebLLM engine bridge
declare module "@/meal-plan/solver.js";
declare module "@/meal-plan/food-lookup.js";
declare module "@/meal-plan/planner.js";

/*
 * Small formatting/date helpers, ported verbatim from index.html's
 * "// ---- helpers" region. Pure (no DOM). Dual CommonJS export.
 */
"use strict";

function toDateStr(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function addDays(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
function fmt(n) { return isFinite(n) ? n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—"; }
function fmt0(n) { return isFinite(n) ? Math.round(n).toLocaleString() : "—"; }   // whole numbers (kcal, g, steps)
function clampDecimals(val) {
  if (val === "") return "";
  var cleaned = val.replace(/,/g, ".").replace(/[^0-9.]/g, "");   // comma -> dot
  var parts = cleaned.split(".");
  if (parts.length > 2) cleaned = parts[0] + "." + parts.slice(1).join("");
  var ip = cleaned.split(".")[0], dp = cleaned.split(".")[1];
  if (dp !== undefined) cleaned = ip + "." + dp.slice(0, 2);
  return cleaned;
}
function prettyDate(str) {
  if (!str) return "—";
  var d = new Date(str + "T00:00:00");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

var api = { toDateStr: toDateStr, addDays: addDays, fmt: fmt, fmt0: fmt0, clampDecimals: clampDecimals, prettyDate: prettyDate };
if (typeof module !== "undefined" && module.exports) module.exports = api;
else (typeof window !== "undefined" ? window : this).YdinFormat = api;

/*
 * Daily weight log: IndexedDB with a localStorage fallback. Ported verbatim
 * from index.html. Browser-only at call time (indexedDB/localStorage); importing
 * is inert. Dual CommonJS export so it can be imported from the React app.
 *
 * Stored as { date:"YYYY-MM-DD", weight:Number }.
 */
"use strict";

var WeightLog = (function () {
  var DB_NAME = "weightProjection", DB_VERSION = 1, STORE = "weights", LS_KEY = "wp:log";
  var dbPromise = null, useIDB = (typeof indexedDB !== "undefined" && indexedDB);

  function openDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "date" });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function db() {
    if (!dbPromise) dbPromise = openDB();
    return dbPromise;
  }
  // localStorage fallback (date -> weight map) ----------------------------
  function lsRead() { try { return JSON.parse(localStorage.getItem(LS_KEY) || "{}") || {}; } catch (e) { return {}; } }
  function lsWrite(m) { try { localStorage.setItem(LS_KEY, JSON.stringify(m)); } catch (e) { } }
  function lsAll() {
    var m = lsRead(), out = [];
    for (var d in m) { if (Object.prototype.hasOwnProperty.call(m, d)) out.push({ date: d, weight: m[d] }); }
    return out.sort(byDate);
  }
  function byDate(a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; }

  function fallback(fn) { useIDB = false; dbPromise = null; return fn(); }

  function getAll() {
    if (!useIDB) return Promise.resolve(lsAll());
    return db().then(function (d) {
      return new Promise(function (res, rej) {
        var rq = d.transaction(STORE, "readonly").objectStore(STORE).getAll();
        rq.onsuccess = function () { res((rq.result || []).sort(byDate)); };
        rq.onerror = function () { rej(rq.error); };
      });
    }).catch(function () { return fallback(function () { return lsAll(); }); });
  }
  function put(date, weight) {
    if (!useIDB) { var m = lsRead(); m[date] = weight; lsWrite(m); return Promise.resolve(); }
    return db().then(function (d) {
      return new Promise(function (res, rej) {
        var tx = d.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put({ date: date, weight: weight });
        tx.oncomplete = function () { res(); }; tx.onerror = function () { rej(tx.error); };
      });
    }).catch(function () { return fallback(function () { var m = lsRead(); m[date] = weight; lsWrite(m); }); });
  }
  function remove(date) {
    if (!useIDB) { var m = lsRead(); delete m[date]; lsWrite(m); return Promise.resolve(); }
    return db().then(function (d) {
      return new Promise(function (res, rej) {
        var tx = d.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(date);
        tx.oncomplete = function () { res(); }; tx.onerror = function () { rej(tx.error); };
      });
    }).catch(function () { return fallback(function () { var m = lsRead(); delete m[date]; lsWrite(m); }); });
  }
  // bulk merge (used when importing history from a shared link) -----------
  function putMany(entries) {
    return entries.reduce(function (p, e) { return p.then(function () { return put(e.date, e.weight); }); }, Promise.resolve());
  }
  function clear() {
    if (!useIDB) { lsWrite({}); return Promise.resolve(); }
    return db().then(function (d) {
      return new Promise(function (res, rej) {
        var tx = d.transaction(STORE, "readwrite");
        tx.objectStore(STORE).clear();
        tx.oncomplete = function () { res(); }; tx.onerror = function () { rej(tx.error); };
      });
    }).catch(function () { return fallback(function () { lsWrite({}); }); });
  }
  return { getAll: getAll, put: put, remove: remove, putMany: putMany, clear: clear };
})();

if (typeof module !== "undefined" && module.exports) module.exports = WeightLog;
else (typeof window !== "undefined" ? window : this).YdinWeightLog = WeightLog;

"use strict";
// Invite-gate token storage — extracts the real functions from index.html and
// runs them against a fake localStorage, the same dependency-free pattern as
// offtrack.test.js. Run: node test/invite-gate.test.js
var fs = require("fs");
var path = require("path");

var html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
function region(start, end) {
  var i = html.indexOf(start), j = html.indexOf(end);
  if (i < 0 || j < 0 || j <= i) throw new Error("Could not locate region: " + start);
  return html.slice(i, j);
}
var src = region("// ---- invite gate: token storage", "// ---- invite gate: end");

function load() {
  var store = {};
  var localStorage = {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; },
  };
  /* jshint evil:true */
  var factory = new Function(
    "localStorage", "LS_INVITE",
    src + "\nreturn { store: null, loadInviteToken: loadInviteToken, saveInviteToken: saveInviteToken, gateUnlocked: gateUnlocked };"
  );
  var api = factory(localStorage, "wp:invite");
  api.store = store;
  return api;
}

var passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name); }
}

console.log("invite gate: token storage");

var a = load();
check("starts locked with no token", a.gateUnlocked() === false && a.loadInviteToken() === null);

a.saveInviteToken("tok-abc-123");
check("saving a token unlocks the gate", a.gateUnlocked() === true);
check("the saved token round-trips", a.loadInviteToken() === "tok-abc-123");
check("the token is persisted under wp:invite", /tok-abc-123/.test(a.store["wp:invite"]));

a.saveInviteToken(null);
check("clearing the token re-locks the gate", a.gateUnlocked() === false && a.loadInviteToken() === null);

var b = load();
b.store["wp:invite"] = "not valid json";
check("a corrupt stored value reads as no token", b.loadInviteToken() === null);

var c = load();
c.store["wp:invite"] = JSON.stringify({ at: 123 }); // no token field
check("a stored object without a token reads as no token", c.loadInviteToken() === null);

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);

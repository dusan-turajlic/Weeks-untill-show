/*
 * Runs the whole pure-Node test suite (no browser/GPU). Mirrors the loop in
 * CLAUDE.md so `npm test` and CI stay in sync.
 */
"use strict";
var { execFileSync } = require("child_process");
var path = require("path");

var suites = ["harness", "solver", "foodlookup", "planner", "energy", "offtrack", "webllm"];
var failed = [];

for (var i = 0; i < suites.length; i++) {
  var name = suites[i];
  process.stdout.write("\n=== " + name + " ===\n");
  try {
    execFileSync("node", [path.join(__dirname, name + ".test.js")], { stdio: "inherit" });
  } catch (e) {
    failed.push(name);
  }
}

process.stdout.write("\n" + (failed.length ? "FAILED: " + failed.join(", ") : "ALL SUITES PASSED") + "\n");
process.exit(failed.length ? 1 : 0);

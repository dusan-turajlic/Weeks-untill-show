# A reliable local AI harness for the meal planner

Research notes + a concrete design for turning the on-device (Path A) planner
into a proper **agent harness**: one that can search the web, validate its own
assumptions, call the model many times with different prompts, and produce a
plan that is *verifiable* rather than merely plausible.

The guiding constraint you gave: **running locally there is no token or session
budget.** That single fact flips the usual trade-off. Frontier-API harnesses are
engineered to be *frugal* — every extra model call costs money and latency. A
local WebLLM harness can be *lavish*: fan out, vote, re-ask, and verify as much
as it takes, because the only cost is a few seconds of the user's own GPU. This
document leans into that.

---

## 1. What an "AI harness" actually is

The industry has converged on a clear definition over the last two years: **what
turns an LLM into an agent isn't the model — it's the harness.** The harness is
the software wrapping the model: the orchestration loop, the tools, context
management, memory, error handling, guardrails, and termination. The model is a
stateless text function; the harness is the persistent system around it that
makes it *do* things reliably.

A useful framing from the field: *"Your agent needs a harness, not a
framework."* A framework hides the loop from you; a harness **is** the loop, and
you own every step of it. Reliability comes from owning that loop — deciding
exactly when to call the model, what to feed it, how to check the answer, and
what to do when the answer is wrong.

### The core loop

Every harness, from Claude Code to a research agent, runs the same shape:

```
receive input
  → build context (state + memory + tool results so far)
  → call model
  → parse / route the response
  → if it asked for a tool: run the tool, feed the result back, repeat
  → if it produced an answer: validate it
       → valid?   → done
       → invalid? → feed the failure back and repeat
  → terminate (success, give-up, or budget/step cap)
```

Three components define the agent inside that loop: **LLM + Tools + Context.**
Everything else — retries, voting, verification — is engineering *around* those
three to fight the model's non-determinism.

### Why reliability is hard

LLMs are non-deterministic and phrasing-sensitive: the same question asked two
ways gives two answers, and small models (the kind that fit in a browser) are
worse. Research on multi-step tool-calling pipelines found that **inconsistency
predicts failure** — and, notably, that naive "self-reflection" does *not*
reliably help. What *does* help are the structural patterns below.

**Sources:**
- [The Anatomy of an Agent Harness — Daily Dose of DS](https://blog.dailydoseofds.com/p/the-anatomy-of-an-agent-harness)
- [Your Agent Needs a Harness, Not a Framework — Inngest](https://www.inngest.com/blog/your-agent-needs-a-harness-not-a-framework)
- [Building an AI Agent Harness from Scratch — DEV](https://dev.to/thedailyagent/building-an-ai-agent-harness-from-scratch-the-architecture-between-llm-and-agent-5gg6)
- [Awesome Harness Engineering (patterns, evals, MCP, observability)](https://github.com/ai-boost/awesome-harness-engineering)
- [How Consistent Are LLM Agents? (arXiv 2605.28840)](https://arxiv.org/html/2605.28840)
- [VerifiAgent: a Unified Verification Agent (arXiv 2504.00406)](https://arxiv.org/pdf/2504.00406)
- [LLM Fan-Out 101: Self-Consistency, Consensus, Voting — Kinde](https://www.kinde.com/learn/ai-for-software-engineering/workflows/llm-fan-out-101-self-consistency-consensus-and-voting-patterns/)

---

## 2. The reliability patterns worth stealing

These are the load-bearing techniques. Each maps directly onto something the
meal planner needs.

| Pattern | What it does | Why it fits us |
|---|---|---|
| **Tool use / function calling** | The model *names* what it wants; deterministic code *does* it. | Already the whole philosophy here — the model names foods, the solver does grams. |
| **Verify → repair loop** | Check the output against hard constraints; on failure, feed the specific failure back and re-ask. | `solver.verify()` already emits per-constraint failures; today they drive a *code* repair, not a *model* repair. |
| **Fan-out + self-consistency (voting)** | Ask N times (different seeds/prompts), keep the answer the majority agree on. Correct answers cluster; hallucinations scatter. | Free locally. Turns one shaky small-model call into a stable one. |
| **Prompt ensemble** | Ask the *same* question phrased several ways, then consolidate — counters phrasing-sensitivity. | Small models are very phrasing-sensitive; this is cheap insurance. |
| **Assumption validation** | Before acting, restate the inferred inputs and check them against a source of truth (or the user). | We infer country/prefs/macros — each is a place to validate, not assume. |
| **Web search tool** | Give the model a real-world lookup instead of trusting its memory. | Real local products, real prices, real retailers — the copy-prompt path's quality ceiling, brought on-device. |
| **Termination + guardrails** | Step caps, stall watchdogs, blocklists so the loop always ends. | You already have stall watchdogs and a model blocklist in `planner.js`. |
| **Observability** | Log every step so a bad plan is debuggable, not mysterious. | `onProgress` exists; extend it into a structured trace. |

---

## 3. You are already ~60% of a harness

Before adding anything, it's worth naming what's already here, because the design
is an *extension* of it, not a rewrite. In `meal-plan/`:

- **Tool surface** — `FOOD_TOOLS` + `dispatchTool` (`food-lookup.js:299`) already
  expose `search_foods` and `build_meal_totals` as OpenAI-style function tools.
  WebLLM is OpenAI-API-compatible, so this is a real, ready tool layer — it's
  just **not yet wired into an agentic loop**; the planner calls the model with
  free-text JSON prompts instead.
- **Verification** — `solver.verify()` (`solver.js:197`) returns exactly the
  structured, per-constraint failure list a repair loop needs.
- **A code-side repair loop** — `assembleLayoutDay` (`planner.js:222`) already
  loops: solve → on failure, `gatherFoods(repairQueries(...))` → re-solve. This
  is a harness loop where the "agent" is deterministic code. Making the *model*
  a participant in that loop is the upgrade.
- **Termination + guardrails** — stall watchdogs (`STALL_MS`, `GEN_STALL_MS`),
  a persisted model blocklist, and a deterministic staple fallback all exist.
- **Multi-call orchestration** — per-meal `designMeal`, one-food-at-a-time
  `guessMacros`, and `summarize` already fan the work across many small,
  focused calls (the right instinct for small models).
- **Loose-JSON parsing** — `parseLooseJSON` already tolerates the prose/fences a
  small model wraps around its answer.

The gap is the *reliability* layer: nothing today asks twice and votes, nothing
validates an inferred assumption before committing, nothing reaches the web, and
the model never sees its own verification failures. That's what section 5 adds.

---

## 4. The design principle for "no budget locally"

Frontier harnesses optimize `quality per token`. Yours optimizes `quality`,
full stop — tokens are free. Practical consequences:

1. **Replace single calls with votes.** Anywhere a small model makes one shaky
   choice, make it 3–5 times and take the consensus. This is the single biggest
   reliability win available and it costs only wall-clock.
2. **Verify by re-asking, not just by clamping.** Today a hallucinated macro is
   *clamped* (`sanitizeGuess`, `planner.js:178`). With free tokens you can
   instead *re-ask a second model call to check it* and only clamp as a last
   resort.
3. **Escalate model size on hard steps.** The device can load a bigger model for
   a hard call (design the whole day) and a tiny one for easy calls (guess one
   macro). Model choice becomes per-step, not per-session.
4. **Budget in *steps and wall-clock*, not tokens.** The termination guardrails
   change from "stop spending money" to "stop the user waiting" — a step cap and
   the existing stall watchdogs, nothing more.

---

## 5. Proposed architecture: the local planning harness

A single orchestrator loop — call it `runPlanningHarness()` — that drives the
model through explicit *stages*, each with its own validation gate. It sits
where `buildPlan()`'s `selectP` logic is today and reuses every existing module.

```
┌─────────────────────────────────────────────────────────────────┐
│  runPlanningHarness(wizardAnswers, targets, io, engine)          │
│                                                                   │
│  Stage 0  RESOLVE ASSUMPTIONS                                     │
│    • Restate inferred country / currency / diet / meals-per-day.  │
│    • VALIDATE: web_search "supermarkets in <country>" confirms    │
│      the region resolves; if not → ask the user (AskUser gate).   │
│                                                                   │
│  Stage 1  DESIGN  (per meal, FAN-OUT + VOTE)                      │
│    • For each meal: call designMeal N times (different seeds).    │
│    • Consensus foods (named by ≥⌈N/2⌉ runs) win; outliers drop.   │
│    • Diet guardrail: dietBans() filters banned foods pre-vote.    │
│                                                                   │
│  Stage 2  GROUND  (tool use, not memory)                         │
│    • For each chosen food: search_foods (catalog) → real barcode. │
│    • Unmatched foods → web_search for a real local product,       │
│      THEN guessMacros only if the web gives nothing.              │
│                                                                   │
│  Stage 3  SOLVE + VERIFY→REPAIR  (model in the loop)             │
│    • solvePortions → verify(). On failure, feed the EXACT failed  │
│      constraints back to the model: "protein 96/135 — add or swap │
│      a high-protein food that fits <diet>." Re-solve. Cap rounds. │
│    • Cross-check: a second model call sanity-reads the day        │
│      ("does this look like real food a person eats?").            │
│                                                                   │
│  Stage 4  PRICE  (web search)                                     │
│    • web_search each product for a real retailer + price;         │
│      sum against weeklyBudget; flag overspend.                    │
│                                                                   │
│  Stage 5  ASSEMBLE + SELF-CHECK                                   │
│    • Build import JSON (existing code).                           │
│    • Final validation gate: schema-validate + re-run verify() on  │
│      the assembled totals. Emit a structured trace of every stage.│
└─────────────────────────────────────────────────────────────────┘
      every stage → onTrace(stage, inputs, outputs, validation)
```

### The three new capabilities you asked for, concretely

**a) Google / web search.** WebLLM is OpenAI-API-compatible, so add a third
tool to `FOOD_TOOLS`:

```js
{ type: "function", function: {
    name: "web_search",
    description: "Search the web for real local products, prices, and retailers. " +
      "Use when the catalog lacks a food, or to price a shopping list.",
    parameters: { type: "object",
      properties: { query: { type: "string" } }, required: ["query"] } } }
```

The one real constraint: **a browser can't call Google directly** — CORS blocks
it, and scraping is fragile. The clean options, cheapest-first:

1. **A search API with a browser-callable endpoint** — Brave Search API, Serper,
   or SerpApi. One `fetch` from the client; a key in the request. SerpApi's
   `json_restrictor` can trim responses ~99% so a small model isn't drowned.
2. **A tiny proxy** (Cloudflare Worker / any function) that holds the key and
   returns trimmed results — keeps the key off the client and normalizes shape.
3. **Fully offline** — skip the web tool; the catalog + `guessMacros` already
   cover it. Web search becomes a progressive enhancement, gated like Path A is
   gated on WebGPU.

Dispatch it in `dispatchTool` next to the existing two, returning
`[{title, snippet, url, price?}]`. Feed only the trimmed fields back to the
model. (Prior art for exactly this client-side pattern:
[llm-local-web-search](https://github.com/tbocek/llm-local-web-search),
[serpapi/local-llm-web-search](https://github.com/serpapi/local-llm-web-search).)

**b) Validate assumptions.** Two mechanisms:

- *Against a source of truth* — after Stage 0 infers a country, a `web_search`
  (or a catalog probe) confirms it resolves to real retailers before the whole
  plan is built on it. A hallucinated macro in Stage 2 is validated by
  re-asking a second call and comparing, *then* clamped by `sanitizeGuess` only
  if they disagree — clamp becomes the floor, not the only check.
- *Against the user* — when validation is genuinely ambiguous (region doesn't
  resolve, diet string is contradictory), surface it rather than guess. In this
  Claude Code context that's an `AskUserQuestion`; in the shipped PWA it's a
  one-line confirm chip in the wizard.

**c) Call the model many times with different prompts.** This is fan-out +
prompt-ensemble, and it's where "free local tokens" pays off. A small helper:

```js
// Ask the model K times (varied seed/temperature/paraphrase) and return the
// answer the majority agree on. Correct answers cluster; hallucinations scatter.
async function vote(engine, buildPrompt, k, keyOf) {
  const runs = await Promise.all(
    Array.from({ length: k }, (_, i) => engine.chatJSON(buildPrompt(i))));
  const tally = new Map();
  for (const r of runs) for (const item of r) {
    const key = keyOf(item);
    tally.set(key, (tally.get(key) || 0) + 1);
  }
  return [...tally].filter(([, n]) => n >= Math.ceil(k / 2)).map(([k]) => k);
}
```

Wrap `designMeal`, `suggestFoods`, and `guessMacros` in `vote(...)`. Same code,
dramatically steadier output — this is the mechanism that makes a 360M model
usable instead of a coin-flip.

---

## 6. Making it *validatable* — the eval harness

"Reliable and can be validated" needs a second harness: an **offline eval loop**
so you can prove a change helped instead of hoping. You already have the bones —
`test/` runs pure-Node tests against the real solver and food-lookup.

Add `test/harness.eval.js`: a fixed set of scenarios (country × diet ×
meals/day × budget) run through `runPlanningHarness()` with a **mock engine**
that replays canned/adversarial model outputs (including deliberately bad ones:
banned foods, wild macros, empty answers). Assert on the *validation gates*, not
on exact text:

- Every day's `verify()` passes (or is honestly flagged in `unmet`).
- No banned food survives `dietBans()`.
- Final JSON validates against the import schema in `docs/meal-plan-prompt.md`.
- The trace shows each stage ran and each gate fired.
- Voting converges: given noisy mock outputs, consensus still yields a solvable
  plate.

Because the engine is injectable (the code already does this — `options.webllm`
and `io` are seams), this runs in Node with zero GPU, in CI, deterministically.
That is what "validatable" means in practice: **the harness's guarantees are
themselves under test.**

---

## 7. Suggested build order

Each step is independently shippable and testable; none requires a rewrite.

1. **Wire the existing tools into a real loop.** Add `engine.chatWithTools()`
   that runs the WebLLM tool-call loop against `FOOD_TOOLS`/`dispatchTool`.
   Deterministic, testable with a mock engine. *(No new deps.)*
2. **Add `vote()` and wrap `designMeal`.** Pure orchestration; unit-test the
   consensus logic with canned outputs. Biggest reliability win per line.
3. **Feed `verify()` failures back to the model** in Stage 3 (model repair
   before/alongside the existing code repair).
4. **Add assumption validation** (Stage 0) with an `AskUser`/confirm-chip gate.
5. **Add the `web_search` tool** behind a capability gate (like WebGPU gates
   Path A), starting with a search API or proxy; keep offline as the fallback.
6. **Build `test/harness.eval.js`** and gate merges on it.

Steps 1–3 need no network and no new dependencies — they're pure reliability and
land immediately. Steps 4–5 add the web reach. Step 6 makes all of it provable.

---

## 8. TL;DR

- A **harness** is the loop + tools + context around a stateless model; that's
  where reliability lives, and you already have most of it in `meal-plan/`.
- The three things you asked for map to three known patterns: **web search =**
  a tool (add to `FOOD_TOOLS`, dispatch via a search API/proxy since browsers
  can't hit Google directly); **validate assumptions =** a validation gate per
  stage, checked against a source of truth or the user; **many prompts =**
  fan-out + voting (`vote()`), which is where free local tokens buy the most.
- **"No budget locally" changes the design:** vote instead of single-shot,
  re-ask to verify instead of only clamping, size the model per-step. Budget in
  wall-clock, not tokens.
- **Validatable** means a second, offline **eval harness** with a mock engine in
  `test/`, asserting the validation gates hold under adversarial model output.

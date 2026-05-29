# Weeks-untill-show

A small, installable web app (PWA) that counts the weeks until a target date and
projects your weight over that time, assuming a fixed percentage of fat loss
each week. Built as a single static `index.html` — no build step, no
dependencies.

## What it does

- **Weeks-left countdown** — pick an end date and see how many whole weeks remain
  from today.
- **Weight projection** — enter your current weight and a weekly loss percentage.
  The app compounds that loss week over week and shows your projected weight on
  the target date, total lost, and the percentage of your starting weight.
- **Trajectory chart** — an inline SVG line chart of your weight from today
  (week N) to your end date (week 0).
- **Week-by-week table** — every week's projected weight and cumulative loss.
- **Calories, macros & steps** — set your sex and height once (it collapses to a
  summary afterwards, so return visits land on the weight field) and the app
  works out the daily calories to eat to hit your goal as the headline, plus
  maintenance, a protein / fat / carb split (with a fibre target), and the daily
  step count needed to make up the rest of the deficit. See
  [How the calorie numbers work](#how-the-calorie-numbers-work).
- **kg / lb toggle** — switch units on the fly (height follows as cm / in).
- **Shareable links** — all inputs are stored in the URL's query string, so you
  can bookmark or share a link to restore the exact projection (use the
  "Copy shareable link" button).
- **Installable & offline** — it's a PWA with a web app manifest and a service
  worker, so it can be added to your home screen and works offline.

## Running it

It's fully static. Any HTTP server works — for example:

```bash
# Python
python3 -m http.server 8000

# or Node
npx serve .
```

Then open `http://localhost:8000`.

> Note: the service worker and "add to home screen" install only work over
> `http://localhost` or HTTPS, not from a `file://` URL.

## Files

| File | Purpose |
|------|---------|
| `index.html` | The entire app — markup, styles, and logic |
| `manifest.webmanifest` | PWA metadata (name, icons, theme, display mode) |
| `sw.js` | Service worker — network-first for HTML, cache-first for assets |
| `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` | App icons |
| `apple-touch-icon.png` | iOS home-screen icon |

## How the projection works

Each week the weight is multiplied by `(1 − rate)`, where `rate` is the weekly
loss percentage divided by 100 — so the loss compounds on your current weight
rather than being linear. Week 0 is your end date; higher week numbers count
back toward today. Only whole weeks between today and the end date are shown.

## How the calorie numbers work

The aim is to keep input minimal — sex, height and your logged weight — and turn
the chosen rate of loss into a simple, actionable plan. All figures are
estimates.

- **Maintenance calories** — your current weight in **pounds** × a multiplier
  that tapers as weight rises (the midpoint of a sex-specific range). For
  example a male under 200 lb uses ~12×, 200–250 lb ~10.5×, and so on; women use
  a slightly higher set of brackets. Weight entered in kg is converted to lb
  first.
- **Minimum protein & fat** — set by your **height** (interpolated from a
  reference table, in cm) to protect muscle and keep hormones healthy.
- **"Prefer not to say"** — every sex-keyed figure (maintenance multiplier,
  protein and fat) is computed for both male and female and averaged.
- **Carbs** — whatever calories are left after protein (4 kcal/g) and fat
  (9 kcal/g), at 4 kcal/g — including a target of **≥35 g fibre**.
- **Deficit & intake** — the projected weight to lose × ~7,700 kcal/kg (≈3,500
  kcal/lb), spread over the days until your end date. The deficit taken from
  **food is capped at 700 kcal** so the diet never gets too aggressive.
- **Steps** — any deficit beyond that 700 kcal is made up with walking. The app
  shows the daily step count for it, using a height-based stride and the net
  cost of walking (~0.5 kcal per kg per km). Enter your **current daily step
  average** (optional, under "About you") and the plan shows your *total* daily
  step target — your current average plus what's added — instead of just the
  extra.

### Eating patterns (carb cycling)

You can spread the same weekly calories across different day types:

- **Even** — the same macros every day (default).
- **High / Low** — high-carb days + low-carb days.
- **Carb cycle** — high + medium + low days.

Pick the pattern from the tabs, and choose **1 or 2 high-carb days** with the
sub-tabs (fewer high days means each one packs in more carbs).

The **whole week still totals 7 × your goal intake**, so the goal is unchanged —
only the day-to-day distribution shifts:

- **High / Low** — 1 high day + 6 low, or 2 high days + 5 low.
- **Carb cycle** — always 1 high day + 2 medium days + 4 low days.

**Protein is constant every day** in both patterns; only carbs (and, in carb
cycle, fat) move around. The two patterns work differently:

**High / Low** is a pure **carb shift** off the even baseline — protein *and*
fat stay exactly the same every day, and carbs are pulled off the low days and
stacked onto the high day(s):

- **1 high day** — cut **100 kcal of carbs** (−25 g) from each of the 6 low
  days and pile all 600 kcal onto the high day as carbs (**+150 g**).
- **2 high days** — cut **150 kcal of carbs** (−37.5 g) from each of the 5 low
  days and split the 750 kcal across the two high days (**+93.75 g each**).

Because it only moves carbs around, the week still totals 7 × your goal intake
exactly. If the low days bottom out at the 35 g carb floor before funding the
full bump, the **high day's fat is trimmed first** (from its height minimum down
to a 0.6 g/kg floor) to make room for the carbs — that keeps the day healthy and
avoids piling on cardio. Only what's still unfunded after that is walked off with
**steps on the high day**.

**Carb cycle** keeps a focused macro split per day type:

- **High day** — carbs = **35%** of the day's calories, fat is the remainder.
- **Medium day** — fat = **35%** of calories, carbs are the remainder.
- **Low day** — a solid **0.7 g/kg** fat at the 35 g carb floor.

The week still totals 7 × your goal intake. If the deficit is steep enough that
solid low-day fat would make low days out-eat the high days, the low-day fat
eases down toward the floor until the high days are biggest again.

Steps are the **same every day** (whatever the goal needs beyond a 700 kcal food
deficit), with any extra from the cases above added to the **high day** — where
you've eaten enough to walk them. The per-day calories, macros and steps are
shown in a table.

These are general estimates, not medical advice. If even a capped food deficit
can't fit your protein + fat minimums, the app says so — lower the weekly % or
push the end date out for a gentler plan.

## Tests

Pure logic is covered by dependency-free Node tests:

```bash
node test/offtrack.test.js   # on/off-track indicator
node test/energy.test.js     # maintenance, macros, deficit cap & steps
```

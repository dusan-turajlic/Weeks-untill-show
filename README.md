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
- **kg / lb toggle** — switch units on the fly.
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

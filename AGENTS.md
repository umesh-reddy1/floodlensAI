# AGENTS.md — FloodLens AI

Static, dependency-light web app. No build step, no package manager, no server logic.
Deploy by serving the folder as-is.

## Stack
- `index.html` — single page. App shell: navy **sidebar** (5 sections) + main column
  (topbar, command bar, and five `.view` sections):
  `#view-overview`, `#view-map`, `#view-reports`, `#view-priority`, `#view-dataquality`.
- `styles.css` — design tokens in `:root` (navy sidebar `--navy-*`, teal accent `--teal-*`,
  risk accents `--risk-low/medium/high`). Responsive breakpoints at 1200 / 1080 / 900 / 640 px.
  Global `[hidden]{display:none !important}` and grid `min-width:0` guards prevent overflow bugs.
- `sample-data.js` — generated; exposes `window.FLOODLENS` (cities, zones, rainScenarios,
  demoReports). Do not hand-edit; regenerate with `tools/gen_sample.py`.
- `app.js` — IIFE containing all logic: routing, lazy Leaflet map, scoring engine, tables,
  charts, road-damage reporting. No frameworks; plain DOM + delegated events.
- `tools/gen_sample.py` — deterministic generator for `sample-data.js`.

## Run / test
- Serve: `python3 -m http.server 12000` then open `http://localhost:12000/`.
- Syntax check: `node --check app.js`.
- Browser test with puppeteer-core + `/usr/bin/chromium` (see `/tmp/t_*.js`):
  launch with `--no-sandbox --disable-dev-shm-usage`, wait ~6–15 s for the Overpass fetch
  before asserting. To simulate a photo upload, inject a real `File` via `DataTransfer`
  (puppeteer's `uploadFile` hits a sandboxed-Chromium `FileReader` NotFoundError).

## Architecture notes
- **Routing** is hash-based: `showView(name)` toggles `[hidden]` on `.view` sections and
  `.active` on `.nav-item[data-view]`. `showView` is the only place that needs updating when
  adding a section (plus `VIEW_META`).
- **Map is lazy**: Leaflet is initialised only when the Flood Risk Map view is first shown
  (`initMap`), so the Overview dashboard renders instantly without tile/Overpass delays.
  Guard every map call with `if (state.mapReady)`.
- **Scoring engine** (all transparent, illustrative):
  - *Flood susceptibility* (simulated 0–100) = capped sum of `FLOOD_WEIGHTS`
    (rainfall 32, elevation 26, drainage 24, impervious 10, history 8).
  - *Damage severity* (0–100) = highest `CONFIRMED_SEV` among **confirmed** reports
    (`verified`/`resolved`) + duplicate bonus. No confirmed reports → 0, flagged "missing".
  - *Road importance* (0–100) = real OSM road class base (`ROAD_CLASS_BASE`) + distance bonus
    + near-road bonus; no road data → 0, flagged "missing".
  - *Priority* = `0.40·damage + 0.35·flood + 0.25·road` (`PRIORITY_WEIGHTS`) — prototype
    defaults, never described as validated.
  - Every value carries a `tag`: `real` | `sim` | `missing`, and explanations surface missing
    terms instead of estimating them.
- `computePriority(z)` returns `{score, category, damage, road, contribution, missing}`;
  `renderExplain` renders contribution bars + flood factor bars.
- `renderAll()` recomputes scores, annotations and every view. Call it after any state change.

## Key facts / gotchas
- Real data = OpenStreetMap facilities/roads via Overpass API. Use **explicit tag lists,
  never regex** (regex queries time out). Mirrors must send CORS headers; keep only the
  three working mirrors in `OVERPASS`.
- Roads are stored as `{line, class, name}` objects (not bare polylines). Legacy cached bare
  arrays are tolerated via `rl.line || rl`.
- Reports persist in `localStorage` (`floodlens.reports.v1`); real OSM geometry cached in
  `floodlens.reportMeta.v1` (only `source === "real"` cache is reused as authoritative).
  Persistence is **browser-local only** — never claim server storage.
- Duplicate suppression: within 60 m and same damage type or severity → increments `dupes`
  on the existing incident instead of creating a new one. `submitting` flag + disabled button
  prevent double-submit.
- Reports **without coordinates** appear in the list/tables but never get a map marker.
- GPS is opt-in only; never infer location automatically.
- NEVER describe simulated values (flood scores, rainfall, historical notes, demo AI severity,
  demo reports) as real observations or validated AI predictions.

# FloodLens AI — Explainable Urban Flood Impact & Priority Mapping

A polished, responsive **civic-tech decision-support dashboard** that maps urban flood risk,
public facilities and flood-related road damage, ranks locations by inspection priority, and
explains every score.

> **This is a prototype and decision-support demonstration. It is NOT an operational
> flood-warning system.** Do not use it for emergency, evacuation or life-safety decisions.

Supports **UN SDG 11 (Target 11.5)** and **SDG 13 (Target 13.1)**.

---

## Application structure

The app is one coherent product with a navy sidebar and five sections (hash-routed, no build step):

1. **Overview** — four summary cards (total reports, high-priority locations, awaiting
   verification, verified/resolved), risk distribution, exposure summary, recent reports,
   high-priority locations, submit-report call to action, and a live data-source indicator.
2. **Flood Risk Map** — interactive Leaflet map with risk zones, facilities, roads and damage
   markers; layer/facility toggles; a legend; and a detail panel that shows the selected
   zone / facility / report (risk, priority, related reports).
3. **Road Damage Reports** — the full capture → review → submit → manage workflow.
4. **Inspection Priorities** — the explainable priority engine, table and factor breakdown.
5. **Data Quality & Methodology** — real vs simulated data, method, limitations, uncertainty
   and validation needs.

Every dashboard count and chart derives from the live application state (zones, facilities,
roads, reports) — nothing is hardcoded.

---

## Features

| Feature | Notes |
|---|---|
| Interactive city map | Leaflet + real OpenStreetMap base tiles |
| Low / medium / high risk zones | Simulated, transparently-scored grid zones |
| Public-facility markers | **Real** hospitals, schools, shelters and other facilities (OpenStreetMap) |
| Road layer | **Real** primary/secondary/tertiary roads with class-based styling |
| Dashboard summary cards | Report totals, high-priority locations, pending, verified/resolved |
| Charts | Risk distribution + facility/report exposure bar charts |
| Inspection-priority table | Sortable, filterable, searchable |
| Explainable priority engine | Factor breakdown, real/simulated/missing labels, drivers |
| Rainfall scenario selector | Light / Moderate / Heavy / Cloudburst-like (illustrative) |
| Data-quality & methodology | Separates real vs simulated data and states limitations |
| Disclaimer | Banner, modal and full text |

### Road-damage capture & reporting (end to end)

* Image upload via click **or** drag-and-drop; previewed before submitting; can be cleared.
* Fields: location description, optional coordinates, damage type, severity, description,
  report date/time, optional reporter.
* Damage categories: Pothole, Cracked road, Damaged road surface, Waterlogged road,
  Possible flood-related road damage, Other.
* **Simulated** AI severity assessment (Low/Medium/High) with a confidence indicator,
  clearly labelled as a brightness/texture heuristic — **not a trained model and not a
  validated AI detection**. Severity can always be set manually.
* Validate → **Review** → **Submit**, with readable validation messages and a double-submit guard.
* Submitted reports appear immediately in the reports table, moderation queue, dashboard
  counts and priorities — and as a map marker **only when coordinates are valid**.
* Reports without coordinates still appear in the tables with their location details.
* Reports link to the nearest flood-risk zone and nearest mapped road where coordinates allow.
* Duplicates within ~60 m with the same damage type/severity are grouped as **one incident**
  with repeat confirmations — never separate confirmed incidents.
* Statuses: **Pending Review → Verified → Resolved**; only a reviewer can verify, and only
  verified/resolved reports count toward confirmed damage in the priority score.
* Filters (All / Pending / Verified / Resolved) and search by ID, damage type or location.
* Report IDs are shown as `RD-…`; opening a report reveals its full details and image.
* GPS is used **only** when the user clicks *Use my GPS location* and grants permission —
  the app never infers location automatically.

### Explainable priority engine

```
Priority Score = 0.40 × Damage severity
               + 0.35 × Flood susceptibility
               + 0.25 × Road importance       (each normalised to 0–100)
```

* **Damage severity** — from *confirmed* reports near the zone (real user/moderator data).
* **Flood susceptibility** — simulated, from the selected rainfall scenario.
* **Road importance** — from real OpenStreetMap road class and distance.
* Missing inputs contribute **0** and are explicitly labelled "missing" (never estimated).
* Every explanation shows the weighted contribution of each term, the main drivers, nearby
  facilities, related reports and historical notes, plus a coverage/confidence indicator.

These weights are **prototype defaults, not scientifically validated**.

---

## Real vs simulated data

**Real**
* Public-facility locations, road geometry/names — OpenStreetMap via the Overpass API
  (© OpenStreetMap contributors, ODbL).
* Base map tiles — OpenStreetMap standard tiles.
* Coordinates taken from the map picker or your device GPS (with consent).

**Simulated / illustrative**
* Flood-risk zones and scores (a transparent, documented formula).
* Rainfall intensities in the scenario selector.
* Historical flood notes.
* The demo AI image-severity assessment.
* Bundled sample reports (labelled **Demo**).
* Sample fallback facilities if OpenStreetMap is unavailable (labelled simulated).

Simulated values are **never** presented as real observations or as validated AI predictions.

---

## Persistence

There is **no backend**. Submitted reports are stored in this browser's `localStorage`
(`floodlens.reports.v1`) and real OpenStreetMap geometry is cached in
`floodlens.reportMeta.v1`. Reports therefore:

* survive a page refresh **in the same browser**, and
* are **not** written to any server and **do not** sync across devices or browsers.

Photos are kept in memory for the session and may not persist if the browser storage quota
is exceeded.

---

## Run locally

No build step. Serve the folder and open it:

```bash
cd /workspace/project
python3 -m http.server 12000
# open http://localhost:12000/
```

## Publish online (free, static)

The app is fully static, so any static host works. A few options:

**GitHub Pages**
1. Push this folder to a GitHub repository.
2. Repository → Settings → Pages → Source: *Deploy from a branch* → `main` / `/root`.
3. The app is served at `https://<user>.github.io/<repo>/`.

**Netlify / Vercel (drag-and-drop)**
1. Go to Netlify Drop (app.netlify.com/drop) or Vercel → *Add New Project*.
2. Drag this folder (or connect the repo). No build command; publish directory = `/`.
3. You get a public HTTPS URL.

**Cloudflare Pages** — connect the repo; framework preset *None*; build command empty;
output directory `/`.

Everything (HTML/CSS/JS + Leaflet from the CDN) is fetched at runtime, so no server-side
runtime is required.

---

## Testing status

Verified with headless Chromium (puppeteer-core): navigation/routing, overview counts and
charts, lazy map + tiles + markers, layer toggles, zone/facility/report selection and detail
panel, locate-on-map, photo upload preview, validation messages (including out-of-range
coordinates), review → submit, no-coordinate handling, duplicate suppression, status
transitions, dashboard synchronisation, search/filters, scenario changes updating scores,
city switching, mobile drawer navigation, and localStorage persistence across reload.

## Limitations (summary)

* No real elevation/terrain model; elevation is illustrative.
* Facility/road coverage depends on OpenStreetMap completeness.
* Scores are relative within a study area and not comparable across cities.
* No live flood forecasts, official incidents, sensor data or government integrations.
* The AI assessment is a demonstration heuristic, not a model.

See the in-app **Data Quality & Methodology** section for the full statement.

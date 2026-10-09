/* =========================================================
   FloodLens AI — application logic  (prototype, decision support)
   Static, client-side, no build step, no server, no accounts.

   REAL data:  OpenStreetMap public facilities / roads (Overpass API),
               OSM base tiles, and coordinates you explicitly provide.
   SIMULATED:  flood-risk zones, flood scores, rainfall scenarios,
               historical notes, demo road-damage reports, and the
               demo image "AI" severity.
   Nothing simulated is ever presented as a real observation or as a
   validated AI prediction.
   ========================================================= */
(function () {
  "use strict";

  const DATA = window.FLOODLENS;
  const REF = DATA.cities;
  const RAIN = DATA.rainScenarios;

  /* ---------------------------------------------------------
     Transparent, illustrative scoring configuration
     --------------------------------------------------------- */
  // Flood susceptibility: each factor's maximum contribution to a 0-100 score.
  const FLOOD_WEIGHTS = { rainfall: 32, elevation: 26, drainage: 24, impervious: 10, history: 8 };
  const RISK_THRESHOLDS = { high: 65, medium: 40 };

  // Inspection-priority blend. PROTOTYPE DEFAULT weights (not validated science).
  const PRIORITY_WEIGHTS = { damage: 0.40, flood: 0.35, road: 0.25 };

  // Normalisation helpers for the priority terms.
  const CONFIRMED_SEV = { low: 30, medium: 65, high: 100 };
  const ROAD_CLASS_BASE = { primary: 60, secondary: 45, tertiary: 30 };
  const ROAD_CAP_M = { primary: 500, secondary: 350, tertiary: 250 };
  const ROAD_AT_0M = 45; // distance-bonus slope (points lost per metre near a road)
  const ROAD_NEAREST200 = 5; // bonus when the nearest major road is under 200 m

  const FACILITY_IMPORTANCE = { hospital: 3, shelter: 2, school: 2, other: 1 };
  const RISK_FILL = { low: "#2f9e6f", medium: "#d99512", high: "#d3554a" };
  const FAC_COLOR = { hospital: "#c0392b", school: "#7d3c98", shelter: "#1f7a4d", other: "#2c6fbb" };
  const FAC_GLYPH = { hospital: "H", school: "S", shelter: "\u2302", other: "\u2022" };
  const STATUS_LABEL = { pending: "Pending Review", verified: "Verified", resolved: "Resolved" };
  const SEV_ORDER = { low: 1, medium: 2, high: 3 };
  const STORAGE = { reports: "floodlens.reports.v1", meta: "floodlens.reportMeta.v1" };

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n, d) => Number(n).toFixed(d == null ? 0 : d);

  const VIEW_META = {
    overview: ["Overview", "Situation summary for the selected study area and rainfall scenario."],
    map: ["Flood Risk Map", "Inspect risk zones, public facilities, roads and damage reports. Base map © OpenStreetMap contributors."],
    reports: ["Road Damage Reports", "Capture, review and manage road-damage reports."],
    priority: ["Inspection Priorities", "Explainable ranking of locations for field inspection."],
    dataquality: ["Data Quality & Methodology", "What is real, what is simulated, and where the numbers are weak."],
  };

  function distM(lat1, lon1, lat2, lon2) {
    const R = 6371000, toR = Math.PI / 180;
    const dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  function distToSegmentM(p, a, b) {
    const x = p[1], y = p[0], x1 = a[1], y1 = a[0], x2 = b[1], y2 = b[0];
    const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
    let t = len2 ? ((x - x1) * dx + (y - y1) * dy) / len2 : 0;
    t = clamp(t, 0, 1);
    return distM(y, x, y1 + t * dy, x1 + t * dx);
  }
  function distToPolylineM(lat, lon, line) {
    let best = Infinity;
    for (let i = 0; i < line.length - 1; i++) best = Math.min(best, distToSegmentM([lat, lon], line[i], line[i + 1]));
    return best;
  }
  function mulberry(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function seedOf(str) { let h = 7; for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0; return h; }

  /* ---------------------------------------------------------
     State
     --------------------------------------------------------- */
  const state = {
    view: "overview",
    cityKey: "bengaluru",
    rainId: "moderate",
    city: null,
    zones: [],
    facilities: [],
    roads: [],
    reports: [],
    source: "simulated",      // "real" | "simulated"
    loadingReal: false,
    selectedZoneId: null,
    selectedReportId: null,
    expandedReportId: null,
    sortKey: "priorityScore",
    sortDir: "desc",
    riskFilter: "all",
    prioritySearch: "",
    reportFilter: "all",
    reportSearch: "",
    layerZones: true,
    layerFacilities: true,
    layerRoads: true,
    layerReports: true,
    facFilter: { hospital: true, school: true, shelter: true, other: true },
    pendingReport: null,
    pickMode: false,
    assess: null,
    map: null,
    mapReady: false,
    mapError: false,
    mapLoadingText: "Loading map\u2026",
    zoneLayers: {},
    pickMarker: null,
    mapDirty: true,
  };

  /* ---------------------------------------------------------
     Persistence (browser localStorage only — documented)
     --------------------------------------------------------- */
  function loadStoredReports() {
    try { return JSON.parse(localStorage.getItem(STORAGE.reports) || "[]"); }
    catch (e) { return []; }
  }
  function saveStoredReports() {
    try {
      const mine = state.reports.filter((r) => !r.demo).map((r) => {
        const c = Object.assign({}, r); delete c.photo; delete c.zone; delete c._d; return c;
      });
      localStorage.setItem(STORAGE.reports, JSON.stringify(mine));
    } catch (e) { /* quota exceeded — photo data URLs are large; records still in memory */ }
  }
  function loadMeta(cityKey) {
    try { return JSON.parse(localStorage.getItem(STORAGE.meta) || "{}")[cityKey] || null; }
    catch (e) { return null; }
  }
  function saveMeta() {
    try {
      const all = JSON.parse(localStorage.getItem(STORAGE.meta) || "{}");
      all[state.cityKey] = { facilities: state.facilities, roads: state.roads, source: state.source };
      localStorage.setItem(STORAGE.meta, JSON.stringify(all));
    } catch (e) { /* ignore */ }
  }

  /* =========================================================
     SCORING ENGINE
     ========================================================= */

  // 1) Flood susceptibility score (SIMULATED, transparent)
  function scoreZones() {
    const rain = RAIN.find((r) => r.id === state.rainId) || RAIN[1];
    const elevs = state.zones.map((z) => z.elevation_m);
    const minE = Math.min.apply(null, elevs), maxE = Math.max.apply(null, elevs);
    const span = Math.max(1, maxE - minE);
    state.zones.forEach((z) => {
      const low = 1 - (z.elevation_m - minE) / span;
      const rainScore = FLOOD_WEIGHTS.rainfall * clamp(1 - Math.exp(-rain.intensity / 30), 0, 1);
      const elevScore = FLOOD_WEIGHTS.elevation * low;
      const drainScore = FLOOD_WEIGHTS.drainage * z.drainage_index;
      const impScore = FLOOD_WEIGHTS.impervious * z.impervious;
      const histScore = FLOOD_WEIGHTS.history * z.historical_flag;
      z.riskScore = Math.round(clamp(rainScore + elevScore + drainScore + impScore + histScore, 0, 100));
      z.riskLevel = z.riskScore >= RISK_THRESHOLDS.high ? "high" : z.riskScore >= RISK_THRESHOLDS.medium ? "medium" : "low";
      z.rainLabel = rain.label;
      z.rainIntensity = rain.intensity;
      z.factors = {
        rainfall: { label: "Assumed rainfall intensity", value: rain.intensity, unit: "mm / 3 h",
          points: Math.round(rainScore), max: FLOOD_WEIGHTS.rainfall, note: "Scenario-driven. Illustrative, not a forecast.", tag: "sim" },
        elevation: { label: "Ground elevation", value: z.elevation_m, unit: "m",
          points: Math.round(elevScore), max: FLOOD_WEIGHTS.elevation, note: "Lower ground relative to this study area scores higher.", tag: "sim" },
        drainage: { label: "Drainage quality", value: z.drainage_index, unit: "index 0-1",
          points: Math.round(drainScore), max: FLOOD_WEIGHTS.drainage, note: "Illustrative index: higher means poorer drainage.", tag: "sim" },
        impervious: { label: "Built-up / impervious surface", value: z.impervious, unit: "share 0-1",
          points: Math.round(impScore), max: FLOOD_WEIGHTS.impervious, note: "More sealed surface means less infiltration.", tag: "sim" },
        history: { label: "Historical flooding note", value: z.historical_flag ? "present" : "none",
          points: Math.round(histScore), max: FLOOD_WEIGHTS.history, note: "Illustrative sample narrative, not a verified register.", tag: "sim" },
      };
    });
  }

  function annotateFacilities() {
    state.facilities.forEach((f) => {
      let best = null, bestD = Infinity;
      state.zones.forEach((z) => { const d = distM(f.lat, f.lon, z.lat, z.lon); if (d < bestD) { bestD = d; best = z; } });
      f.zoneId = best ? best.id : null;
      f.zoneDistM = Math.round(bestD);
      f.weight = FACILITY_IMPORTANCE[f.type] || 1;
    });
  }

  // Nearest mapped real road + class, per zone.
  function nearestRoadForZone(z) {
    let nearest = null, nd = Infinity, bestClassDist = Infinity, bestClass = null;
    for (let i = 0; i < state.roads.length; i++) {
      const rd = state.roads[i];
      const line = rd && rd.line ? rd.line : rd;
      if (!line || line.length < 2) continue;
      const d = distToPolylineM(z.lat, z.lon, line);
      if (d < nd) { nd = d; nearest = rd; }
      const cls = (rd && rd.class) || null;
      if (cls && d < bestClassDist) { bestClassDist = d; bestClass = cls; }
    }
    return isFinite(nd) ? { nearestDistM: Math.round(nd), bestClass: bestClass || "tertiary",
      nearestClass: (nearest && nearest.class) || null, name: (nearest && nearest.name) || "" } : null;
  }

  // 2) Road importance score (REAL data derived, 0-100), with missing handling.
  function roadImportance(z) {
    if (!state.roads.length) {
      return { value: 0, nearM: null, cls: null, name: "", available: false,
        note: "No mapped road data available \u2014 road importance treated as missing (0)." };
    }
    const r = nearestRoadForZone(z);
    if (!r) return { value: 0, nearM: null, cls: null, name: "", available: false, note: "No road near this location." };
    const effective = r.bestClass || "tertiary";
    const base = ROAD_CLASS_BASE[effective] != null ? ROAD_CLASS_BASE[effective] : 30;
    const cap = ROAD_CAP_M[effective] != null ? ROAD_CAP_M[effective] : 250;
    const distBonus = clamp(Math.round((cap - r.nearestDistM) / ROAD_AT_0M), 0, 25);
    const nearBonus = r.nearestDistM <= 200 ? ROAD_NEAREST200 : 0;
    const value = clamp(base + distBonus + nearBonus, 0, 100);
    return { value, nearM: r.nearestDistM, cls: effective, name: r.name, available: true,
      note: "Real OpenStreetMap roads: nearest classified road is " + effective + " at " + r.nearestDistM + " m." };
  }

  // 3) Damage severity score (from confirmed reports only, 0-100).
  function damageSeverityOf(z) {
    const reports = state.reports.filter((r) => r.zoneId === z.id);
    const confirmed = reports.filter((r) => r.status === "verified" || r.status === "resolved");
    if (!confirmed.length) {
      const pending = reports.filter((r) => r.status === "pending").length;
      return { value: 0, available: false, confirmedCount: 0, pendingCount: pending,
        primaryType: null,
        note: pending
          ? "No confirmed damage data (" + pending + " report(s) awaiting verification) \u2014 contributes 0."
          : "No confirmed damage data for this location \u2014 contributes 0." };
    }
    let best = null;
    confirmed.forEach((r) => {
      const base = CONFIRMED_SEV[r.severity] != null ? CONFIRMED_SEV[r.severity] : 55;
      const v = clamp(base + Math.min(15, (r.dupes || 0) * 5), 0, 100);
      if (!best || v > best.value) best = { value: v, report: r, base: base };
    });
    return { value: best.value, available: true, confirmedCount: confirmed.length,
      pendingCount: reports.length - confirmed.length, primaryType: (best.report && best.report.damageType) || null,
      note: confirmed.length + " confirmed report(s); highest severity contributes the damage term." };
  }

  // Priority + full explanation object.
  function computePriority(z) {
    const flood = z.riskScore;
    const damage = damageSeverityOf(z);
    const road = roadImportance(z);
    const w = PRIORITY_WEIGHTS;
    const score = Math.round(clamp(w.damage * damage.value + w.flood * flood + w.road * road.value, 0, 100));
    const category = score >= 60 ? "High" : score >= 30 ? "Medium" : "Low";
    // transparency: does the score depend on missing data?
    const missing = [];
    if (!damage.available) missing.push("confirmed damage (none)");
    if (!road.available) missing.push("road importance (no road data)");
    const contributing = [
      { key: "damage", label: "Damage severity", weight: w.damage, value: damage.value,
        pts: Math.round(w.damage * damage.value), tag: "real", note: damage.note },
      { key: "flood", label: "Flood susceptibility", weight: w.flood, value: flood,
        pts: Math.round(w.flood * flood), tag: "sim", note: "Illustrative flood score for the current rainfall scenario." },
      { key: "road", label: "Road importance", weight: w.road, value: road.value,
        pts: Math.round(w.road * road.value), tag: road.available ? "real" : "missing", note: road.note },
    ];
    return { score, category, damage, road, contribution: contributing, missing,
      floodAvailable: true, damageAvailable: damage.available, roadAvailable: road.available };
  }

  function annotateReports() {
    state.reports.forEach((r) => {
      if (r.lat == null || r.lon == null) { r.zoneDistM = null; r.nearRoad = null; return; }
      let best = null, bestD = Infinity;
      state.zones.forEach((z) => { const d = distM(r.lat, r.lon, z.lat, z.lon); if (d < bestD) { bestD = d; best = z; } });
      r.zoneId = best ? best.id : r.zoneId;
      r.zoneDistM = Math.round(bestD);
      let rd = Infinity;
      state.roads.forEach((rl) => { const d = distToPolylineM(r.lat, r.lon, rl.line || rl); if (d < rd) rd = d; });
      r.nearRoad = isFinite(rd) ? { distM: Math.round(rd) } : null;
    });
  }

  function zoneStats(z) {
    const facs = state.facilities.filter((f) => f.zoneId === z.id);
    const counts = { hospital: 0, school: 0, shelter: 0, other: 0 };
    facs.forEach((f) => { counts[f.type] = (counts[f.type] || 0) + 1; });
    const reports = state.reports.filter((r) => r.zoneId === z.id);
    const confirmed = reports.filter((r) => r.status === "verified" || r.status === "resolved");
    return { facilities: facs, facCounts: counts, facCount: facs.length, reports,
      confirmedCount: confirmed.length, pendingCount: reports.filter((r) => r.status === "pending").length };
  }

  /* ---------------------------------------------------------
     Real data fetch (OpenStreetMap / Overpass)
     --------------------------------------------------------- */
  const OVERPASS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.osm.ch/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  ];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function facilitiesQuery(bbox) {
    const b = bbox.join(",");
    const vals = ["hospital", "clinic", "school", "college", "university",
      "social_facility", "fire_station", "police", "community_centre"];
    let s = "[out:json][timeout:25];\n(\n";
    vals.forEach((v) => { s += '  nwr["amenity"="' + v + '"](' + b + ");\n"; });
    s += '  nwr["emergency"="shelter"](' + b + ");\n);\nout center tags 700;";
    return s;
  }
  function roadsQuery(bbox) {
    const b = bbox.join(",");
    return "[out:json][timeout:25];\n(\n" +
      '  way["highway"="primary"](' + b + ");\n" +
      '  way["highway"="secondary"](' + b + ");\n" +
      '  way["highway"="tertiary"](' + b + ");\n);\nout geom qt 400;";
  }
  function classifyFacility(t) {
    const a = t.amenity || t.emergency || "";
    if (a === "hospital" || a === "clinic") return "hospital";
    if (a === "school" || a === "college" || a === "university") return "school";
    if (a === "shelter" || a === "social_facility") return "shelter";
    return "other";
  }
  function parseFacilities(json) {
    const out = [];
    (json.elements || []).forEach((el) => {
      const t = el.tags || {};
      if (t.highway) return;
      const lat = el.lat != null ? el.lat : (el.center && el.center.lat);
      const lon = el.lon != null ? el.lon : (el.center && el.center.lon);
      if (lat == null || lon == null) return;
      const type = classifyFacility(t);
      out.push({ id: "osm-" + el.type + "-" + el.id, type: type,
        name: t.name || (type === "hospital" ? "Clinic / health facility" : type.charAt(0).toUpperCase() + type.slice(1)),
        lat: lat, lon: lon, road: t["addr:street"] || "", simulated: false });
    });
    const cap = { hospital: 60, shelter: 40, school: 60, other: 40 };
    const seen = { hospital: 0, shelter: 0, school: 0, other: 0 };
    return out.filter((f) => { if (seen[f.type] >= cap[f.type]) return false; seen[f.type]++; return true; });
  }
  function parseRoads(json) {
    return (json.elements || []).filter((el) => el.type === "way" && el.geometry).map((el) => ({
      line: el.geometry.map((g) => [g.lat, g.lon]),
      class: (el.tags && el.tags.highway) || null,
      name: (el.tags && el.tags.name) || "",
    })).slice(0, 400);
  }

  async function postOverpass(query) {
    let lastErr = null;
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < OVERPASS.length; i++) {
        try {
          const res = await fetch(OVERPASS[i], {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: "data=" + encodeURIComponent(query),
          });
          if (!res.ok) throw new Error("HTTP " + res.status);
          const json = await res.json();
          if (!json || !json.elements) throw new Error("unexpected response");
          return json;
        } catch (e) { lastErr = e; }
      }
      await sleep(1500 + round * 1500);
    }
    throw lastErr || new Error("Overpass unavailable");
  }

  function fetchRealData(onFacilities) {
    const bbox = state.city.bbox;
    return postOverpass(facilitiesQuery(bbox)).then((j) => {
      const facilities = parseFacilities(j);
      if (!facilities.length) throw new Error("no facilities returned");
      if (onFacilities) onFacilities(facilities);
      return sleep(1200)
        .then(() => postOverpass(roadsQuery(bbox)))
        .then((jr) => ({ facilities: facilities, roads: parseRoads(jr) }))
        .catch(() => ({ facilities: facilities, roads: [] }));
    });
  }

  function syntheticFacilities(center, n) {
    const rng = mulberry(seedOf(state.cityKey));
    const types = ["hospital", "school", "shelter", "other"];
    const out = [];
    for (let i = 0; i < n; i++) {
      const z = state.zones[i % state.zones.length];
      out.push({ id: "sim-f" + i, type: types[i % types.length],
        name: "Simulated " + types[i % types.length] + " #" + (i + 1),
        lat: z.lat + (rng() - 0.5) * 0.006, lon: z.lon + (rng() - 0.5) * 0.006,
        simulated: true, road: "" });
    }
    return out;
  }

  /* ---------------------------------------------------------
     Data loading & source status
     --------------------------------------------------------- */
  function setSource(kind, text) {
    if (kind === "real" || kind === "simulated") state.source = kind;
    const pill = $("#data-source-pill");
    if (pill) { pill.textContent = text; pill.className = "source-pill " + (kind === "real" ? "real" : kind === "simulated" ? "sim" : ""); }
    state.loadingReal = kind === "loading";
    renderSimIndicator();
  }
  function renderSimIndicator() {
    const el = $("#sim-indicator"), dot = $("#sim-dot"), txt = $("#sim-text");
    if (!el) return;
    let cls = "", text = "";
    if (state.loadingReal) { cls = "loading"; text = "Loading real map data…"; }
    else if (state.source === "real") { cls = "real"; text = "Real OpenStreetMap facilities" + (state.roads.length ? " + roads" : ""); }
    else { cls = "sim"; text = "Risk scores simulated" + (state.facilities.some((f) => f.simulated) ? " · sample facilities" : ""); }
    el.className = "sim-indicator " + cls;
    dot.className = "sim-dot";
    txt.textContent = "Data: " + text;
  }

  function loadCity(cityKey, useCache) {
    state.cityKey = cityKey;
    state.city = REF[cityKey];
    state.zones = state.city.zones.map((z) => Object.assign({}, z));
    state.selectedZoneId = null;
    state.selectedReportId = null;
    state.expandedReportId = null;

    const meta = useCache ? loadMeta(cityKey) : null;
    const cacheIsReal = meta && meta.facilities && meta.facilities.length && meta.source === "real";
    if (meta && meta.facilities && meta.facilities.length) {
      state.facilities = meta.facilities; state.roads = meta.roads || []; state.source = meta.source || "simulated";
    } else { state.facilities = []; state.roads = []; state.source = "simulated"; }

    state.reports = (DATA.demoReports[cityKey] || []).map((r) => Object.assign({}, r))
      .concat(loadStoredReports().filter((r) => r.city === cityKey));
    annotateReports();
    renderAll();

    if (cacheIsReal) {
      setSource("real", "Real \u00b7 OpenStreetMap (cached)");
      annotateFacilities(); renderAll();
      return;
    }

    setSource("loading", "Loading real map data\u2026");
    let gotReal = false;
    fetchRealData((facs) => {
      gotReal = true; state.facilities = facs; state.source = "real";
      annotateFacilities(); renderAll();
      setSource("real", "Real \u00b7 OSM facilities (" + facs.length + ") \u00b7 loading roads\u2026");
    }).then((real) => {
      state.facilities = real.facilities; state.roads = real.roads;
      setSource("real", "Real \u00b7 OSM facilities & roads (" + real.facilities.length + " facilities, " + real.roads.length + " roads)");
      finishLoad();
    }).catch(() => {
      if (gotReal) { finishLoad(); return; }
      state.facilities = syntheticFacilities(state.city.center, 20); state.roads = [];
      setSource("simulated", "Simulated sample (OpenStreetMap busy or network unavailable)");
      finishLoad();
    });
  }
  function finishLoad() { saveMeta(); annotateFacilities(); annotateReports(); renderAll(); }

  /* ---------------------------------------------------------
     Map
     --------------------------------------------------------- */
  function setMapLoading() {
    const el = $("#map-loading");
    if (!el) return;
    if (state.mapError) {
      el.hidden = false;
      el.innerHTML = '<span style="color:#a5372d;text-align:center;max-width:420px">Interactive map library could not load (offline?). The dashboard, tables and reporting module still work.</span>';
      return;
    }
    if (state.mapReady) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = '<span class="spinner" aria-hidden="true"></span> ' + esc(state.mapLoadingText);
  }

  function initMap() {
    const mapEl = $("#map");
    if (!mapEl || state.mapReady) return;
    if (typeof L === "undefined" || !L) {
      state.mapError = true; state.mapLoadingText = ""; setMapLoading(); return;
    }
    const map = L.map("map", { zoomControl: true, scrollWheelZoom: true });
    L.tileLayer("https://a.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
    map.setView(state.city.center, 12);
    state.map = map;
    const ov = document.createElement("div");
    ov.id = "pick-overlay";
    map.getContainer().appendChild(ov);
    ov.addEventListener("click", (ev) => {
      const r = map.getContainer().getBoundingClientRect();
      const ll = map.containerPointToLatLng([ev.clientX - r.left, ev.clientY - r.top]);
      setReportCoords(ll.lat, ll.lng);
      exitPickMode();
      toast("Location set from map click.");
      showView("reports", { silent: true });
      setTimeout(() => { const f = $("#r-location"); if (f) { f.scrollIntoView({ behavior: "smooth", block: "center" }); f.focus(); } }, 60);
    });
    state.zoneLayer = L.layerGroup().addTo(map);
    state.roadLayer = L.layerGroup().addTo(map);
    state.facLayer = L.layerGroup().addTo(map);
    state.reportLayer = L.layerGroup().addTo(map);
    state.mapReady = true;
    state.mapDirty = true;
    setMapLoading();
    renderMap();
  }

  function zoneBounds(z) {
    const g = state.city.grid, b = state.city.bbox;
    const dlat = (b[2] - b[0]) / g.rows, dlon = (b[3] - b[1]) / g.cols;
    return [[b[0] + z.row * dlat, b[1] + z.col * dlon], [b[0] + (z.row + 1) * dlat, b[1] + (z.col + 1) * dlon]];
  }
  function facilityIcon(type) {
    return L.divIcon({ className: "fac-icon", iconSize: [22, 22], iconAnchor: [11, 11],
      html: '<span style="display:flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:' +
        (FAC_COLOR[type] || "#2c6fbb") + ";color:#fff;font:700 11px/1 sans-serif;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)\">" +
        (FAC_GLYPH[type] || "\u2022") + "</span>" });
  }
  function reportIcon(sev) {
    return L.divIcon({ className: "rep-icon", iconSize: [26, 26], iconAnchor: [13, 13],
      html: '<span style="display:flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;background:#1b1b1b;color:#ffd166;font:700 12px/1 sans-serif;border:3px solid ' +
        (RISK_FILL[sev] || "#666") + ';box-shadow:0 1px 5px rgba(0,0,0,.5)">\u26a0</span>' });
  }

  function renderMap() {
    if (!state.mapReady) return;
    const map = state.map;
    state.zoneLayer.clearLayers(); state.facLayer.clearLayers();
    state.roadLayer.clearLayers(); state.reportLayer.clearLayers();
    state.zoneLayers = {};

    state.zones.forEach((z) => {
      const rect = L.rectangle(zoneBounds(z), {
        color: RISK_FILL[z.riskLevel], weight: z.id === state.selectedZoneId ? 3 : 1.2,
        fillColor: RISK_FILL[z.riskLevel], fillOpacity: z.id === state.selectedZoneId ? 0.42 : 0.22,
      });
      const stats = zoneStats(z);
      rect.bindPopup("<strong>" + esc(z.name) + "</strong><br>Simulated flood risk: <b>" + z.riskLevel.toUpperCase() +
        "</b> (" + z.riskScore + "/100)<br>Priority: <b>" + computePriority(z).score + "</b><br>" +
        "Facilities: " + stats.facCount + " \u00b7 Reports: " + stats.reports.length +
        "<br><button class=\"text-btn\" data-inspect=\"" + z.id + "\">Inspect \u2192 explainability</button>" +
        "<div style='font-size:11px;color:#6b7c92;margin-top:4px'>Flood score is simulated.</div>");
      rect.on("click", () => { selectZone(z.id, false, true); });
      rect.addTo(state.zoneLayer);
      state.zoneLayers[z.id] = rect;
      L.marker([z.lat, z.lon], { icon: L.divIcon({ className: "zone-dot", iconSize: [0, 0],
        html: '<span style="display:inline-flex;align-items:center;justify-content:center;min-width:34px;height:20px;padding:0 6px;border-radius:999px;background:' +
          RISK_FILL[z.riskLevel] + ";color:#fff;font:700 11px/1 sans-serif;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35);transform:translate(-50%,-50%)\">" +
          z.riskScore + "</span>" }) }).on("click", () => { selectZone(z.id, false, true); }).addTo(state.zoneLayer);
    });

    state.roads.forEach((rd) => {
      const line = rd.line || rd;
      const c = rd.class === "primary" ? "#8a6a00" : rd.class === "secondary" ? "#a98a2e" : "#b7a25a";
      L.polyline(line, { color: c, weight: rd.class === "primary" ? 2.6 : 1.8, opacity: 0.55 }).addTo(state.roadLayer);
    });

    Object.keys(state.facFilter).forEach((type) => {
      if (!state.facFilter[type]) return;
      state.facilities.filter((f) => f.type === type).forEach((f) => {
        const z = state.zones.find((x) => x.id === f.zoneId);
        L.marker([f.lat, f.lon], { icon: facilityIcon(f.type) }).bindPopup(
          "<strong>" + esc(f.name) + "</strong><br>Type: " + esc(f.type) + "<br>" +
          (f.road ? "Road: " + esc(f.road) + "<br>" : "") +
          (z ? "Nearest zone: " + esc(z.name) + " (" + f.zoneDistM + " m \u00b7 " + z.riskLevel + " risk)<br>" : "") +
          (f.simulated ? "<em>Simulated sample facility</em>" : "<span style='font-size:11px;color:#1d6b4c'>Real \u00b7 OpenStreetMap</span>")
        ).on("click", () => selectFacility(f.id)).addTo(state.facLayer);
      });
    });

    state.reports.forEach((r) => {
      if (r.lat == null || !reportFilterMatches(r)) return;
      L.marker([r.lat, r.lon], { icon: reportIcon(r.severity) }).bindPopup(reportPopup(r))
        .on("click", () => selectReport(r.id, false)).addTo(state.reportLayer);
    });

    applyLayerVisibility();
    state.mapDirty = false;
    setMapLoading();
    setTimeout(() => { if (state.mapReady && state.map) state.map.invalidateSize(); }, 30);
  }

  function reportPopup(r) {
    return "<strong>" + esc(r.damageType) + "</strong> \u00b7 <b>" + esc(r.severity) + "</b> severity<br>" +
      esc(r.locationText) + "<br>" +
      (r.zoneId ? "Related zone: " + esc((state.zones.find((z) => z.id === r.zoneId) || {}).name || "") + " (" + r.zoneDistM + " m)<br>" : "") +
      (r.nearRoad ? "Near mapped road: " + r.nearRoad.distM + " m<br>" : "") +
      "Status: " + STATUS_LABEL[r.status] + "<br>" +
      (r.demo ? "<span style='color:#5a3fa0;font-size:11px'>Demo data</span><br>" : "") +
      (r.dupes ? "<span style='color:#a5372d;font-size:11px'>+" + r.dupes + " duplicate confirmation(s)</span><br>" : "") +
      '<button class="text-btn" data-report="' + r.id + '">Open in reports \u2192</button>';
  }

  function reportFilterMatches(r) { return state.reportFilter === "all" || r.status === state.reportFilter; }

  function applyLayerVisibility() {
    if (!state.mapReady) return;
    const map = state.map;
    const set = (layer, on) => {
      if (!layer) return;
      if (on) { if (!map.hasLayer(layer)) map.addLayer(layer); } else { if (map.hasLayer(layer)) map.removeLayer(layer); }
    };
    set(state.zoneLayer, state.layerZones);
    set(state.roadLayer, state.layerRoads);
    set(state.facLayer, state.layerFacilities);
    set(state.reportLayer, state.layerReports);
  }

  function enterPickMode() {
    state.pickMode = true;
    const ov = document.getElementById("pick-overlay"); if (ov) ov.style.display = "block";
    const banner = $("#pick-banner"); if (banner) banner.hidden = false;
    $("#map").classList.add("picking");
  }
  function exitPickMode() {
    state.pickMode = false;
    const ov = document.getElementById("pick-overlay"); if (ov) ov.style.display = "none";
    const banner = $("#pick-banner"); if (banner) banner.hidden = true;
    $("#map").classList.remove("picking");
  }
  function focusZone(z, openPopup) {
    if (!state.mapReady || !z) return;
    state.map.setView([z.lat, z.lon], Math.max(state.map.getZoom(), 13), { animate: true });
    if (openPopup) { const rect = state.zoneLayers[z.id]; if (rect) rect.openPopup(); }
  }
  function fitZones() {
    if (!state.mapReady) return;
    const b = state.city.bbox;
    state.map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: [20, 20] });
  }
  function locateReport(r) {
    if (r.lat == null) { toast("This report has no coordinates."); return false; }
    showView("map");
    setTimeout(() => {
      if (!state.mapReady) { toast("Map is still loading — try again in a moment."); return; }
      state.map.setView([r.lat, r.lon], 16, { animate: true });
      const m = state.reportLayer.getLayers().find((l) => {
        const ll = l.getLatLng && l.getLatLng(); return ll && Math.abs(ll.lat - r.lat) < 1e-6 && Math.abs(ll.lng - r.lon) < 1e-6;
      });
      if (m) m.openPopup();
    }, 200);
    return true;
  }

  /* ---------------------------------------------------------
     Selection + detail panel + explainability
     --------------------------------------------------------- */
  function selectZone(id, fromTable, fromMap) {
    state.selectedZoneId = id;
    state.selectedReportId = null;
    if (fromTable) showView("priority", { silent: true });
    renderPriorityTable();
    renderExplain();
    renderDetail();
    if (state.mapReady) { renderMap(); if (fromMap) focusZone(state.zones.find((z) => z.id === id), false); }
  }
  function selectFacility(id) {
    const f = state.facilities.find((x) => x.id === id);
    if (!f) return;
    state.selectedZoneId = f.zoneId || null;
    state.selectedReportId = null;
    renderDetail({ facility: f });
    renderExplain();
    renderPriorityTable();
  }
  function selectReport(id, fromMap) {
    const r = state.reports.find((x) => x.id === id);
    if (!r) return;
    state.selectedReportId = id;
    if (r.zoneId) state.selectedZoneId = r.zoneId;
    if (fromMap) showView("map", { silent: true });
    renderDetail({ report: r });
    renderExplain();
    renderPriorityTable();
  }

  function renderDetail(opts) {
    const box = $("#detail-panel");
    if (!box) return;
    opts = opts || {};
    if (opts.report) { box.innerHTML = detailReport(opts.report); return; }
    if (opts.facility) { box.innerHTML = detailFacility(opts.facility); return; }
    const z = state.zones.find((x) => x.id === state.selectedZoneId);
    if (z) { box.innerHTML = detailZone(z); return; }
    box.innerHTML = '<p class="muted">Select a risk zone, facility or damage-report marker on the map, or a row in the tables, to see its details here.</p>';
  }

  function detailZone(z) {
    const pr = computePriority(z), s = zoneStats(z);
    const zoneReports = s.reports;
    return '<div class="detail-head"><div><h3>' + esc(z.name) + '</h3>' +
      '<span class="badge ' + z.riskLevel + '">' + z.riskLevel.toUpperCase() + ' risk</span></div>' +
      '<div class="explain-score"><div class="es-num">' + pr.score + '</div><div class="es-lbl">Priority</div></div></div>' +
      '<ul class="detail-list">' +
      '<li><span>Simulated flood score</span><span>' + z.riskScore + ' / 100</span></li>' +
      '<li><span>Rainfall scenario</span><span>' + esc(z.rainLabel || "") + '</span></li>' +
      '<li><span>Ground elevation</span><span>' + fmt(z.elevation_m, 0) + ' m</span></li>' +
      '<li><span>Damage term</span><span>' + pr.damage.value + (pr.damage.available ? '' : ' <em class="muted">(no confirmed data)</em>') + '</span></li>' +
      '<li><span>Road importance</span><span>' + pr.road.value + (pr.road.available ? '' : ' <em class="muted">(missing)</em>') + '</span></li>' +
      '<li><span>Public facilities</span><span>' + s.facCount + ' nearby</span></li>' +
      '<li><span>Damage reports</span><span>' + zoneReports.length + ' (' + s.confirmedCount + ' confirmed)</span></li>' +
      '</ul>' +
      '<div class="row gap" style="margin-top:12px">' +
      '<button class="small-btn" data-inspect="' + z.id + '">Full explanation</button>' +
      '<button class="small-btn" data-focus="' + z.id + '">Zoom on map</button></div>' +
      '<p class="muted small" style="margin-top:10px">Flood score is simulated. Facility/road values use real OpenStreetMap data when available.</p>';
  }
  function detailFacility(f) {
    const z = state.zones.find((x) => x.id === f.zoneId);
    return '<div class="detail-head"><div><h3>' + esc(f.name) + '</h3>' +
      '<span class="badge ' + (z ? z.riskLevel : 'low') + '">' + (z ? z.riskLevel.toUpperCase() + ' zone' : 'facility') + '</span></div></div>' +
      '<ul class="detail-list">' +
      '<li><span>Type</span><span>' + esc(f.type) + '</span></li>' +
      (f.road ? '<li><span>Address road</span><span>' + esc(f.road) + '</span></li>' : '') +
      '<li><span>Nearest zone</span><span>' + (z ? esc(z.name) : '—') + '</span></li>' +
      '<li><span>Distance to zone</span><span>' + (f.zoneDistM != null ? f.zoneDistM + ' m' : '—') + '</span></li>' +
      '<li><span>Source</span><span>' + (f.simulated ? 'Simulated sample' : 'Real · OpenStreetMap') + '</span></li>' +
      '</ul>' +
      (z ? '<div class="row gap" style="margin-top:12px"><button class="small-btn" data-inspect="' + z.id + '">Inspect zone</button></div>' : '');
  }
  function detailReport(r) {
    const z = state.zones.find((x) => x.id === r.zoneId);
    const pr = z ? computePriority(z) : null;
    return '<div class="detail-head"><div><h3>' + esc(r.damageType) + '</h3>' +
      '<span class="badge ' + r.severity + '">' + esc(r.severity) + '</span> <span class="badge ' + r.status + '">' + STATUS_LABEL[r.status] + '</span>' +
      (r.demo ? ' <span class="badge demo">Demo</span>' : '') + '</div></div>' +
      '<ul class="detail-list">' +
      '<li><span>Report ID</span><span class="mono-id">' + esc(shortId(r.id)) + '</span></li>' +
      '<li><span>Location</span><span>' + esc(r.locationText || '—') + '</span></li>' +
      '<li><span>Coordinates</span><span>' + (r.lat != null ? r.lat + ', ' + r.lon : 'not provided') + '</span></li>' +
      '<li><span>Related zone</span><span>' + (z ? esc(z.name) + ' · ' + z.riskLevel + ' risk' : 'unlinked') + '</span></li>' +
      (z ? '<li><span>Zone priority</span><span>' + pr.score + ' / 100</span></li>' : '') +
      '<li><span>Reported</span><span>' + fmtDateTime(r.reportedAt) + '</span></li>' +
      (r.dupes ? '<li><span>Duplicate confirmations</span><span>+' + r.dupes + '</span></li>' : '') +
      '</ul>' +
      '<div class="row gap" style="margin-top:12px">' +
      (r.lat != null ? '<button class="small-btn" data-locate="' + r.id + '">Zoom on map</button>' : '') +
      '<button class="small-btn" data-openreport="' + r.id + '">Open report</button></div>';
  }

  function shortId(id) { return String(id).replace(/^r-/, "RD-").toUpperCase(); }

  function renderExplain() {
    const z = state.zones.find((x) => x.id === state.selectedZoneId);
    const box = $("#explain-body");
    if (!box) return;
    if (!z) {
      box.innerHTML = '<p class="muted">No location selected yet. Choose a row in the table above or click a risk zone on the map.</p>';
      return;
    }
    const pr = computePriority(z), s = zoneStats(z), f = z.factors;
    const total = Object.keys(f).reduce((a, k) => a + f[k].points, 0);
    const factorHtml = Object.keys(f).map((k) => {
      const x = f[k], pct = x.max ? Math.round((x.points / x.max) * 100) : 0;
      return '<div class="factor"><div class="factor-top"><span class="factor-name">' + esc(x.label) +
        ' <span class="tag ' + (x.tag || 'sim') + '">' + (x.tag === "real" ? "real" : "simulated") + '</span></span>' +
        '<span class="factor-val">' + esc(String(x.value)) + (x.unit ? " " + esc(x.unit) : "") + " · <b>" + x.points + "/" + x.max + "</b></span></div>" +
        '<div class="factor-track"><div class="factor-fill" style="width:' + pct + '%"></div></div></div>';
    }).join("");

    const contribHtml = pr.contribution.map((c) => {
      const tag = c.tag === "real" ? '<span class="tag real">real</span>' : c.tag === "missing" ? '<span class="tag missing">missing</span>' : '<span class="tag sim">simulated</span>';
      return '<div class="factor"><div class="factor-top"><span class="factor-name">' + esc(c.label) + ' ' + tag +
        ' <span class="muted small">× ' + c.weight.toFixed(2) + '</span></span>' +
        '<span class="factor-val">' + c.value + "/100 · <b>" + c.pts + '</b> pts</span></div>' +
        '<div class="factor-track"><div class="factor-fill" style="width:' + c.value + '%"></div></div>' +
        '<p class="muted small" style="margin-top:3px">' + esc(c.note) + '</p></div>';
    }).join("");

    const coverage = s.facCount >= 3 ? "ok" : "weak";
    const covText = s.facCount >= 3
      ? "Coverage: good (" + s.facCount + " mapped facilities nearby)"
      : "Coverage: limited (" + s.facCount + " mapped facilities) — treat with caution";

    const drivers = pr.contribution.slice().sort((a, b) => b.pts - a.pts);
    const topDriver = drivers[0];
    box.innerHTML =
      '<div class="explain-head"><div><h3>' + esc(z.name) + '</h3>' +
      '<span class="badge ' + z.riskLevel + '">' + z.riskLevel.toUpperCase() + ' risk</span> ' +
      '<span class="confidence ' + coverage + '">' + esc(covText) + '</span></div>' +
      '<div class="explain-score"><div class="es-num">' + pr.score + '<span style="font-size:.9rem">/100</span></div>' +
      '<div class="es-lbl">Priority · ' + pr.category + '</div></div></div>' +

      '<div class="explain-grid"><div>' +
      '<h3 style="font-size:.9rem">Inspection-priority breakdown</h3>' +
      '<p class="muted small">Priority = 0.40 × damage + 0.35 × flood + 0.25 × road importance. Prototype weights, not validated.</p>' +
      contribHtml +
      '<p class="muted small">Weighted total: <b>' + pr.contribution.reduce((a, c) => a + c.pts, 0) + "</b> → priority <b>" + pr.score + "</b>.</p>" +
      '<h3 style="font-size:.9rem;margin-top:16px">Flood susceptibility factors (simulated)</h3>' +
      factorHtml +
      '<p class="muted small">Raw flood points sum: <b>' + total + "</b> (capped to " + z.riskScore + "/100).</p></div>" +

      "<div class='explain-side'><h3>Why this location ranks here</h3>" +
      "<div class='why-box'>" + esc(z.name) + " scores <b>" + pr.category + " priority (" + pr.score + "/100)</b>, driven mainly by <b>" +
      esc(topDriver.label) + "</b> (" + topDriver.pts + " of " + pr.score + " weighted points). Flood susceptibility is <b>simulated</b>; " +
      "damage and road-importance terms are marked real/missing above.</div>" +

      (pr.missing.length ? "<div class='history-box'>⚠ <strong>Missing data:</strong> " + esc(pr.missing.join(", ")) +
        ". Missing terms contribute 0 and are never estimated.</div>" : "") +

      (z.historical_note
        ? '<div class="history-box">📋 <strong>Historical flood information (illustrative):</strong> ' + esc(z.historical_note) + "</div>"
        : '<div class="history-box">📋 <strong>Historical flood information:</strong> none provided in the sample set.</div>') +

      "<h3 style='font-size:.9rem;margin-top:14px'>Nearby public facilities <span class='muted small'>(" + s.facCount + ")</span></h3><ul>" +
      (s.facCount ? s.facilities.slice(0, 8).map((x) =>
        "<li>" + esc(x.name) + " <span class='muted'>(" + esc(x.type) + ", " + x.zoneDistM + " m)</span>" +
        (x.simulated ? " <em class='muted'>simulated</em>" : "") + "</li>").join("") +
        (s.facCount > 8 ? "<li class='muted'>+" + (s.facCount - 8) + " more…</li>" : "")
        : "<li class='muted'>No mapped public facilities in this zone.</li>") + "</ul>" +

      ((s.reports.length) ? "<h3 style='font-size:.9rem'>Road-damage reports here</h3><ul>" + s.reports.map((r) =>
        "<li>" + esc(r.damageType) + " — <b>" + esc(r.severity) + "</b> · " + STATUS_LABEL[r.status] +
        (r.demo ? " <em class='muted'>demo</em>" : "") + "</li>").join("") + "</ul>" : "") +
      "</div></div>" +
      '<p class="muted small" style="margin-top:12px">⚠ Illustrative weighted factors only. Not a hydrological model and not an operational flood warning.</p>';
  }

  /* ---------------------------------------------------------
     Overview dashboard
     --------------------------------------------------------- */
  function renderSummary() {
    const total = state.reports.length;
    const pending = state.reports.filter((r) => r.status === "pending").length;
    const confirmed = state.reports.filter((r) => r.status === "verified" || r.status === "resolved").length;
    const highPriority = state.zones.filter((z) => computePriority(z).category === "High").length;
    $("#summary-cards").innerHTML =
      sc("Total road-damage reports", total, confirmed + " confirmed · " + pending + " pending", "") +
      sc("High-priority locations", highPriority, "priority score ≥ 60", "alert") +
      sc("Awaiting verification", pending, "Pending Review status", "warn") +
      sc("Verified or resolved", confirmed, "treated as confirmed", "good");
    const nc = $("#nav-report-count"); if (nc) nc.textContent = pending;
  }
  function sc(label, value, sub, cls) {
    return '<div class="s-card ' + cls + '"><div class="s-label">' + esc(label) + '</div>' +
      '<div class="s-value">' + value + '</div><div class="s-sub">' + esc(sub) + "</div></div>";
  }

  function renderOverviewLists() {
    const reports = state.reports.slice().sort((a, b) => String(b.reportedAt).localeCompare(String(a.reportedAt))).slice(0, 6);
    $("#ov-reports").innerHTML = reports.length ? reports.map((r) => {
      const z = state.zones.find((x) => x.id === r.zoneId);
      return '<div class="mini-row" data-openreport="' + r.id + '"><div class="mr-main">' +
        '<div class="mr-title">' + esc(r.damageType) + (r.demo ? ' <span class="badge demo">Demo</span>' : '') + '</div>' +
        '<div class="mr-meta">' + esc(shortId(r.id)) + ' · ' + esc(r.locationText || "no location") +
        (z ? ' · ' + esc(z.name) : '') + '</div></div>' +
        '<div class="mr-right"><span class="badge ' + r.severity + '">' + esc(r.severity) + '</span><br>' +
        '<span class="badge ' + r.status + '">' + STATUS_LABEL[r.status] + '</span></div></div>';
    }).join("") : '<p class="empty-note">No reports yet. Submit one from the Road Damage Reports section.</p>';

    const ranked = state.zones.map((z) => ({ z: z, pr: computePriority(z) }))
      .sort((a, b) => b.pr.score - a.pr.score).slice(0, 6);
    $("#ov-priority").innerHTML = ranked.map((row) => {
      const s = zoneStats(row.z);
      return '<div class="mini-row" data-inspect="' + row.z.id + '"><div class="mr-main">' +
        '<div class="mr-title">' + esc(row.z.name) + '</div>' +
        '<div class="mr-meta"><span class="badge ' + row.z.riskLevel + '">' + row.z.riskLevel + '</span> ' +
        s.facCount + ' facilities · ' + s.confirmedCount + ' confirmed reports</div></div>' +
        '<div class="mr-right"><b style="font-size:1.05rem;color:var(--navy-900)">' + row.pr.score + '</b><br>' +
        '<span class="muted small">' + row.pr.category + '</span></div></div>';
    }).join("");
  }

  function renderCharts() {
    const counts = { low: 0, medium: 0, high: 0 };
    state.zones.forEach((z) => counts[z.riskLevel]++);
    const max = Math.max(1, counts.low, counts.medium, counts.high);
    $("#risk-chart").innerHTML = ["high", "medium", "low"].map((k) =>
      '<div class="bar-row"><span>' + k.charAt(0).toUpperCase() + k.slice(1) + "</span>" +
      '<div class="bar-track"><div class="bar-fill ' + k + '" style="width:' + (counts[k] / max * 100) + '%"></div></div>' +
      '<span class="bar-val">' + counts[k] + "</span></div>").join("");
    if ($("#risk-split")) $("#risk-split").innerHTML =
      '<div class="ss"><b>' + state.zones.length + '</b>locations mapped</div>' +
      '<div class="ss"><b>' + counts.high + '</b>high risk</div>' +
      '<div class="ss"><b>' + counts.medium + '</b>medium risk</div>' +
      '<div class="ss"><b>' + rainIntensityLabel() + '</b>rainfall scenario</div>';

    const exposedFac = state.facilities.filter((f) => { const z = state.zones.find((x) => x.id === f.zoneId); return z && z.riskLevel !== "low"; });
    const byType = { hospital: 0, school: 0, shelter: 0, other: 0 };
    exposedFac.forEach((f) => { byType[f.type] = (byType[f.type] || 0) + 1; });
    const vals = Object.keys(byType).map((k) => byType[k]);
    const fmax = Math.max.apply(null, [1].concat(vals));
    $("#facility-chart").innerHTML = Object.keys(byType).map((k) =>
      '<div class="bar-row"><span>' + k.charAt(0).toUpperCase() + k.slice(1) + "s</span>" +
      '<div class="bar-track"><div class="bar-fill blue" style="width:' + (byType[k] / fmax * 100) + '%"></div></div>' +
      '<span class="bar-val">' + byType[k] + "</span></div>").join("");
    const reportsInRisk = state.reports.filter((r) => { const z = state.zones.find((x) => x.id === r.zoneId); return z && z.riskLevel !== "low"; });
    if ($("#exposure-split")) $("#exposure-split").innerHTML =
      '<div class="ss"><b>' + exposedFac.length + '</b>facilities in medium/high zones</div>' +
      '<div class="ss"><b>' + reportsInRisk.length + '</b>reports in medium/high zones</div>' +
      '<div class="ss"><b>' + state.facilities.length + '</b>facilities loaded</div>';
  }
  function rainIntensityLabel() { const r = RAIN.find((x) => x.id === state.rainId); return r ? r.intensity + " mm/3h" : "—"; }
  function renderLegend() {
    $("#legend").innerHTML =
      '<div class="legend-group"><span class="legend-title">Flood risk (simulated)</span>' +
      '<span class="legend-item"><i class="swatch zone low"></i>Low</span>' +
      '<span class="legend-item"><i class="swatch zone medium"></i>Medium</span>' +
      '<span class="legend-item"><i class="swatch zone high"></i>High</span></div>' +
      '<div class="legend-group"><span class="legend-title">Facilities (real)</span>' +
      '<span class="legend-item"><i class="dot hospital"></i>Hospital</span>' +
      '<span class="legend-item"><i class="dot school"></i>School</span>' +
      '<span class="legend-item"><i class="dot shelter"></i>Shelter</span>' +
      '<span class="legend-item"><i class="dot other"></i>Other</span></div>' +
      '<div class="legend-group"><span class="legend-title">Roads</span>' +
      '<span class="legend-item"><span style="display:inline-block;width:22px;height:3px;background:#8a6a00;border-radius:2px"></span>Primary</span>' +
      '<span class="legend-item"><span style="display:inline-block;width:22px;height:3px;background:#b7a25a;border-radius:2px"></span>Secondary / tertiary</span></div>' +
      '<div class="legend-group"><span class="legend-title">Damage report</span>' +
      '<span class="legend-item"><i class="dot report"></i>Reported road damage</span></div>' +
      '<span class="legend-note">Rectangle colour = simulated flood-risk level for the current scenario. Marker numbers show the 0-100 flood score. Facility markers use real OpenStreetMap data when available.</span>';
  }

  /* ---------------------------------------------------------
     Priority table
     --------------------------------------------------------- */
  function sortedPriorityRows() {
    let rows = state.zones.map((z) => ({ z: z, pr: computePriority(z), stats: zoneStats(z) }));
    if (state.riskFilter !== "all") rows = rows.filter((r) => r.z.riskLevel === state.riskFilter);
    if (state.prioritySearch) {
      const q = state.prioritySearch.toLowerCase();
      rows = rows.filter((r) => r.z.name.toLowerCase().indexOf(q) !== -1);
    }
    const dir = state.sortDir === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      if (state.sortKey === "name") return a.z.name.localeCompare(b.z.name) * dir;
      if (state.sortKey === "riskScore") return (a.z.riskScore - b.z.riskScore) * dir;
      return (a.pr.score - b.pr.score) * dir;
    });
    return rows;
  }

  function renderPriorityTable() {
    const rows = sortedPriorityRows();
    $("#priority-body").innerHTML = rows.map((r, i) => {
      const z = r.z, s = r.stats, pr = r.pr;
      return '<tr data-zone="' + z.id + '"' + (z.id === state.selectedZoneId ? ' class="active"' : "") + ">" +
        "<td>" + (i + 1) + "</td>" +
        "<td><strong>" + esc(z.name) + "</strong><br><span class='muted small'>" + fmt(z.elevation_m, 0) +
        " m elev · drain idx " + z.drainage_index + "</span></td>" +
        '<td><span class="badge ' + z.riskLevel + '">' + z.riskLevel.toUpperCase() + "</span></td>" +
        '<td class="num">' + z.riskScore + "</td>" +
        '<td class="num">' + pr.damage.value + (pr.damage.available ? " <span class='muted small'>(" + pr.damage.confirmedCount + ")</span>" : " <span class='muted small'>—</span>") + "</td>" +
        '<td class="num">' + s.facCount + (s.facCounts.hospital ? " <span class='muted small'>(" + s.facCounts.hospital + " hosp)</span>" : "") + "</td>" +
        '<td class="num"><span class="mini-bar"><i style="width:' + pr.score + "%;background:" + RISK_FILL[z.riskLevel] + '"></i></span><b>' + pr.score + "</b> <span class='muted small'>" + pr.category + "</span></td>" +
        '<td><div class="row-actions"><button class="text-btn" data-inspect="' + z.id + '">Inspect</button>' +
        '<button class="text-btn" data-focus="' + z.id + '">Map</button></div></td></tr>';
    }).join("") || '<tr><td colspan="8" class="muted" style="padding:18px">No locations match the current filter.</td></tr>';
    $("#priority-count").textContent = rows.length + " of " + state.zones.length + " locations shown.";

    const w = PRIORITY_WEIGHTS;
    $("#weight-strip").innerHTML =
      weightCard(w.damage, "Damage severity", "From confirmed road-damage reports near the zone (real, if any).") +
      weightCard(w.flood, "Flood susceptibility", "Simulated flood score for the selected rainfall scenario.") +
      weightCard(w.road, "Road importance", "Real OpenStreetMap road class + distance to the zone.");
  }
  function weightCard(w, name, desc) {
    return '<div class="weight-card"><div class="w-pct">' + Math.round(w * 100) + '%</div>' +
      '<div class="w-name">' + esc(name) + '</div><div class="w-desc">' + esc(desc) + "</div></div>";
  }

  /* ---------------------------------------------------------
     Road-damage reporting module
     --------------------------------------------------------- */
  function renderZoneOptions() {
    const sel = $("#r-zone"), cur = sel.value;
    sel.innerHTML = '<option value="">— auto-detect from coordinates —</option>' +
      state.zones.map((z) => '<option value="' + z.id + '">' + esc(z.name) + " (" + z.riskLevel + " risk)</option>").join("");
    if (cur) sel.value = cur;
  }

  function setReportCoords(lat, lng) {
    $("#r-lat").value = Number(lat).toFixed(6);
    $("#r-lng").value = Number(lng).toFixed(6);
    updateCoordHint();
    if (state.mapReady) {
      if (state.pickMarker) state.map.removeLayer(state.pickMarker);
      state.pickMarker = L.circleMarker([lat, lng], { radius: 8, color: "#17a08f", weight: 3, fillColor: "#fff", fillOpacity: 1 })
        .addTo(state.map).bindPopup("Report location (unsaved)").openPopup();
    }
  }
  function nearestZone(lat, lng) {
    let best = null, bd = Infinity;
    state.zones.forEach((z) => { const d = distM(lat, lng, z.lat, z.lon); if (d < bd) { bd = d; best = z; } });
    return best;
  }
  function updateCoordHint() {
    const lat = parseFloat($("#r-lat").value), lng = parseFloat($("#r-lng").value);
    const note = $("#gps-note");
    if (isNaN(lat) || isNaN(lng)) {
      note.textContent = "GPS is optional and only used when you grant permission. We never infer your location automatically.";
      return;
    }
    const z = nearestZone(lat, lng);
    note.textContent = "Nearest sample zone: " + (z ? z.name + " (" + Math.round(distM(lat, lng, z.lat, z.lon)) + " m)" : "unknown") +
      ". Coordinates are used exactly as provided; we do not auto-infer location.";
  }

  /* simulated AI image assessment (heuristic, NOT a model) */
  function assessImage(file, cb) {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = function () {
      try {
        const w = 128, h = Math.max(1, Math.round(img.height / img.width * 128));
        const c = document.createElement("canvas"); c.width = w; c.height = h;
        const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0, w, h);
        const d = ctx.getImageData(0, 0, w, h).data;
        let sum = 0, sum2 = 0, n = 0, dark = 0, edge = 0, prev = 0;
        for (let i = 0; i < d.length; i += 4) {
          const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          sum += g; sum2 += g * g; n++;
          if (g < 55) dark++;
          if (n > 1) edge += Math.abs(g - prev);
          prev = g;
        }
        const mean = sum / n;
        const std = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
        const darkness = dark / n, texture = edge / n;
        const sevScore = clamp(0.45 * darkness + 0.35 * (texture / 40) + 0.20 * (std / 70), 0, 1);
        const severity = sevScore > 0.55 ? "high" : sevScore > 0.32 ? "medium" : "low";
        const confidence = Math.round(clamp(0.5 + Math.abs(sevScore - 0.42), 0.45, 0.9) * 100);
        cb({ ok: true, severity: severity, confidence: confidence, sevScore: sevScore });
      } catch (e) { cb({ ok: false, error: e.message }); }
      URL.revokeObjectURL(url);
    };
    img.onerror = function () { URL.revokeObjectURL(url); cb({ ok: false, error: "Could not read the image file." }); };
    img.src = url;
  }

  function duplicateOf(lat, lng, damageType, severity) {
    if (lat == null || lng == null) return null;
    let found = null;
    state.reports.forEach((r) => {
      if (r.lat == null) return;
      const d = distM(lat, lng, r.lat, r.lon);
      const sameType = r.damageType === damageType;
      const sameSev = severity && SEV_ORDER[r.severity] === SEV_ORDER[severity];
      if (d <= 60 && (sameType || sameSev)) { r._d = d; if (!found || d < found._d) found = r; }
    });
    return found;
  }

  function fmtDateTime(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return esc(iso);
    return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  function reportMatchesSearch(r) {
    if (!state.reportSearch) return true;
    const q = state.reportSearch.toLowerCase();
    return (shortId(r.id).toLowerCase().indexOf(q) !== -1) ||
      (String(r.locationText || "").toLowerCase().indexOf(q) !== -1) ||
      (String(r.damageType || "").toLowerCase().indexOf(q) !== -1);
  }

  function reportPriority(r) {
    const z = r.zoneId ? state.zones.find((x) => x.id === r.zoneId) : null;
    return z ? computePriority(z).score : null;
  }

  function renderReports() {
    annotateReports();
    const list = state.reports.filter((r) => reportFilterMatches(r) && reportMatchesSearch(r));
    const mine = state.reports.filter((r) => !r.demo).length;
    const demo = state.reports.filter((r) => r.demo).length;
    const pending = state.reports.filter((r) => r.status === "pending").length;
    $("#reports-summary").textContent = mine + " submitted in this browser · " + demo +
      " labelled demo seed reports · " + pending + " pending review.";
    $("#reports-foot").textContent = list.length + " of " + state.reports.length +
      " reports shown. Duplicate reports near the same spot are grouped as one incident with repeat confirmations. Submitted reports are stored in this browser only.";

    let html = "";
    list.forEach((r) => {
      const zone = state.zones.find((z) => z.id === r.zoneId);
      const pr = reportPriority(r);
      const open = state.expandedReportId === r.id;
      html += '<tr data-report="' + r.id + '"' + (open ? ' class="active"' : "") + ">" +
        "<td>" + (r.photo ? '<img class="thumb" src="' + r.photo + '" alt="Road damage photo">' : '<div class="thumb-ph">' + (r.demo ? "demo" : "—") + "</div>") + "</td>" +
        '<td><span class="mono-id">' + esc(shortId(r.id)) + "</span>" + (r.demo ? ' <span class="badge demo">Demo</span>' : "") + "</td>" +
        "<td><strong>" + esc(r.damageType) + "</strong></td>" +
        '<td><span class="badge ' + r.severity + '">' + esc(r.severity) + "</span></td>" +
        "<td>" + esc(r.locationText || "—") + (r.lat != null ? "<br><span class='muted small'>" + r.lat + ", " + r.lon + "</span>" : " <span class='muted small'>no coords</span>") + "</td>" +
        "<td><span class='small'>" + fmtDateTime(r.reportedAt) + "</span></td>" +
        '<td class="num">' + (pr != null ? pr : '<span class="muted">—</span>') + "</td>" +
        '<td><span class="badge ' + r.status + '">' + STATUS_LABEL[r.status] + "</span>" +
        (r.dupes ? ' <span class="badge dup">+' + r.dupes + "</span>" : "") + "</td>" +
        '<td><div class="row-actions">' +
        '<button class="small-btn" data-opendetail="' + r.id + '" aria-expanded="' + (open ? "true" : "false") + '">' + (open ? "Hide" : "Details") + "</button>" +
        (r.status === "pending" ? '<button class="small-btn verify" data-act="verify" data-id="' + r.id + '">Verify</button>' : "") +
        (r.status === "verified" ? '<button class="small-btn resolve" data-act="resolve" data-id="' + r.id + '">Resolve</button>' : "") +
        (r.lat != null ? '<button class="small-btn" data-locate="' + r.id + '">Map</button>' : "") +
        '<button class="small-btn danger" data-act="delete" data-id="' + r.id + '">Delete</button>' +
        "</div></td></tr>";
      if (open) html += '<tr class="detail-row"><td colspan="9">' + reportDetailHtml(r, zone) + "</td></tr>";
    });
    $("#reports-body").innerHTML = html || '<tr><td colspan="9" class="muted" style="padding:18px">No reports match the current filter. ' +
      (state.reports.length ? "Try a different status or search." : "Submit a report using the form above.") + "</td></tr>";

    renderReviewList();
    if (state.mapReady) renderMap();
  }

  function reportDetailHtml(r, zone) {
    return '<div class="report-detail"><div>' +
      (r.photo ? '<img src="' + r.photo + '" alt="Road-damage photo">' : '<div class="rd-ph">' + (r.demo ? "No photo (demo seed)" : "No photo stored") + "</div>") + "</div><div>" +
      "<dl>" +
      "<dt>Report ID</dt><dd class='mono-id'>" + esc(shortId(r.id)) + "</dd>" +
      "<dt>Damage type</dt><dd>" + esc(r.damageType) + "</dd>" +
      "<dt>Severity</dt><dd><span class='badge " + r.severity + "'>" + esc(r.severity) + "</span></dd>" +
      "<dt>Status</dt><dd><span class='badge " + r.status + "'>" + STATUS_LABEL[r.status] + "</span></dd>" +
      "<dt>Location</dt><dd>" + esc(r.locationText || "—") + "</dd>" +
      "<dt>Coordinates</dt><dd>" + (r.lat != null ? r.lat + ", " + r.lon : "not provided") + "</dd>" +
      "<dt>Related zone</dt><dd>" + (zone ? esc(zone.name) + " · " + zone.riskLevel + " risk (" + r.zoneDistM + " m)" : "unlinked") + "</dd>" +
      "<dt>Nearest road</dt><dd>" + (r.nearRoad ? r.nearRoad.distM + " m" : "no road data") + "</dd>" +
      "<dt>Reported</dt><dd>" + fmtDateTime(r.reportedAt) + "</dd>" +
      (r.reporter ? "<dt>Reporter</dt><dd>" + esc(r.reporter) + "</dd>" : "") +
      (r.description ? "<dt>Description</dt><dd>" + esc(r.description) + "</dd>" : "") +
      (r.aiSimulated ? "<dt>Demo AI severity</dt><dd>" + esc(r.aiSeverity) + " (" + r.aiConfidence + "%) — <em class='muted'>simulated, not a model</em></dd>" : "") +
      (r.dupes ? "<dt>Duplicate confirmations</dt><dd>+" + r.dupes + " grouped at this location</dd>" : "") +
      "</dl>" +
      "<div class='row gap' style='margin-top:12px'>" +
      (r.status === "pending" ? '<button class="small-btn verify" data-act="verify" data-id="' + r.id + '">Verify report</button>' : "") +
      (r.status === "verified" ? '<button class="small-btn resolve" data-act="resolve" data-id="' + r.id + '">Mark resolved</button>' : "") +
      (r.lat != null ? '<button class="small-btn" data-locate="' + r.id + '">Locate on map</button>' : "") +
      "</div></div></div>";
  }

  function renderReviewList() {
    const list = state.reports.filter((r) => state.reportFilter === "all" || r.status === state.reportFilter);
    $("#review-list").innerHTML = list.map((r) =>
      '<div class="review-item"><div class="review-item-top"><div><strong>' + esc(r.damageType) +
      "</strong> · <span class='badge " + r.severity + "'>" + esc(r.severity) + "</span>" +
      (r.demo ? ' <span class="badge demo">Demo</span>' : "") + "</div>" +
      '<span class="badge ' + r.status + '">' + STATUS_LABEL[r.status] + "</span></div>" +
      '<div class="ri-meta">' + esc(shortId(r.id)) + " · " + esc(r.locationText || "no location text") + " · " + fmtDateTime(r.reportedAt) +
      (r.zoneId ? " · " + esc((state.zones.find((z) => z.id === r.zoneId) || {}).name || "") : "") +
      (r.dupes ? " · +" + r.dupes + " dup" : "") + "</div>" +
      '<div class="ri-actions">' +
      (r.status === "pending" ? '<button class="small-btn verify" data-act="verify" data-id="' + r.id + '">✓ Verify</button>' : "") +
      (r.status !== "resolved" ? '<button class="small-btn resolve" data-act="resolve" data-id="' + r.id + '">Resolve</button>' : "") +
      '<button class="small-btn" data-locate="' + r.id + '">Locate on map</button>' +
      (r.status === "pending" ? '<button class="small-btn danger" data-act="delete" data-id="' + r.id + '">Delete</button>' : "") +
      "</div></div>"
    ).join("") || '<p class="muted small">No reports with this status.</p>';
  }

  function handlePhoto(file) {
    if (!/^image\//.test(file.type)) { toast("Please choose an image file."); return; }
    if (file.size > 6 * 1024 * 1024) toast("Large image — used this session only.");
    const reader = new FileReader();
    reader.onload = function (ev) {
      const prev = $("#photo-preview");
      prev.src = ev.target.result; prev.hidden = false;
      $("#drop-hint").hidden = true;
      $("#btn-assess").disabled = false; $("#btn-clear-photo").disabled = false;
      $("#ai-result").hidden = true; state.assess = null;
    };
    reader.readAsDataURL(file);
  }
  function runAssess() {
    const input = $("#photo-input");
    if (input.files && input.files[0]) return doAssess(input.files[0]);
    const src = $("#photo-preview").src;
    if (!src) return;
    fetch(src).then((r) => r.blob()).then((b) => doAssess(b)).catch(() => toast("Could not re-read the image."));
  }
  function doAssess(file) {
    assessImage(file, (res) => {
      const box = $("#ai-result"); box.hidden = false;
      if (!res.ok) { box.innerHTML = '<p class="muted">Assessment unavailable: ' + esc(res.error) + "</p>"; return; }
      state.assess = res; $("#r-severity").value = res.severity;
      box.innerHTML =
        '<div class="ai-row"><div><strong>Demo AI severity:</strong> <span class="badge ' + res.severity + '">' + res.severity.toUpperCase() + "</span></div>" +
        "<div class='small'><b>" + res.confidence + "%</b> confidence</div></div>" +
        '<div class="conf-meter"><i style="width:' + res.confidence + '%"></i></div>' +
        '<div class="ai-sim-note">⚠ SIMULATED DEMONSTRATION — a simple image-brightness/texture heuristic, not a trained vision model. ' +
        "It is not a validated AI detection and must not be relied on. The severity value was copied into the form; you can adjust it.</div>";
      toast("Demo assessment complete (" + res.severity + ", " + res.confidence + "% confidence).");
    });
  }

  function collectForm() {
    const lat = parseFloat($("#r-lat").value), lng = parseFloat($("#r-lng").value);
    return {
      photo: $("#photo-preview").hidden ? null : ($("#photo-preview").getAttribute("src") || null),
      locationText: $("#r-location").value.trim(),
      lat: isNaN(lat) ? null : lat, lng: isNaN(lng) ? null : lng,
      zoneId: $("#r-zone").value || null,
      damageType: $("#r-damage").value, severity: $("#r-severity").value,
      description: $("#r-desc").value.trim(),
      reportedAt: $("#r-when").value || new Date().toISOString().slice(0, 16),
      reporter: $("#r-reporter").value.trim(),
      aiSeverity: state.assess ? state.assess.severity : null,
      aiConfidence: state.assess ? state.assess.confidence : null,
      aiSimulated: !!state.assess,
    };
  }
  function validateForm(d) {
    const errs = [];
    if (!d.damageType) errs.push("Select a damage type.");
    if (!d.locationText) errs.push("Add a location description.");
    if ((d.lat == null) !== (d.lng == null)) errs.push("Provide both latitude and longitude, or neither.");
    if (d.lat != null && (d.lat < -90 || d.lat > 90 || d.lng < -180 || d.lng > 180)) errs.push("Coordinates are out of range (lat −90..90, lng −180..180).");
    if (!d.photo) errs.push("Attach a road-damage photograph — this is a visual reporting tool.");
    return errs;
  }
  function showFormErrors(errs) {
    const box = $("#form-errors");
    if (!errs.length) { box.hidden = true; box.innerHTML = ""; return; }
    box.hidden = false;
    box.innerHTML = "<strong>Please fix " + errs.length + " item(s):</strong><ul>" + errs.map((e) => "<li>" + esc(e) + "</li>").join("") + "</ul>";
    box.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function reviewReport() {
    const d = collectForm();
    const errs = validateForm(d);
    showFormErrors(errs);
    if (errs.length) { toast("Please fix the highlighted items."); return; }
    if (!d.zoneId && d.lat != null) { const z = nearestZone(d.lat, d.lng); if (z) d.zoneId = z.id; }
    const dup = duplicateOf(d.lat, d.lng, d.damageType, d.severity);
    state.pendingReport = d;
    const box = $("#review-card"), zone = state.zones.find((x) => x.id === d.zoneId);
    box.hidden = false;
    $("#review-preview").innerHTML =
      (d.photo ? '<img src="' + d.photo + '" alt="Review photo" style="max-width:100%;border-radius:9px;margin-bottom:10px">' : "") +
      "<p><strong>" + esc(d.damageType) + "</strong> · severity <span class='badge " + d.severity + "'>" + esc(d.severity) + "</span>" +
      (d.aiSimulated ? " <span class='badge demo'>AI demo: " + esc(d.aiSeverity) + " (" + d.aiConfidence + "%)</span>" : "") + "</p>" +
      "<p class='small'><strong>Location:</strong> " + esc(d.locationText) + (d.lat != null ? " (" + d.lat + ", " + d.lng + ")" : " (no coordinates)") + "</p>" +
      "<p class='small'><strong>Related zone:</strong> " + (zone ? esc(zone.name) + " · " + zone.riskLevel + " risk" : "not linked") + "</p>" +
      (d.description ? "<p class='small'><strong>Description:</strong> " + esc(d.description) + "</p>" : "") +
      "<p class='small'><strong>Reported:</strong> " + fmtDateTime(d.reportedAt) + (d.reporter ? " · " + esc(d.reporter) : "") + "</p>" +
      (dup ? "<p class='small' style='color:#a5372d'><strong>⚠ Possible duplicate:</strong> a report of “" + esc(dup.damageType) +
        "” already exists ~" + Math.round(dup._d) + " m away. Submitting adds a confirmation to that incident instead of a separate confirmed incident.</p>" : "") +
      "<p class='small muted'>On submit the status is <b>Pending Review</b>. A reviewer must verify it before it counts as confirmed damage.</p>";
    box.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  let submitting = false;
  function submitReport() {
    const d = state.pendingReport;
    if (!d) { toast("Review the report first."); return; }
    if (submitting) return;                 // guard against double-submit
    submitting = true;
    $("#btn-submit").disabled = true;
    const finish = () => { submitting = false; $("#btn-submit").disabled = false; };
    const dup = duplicateOf(d.lat, d.lng, d.damageType, d.severity);
    let newId = null;
    if (dup) {
      dup.dupes = (dup.dupes || 0) + 1;
      dup.dupSeverities = dup.dupSeverities || []; dup.dupSeverities.push(d.severity);
      toast("Duplicate detected — added as a confirmation (" + Math.round(dup._d) + " m away).");
    } else {
      newId = "r-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      state.reports.push({
        id: newId, demo: false, city: state.cityKey,
        damageType: d.damageType, severity: d.severity,
        aiSeverity: d.aiSeverity, aiConfidence: d.aiConfidence, aiSimulated: d.aiSimulated,
        locationText: d.locationText, lat: d.lat, lng: d.lng, lon: d.lng,
        description: d.description, reporter: d.reporter,
        reportedAt: d.reportedAt, status: "pending", zoneId: d.zoneId, photo: d.photo,
        dupes: 0, dupOf: null,
      });
      toast("Report submitted — status: Pending Review.");
    }
    saveStoredReports();
    state.pendingReport = null;
    $("#review-card").hidden = true;
    resetForm();
    annotateReports();
    renderAll();
    if (newId) { state.expandedReportId = newId; renderReports(); }
    finish();
    if (state.reports.length && !$("#reports-summary").textContent) { /* noop */ }
  }

  function resetForm() {
    state.assess = null;
    const prev = $("#photo-preview");
    prev.hidden = true; prev.removeAttribute("src");
    $("#drop-hint").hidden = false;
    $("#ai-result").hidden = true; $("#ai-result").innerHTML = "";
    $("#btn-assess").disabled = true; $("#btn-clear-photo").disabled = true;
    if (state.pickMarker && state.mapReady) { state.map.removeLayer(state.pickMarker); state.pickMarker = null; }
    $("#r-lat").value = ""; $("#r-lng").value = "";
    updateCoordHint();
    const input = $("#photo-input"); if (input) input.value = "";
  }

  function reportAction(id, act) {
    const r = state.reports.find((x) => x.id === id);
    if (!r) return;
    if (act === "verify") { r.status = "verified"; toast("Report verified — now counted as confirmed damage."); }
    else if (act === "resolve") { r.status = "resolved"; toast("Report marked resolved."); }
    else if (act === "delete") { state.reports = state.reports.filter((x) => x.id !== id); if (state.expandedReportId === id) state.expandedReportId = null; toast("Report deleted."); }
    saveStoredReports();
    annotateReports();
    renderAll();
  }

  /* ---------------------------------------------------------
     Routing / views
     --------------------------------------------------------- */
  function showView(name, opts) {
    opts = opts || {};
    if (!VIEW_META[name]) name = "overview";
    state.view = name;
    $$(".view").forEach((v) => { v.hidden = v.id !== "view-" + name; });
    $$(".nav-item").forEach((b) => {
      const on = b.getAttribute("data-view") === name;
      b.classList.toggle("active", on);
      if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    $("#view-title").textContent = VIEW_META[name][0];
    $("#view-sub").textContent = VIEW_META[name][1];
    const shell = $(".app-shell"); if (shell) shell.classList.remove("nav-open");
    $("#menu-btn").setAttribute("aria-expanded", "false");
    if (location.hash.slice(1) !== name) history.replaceState(null, "", "#" + name);
    if (!opts.silent) window.scrollTo({ top: 0, behavior: "auto" });
    if (name === "map") {
      ensureMap();
      setTimeout(() => { if (state.mapReady) { state.map.invalidateSize(); if (state.mapDirty) renderMap(); } }, 60);
    }
  }
  function ensureMap() {
    if (!state.mapReady) initMap();
    else if (state.map) setTimeout(() => state.map.invalidateSize(), 50);
  }

  /* ---------------------------------------------------------
     Master render
     --------------------------------------------------------- */
  function renderAll() {
    scoreZones();
    annotateFacilities();
    annotateReports();
    renderSummary();
    renderCharts();
    renderOverviewLists();
    renderLegend();
    renderPriorityTable();
    renderExplain();
    renderZoneOptions();
    renderReports();
    renderDetail();
    renderSimIndicator();
    if (state.mapReady) renderMap();
    const rain = RAIN.find((r) => r.id === state.rainId);
    if (rain) { const rh = $("#rain-help"); if (rh) rh.textContent = rain.desc + " (illustrative scenario)"; }
  }

  /* ---------------------------------------------------------
     Toast
     --------------------------------------------------------- */
  let toastTimer = null;
  function toast(msg) {
    const el = $("#toast"); if (!el) return;
    el.textContent = msg; el.hidden = false;
    requestAnimationFrame(() => el.classList.add("show"));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.classList.remove("show"); setTimeout(() => (el.hidden = true), 260); }, 3200);
  }

  /* ---------------------------------------------------------
     Events
     --------------------------------------------------------- */
  function bindEvents() {
    // sidebar / routing
    $$(".nav-item").forEach((b) => b.addEventListener("click", () => showView(b.getAttribute("data-view"))));
    $("#menu-btn").addEventListener("click", () => {
      const shell = $(".app-shell");
      const open = shell.classList.toggle("nav-open");
      $("#menu-btn").setAttribute("aria-expanded", open ? "true" : "false");
    });
    window.addEventListener("hashchange", () => { const h = location.hash.slice(1); if (VIEW_META[h] && h !== state.view) showView(h); });

    // global "view" buttons via data-view (on overview cards etc.) handled by delegation below

    // scenario controls
    $("#city-select").addEventListener("change", (e) => { exitPickMode(); loadCity(e.target.value, true); });
    const rainSel = $("#rain-select");
    rainSel.innerHTML = RAIN.map((r) => '<option value="' + r.id + '">' + esc(r.label) + "</option>").join("");
    rainSel.value = state.rainId;
    rainSel.addEventListener("change", (e) => { state.rainId = e.target.value; renderAll(); });
    $("#btn-refresh-data").addEventListener("click", () => loadCity(state.cityKey, false));
    $("#btn-fit").addEventListener("click", () => { showView("map"); fitZones(); });
    $("#btn-submit-cta").addEventListener("click", () => { showView("reports"); setTimeout(() => $("#report-form").scrollIntoView({ behavior: "smooth", block: "start" }), 60); });

    // map layers
    $("#layer-zones").addEventListener("change", (e) => { state.layerZones = e.target.checked; applyLayerVisibility(); });
    $("#layer-facilities").addEventListener("change", (e) => { state.layerFacilities = e.target.checked; renderMap(); });
    $("#layer-roads").addEventListener("change", (e) => { state.layerRoads = e.target.checked; renderMap(); });
    $("#layer-reports").addEventListener("change", (e) => { state.layerReports = e.target.checked; renderMap(); });
    $$(".fac-filter").forEach((cb) => cb.addEventListener("change", () => { state.facFilter[cb.value] = cb.checked; renderMap(); }));

    // priority tools
    $("#priority-search").addEventListener("input", (e) => { state.prioritySearch = e.target.value; renderPriorityTable(); });
    $("#priority-risk-filter").addEventListener("change", (e) => { state.riskFilter = e.target.value; renderPriorityTable(); });
    $$("#priority-table th.sortable").forEach((th) => th.addEventListener("click", () => {
      const k = th.getAttribute("data-sort");
      if (state.sortKey === k) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
      else { state.sortKey = k; state.sortDir = "desc"; }
      $$("#priority-table th.sortable").forEach((x) => x.classList.remove("sorted-asc", "sorted-desc"));
      th.classList.add(state.sortDir === "asc" ? "sorted-asc" : "sorted-desc");
      renderPriorityTable();
    }));

    // report tools
    $("#report-search").addEventListener("input", (e) => { state.reportSearch = e.target.value; renderReports(); });
    $("#report-status-filter").addEventListener("change", (e) => {
      state.reportFilter = e.target.value; renderReports();
      $$(".tab-btn").forEach((x) => x.classList.toggle("active", x.getAttribute("data-status") === state.reportFilter));
    });

    // delegated clicks (dynamic content)
    document.addEventListener("click", (e) => {
      const viewBtn = e.target.closest("[data-view]");
      if (viewBtn && !viewBtn.closest(".side-nav")) { showView(viewBtn.getAttribute("data-view")); return; }

      const act = e.target.closest("[data-act]");
      if (act) { reportAction(act.getAttribute("data-id"), act.getAttribute("data-act")); return; }

      const insp = e.target.closest("[data-inspect]");
      if (insp) { selectZone(insp.getAttribute("data-inspect"), true, false); return; }

      const foc = e.target.closest("[data-focus]");
      if (foc) { const z = state.zones.find((x) => x.id === foc.getAttribute("data-focus")); showView("map"); setTimeout(() => focusZone(z, true), 120); return; }

      const loc = e.target.closest("[data-locate]");
      if (loc) { const r = state.reports.find((x) => x.id === loc.getAttribute("data-locate")); if (r) locateReport(r); return; }

      const openDetail = e.target.closest("[data-opendetail]");
      if (openDetail) {
        const id = openDetail.getAttribute("data-opendetail");
        state.expandedReportId = state.expandedReportId === id ? null : id;
        renderReports(); return;
      }
      const openRep = e.target.closest("[data-openreport]");
      if (openRep) {
        const id = openRep.getAttribute("data-openreport");
        state.expandedReportId = id; showView("reports");
        setTimeout(() => { const row = document.querySelector('tr[data-report="' + id + '"]'); if (row) { row.scrollIntoView({ behavior: "smooth", block: "center" }); renderReports(); } }, 80);
        return;
      }
      const rep = e.target.closest("[data-report]");
      if (rep) { selectReport(rep.getAttribute("data-report"), true); return; }

      const rrow = e.target.closest("tr[data-report]");
      if (rrow) {
        const id = rrow.getAttribute("data-report");
        state.expandedReportId = state.expandedReportId === id ? null : id;
        renderReports(); return;
      }

      const row = e.target.closest("tr[data-zone]");
      if (row) { selectZone(row.getAttribute("data-zone"), false, false); return; }
    });

    // disclaimer modal
    $("#btn-disclaimer").addEventListener("click", () => { $("#modal-disclaimer").hidden = false; });
    $("#md-close").addEventListener("click", () => { $("#modal-disclaimer").hidden = true; });
    $("#modal-disclaimer").addEventListener("click", (e) => { if (e.target.id === "modal-disclaimer") e.target.hidden = true; });

    // reporting: photo
    const photoInput = $("#photo-input"), uploadBox = $("#upload-box");
    uploadBox.addEventListener("dragover", (e) => { e.preventDefault(); uploadBox.classList.add("dragover"); });
    uploadBox.addEventListener("dragleave", () => uploadBox.classList.remove("dragover"));
    uploadBox.addEventListener("drop", (e) => {
      e.preventDefault(); uploadBox.classList.remove("dragover");
      if (e.dataTransfer.files && e.dataTransfer.files[0]) handlePhoto(e.dataTransfer.files[0]);
    });
    photoInput.addEventListener("change", (e) => { if (e.target.files && e.target.files[0]) handlePhoto(e.target.files[0]); });
    $("#btn-clear-photo").addEventListener("click", () => { resetForm(); toast("Photo cleared."); });
    $("#btn-assess").addEventListener("click", runAssess);

    // reporting: location
    $("#r-lat").addEventListener("input", updateCoordHint);
    $("#r-lng").addEventListener("input", updateCoordHint);
    $("#btn-gps").addEventListener("click", () => {
      if (!navigator.geolocation) { toast("Geolocation is not available in this browser."); return; }
      toast("Requesting your location…");
      navigator.geolocation.getCurrentPosition(
        (pos) => { setReportCoords(pos.coords.latitude, pos.coords.longitude); toast("Location captured with your permission."); },
        (err) => { toast("Location not available (" + (err && err.message ? err.message : "permission denied") + "). Enter coordinates manually or pick on the map — we never infer your location."); },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
      );
    });
    $("#btn-pick").addEventListener("click", () => { enterPickMode(); showView("map"); toast("Click the map to set the report location."); });
    $("#pick-cancel").addEventListener("click", exitPickMode);

    // reporting: review / submit
    $("#btn-review").addEventListener("click", reviewReport);
    $("#btn-cancel-review").addEventListener("click", () => { $("#review-card").hidden = true; state.pendingReport = null; });
    $("#btn-submit").addEventListener("click", submitReport);
    $("#btn-reset-form").addEventListener("click", () => { state.pendingReport = null; $("#review-card").hidden = true; setTimeout(() => { resetForm(); showFormErrors([]); }, 0); });

    // moderation tabs
    $$(".tab-btn").forEach((b) => b.addEventListener("click", () => {
      $$(".tab-btn").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      state.reportFilter = b.getAttribute("data-status");
      const sel = $("#report-status-filter"); if (sel) sel.value = state.reportFilter;
      renderReviewList();
      if (state.mapReady) renderMap();
    }));
  }

  /* ---------------------------------------------------------
     Init
     --------------------------------------------------------- */
  function init() {
    state.city = REF[state.cityKey];
    state.zones = state.city.zones.map((z) => Object.assign({}, z));
    $("#rain-select").innerHTML = RAIN.map((r) => '<option value="' + r.id + '">' + esc(r.label) + "</option>").join("");
    $("#rain-select").value = state.rainId;
    $("#r-when").value = new Date().toISOString().slice(0, 16);
    const th = document.querySelector('#priority-table th[data-sort="priorityScore"]');
    if (th) th.classList.add("sorted-desc");
    bindEvents();
    const startView = VIEW_META[location.hash.slice(1)] ? location.hash.slice(1) : "overview";
    showView(startView, { silent: true });
    // render data first (does not need the map); map is initialised lazily on demand
    loadCity(state.cityKey, true);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

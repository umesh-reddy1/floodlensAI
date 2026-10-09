"""Generates sample-data.js for FloodLens AI.

All zone risk inputs, historical notes and demo reports are SIMULATED
illustrative samples. They are not observed or validated flood data.
"""
import json, math, random, datetime, pathlib

CITIES = {
    "bengaluru": {
        "name": "Bengaluru, India (sample district)",
        "center": [12.9716, 77.5946],
        "bbox": [12.905, 77.530, 13.035, 77.660],
        "base_elev": 905, "elev_amp": 45, "channel_dir": 200.0,
        "wards": ["Ward 74 - HSR", "Ward 84 - Koramangala", "Ward 76 - Bellandur",
                  "Ward 68 - Jayanagar", "Ward 80 - Bommanahalli", "Ward 88 - Whitefield",
                  "Ward 71 - Shantinagar", "Ward 79 - BTM Layout"],
    },
    "mumbai": {
        "name": "Mumbai, India (sample district)",
        "center": [19.0760, 72.8777],
        "bbox": [19.010, 72.790, 19.150, 72.960],
        "base_elev": 22, "elev_amp": 34, "channel_dir": 250.0,
        "wards": ["Ward K/E - Andheri", "Ward H/E - Bandra", "Ward F/N - Parel",
                  "Ward M/E - Chembur", "Ward S - Bhandup", "Ward G/S - Worli",
                  "Ward L - Kurla", "Ward N - Ghatkopar"],
    },
    "chennai": {
        "name": "Chennai, India (sample district)",
        "center": [13.0827, 80.2707],
        "bbox": [13.020, 80.190, 13.150, 80.350],
        "base_elev": 11, "elev_amp": 22, "channel_dir": 160.0,
        "wards": ["Ward 178 - Velachery", "Ward 137 - Adyar", "Ward 197 - Pallikaranai",
                  "Ward 107 - Anna Nagar", "Ward 155 - Guindy", "Ward 112 - Perungudi",
                  "Ward 182 - Madipakkam", "Ward 128 - Kodambakkam"],
    },
}

HIST = [
    "Local news reports (illustrative) mention monsoon waterlogging in this ward.",
    "Residents recall short-duration street flooding after intense evening rain.",
    "Historical drain overflow noted in a sample municipal register entry.",
    "No significant historical flooding recalled in the sample narrative.",
    "Sample historical note: low-lying stretch near a stormwater outfall.",
    "Illustrative record of two waterlogging events in the past five years.",
    None, None,
]
DRAIN = ["poor", "fair", "good", "fair", "poor", "good", "fair", "poor"]


def build(city_key):
    c = CITIES[city_key]
    rng = random.Random(hash(city_key) & 0xFFFF)
    lat0, lon0 = c["center"]
    rows, cols = 4, 6
    dlat = (c["bbox"][2] - c["bbox"][0]) / rows
    dlon = (c["bbox"][3] - c["bbox"][1]) / cols
    zones = []
    ang = math.radians(c["channel_dir"])
    nx, ny = math.sin(ang), math.cos(ang)
    i = 0
    for r in range(rows):
        for col in range(cols):
            lat = c["bbox"][0] + (r + 0.5) * dlat
            lon = c["bbox"][1] + (col + 0.5) * dlon
            dx = lon - lon0
            dy = (lat - lat0) * 0.9
            perp = abs(-nx * dx + ny * dy)
            lowness = max(0.0, 1 - perp / 0.075)
            elev = c["base_elev"] - c["elev_amp"] * lowness + rng.uniform(-6, 6)
            drain_worse = {"poor": 0.85, "fair": 0.5, "good": 0.2}[DRAIN[i % len(DRAIN)]]
            drain_worse = min(1.0, max(0.05, drain_worse + rng.uniform(-0.12, 0.12)))
            impervious = min(1.0, max(0.25, 0.45 + 0.5 * lowness + rng.uniform(-0.15, 0.15)))
            hist = HIST[i % len(HIST)]
            hist_flag = 1 if hist and "no significant" not in hist.lower() else 0
            name = c["wards"][i % len(c["wards"])] + " \u00b7 Z%02d" % (i + 1)
            zones.append({
                "id": "%s-z%02d" % (city_key[:3], i + 1),
                "name": name,
                "row": r, "col": col,
                "lat": round(lat, 5), "lon": round(lon, 5),
                "elevation_m": round(elev, 1),
                "drainage_index": round(drain_worse, 2),
                "impervious": round(impervious, 2),
                "historical_note": hist,
                "historical_flag": hist_flag,
                "pop_density": rng.choice(["low", "medium", "high", "high"]),
            })
            i += 1
    return {"key": city_key, "name": c["name"], "center": c["center"],
            "bbox": c["bbox"], "grid": {"rows": rows, "cols": cols},
            "synthetic": True, "zones": zones}


def demo_reports(city_key, data):
    c = data[city_key]
    rng = random.Random(hash(city_key + "r") & 0xFFFF)
    zs = rng.sample(c["zones"], 6)
    types = ["Pothole", "Cracked road", "Damaged road surface", "Waterlogged road",
             "Possible flood-related road damage", "Pothole"]
    sev = ["low", "medium", "high", "medium", "high", "medium"]
    statuses = ["verified", "pending", "pending", "resolved", "verified", "pending"]
    base = datetime.datetime(2026, 9, 18, 9, 30)
    out = []
    for i, (z, t, s, st) in enumerate(zip(zs, types, sev, statuses)):
        dt = base + datetime.timedelta(days=i * 3, hours=i * 5)
        out.append({
            "id": "demo-%s-%d" % (city_key[:3], i + 1),
            "demo": True,
            "damageType": t,
            "severity": s,
            "aiSeverity": s,
            "aiConfidence": round(rng.uniform(0.55, 0.88), 2),
            "aiSimulated": True,
            "locationText": "Sample stretch near %s" % z["name"],
            "lat": round(z["lat"] + rng.uniform(-.004, .004), 5),
            "lon": round(z["lon"] + rng.uniform(-.004, .004), 5),
            "description": "Demo data \u2014 fabricated example for UI illustration only.",
            "reporter": "Demo seed",
            "reportedAt": dt.isoformat(timespec="minutes"),
            "status": st,
            "zoneId": z["id"],
            "photo": None,
            "dupes": 0,
            "dupOf": None,
        })
    return out


def main():
    data = {k: build(k) for k in CITIES}
    reports = {k: demo_reports(k, data) for k in CITIES}
    payload = {
        "generated": "2026-10-09",
        "disclaimer": ("Zone risk inputs, historical notes and demo reports are simulated "
                       "illustrative samples, not real observations."),
        "cities": data,
        "demoReports": reports,
        "rainScenarios": [
            {"id": "light", "label": "Light rain \u2014 12 mm / 3 h (illustrative)", "intensity": 12, "hourly": 4,
             "desc": "Occasional showers. Minimal surface water expected on drained streets."},
            {"id": "moderate", "label": "Moderate rain \u2014 35 mm / 3 h (illustrative)", "intensity": 35, "hourly": 12,
             "desc": "Steady monsoon rain. Minor ponding possible at known low points."},
            {"id": "heavy", "label": "Heavy rain \u2014 75 mm / 3 h (illustrative)", "intensity": 75, "hourly": 25,
             "desc": "Intense burst. Repeat waterlogging likely where drainage is poor."},
            {"id": "cloudburst", "label": "Cloudburst-like \u2014 150 mm / 3 h (illustrative)", "intensity": 150, "hourly": 50,
             "desc": "Extreme illustrative scenario for stress-testing priorities, not a forecast."},
        ],
    }
    header = ("/* FloodLens AI \u2014 sample & simulated data. "
              "ALL ZONES/LABELS HERE ARE SIMULATED, NOT OBSERVED DATA. */\n")
    out = header + "window.FLOODLENS = " + json.dumps(payload, indent=1, ensure_ascii=False) + ";\n"
    dest = pathlib.Path(__file__).resolve().parent.parent / "sample-data.js"
    dest.write_text(out, encoding="utf-8")
    print("written", len(out), "bytes ->", dest)
    print("zones per city:", {k: len(v["zones"]) for k, v in data.items()})


if __name__ == "__main__":
    main()

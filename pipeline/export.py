"""A3: write the app's JSON files exactly per the data contract, then validate them. Owner A.

    python pipeline/export.py                    # verified areas only, writes site/data/
    python pipeline/export.py --allow-unverified # development: include unverified districts

Writes to site/data/ (mode "real"):
  meta.json, areas.geojson, calendar/<area>.json, map/<year>.json, harmonize.json, manifest.json
and to docs/:
  methodology.md (numbers filled from the computed results), data-samples/*.csv

The full contract is in docs/methodology.md, section "Data files". make_mock.py uses the same
functions to write labelled demo data to site/data/mock/ (mode "mock").
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import shapely
from shapely.geometry import mapping

from common import (DOCS, OTHER_UNIT, RAW, SITE_DATA, SOURCES, UNITS, WORK, PipelineError, area_file,
                    clean_number, load_district_table, read_json, run_main, write_json)

GRID = 0.05
MIN_REFERENCE_YEARS = 3
AREAS_MAX_BYTES = 400_000
FIRMS_URL = "https://firms.modaps.eosdis.nasa.gov/"


# ---------- comparisons ----------

def seasonal_stats(months: list[str], values: np.ndarray):
    """For each month: median of the same calendar month in complete reference years, excluding the
    month's own year, and a robust z-score against those years (capped at +/-10)."""
    years = sorted({m[:4] for m in months})
    by_year = {y: {} for y in years}
    for m, v in zip(months, values):
        by_year[m[:4]][int(m[5:7])] = v
    complete = [y for y in years if len(by_year[y]) == 12 and not any(np.isnan(v) for v in by_year[y].values())]
    median = np.full(len(months), np.nan)
    score = np.full(len(months), np.nan)
    for i, (m, v) in enumerate(zip(months, values)):
        ref = np.array([by_year[y][int(m[5:7])] for y in complete if y != m[:4]])
        if len(ref) < MIN_REFERENCE_YEARS:
            continue
        med = float(np.median(ref))
        median[i] = med
        if np.isnan(v):
            continue
        spread = 1.4826 * float(np.median(np.abs(ref - med)))
        if spread == 0:
            spread = 1.2533 * float(np.mean(np.abs(ref - med)))
        if spread == 0:
            score[i] = 0.0 if v == med else float(np.sign(v - med) * 10)
        else:
            score[i] = float(np.clip((v - med) / spread, -10, 10))
    reference = {"completeYears": [int(complete[0]), int(complete[-1])] if complete else None,
                 "yearCount": len(complete), "excludesTargetYear": True, "minimumYears": MIN_REFERENCE_YEARS}
    return median, score, reference


# ---------- builders ----------

def exported_areas(table: list[dict], allow_unverified: bool) -> list[dict]:
    areas = [{"id": "sarawak", "name": "Sarawak", "type": "sarawak", "verified": True}]
    divisions: dict[str, list[dict]] = {}
    for r in table:
        divisions.setdefault(r["division_id"], []).append(r)
    for div_id, rows in divisions.items():
        verified = all(r["verified"] for r in rows)
        if verified or allow_unverified:
            areas.append({"id": div_id, "name": f"{rows[0]['division_name']} Division", "type": "division",
                          "verified": verified})
            for r in rows:
                areas.append({"id": r["district_id"], "name": f"{r['district_name']} District", "type": "district",
                              "division": div_id, "verified": r["verified"]})
    return areas


def calendar_range(harmonized: pd.DataFrame) -> list[str]:
    sar = harmonized[harmonized["area_id"] == "sarawak"].sort_values("month")
    present = sar[sar["status"] != "missing"]["month"].tolist()
    if not present:
        raise PipelineError("No month has data from either sensor; nothing to export.")
    return [m for m in sar["month"] if present[0] <= m <= present[-1]]


def build_calendar(area: dict, harmonized: pd.DataFrame, months: list[str]) -> dict:
    rows = harmonized[harmonized["area_id"] == area["id"]].set_index("month").reindex(months)
    if rows["status"].isna().all():
        raise PipelineError(f"No harmonized rows for {area['id']}.")
    h = rows["harmonized"].to_numpy(dtype=float)
    median, score, reference = seasonal_stats(months, h)
    return {
        "areaId": area["id"],
        "name": area["name"],
        "type": area["type"],
        "months": months,
        "harmonizedCount": [clean_number(v, 1) for v in h],
        "rawModisCount": [clean_number(v, 0) for v in rows["modis"]],
        "rawViirsCount": [clean_number(v, 0) for v in rows["viirs"]],
        "seasonalMedian": [clean_number(v, 1) for v in median],
        "anomalyScore": [clean_number(v, 2) for v in score],
        "status": rows["status"].fillna("missing").tolist(),
        "units": UNITS,
        "reference": reference,
    }


def build_maps(clean: pd.DataFrame, harmonized: pd.DataFrame, months: list[str]) -> dict[int, dict]:
    """Observed detections binned to 0.05-degree cells, per month, sensor and processing.
    Only months where that sensor covered the whole month, so map totals equal raw calendar totals."""
    sar = harmonized[harmonized["area_id"] == "sarawak"].set_index("month")
    available = {("MODIS", m) for m in months if not np.isnan(sar.at[m, "modis"])} | \
                {("VIIRS", m) for m in months if not np.isnan(sar.at[m, "viirs"])}
    df = clean[["date", "lat", "lon", "sensor", "processing"]].copy()
    df["month"] = pd.to_datetime(df["date"]).dt.strftime("%Y-%m")
    keep = [(s, m) in available for s, m in zip(df["sensor"], df["month"])]
    df = df[keep]
    df["clon"] = (np.floor(df["lon"] / GRID) * GRID + GRID / 2).round(3)
    df["clat"] = (np.floor(df["lat"] / GRID) * GRID + GRID / 2).round(3)
    grouped = df.groupby(["month", "clon", "clat", "sensor", "processing"]).size().reset_index(name="count")
    out = {}
    for year in sorted({int(m[:4]) for m in months}):
        g = grouped[grouped["month"].str[:4] == str(year)]
        out[year] = {
            "year": year,
            "cell": GRID,
            "sourceView": "observed hotspots, not harmonized locations",
            "cells": [{"lon": float(r.clon), "lat": float(r.clat), "month": int(r.month[5:7]), "count": int(r.count),
                       "sensor": r.sensor, "processing": r.processing} for r in g.itertuples()],
        }
    return out


def _round_coords(obj, digits=4):
    if isinstance(obj, (list, tuple)):
        if obj and isinstance(obj[0], (int, float)):
            return [round(float(v), digits) for v in obj]
        return [_round_coords(v, digits) for v in obj]
    return obj


def build_areas_geojson(areas: list[dict], district_features: list[dict], outline=None) -> dict:
    """Exported district polygons, plus (when given) the Sarawak state outline as the first feature with
    id "sarawak" and division null, so the map can draw land outside the exported districts."""
    wanted = {a["id"]: a for a in areas if a["type"] == "district"}
    feats = [d for d in district_features if d["id"] in wanted]
    if outline is not None:
        wanted = {**wanted, "sarawak": {"division": None}}
        # ~300 m detail is plenty for a state outline drawn behind the districts.
        outline = shapely.simplify(outline, 0.003, preserve_topology=True)
        feats = [{"id": "sarawak", "name": "Sarawak", "geometry": outline}] + feats
    for tol in (0.0, 0.0005, 0.001, 0.002, 0.004, 0.008, 0.016):
        out = {"type": "FeatureCollection", "features": []}
        for d in feats:
            geom = shapely.simplify(d["geometry"], tol, preserve_topology=True) if tol else d["geometry"]
            gj = mapping(geom)
            out["features"].append({"type": "Feature",
                                    "properties": {"id": d["id"], "name": d["name"], "division": wanted[d["id"]]["division"]},
                                    "geometry": {"type": gj["type"], "coordinates": _round_coords(gj["coordinates"])}})
        if len(json.dumps(out, separators=(",", ":"))) < AREAS_MAX_BYTES:
            return out
    raise PipelineError("areas.geojson stays above 400 KB even after simplifying; check the boundaries.")


def sensor_products(source_cov: dict, raw_manifest: dict) -> list[dict]:
    out = []
    for source, cov in source_cov.items():
        info = raw_manifest.get("datasets", {}).get(source, {})
        out.append({"id": source, "sensor": SOURCES[source]["sensor"], "processing": SOURCES[source]["processing"],
                    "coverage": {"start": cov["start"], "end": cov["end"]}, "url": FIRMS_URL,
                    "request": info.get("url_pattern"), "rows": info.get("rows")})
    return out


def build_outputs(*, harmonized, report, clean, source_cov, table, district_features, mode, allow_unverified,
                  source_label, raw_manifest=None, default_area="div:mukah", outline=None,
                  audit=None) -> dict[str, object]:
    areas = exported_areas(table, allow_unverified)
    ids = {a["id"] for a in areas}
    if default_area not in ids:
        raise PipelineError(f"Default area {default_area} is not exported because its districts are not verified "
                            f"in districts.csv. Verify them, or run with --allow-unverified for development.")
    months = calendar_range(harmonized)
    files: dict[str, object] = {}
    files["meta.json"] = {
        "mode": mode,
        "source": source_label,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "coverage": {"start": months[0], "end": months[-1]},
        "lastCompleteMonth": months[-1],
        "areas": areas,
        "defaultArea": default_area,
        "sensorProducts": sensor_products(source_cov, raw_manifest or {}),
        "methodVersion": report["methodVersion"],
    }
    if audit:  # cleaning rules and row counts, shown by the About panel (optional key)
        files["meta.json"]["cleaning"] = {"rules": audit.get("rules", {}), "counts": audit.get("counts", {})}
    files["areas.geojson"] = build_areas_geojson(areas, district_features, outline)
    for a in areas:
        files[f"calendar/{area_file(a['id'])}"] = build_calendar(a, harmonized, months)
    for year, obj in build_maps(clean, harmonized, months).items():
        files[f"map/{year}.json"] = obj
    files["harmonize.json"] = report
    return files


def write_outputs(files: dict[str, object], out_dir: Path) -> None:
    for sub in ("calendar", "map"):
        if (out_dir / sub).exists():
            shutil.rmtree(out_dir / sub)
    out_dir.mkdir(parents=True, exist_ok=True)
    for rel, obj in files.items():
        write_json(out_dir / rel, obj)
    entries = []
    for rel in sorted(files):
        p = out_dir / rel
        obj = files[rel]
        cov = None
        if rel.startswith("calendar/"):
            cov = {"start": obj["months"][0], "end": obj["months"][-1]}
        elif rel.startswith("map/"):
            ms = sorted({c["month"] for c in obj["cells"]})
            cov = {"start": f"{obj['year']}-{ms[0]:02d}", "end": f"{obj['year']}-{ms[-1]:02d}"} if ms else None
        elif rel == "meta.json":
            cov = obj["coverage"]
        entries.append({"path": rel, "bytes": p.stat().st_size,
                        "sha256": hashlib.sha256(p.read_bytes()).hexdigest(), "coverage": cov})
    write_json(out_dir / "manifest.json", {"generatedAt": files["meta.json"]["generatedAt"],
                                           "mode": files["meta.json"]["mode"], "files": entries}, pretty=True)


# ---------- docs ----------

def fmt_pct(v):
    return "not computed" if v is None else f"{v * 100:.1f}%"


def write_docs(files: dict, audit: dict, coverage: dict) -> None:
    meta, rep = files["meta.json"], files["harmonize.json"]
    m = rep["metrics"]
    lines = [
        "# Bara methodology",
        "",
        f"Generated by `pipeline/export.py` on {meta['generatedAt']}. Every number here comes from the pipeline "
        "output; nothing is typed by hand.",
        "",
        "## Reproduce",
        "",
        "```bash",
        "python -m venv pipeline/.venv",
        "pipeline/.venv/Scripts/python -m pip install -r pipeline/requirements.txt   # bin/python on macOS/Linux",
        "cp pipeline/.env.example pipeline/.env   # paste FIRMS_MAP_KEY",
        "python pipeline/acquire.py",
        "python pipeline/clean.py",
        "python pipeline/aggregate.py",
        "python pipeline/harmonize.py",
        "python pipeline/export.py",
        "python pipeline/validate.py --production",
        "python -m pytest pipeline/tests",
        "```",
        "",
        "## Sources",
        "",
    ]
    for p in meta["sensorProducts"]:
        lines.append(f"- NASA FIRMS `{p['id']}` ({p['sensor']}, {p['processing']} processing), "
                     f"{p['coverage']['start']} to {p['coverage']['end']}, {p.get('rows') or 'unknown'} rows downloaded.")
    lines += [
        "- Boundaries: geoBoundaries gbOpen Malaysia ADM1 and ADM2. District to division mapping: `pipeline/districts.csv`.",
        "",
        f"Calendar coverage: {meta['coverage']['start']} to {meta['lastCompleteMonth']} (complete months only).",
        "",
        "## Cleaning",
        "",
        "| Step | MODIS | VIIRS |",
        "| --- | ---: | ---: |",
    ]
    for step in ["loaded", "missing_fields", "nrt_replaced_by_sp", "non_vegetation_type", "low_confidence",
                 "exact_duplicates", "outside_sarawak", "kept", "no_district"]:
        lines.append(f"| {step} | {audit.get('MODIS', {}).get(step, 0)} | {audit.get('VIIRS', {}).get(step, 0)} |")
    lines += [
        "",
        "Rules are listed at the top of `pipeline/clean.py`. The type filter only removes what FIRMS labels as "
        "volcanoes, other static land sources and offshore sources; it does not remove every industrial heat source.",
        "",
        "## Harmonization",
        "",
        f"Train {rep['trainWindow'][0]} to {rep['trainWindow'][1]}, validation {rep['validationWindow'][0]} to "
        f"{rep['validationWindow'][1]}, final test {rep['testWindow'][0]} to {rep['testWindow'][1]}. "
        f"Method chosen on validation only: **{rep['methodName']}**.",
        "",
        "| Method | Validation WAPE | Test WAPE | Test MAE | Test bias |",
        "| --- | ---: | ---: | ---: | ---: |",
    ]
    for meth in rep["methods"]:
        t = meth["test"]
        bias = "not computed" if t["biasPct"] is None else f"{t['biasPct']}%"
        lines.append(f"| {meth['name']} | {fmt_pct(meth['validation']['WAPE'])} | {fmt_pct(t['WAPE'])} | "
                     f"{t['MAE'] if t['MAE'] is not None else 'not computed'} | {bias} |")
    lines += [
        "",
        f"Chosen method on the test year: WAPE {fmt_pct(m['WAPE'])}, {m['n']} evaluation months, "
        f"{m['sparseMonths']} with fewer than 5 detections, {m['zeroMonths']} with none. "
        f"Evaluation unit: {rep['evaluationUnit']}.",
        "",
        rep["continuity"],
        "",
        "Limitations: " + rep["notes"],
        "",
        "## Data files",
        "",
        "All files are in `site/data/` (demo data with the same shapes in `site/data/mock/`, `mode: \"mock\"`). "
        "`null` means not available (the sensor did not cover the whole month); `0` means observed with no detections.",
        "",
        "- `meta.json`: mode, source, generatedAt, coverage {start, end}, lastCompleteMonth, areas "
        "[{id, name, type, division?, verified}], defaultArea, sensorProducts [{id, sensor, processing, coverage, url, "
        "request, rows}], methodVersion",
        "- `areas.geojson`: district polygons, properties {id, name, division}, WGS84 lon/lat, 4 decimals",
        "- `calendar/<area id with : replaced by _>.json`: areaId, name, type, months, harmonizedCount, rawModisCount, "
        "rawViirsCount, seasonalMedian, anomalyScore (robust z-score, capped at +/-10), status "
        "(observed | estimated | missing), units, reference {completeYears, yearCount, excludesTargetYear, minimumYears}",
        "- `map/<year>.json`: year, cell, sourceView, cells [{lon, lat, month, count, sensor, processing}] "
        "(observed detections in 0.05-degree cells)",
        "- `harmonize.json`: methodVersion, method, methodName, chosenOn, finalTestYear, metrics {MAE, WAPE, biasPct, n, "
        "sparseMonths, zeroMonths}, trainWindow, validationWindow, testWindow, evaluationUnit, metricDefinitions, "
        "methods [{id, name, params, validation, test}], uncertainty, continuity, notes",
        "- `manifest.json`: every file with bytes, sha256 and coverage",
        "",
    ]
    DOCS.mkdir(parents=True, exist_ok=True)
    (DOCS / "methodology.md").write_text("\n".join(lines), encoding="utf-8", newline="\n")


def write_samples(clean: pd.DataFrame, files: dict) -> None:
    folder = DOCS / "data-samples"
    folder.mkdir(parents=True, exist_ok=True)
    sample = clean.sample(n=min(200, len(clean)), random_state=0).sort_values(["date", "time"])
    # LF line endings on every OS, so the files are identical in git and on any machine.
    sample.assign(date=pd.to_datetime(sample["date"]).dt.strftime("%Y-%m-%d")).to_csv(
        folder / "hotspots_sample.csv", index=False, lineterminator="\n")
    cal = files["calendar/sarawak.json"]
    pd.DataFrame({k: cal[k] for k in ("months", "harmonizedCount", "rawModisCount", "rawViirsCount",
                                      "seasonalMedian", "anomalyScore", "status")}).to_csv(
        folder / "calendar_sarawak.csv", index=False, lineterminator="\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--allow-unverified", action="store_true", help="development only")
    parser.add_argument("--out", type=Path, default=SITE_DATA)
    args = parser.parse_args()
    for f in ("harmonized.parquet", "harmonize.json", "hotspots_clean.parquet", "coverage.json", "audit_clean.json"):
        if not (WORK / f).exists():
            raise PipelineError(f"pipeline/work/{f} is missing. Run clean, aggregate and harmonize first.")

    from clean import load_geography
    table = load_district_table()
    adm1, districts = load_geography(table)
    cov = read_json(WORK / "coverage.json")
    raw_manifest = read_json(RAW / "manifest.json") if (RAW / "manifest.json").exists() else {}
    clean = pd.read_parquet(WORK / "hotspots_clean.parquet")
    files = build_outputs(harmonized=pd.read_parquet(WORK / "harmonized.parquet"),
                          report=read_json(WORK / "harmonize.json"), clean=clean, source_cov=cov["sources"],
                          table=table, district_features=districts, mode="real",
                          allow_unverified=args.allow_unverified, source_label="NASA FIRMS",
                          raw_manifest=raw_manifest, outline=adm1, audit=read_json(WORK / "audit_clean.json"))
    if args.allow_unverified:
        print("WARNING: unverified districts are included (meta.areas[].verified = false). Do not ship this.")
    write_outputs(files, args.out)
    write_docs(files, read_json(WORK / "audit_clean.json")["counts"], cov)
    write_samples(clean, files)
    print(f"Wrote {len(files) + 1} files to {args.out}, docs/methodology.md and docs/data-samples/")

    from validate import report_and_exit
    report_and_exit(args.out, production=False)


if __name__ == "__main__":
    run_main(main)

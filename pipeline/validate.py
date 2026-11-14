"""A3: check every data file against the contract. Exits 1 on any failure. Owner A.

    python pipeline/validate.py                 # site/data (real or mock mode accepted)
    python pipeline/validate.py --mock          # site/data/mock
    python pipeline/validate.py --production    # also fails unless site/data holds REAL data
    python pipeline/validate.py --dir some/folder

Checks: required keys, lon/lat order and Sarawak bounds, polygon geometry, months consecutive and
inside coverage, equal array lengths, non-negative finite counts, no NaN/Infinity, missing vs
observed vs estimated consistency, provenance in meta, division = sum of districts, map totals =
Sarawak raw totals, manifest hashes. --production fails closed if only mock data exists.
"""
from __future__ import annotations

import argparse
import hashlib
import math
import sys
from pathlib import Path

from common import SITE_DATA, area_file, month_range, read_json

LON = (109.0, 116.5)
LAT = (0.5, 5.5)
STATUS = {"observed", "estimated", "missing"}
META_KEYS = ["mode", "source", "generatedAt", "coverage", "lastCompleteMonth", "areas", "defaultArea",
             "sensorProducts", "methodVersion"]
CAL_KEYS = ["areaId", "name", "type", "months", "harmonizedCount", "rawModisCount", "rawViirsCount",
            "seasonalMedian", "anomalyScore", "status", "units", "reference"]
CAL_ARRAYS = ["harmonizedCount", "rawModisCount", "rawViirsCount", "seasonalMedian", "anomalyScore", "status"]
HARM_KEYS = ["methodVersion", "method", "chosenOn", "finalTestYear", "metrics", "trainWindow", "validationWindow",
             "testWindow", "methods", "continuity", "notes"]


class Checker:
    def __init__(self, root: Path):
        self.root = root
        self.errors: list[str] = []
        self.warnings: list[str] = []

    def err(self, where: str, msg: str):
        self.errors.append(f"{where}: {msg}")

    def load(self, rel: str):
        p = self.root / rel
        if not p.exists():
            self.err(rel, "file is missing")
            return None
        try:
            return read_json(p)
        except ValueError as e:
            self.err(rel, f"not valid JSON ({e})")
            return None

    def keys(self, rel, obj, keys) -> bool:
        missing = [k for k in keys if k not in obj]
        if missing:
            self.err(rel, f"missing keys {missing}")
        return not missing


def is_count(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v >= 0


def check_meta(c: Checker, production: bool):
    meta = c.load("meta.json")
    if meta is None or not c.keys("meta.json", meta, META_KEYS):
        return None
    if meta["mode"] not in ("real", "mock"):
        c.err("meta.json", f"mode must be 'real' or 'mock', got {meta['mode']!r}")
    if production and meta["mode"] != "real":
        c.err("meta.json", "production check: this folder holds mock data, not real NASA FIRMS data")
    cov = meta["coverage"]
    if not (isinstance(cov, dict) and cov.get("start") and cov.get("end") and cov["start"] <= cov["end"]):
        c.err("meta.json", f"coverage must be {{start, end}} with start <= end, got {cov}")
        return None
    if meta["lastCompleteMonth"] != cov["end"]:
        c.err("meta.json", "lastCompleteMonth must equal coverage.end")
    ids = [a.get("id") for a in meta["areas"]]
    if len(ids) != len(set(ids)):
        c.err("meta.json", "area ids are not unique")
    if meta["defaultArea"] not in ids:
        c.err("meta.json", f"defaultArea {meta['defaultArea']} is not in areas")
    for a in meta["areas"]:
        if not {"id", "name", "type", "verified"} <= set(a):
            c.err("meta.json", f"area {a} needs id, name, type, verified")
        if production and a.get("verified") is not True:
            c.err("meta.json", f"production check: area {a.get('id')} is not verified")
    if not meta["sensorProducts"]:
        c.err("meta.json", "sensorProducts is empty (provenance required)")
    for p in meta["sensorProducts"]:
        if not (p.get("id") and p.get("sensor") in ("MODIS", "VIIRS") and p.get("processing") in ("standard", "nrt")
                and p.get("coverage", {}).get("start") and p.get("coverage", {}).get("end")):
            c.err("meta.json", f"sensorProduct {p.get('id')} needs sensor, processing and coverage")
    return meta


def check_calendar(c: Checker, meta, area) -> dict | None:
    rel = f"calendar/{area_file(area['id'])}"
    cal = c.load(rel)
    if cal is None or not c.keys(rel, cal, CAL_KEYS):
        return None
    if cal["areaId"] != area["id"]:
        c.err(rel, f"areaId {cal['areaId']} does not match file name / meta id {area['id']}")
    months = cal["months"]
    expected = month_range(meta["coverage"]["start"], meta["coverage"]["end"])
    if months != expected:
        c.err(rel, f"months must run consecutively from {expected[0]} to {expected[-1]} "
                   f"(got {len(months)} months, {months[:1]}..{months[-1:]})")
    for k in CAL_ARRAYS:
        if len(cal[k]) != len(months):
            c.err(rel, f"{k} has {len(cal[k])} values but months has {len(months)}")
            return None
    for i, m in enumerate(months):
        st = cal["status"][i]
        h, mo, vi = cal["harmonizedCount"][i], cal["rawModisCount"][i], cal["rawViirsCount"][i]
        for name, v in (("harmonizedCount", h), ("rawModisCount", mo), ("rawViirsCount", vi),
                        ("seasonalMedian", cal["seasonalMedian"][i])):
            if v is not None and not is_count(v):
                c.err(rel, f"{m} {name} = {v} is not a non-negative finite number")
        a = cal["anomalyScore"][i]
        if a is not None and not (isinstance(a, (int, float)) and math.isfinite(a) and -10 <= a <= 10):
            c.err(rel, f"{m} anomalyScore = {a} must be finite and within -10..10")
        if st not in STATUS:
            c.err(rel, f"{m} status {st!r} must be one of {sorted(STATUS)}")
        elif st == "missing" and h is not None:
            c.err(rel, f"{m} is missing but harmonizedCount = {h}")
        elif st == "observed" and (vi is None or h is None or abs(h - vi) > 0.05):
            c.err(rel, f"{m} is observed but harmonizedCount {h} != rawViirsCount {vi}")
        elif st == "estimated" and (vi is not None or mo is None or h is None):
            c.err(rel, f"{m} is estimated, so rawViirsCount must be null and rawModisCount/harmonizedCount set")
    if months and cal["status"][-1] == "missing":
        c.err(rel, "the last month is missing; lastCompleteMonth must be a month with data")
    return cal


def check_totals(c: Checker, meta, cals: dict):
    by_div: dict[str, list[str]] = {}
    for a in meta["areas"]:
        if a["type"] == "district":
            by_div.setdefault(a["division"], []).append(a["id"])
    for div, members in by_div.items():
        if div not in cals or not all(m in cals for m in members):
            continue
        for key in ("rawModisCount", "rawViirsCount"):
            for i, m in enumerate(cals[div]["months"]):
                vals = [cals[d][key][i] for d in members]
                if cals[div][key][i] is None:
                    continue
                if any(v is None for v in vals) or abs(sum(vals) - cals[div][key][i]) > 0.5:
                    c.err(f"calendar/{area_file(div)}", f"{m} {key} {cals[div][key][i]} != sum of its districts {vals}")
                    break
    divs = [a["id"] for a in meta["areas"] if a["type"] == "division" and a["id"] in cals]
    if "sarawak" in cals:
        for key in ("rawModisCount", "rawViirsCount"):
            for i, m in enumerate(cals["sarawak"]["months"]):
                s = cals["sarawak"][key][i]
                part = sum(cals[d][key][i] or 0 for d in divs)
                if s is not None and part > s + 0.5:
                    c.err("calendar/sarawak.json", f"{m} {key} {s} is smaller than the sum of divisions {part}")
                    break


def check_map(c: Checker, meta, sarawak_cal):
    years = sorted({int(m[:4]) for m in month_range(meta["coverage"]["start"], meta["coverage"]["end"])})
    totals: dict[tuple[str, str], int] = {}
    for y in years:
        rel = f"map/{y}.json"
        obj = c.load(rel)
        if obj is None or not c.keys(rel, obj, ["year", "cell", "sourceView", "cells"]):
            continue
        if obj["year"] != y:
            c.err(rel, f"year {obj['year']} does not match the file name")
        for cell in obj["cells"]:
            lon, lat = cell.get("lon"), cell.get("lat")
            if not (isinstance(lon, (int, float)) and isinstance(lat, (int, float))):
                c.err(rel, f"cell {cell} needs numeric lon and lat")
                break
            if not (LON[0] <= lon <= LON[1] and LAT[0] <= lat <= LAT[1]):
                c.err(rel, f"cell lon={lon} lat={lat} is outside Sarawak (are lon and lat swapped?)")
                break
            if cell.get("sensor") not in ("MODIS", "VIIRS") or cell.get("processing") not in ("standard", "nrt") \
                    or not (isinstance(cell.get("month"), int) and 1 <= cell["month"] <= 12) \
                    or not (isinstance(cell.get("count"), int) and cell["count"] > 0):
                c.err(rel, f"bad cell {cell}")
                break
            key = (cell["sensor"], f"{y}-{cell['month']:02d}")
            totals[key] = totals.get(key, 0) + cell["count"]
    if sarawak_cal:
        for i, m in enumerate(sarawak_cal["months"]):
            for sensor, k in (("MODIS", "rawModisCount"), ("VIIRS", "rawViirsCount")):
                expected = sarawak_cal[k][i] or 0
                if totals.get((sensor, m), 0) != expected:
                    c.err(f"map/{m[:4]}.json", f"{sensor} {m} total {totals.get((sensor, m), 0)} != "
                                               f"calendar/sarawak.json {k} {expected}")
                    return


def check_geojson(c: Checker, meta):
    rel = "areas.geojson"
    gj = c.load(rel)
    if gj is None:
        return
    size = (c.root / rel).stat().st_size
    if size > 400_000:
        c.err(rel, f"{size} bytes; must be under 400 KB")
    if gj.get("type") != "FeatureCollection":
        c.err(rel, "must be a FeatureCollection")
        return
    district_ids = {a["id"] for a in meta["areas"] if a["type"] == "district"}
    seen = set()
    for f in gj.get("features", []):
        props = f.get("properties", {})
        if not {"id", "name", "division"} <= set(props):
            c.err(rel, f"feature properties {props} need id, name, division")
            continue
        seen.add(props["id"])
        geom = f.get("geometry") or {}
        if geom.get("type") not in ("Polygon", "MultiPolygon"):
            c.err(rel, f"{props['id']} geometry must be Polygon or MultiPolygon")
            continue
        polys = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
        for poly in polys:
            for ring in poly:
                if len(ring) < 4 or ring[0] != ring[-1]:
                    c.err(rel, f"{props['id']} has an unclosed or too-short ring")
                    break
                bad = [p for p in ring if not (LON[0] <= p[0] <= LON[1] and LAT[0] <= p[1] <= LAT[1])]
                if bad:
                    c.err(rel, f"{props['id']} point {bad[0]} is outside Sarawak (coordinates must be [lon, lat])")
                    break
    if district_ids - seen:
        c.err(rel, f"no polygon for districts {sorted(district_ids - seen)}")


def check_harmonize(c: Checker):
    rel = "harmonize.json"
    h = c.load(rel)
    if h is None or not c.keys(rel, h, HARM_KEYS):
        return
    tr, va, te = h["trainWindow"], h["validationWindow"], h["testWindow"]
    if not (tr[0] <= tr[1] < va[0] <= va[1] < te[0] <= te[1]):
        c.err(rel, f"windows must be ordered train < validation < test without overlap: {tr} {va} {te}")
    if str(h["finalTestYear"]) != te[0][:4]:
        c.err(rel, "finalTestYear must match testWindow")
    for k in ("MAE", "WAPE", "biasPct"):
        v = h["metrics"].get(k, "absent")
        if v == "absent" or (v is not None and not (isinstance(v, (int, float)) and math.isfinite(v))):
            c.err(rel, f"metrics.{k} must be a finite number or null")
    if h["method"] not in [m["id"] for m in h["methods"]]:
        c.err(rel, f"chosen method {h['method']} is not listed in methods")


def check_manifest(c: Checker):
    p = c.root / "manifest.json"
    if not p.exists():
        c.warnings.append("manifest.json: not found (export.py writes it)")
        return
    for entry in read_json(p).get("files", []):
        f = c.root / entry["path"]
        if not f.exists():
            c.err("manifest.json", f"lists {entry['path']}, which does not exist")
        elif hashlib.sha256(f.read_bytes()).hexdigest() != entry["sha256"]:
            c.err("manifest.json", f"{entry['path']} changed after export (sha256 differs)")


def validate_dir(root: Path, production: bool = False) -> Checker:
    c = Checker(root)
    if not root.exists():
        c.err(str(root), "folder does not exist")
        return c
    meta = check_meta(c, production)
    if meta is None:
        return c
    cals = {}
    for area in meta["areas"]:
        cal = check_calendar(c, meta, area)
        if cal:
            cals[area["id"]] = cal
    check_totals(c, meta, cals)
    check_map(c, meta, cals.get("sarawak"))
    check_geojson(c, meta)
    check_harmonize(c)
    check_manifest(c)
    return c


def report_and_exit(root: Path, production: bool) -> None:
    c = validate_dir(root, production)
    total = sum(p.stat().st_size for p in root.rglob("*") if p.is_file()) if root.exists() else 0
    for w in c.warnings:
        print(f"WARNING {w}")
    if c.errors:
        print(f"FAILED: {len(c.errors)} problem(s) in {root}")
        for e in c.errors[:50]:
            print(f"  - {e}")
        if len(c.errors) > 50:
            print(f"  ... and {len(c.errors) - 50} more")
        sys.exit(1)
    print(f"OK: {root} matches the data contract ({total / 1e6:.2f} MB total)")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dir", type=Path)
    parser.add_argument("--mock", action="store_true", help="validate site/data/mock")
    parser.add_argument("--production", action="store_true", help="fail unless the folder holds verified real data")
    args = parser.parse_args()
    root = args.dir or (SITE_DATA / "mock" if args.mock else SITE_DATA)
    report_and_exit(root, args.production)


if __name__ == "__main__":
    main()

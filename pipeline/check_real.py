"""Independent checks of the REAL pipeline output (not mock data).

Each check re-derives a result a different way from how the pipeline did it, so a bug in the
pipeline cannot also hide itself here:

  1. Download   - re-asks NASA FIRMS for random days and compares with what we saved.
  2. Districts  - re-tests random points against the district polygons one by one (no spatial index).
  3. Counts     - recounts hotspots per area and month straight from the clean table and compares
                  with every number in site/data/calendar/*.json.
  4. Harmonized - observed months must equal real VIIRS; estimated months only where VIIRS is absent.
  5. Busiest months - printed so you can compare them with news of haze years.

Run:  pipeline/.venv/Scripts/python pipeline/check_real.py            (all checks, uses ~20 FIRMS calls)
      pipeline/.venv/Scripts/python pipeline/check_real.py --offline  (skip check 1)
"""
from __future__ import annotations

import argparse
import csv
import glob
import io
import json
import os
import random
from datetime import date, timedelta

import pandas as pd
from shapely.geometry import Point, shape

from common import BBOX, RAW, SITE_DATA, WORK, PIPELINE, area_file, load_district_table, slug

FIRMS = "https://firms.modaps.eosdis.nasa.gov"
failures: list[str] = []


def result(name: str, ok: bool, detail: str) -> None:
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}: {detail}")
    if not ok:
        failures.append(name)


def check_download(days_per_source: int, seed: int) -> None:
    import requests
    from dotenv import load_dotenv

    print("\n1. Download matches NASA FIRMS (fresh request for random days)")
    load_dotenv(PIPELINE / ".env")
    key = os.environ.get("FIRMS_MAP_KEY", "").strip()
    if not key:
        result("download", False, "FIRMS_MAP_KEY missing from pipeline/.env")
        return
    rng = random.Random(seed)
    bbox = ",".join(str(v) for v in BBOX)
    for folder in sorted(glob.glob(str(RAW / "firms" / "*"))):
        source = os.path.basename(folder)
        prog = json.load(open(os.path.join(folder, "_progress.json")))
        first, after = date.fromisoformat(prog["start"]), date.fromisoformat(prog["next"])
        saved = pd.concat([pd.read_csv(f, dtype=str) for f in glob.glob(os.path.join(folder, "*.csv"))])
        for _ in range(days_per_source):
            day = first + timedelta(days=rng.randrange((after - first).days))
            text = requests.get(f"{FIRMS}/api/area/csv/{key}/{source}/{bbox}/1/{day}", timeout=90).text.strip()
            if not text.startswith("latitude"):
                result(f"{source} {day}", False, f"FIRMS answered: {text[:80].replace(key, '<KEY>')}")
                continue
            fresh = pd.read_csv(io.StringIO(text), dtype=str)
            mine = saved[saved["acq_date"] == str(day)]
            fkeys = set(zip(fresh.latitude, fresh.longitude, fresh.acq_time.str.zfill(4)))
            mkeys = set(zip(mine.latitude, mine.longitude, mine.acq_time.str.zfill(4)))
            result(f"{source} {day}", fkeys == mkeys,
                   f"whole download box (all of Sarawak plus borders): NASA has {len(fresh)} rows, we saved {len(mine)}"
                   + ("" if fkeys == mkeys else f" ({len(fkeys - mkeys)} missing, {len(mkeys - fkeys)} extra)"))


def check_districts(clean: pd.DataFrame, sample: int, seed: int) -> None:
    print(f"\n2. District assignment (re-tested {sample} random hotspots, polygon by polygon)")
    table = {r["district_name"].lower(): r["district_id"] for r in load_district_table()}
    feats = json.load(open(RAW / "boundaries" / "sarawak_districts.geojson"))["features"]
    polys = [(table.get(f["properties"]["shapeName"].lower(), f"dist:{slug(f['properties']['shapeName'])}"),
              shape(f["geometry"])) for f in feats]
    rows = clean.sample(min(sample, len(clean)), random_state=seed)
    wrong = []
    for r in rows.itertuples():
        pt = Point(r.lon, r.lat)
        inside = [aid for aid, poly in polys if poly.contains(pt)]
        expected = inside[0] if inside else None
        if expected is not None and expected != r.areaId:
            wrong.append(f"{r.lat},{r.lon} saved as {r.areaId}, polygon says {expected}")
    result("districts", not wrong, f"{len(rows) - len(wrong)} of {len(rows)} match"
           + ("" if not wrong else "; e.g. " + wrong[0]))
    print("     (points exactly on a border or the coast may sit in no polygon; those are skipped)")


def check_counts(clean: pd.DataFrame) -> None:
    print("\n3. Calendar numbers equal a fresh recount of the clean table")
    clean = clean.assign(month=clean["date"].dt.strftime("%Y-%m"))
    meta = json.load(open(SITE_DATA / "meta.json"))
    bad, compared = [], 0
    for area in meta["areas"]:
        aid = area["id"]
        if area["type"] == "sarawak":
            rows = clean
        elif area["type"] == "division":
            rows = clean[clean["divisionId"] == aid]
        else:
            rows = clean[clean["areaId"] == aid]
        counts = rows.groupby(["sensor", "month"]).size()
        cal = json.load(open(SITE_DATA / "calendar" / area_file(aid)))
        for sensor, field in (("MODIS", "rawModisCount"), ("VIIRS", "rawViirsCount")):
            for month, value in zip(cal["months"], cal[field]):
                if value is None:
                    continue
                compared += 1
                mine = int(counts.get((sensor, month), 0))
                if mine != value:
                    bad.append(f"{aid} {month} {sensor}: calendar {value}, recount {mine}")
    result("counts", not bad, f"{compared - len(bad)} of {compared} area-month-sensor numbers match"
           + ("" if not bad else "; e.g. " + bad[0]))


def check_harmonized() -> None:
    print("\n4. Harmonized series")
    bad = []
    for path in glob.glob(str(SITE_DATA / "calendar" / "*.json")):
        cal = json.load(open(path))
        for m, st, h, v, mo in zip(cal["months"], cal["status"], cal["harmonizedCount"],
                                   cal["rawViirsCount"], cal["rawModisCount"]):
            if st == "observed" and h != v:
                bad.append(f"{cal['areaId']} {m}: observed but harmonized {h} != VIIRS {v}")
            if st == "estimated" and (v is not None or mo is None):
                bad.append(f"{cal['areaId']} {m}: estimated although VIIRS={v}, MODIS={mo}")
            if st == "missing" and h is not None:
                bad.append(f"{cal['areaId']} {m}: missing but has value {h}")
    result("harmonized", not bad, "observed = real VIIRS, estimates only before VIIRS, missing has no number"
           if not bad else bad[0])
    rep = json.load(open(SITE_DATA / "harmonize.json"))
    print(f"     method {rep['method']}, test year {rep['finalTestYear']}: "
          + ", ".join(f"{k} {v}" for k, v in rep["metrics"].items() if k in ("WAPE", "MAE", "biasPct")))


def show_busiest() -> None:
    print("\n5. Busiest months in Sarawak (compare with news of haze years)")
    cal = json.load(open(SITE_DATA / "calendar" / "sarawak.json"))
    rows = [(h, m, s) for m, h, s in zip(cal["months"], cal["harmonizedCount"], cal["status"]) if h is not None]
    for h, m, s in sorted(rows, reverse=True)[:10]:
        print(f"     {m}  {h:>8,.0f}  ({s})")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--offline", action="store_true", help="skip the FIRMS re-download check")
    ap.add_argument("--days", type=int, default=4, help="random days re-checked per FIRMS source")
    ap.add_argument("--sample", type=int, default=3000, help="hotspots re-tested against polygons")
    ap.add_argument("--seed", type=int, default=None, help="fix the random picks to repeat a run")
    args = ap.parse_args()
    seed = args.seed if args.seed is not None else random.randrange(10**6)
    print(f"Random seed {seed} (pass --seed {seed} to repeat exactly)")

    meta = json.load(open(SITE_DATA / "meta.json"))
    if meta.get("mode") != "real":
        raise SystemExit("site/data is not real data (meta.mode != 'real'). Run the pipeline first.")
    clean = pd.read_parquet(WORK / "hotspots_clean.parquet")

    if not args.offline:
        check_download(args.days, seed)
    check_districts(clean, args.sample, seed)
    check_counts(clean)
    check_harmonized()
    show_busiest()
    print("\nALL CHECKS PASSED" if not failures else f"\nFAILED: {', '.join(failures)}")
    raise SystemExit(1 if failures else 0)


if __name__ == "__main__":
    main()

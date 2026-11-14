"""Demo data for B and C while real data is pending. Owner A.

    python pipeline/make_mock.py

Writes site/data/mock/ with EXACTLY the same shapes as the real export, because it runs the
real clean -> aggregate -> harmonize -> export code on synthetic FIRMS-like rows.
Every file is labelled: meta.mode = "mock" and meta.source says it is synthetic.
These numbers are NOT NASA observations and must never be shown as real data.

Synthetic world: Sarawak as its bounding box; 3 divisions (Mukah, Sibu, Bintulu) with 2
rectangular districts each, roughly where they are. Fires peak July to September and in
El Nino-like years 2002, 2006, 2015, 2019, 2023. MODIS from 2000-11, VIIRS S-NPP from 2012-01-20,
standard processing to 2026-06-30, near-real-time to 2026-11-10.
"""
from __future__ import annotations

import shutil

import numpy as np
import shapely
import pandas as pd
from shapely.geometry import box

from aggregate import monthly_counts
from clean import clean_observations, combined_coverage
from common import BBOX, SITE_DATA, month_first_last, month_range, run_main
from export import build_outputs, write_outputs
from harmonize import harmonize
from validate import report_and_exit

SEED = 2026
OUT = SITE_DATA / "mock"
LABEL = "DEMO DATA: synthetic hotspots from pipeline/make_mock.py, not NASA FIRMS observations"

DISTRICTS = [
    # id, name, division id, division name, lon_min, lat_min, lon_max, lat_max, weight
    ("dist:mukah", "Mukah", "div:mukah", "Mukah", 112.0, 2.5, 112.6, 3.0, 1.6),
    ("dist:dalat", "Dalat", "div:mukah", "Mukah", 111.5, 2.5, 112.0, 3.0, 1.3),
    ("dist:sibu", "Sibu", "div:sibu", "Sibu", 111.7, 2.0, 112.2, 2.5, 0.8),
    ("dist:kanowit", "Kanowit", "div:sibu", "Sibu", 112.2, 2.0, 112.7, 2.5, 0.5),
    ("dist:bintulu", "Bintulu", "div:bintulu", "Bintulu", 112.8, 2.9, 113.4, 3.4, 0.9),
    ("dist:tatau", "Tatau", "div:bintulu", "Bintulu", 112.6, 2.5, 113.2, 2.9, 0.6),
]
SEASON = [0.3, 0.3, 0.4, 0.5, 0.7, 1.0, 2.0, 3.2, 2.6, 1.2, 0.4, 0.3]
DRY_YEARS = {2002: 1.6, 2006: 1.8, 2009: 1.4, 2015: 3.0, 2019: 2.6, 2023: 1.9}
TRUE_RATIO = [3.0, 3.0, 3.2, 3.4, 3.6, 3.8, 4.0, 4.2, 4.0, 3.6, 3.2, 3.0]  # VIIRS per MODIS by month

SOURCE_COV = {
    "MODIS_SP": {"start": "2000-11-01", "end": "2026-06-30"},
    "MODIS_NRT": {"start": "2026-07-01", "end": "2026-11-10"},
    "VIIRS_SNPP_SP": {"start": "2012-01-20", "end": "2026-06-30"},
    "VIIRS_SNPP_NRT": {"start": "2026-07-01", "end": "2026-11-10"},
}


def synth_rows(rng, sensor: str) -> dict[str, list[dict]]:
    sp, nrt = ("MODIS_SP", "MODIS_NRT") if sensor == "MODIS" else ("VIIRS_SNPP_SP", "VIIRS_SNPP_NRT")
    start, end = pd.Timestamp(SOURCE_COV[sp]["start"]), pd.Timestamp(SOURCE_COV[nrt]["end"])
    sp_end = pd.Timestamp(SOURCE_COV[sp]["end"])
    rows = {sp: [], nrt: []}
    units = [(d[4:8], d[8]) for d in DISTRICTS] + [((BBOX[0], BBOX[1], BBOX[2], BBOX[3]), 0.7)]
    for month in month_range("2000-11", "2026-11"):
        y, m = int(month[:4]), int(month[5:7])
        first, last = month_first_last(month)
        lo, hi = max(pd.Timestamp(first), start), min(pd.Timestamp(last), end)
        if lo > hi:
            continue
        frac = ((hi - lo).days + 1) / ((pd.Timestamp(last) - pd.Timestamp(first)).days + 1)
        for (x0, y0, x1, y1), weight in units:
            viirs_mean = 10.0 * weight * SEASON[m - 1] * DRY_YEARS.get(y, 1.0) * rng.uniform(0.7, 1.3)
            mean = viirs_mean if sensor == "VIIRS" else viirs_mean / TRUE_RATIO[m - 1]
            if sensor == "MODIS" and (y, m) < (2002, 7):
                mean *= 0.5  # Terra only before Aqua
            n = rng.poisson(mean * frac)
            cx, cy = rng.uniform(x0, x1), rng.uniform(y0, y1)  # one hot cluster per unit-month
            for _ in range(n):
                day = lo + pd.Timedelta(days=int(rng.integers(0, (hi - lo).days + 1)))
                if rng.random() < 0.6:
                    lon, lat = np.clip(rng.normal(cx, 0.06), x0, x1), np.clip(rng.normal(cy, 0.06), y0, y1)
                else:
                    lon, lat = rng.uniform(x0, x1), rng.uniform(y0, y1)
                src = sp if day <= sp_end else nrt
                if sensor == "MODIS":
                    sat = "T" if (y, m) < (2002, 7) or rng.random() < 0.5 else "A"
                    conf = str(int(rng.integers(10, 101)))
                else:
                    sat, conf = "N", str(rng.choice(["l", "n", "n", "n", "h"]))
                row = {"latitude": f"{lat:.5f}", "longitude": f"{lon:.5f}", "acq_date": day.strftime("%Y-%m-%d"),
                       "acq_time": f"{int(rng.integers(0, 24)):02d}{int(rng.integers(0, 60)):02d}",
                       "satellite": sat, "confidence": conf, "frp": f"{rng.gamma(2, 8):.1f}",
                       "version": "6.1" if sensor == "MODIS" else "2.0", "daynight": "D"}
                if src == sp:
                    row["type"] = "0" if rng.random() < 0.97 else "2"
                rows[src].append(row)
    return rows


def build_files(seed: int = SEED):
    """Synthetic rows through the real pipeline. Returns (files, audit, report)."""
    rng = np.random.default_rng(seed)
    raw = {}
    for sensor in ("MODIS", "VIIRS"):
        for src, rows in synth_rows(rng, sensor).items():
            raw[src] = pd.DataFrame(rows, dtype=str)
    table = [{"district_name": d[1], "district_id": d[0], "division_id": d[2], "division_name": d[3],
              "verified": True, "source": "synthetic"} for d in DISTRICTS]
    districts = [{"id": d[0], "name": d[1], "division": d[2], "geometry": box(*d[4:8])} for d in DISTRICTS]
    adm1 = box(*BBOX)

    clean, audit = clean_observations(raw, SOURCE_COV, adm1, districts)
    monthly = monthly_counts(clean, combined_coverage(SOURCE_COV), table, "2001-01")
    harmonized, report = harmonize(monthly, table)
    files = build_outputs(harmonized=harmonized, report=report, clean=clean, source_cov=SOURCE_COV, table=table,
                          district_features=districts, mode="mock", allow_unverified=False, source_label=LABEL,
                          outline=shapely.union_all([d["geometry"] for d in districts]).buffer(0.05))
    return files, audit, report


def main():
    files, audit, report = build_files()
    # Clear old mock files (contents only; Windows may hold the folder itself open).
    if OUT.exists():
        for child in OUT.iterdir():
            shutil.rmtree(child) if child.is_dir() else child.unlink()
    write_outputs(files, OUT)
    print(f"Mock rows kept: MODIS {audit['MODIS']['kept']}, VIIRS {audit['VIIRS']['kept']}")
    print(f"Mock method chosen: {report['methodName']}, test WAPE {report['metrics']['WAPE']}")
    print(f"Wrote {len(files) + 1} files to {OUT}")
    report_and_exit(OUT, production=False)


if __name__ == "__main__":
    run_main(main)

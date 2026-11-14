"""Shared paths and helpers for the Bara data pipeline (Owner A).

Every pipeline script imports from here so that paths, area ids, month handling
and JSON writing behave the same way everywhere.
"""
from __future__ import annotations

import csv
import json
import math
import re
import sys
from datetime import date, timedelta
from pathlib import Path

PIPELINE = Path(__file__).resolve().parent
REPO = PIPELINE.parent
RAW = PIPELINE / "raw"
WORK = PIPELINE / "work"
SITE_DATA = REPO / "site" / "data"
DOCS = REPO / "docs"

# Sarawak bounding box used for FIRMS area requests: lon_min, lat_min, lon_max, lat_max.
BBOX = (109.6, 0.8, 115.7, 5.1)

# FIRMS sources we use. MODIS = Terra + Aqua (Collection 6.1); VIIRS = Suomi NPP 375 m only,
# so the VIIRS series stays one instrument from 2012 onwards.
SOURCES = {
    "MODIS_SP": {"sensor": "MODIS", "processing": "standard", "start": "2000-11-01"},
    "MODIS_NRT": {"sensor": "MODIS", "processing": "nrt", "start": None},
    "VIIRS_SNPP_SP": {"sensor": "VIIRS", "processing": "standard", "start": "2012-01-20"},
    "VIIRS_SNPP_NRT": {"sensor": "VIIRS", "processing": "nrt", "start": None},
}
SENSORS = ("MODIS", "VIIRS")

UNITS = "VIIRS-equivalent detection-count estimate"
OTHER_UNIT = "dist:_other"  # points inside Sarawak that are not in a listed district


class PipelineError(Exception):
    """A problem the user must fix (missing files, bad config). Printed without a traceback."""


def run_main(main) -> None:
    """Run a script's main() and turn PipelineError into a clear message and exit code 1."""
    try:
        main()
    except PipelineError as err:
        print(f"\nERROR: {err}", file=sys.stderr)
        sys.exit(1)


# ---------- ids and names ----------

def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")


def area_file(area_id: str) -> str:
    return area_id.replace(":", "_") + ".json"


# ---------- months and dates ----------

def parse_date(text: str) -> date:
    return date.fromisoformat(str(text)[:10])


def month_range(start: str, end: str) -> list[str]:
    y, m = map(int, start.split("-"))
    ey, em = map(int, end.split("-"))
    out = []
    while (y, m) <= (ey, em):
        out.append(f"{y:04d}-{m:02d}")
        m += 1
        if m == 13:
            y, m = y + 1, 1
    return out


def month_first_last(month: str) -> tuple[date, date]:
    y, m = map(int, month.split("-"))
    first = date(y, m, 1)
    nxt = date(y + (m == 12), 1 if m == 12 else m + 1, 1)
    return first, nxt - timedelta(days=1)


def month_complete(cov: dict | None, month: str) -> bool:
    """True when a sensor's coverage {start, end} spans every day of the month."""
    if not cov or not cov.get("start") or not cov.get("end"):
        return False
    first, last = month_first_last(month)
    return parse_date(cov["start"]) <= first and parse_date(cov["end"]) >= last


def last_complete_month(cov: dict) -> str:
    end = parse_date(cov["end"])
    first, last = month_first_last(f"{end.year:04d}-{end.month:02d}")
    if end >= last:
        return f"{end.year:04d}-{end.month:02d}"
    prev = first - timedelta(days=1)
    return f"{prev.year:04d}-{prev.month:02d}"


# ---------- district table ----------

def load_district_table(path: Path | None = None) -> list[dict]:
    """Read districts.csv: which geoBoundaries district belongs to which division, and whether
    that mapping has been checked against an official Sarawak list."""
    path = path or (PIPELINE / "districts.csv")
    if not path.exists():
        raise PipelineError(f"{path} is missing. It maps districts to divisions.")
    rows = []
    with path.open(newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(r for r in fh if not r.startswith("#")):
            rows.append({
                "district_name": row["district_name"].strip(),
                "district_id": row["district_id"].strip(),
                "division_id": row["division_id"].strip(),
                "division_name": row["division_name"].strip(),
                "verified": row["verified"].strip().lower() in ("yes", "true", "1"),
                "source": row.get("source", "").strip(),
            })
    if not rows:
        raise PipelineError(f"{path} has no district rows.")
    return rows


# ---------- JSON ----------

def clean_number(value, digits: int | None = None):
    """NaN/None -> None (JSON null); numpy numbers -> Python numbers; optional rounding."""
    if value is None:
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return value
    if math.isnan(f) or math.isinf(f):
        return None
    if digits is None:
        return f
    if digits == 0:
        return int(round(f))
    return round(f, digits)


def write_json(path: Path, obj, pretty: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(obj, allow_nan=False, ensure_ascii=False,
                      indent=2 if pretty else None,
                      separators=None if pretty else (",", ":"))
    # Always LF: manifest.json stores sha256 of these bytes, so they must be identical on Windows,
    # in git and on the Linux machine that checks and deploys the site.
    path.write_text(text + "\n", encoding="utf-8", newline="\n")


def read_json(path: Path):
    def reject(name):
        raise ValueError(f"{path} contains {name}, which is not valid JSON")
    return json.loads(path.read_text(encoding="utf-8"), parse_constant=reject)

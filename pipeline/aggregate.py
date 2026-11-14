"""A2: monthly hotspot counts per area and sensor. Owner A.

    python pipeline/aggregate.py [--start 2001-01]

Areas: sarawak, every division and district in districts.csv, plus one internal unit
"dist:_other" for points inside Sarawak that are not in a listed district (kept so the
Sarawak total is complete; never exported as an area).

Missing vs zero:
  null  the sensor did not cover every day of that month (not launched yet, archive gap,
        or the current partial month). Detections in such months are not counted.
  0     the sensor covered the whole month and saw nothing in that area.

Output: work/monthly.parquet with area_id, area_type, parent, name, month, modis, viirs
"""
from __future__ import annotations

import argparse

import numpy as np
import pandas as pd

from common import (OTHER_UNIT, SENSORS, WORK, PipelineError, last_complete_month, load_district_table,
                    month_complete, month_range, read_json, run_main)


def area_catalogue(table: list[dict]) -> pd.DataFrame:
    rows = [{"area_id": "sarawak", "area_type": "sarawak", "parent": None, "name": "Sarawak"}]
    divisions = {}
    for r in table:
        divisions.setdefault(r["division_id"], r["division_name"])
    for div_id, name in divisions.items():
        rows.append({"area_id": div_id, "area_type": "division", "parent": "sarawak", "name": f"{name} Division"})
    for r in table:
        rows.append({"area_id": r["district_id"], "area_type": "district", "parent": r["division_id"],
                     "name": f"{r['district_name']} District"})
    rows.append({"area_id": OTHER_UNIT, "area_type": "other", "parent": "sarawak", "name": "Other Sarawak"})
    return pd.DataFrame(rows)


def unit_counts(clean: pd.DataFrame, coverage: dict, table: list[dict], months: list[str]) -> pd.DataFrame:
    """Counts for the base units (listed districts + other). Columns: area_id, month, modis, viirs."""
    listed = {r["district_id"] for r in table}
    units = [r["district_id"] for r in table] + [OTHER_UNIT]
    df = clean[["date", "sensor", "areaId"]].copy()
    df["month"] = pd.to_datetime(df["date"]).dt.strftime("%Y-%m")
    df["unit"] = df["areaId"].where(df["areaId"].isin(listed), OTHER_UNIT)
    counts = df.groupby(["unit", "month", "sensor"]).size()

    idx = pd.MultiIndex.from_product([units, months], names=["area_id", "month"])
    out = pd.DataFrame(index=idx).reset_index()
    for sensor in SENSORS:
        col = sensor.lower()
        s = counts.xs(sensor, level="sensor") if sensor in counts.index.get_level_values("sensor") else pd.Series(dtype=float)
        vals = s.reindex(pd.MultiIndex.from_frame(out[["area_id", "month"]])).fillna(0).to_numpy(dtype=float, copy=True)
        available = np.array([month_complete(coverage.get(sensor), m) for m in out["month"]])
        vals[~available] = np.nan
        out[col] = vals
    return out


def rollup(units: pd.DataFrame, table: list[dict], value_cols: list[str]) -> pd.DataFrame:
    """Sum base units into districts, divisions and Sarawak. NaN stays NaN (all units share a sensor's
    availability, so a month is either fully available or fully missing)."""
    catalogue = area_catalogue(table)
    parts = []
    base = units.merge(catalogue[["area_id", "area_type", "parent", "name"]], on="area_id", how="left")
    parts.append(base)
    district_div = {r["district_id"]: r["division_id"] for r in table}
    for div_id in dict.fromkeys(district_div.values()):
        members = [d for d, v in district_div.items() if v == div_id]
        sub = units[units["area_id"].isin(members)].groupby("month")[value_cols].sum(min_count=1).reset_index()
        sub["area_id"] = div_id
        parts.append(sub)
    sub = units.groupby("month")[value_cols].sum(min_count=1).reset_index()
    sub["area_id"] = "sarawak"
    parts.append(sub)
    out = pd.concat(parts, ignore_index=True)
    out = out.drop(columns=["area_type", "parent", "name"]).merge(catalogue, on="area_id", how="left")
    return out[["area_id", "area_type", "parent", "name", "month"] + value_cols]


def monthly_counts(clean: pd.DataFrame, coverage: dict, table: list[dict], start: str = "2001-01",
                   end: str | None = None) -> pd.DataFrame:
    if not coverage:
        raise PipelineError("No sensor coverage found; run clean.py first.")
    if end is None:
        end = max(last_complete_month(c) for c in coverage.values())
    months = month_range(start, end)
    return rollup(unit_counts(clean, coverage, table, months), table, ["modis", "viirs"])


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--start", default="2001-01", help="first calendar month (default 2001-01)")
    args = parser.parse_args()
    path = WORK / "hotspots_clean.parquet"
    if not path.exists():
        raise PipelineError(f"{path} is missing. Run python pipeline/clean.py first.")
    clean = pd.read_parquet(path)
    coverage = read_json(WORK / "coverage.json")["sensors"]
    monthly = monthly_counts(clean, coverage, load_district_table(), args.start)
    monthly.to_parquet(WORK / "monthly.parquet", index=False)

    sar = monthly[monthly["area_id"] == "sarawak"].copy()
    sar["year"] = sar["month"].str[:4]
    annual = sar.groupby("year")[["modis", "viirs"]].sum(min_count=1)
    print("Sarawak annual raw totals (null = sensor not covering the whole year):")
    print(annual.to_string())
    print(f"Wrote {WORK / 'monthly.parquet'} ({monthly['area_id'].nunique()} areas, "
          f"{monthly['month'].nunique()} months)")


if __name__ == "__main__":
    run_main(main)

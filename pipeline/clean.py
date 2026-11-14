"""A1: clean authentic FIRMS observations into one normalized table. Owner A.

    python pipeline/clean.py

Reads only pipeline/raw/ (written by acquire.py); never downloads anything.

Quality rules, applied in this order (each is logged per sensor in work/audit_clean.json):
  1. missing_fields       drop rows without latitude, longitude, acq_date, acq_time or satellite
  2. nrt_replaced_by_sp   drop near-real-time rows on dates that standard processing covers
  3. non_vegetation_type  only where the product has a documented 'type' column:
                          keep type 0 (presumed vegetation fire); drop 1 volcano, 2 other static
                          land source, 3 offshore. NRT products have no type column, so their rows
                          are kept. This does NOT remove every industrial heat source.
  4. low_confidence       MODIS: numeric confidence 0-100, keep >= 30 (below 30 is the documented
                          "low" class). VIIRS: categorical, keep n/nominal and h/high, drop l/low.
  5. exact_duplicates     same sensor, satellite, acq_date, acq_time, latitude, longitude.
                          Nearby MODIS and VIIRS detections are NOT treated as duplicates.
  6. outside_sarawak      point not inside the geoBoundaries Sarawak ADM1 polygon

Output
  work/hotspots_clean.parquet  date, time, lat, lon, sensor, satellite, confidence, frp,
                               processing, sourceProduct, version, areaId, divisionId
  work/coverage.json           complete date range per sensor (SP + NRT)
  work/audit_clean.json        rows kept and removed per step and sensor
"""
from __future__ import annotations

import glob
from datetime import timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import shapely
from shapely.geometry import shape

from common import (RAW, SENSORS, SOURCES, WORK, PipelineError, load_district_table, parse_date,
                    read_json, run_main, slug, write_json)

REQUIRED = ["latitude", "longitude", "acq_date", "acq_time", "satellite"]
STEPS = ["missing_fields", "nrt_replaced_by_sp", "non_vegetation_type", "low_confidence",
         "exact_duplicates", "outside_sarawak"]
SATELLITE_NAMES = {"T": "Terra", "A": "Aqua", "N": "S-NPP", "TERRA": "Terra", "AQUA": "Aqua",
                   "SUOMI NPP": "S-NPP", "NPP": "S-NPP", "S-NPP": "S-NPP"}
MODIS_MIN_CONFIDENCE = 30
VIIRS_KEEP_CONFIDENCE = {"n", "h", "nominal", "high"}


# ---------- loading ----------

def read_source_folder(source: str) -> pd.DataFrame:
    files = sorted(glob.glob(str(RAW / "firms" / source / "*.csv")))
    frames = [pd.read_csv(f, dtype=str, keep_default_na=False, na_values=[""]) for f in files]
    frames = [f for f in frames if len(f)]
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


def load_coverage(raw: dict[str, pd.DataFrame]) -> dict[str, dict]:
    """Coverage per source from the acquire manifest; inferred from data (with a warning) if absent."""
    manifest_path = RAW / "manifest.json"
    datasets = read_json(manifest_path).get("datasets", {}) if manifest_path.exists() else {}
    cov = {}
    for source, df in raw.items():
        info = datasets.get(source, {})
        if info.get("coverage_start") and info.get("coverage_end"):
            cov[source] = {"start": info["coverage_start"], "end": info["coverage_end"]}
        elif len(df):
            dates = pd.to_datetime(df["acq_date"], errors="coerce").dropna()
            cov[source] = {"start": dates.min().date().isoformat(), "end": dates.max().date().isoformat()}
            print(f"WARNING: no coverage for {source} in raw/manifest.json; using first and last detection "
                  f"dates ({cov[source]['start']} to {cov[source]['end']}). Quiet days at the ends are lost.")
    return cov


def load_geography(table: list[dict]):
    adm1_path = RAW / "boundaries" / "sarawak_adm1.geojson"
    adm2_path = RAW / "boundaries" / "sarawak_districts.geojson"
    for p in (adm1_path, adm2_path):
        if not p.exists():
            raise PipelineError(f"{p} is missing. Run: python pipeline/acquire.py --only boundaries")
    adm1 = shape(read_json(adm1_path)["features"][0]["geometry"])
    lookup = {r["district_name"].lower(): r for r in table}
    districts = []
    for feat in read_json(adm2_path)["features"]:
        name = feat["properties"]["shapeName"]
        row = lookup.get(name.lower())
        districts.append({
            "id": row["district_id"] if row else f"dist:{slug(name)}",
            "name": name,
            "division": row["division_id"] if row else None,
            "geometry": shape(feat["geometry"]),
        })
    found = {d["name"].lower() for d in districts}
    missing = [r["district_name"] for r in table if r["district_name"].lower() not in found]
    if missing:
        print(f"WARNING: districts.csv names not found in geoBoundaries: {', '.join(missing)}. "
              f"See raw/boundaries/district_names.txt for the exact names.")
    return adm1, districts


# ---------- cleaning (pure function, used by tests and make_mock.py) ----------

def combined_coverage(source_cov: dict[str, dict]) -> dict[str, dict]:
    """Per sensor: SP start to the later of SP end and NRT end. Warn if SP and NRT leave a gap."""
    out = {}
    for sensor in SENSORS:
        parts = sorted((parse_date(c["start"]), parse_date(c["end"]))
                       for src, c in source_cov.items() if SOURCES[src]["sensor"] == sensor)
        if not parts:
            continue
        start, end = parts[0]
        for s, e in parts[1:]:
            if s > end + timedelta(days=1):
                print(f"WARNING: {sensor} coverage gap from {end + timedelta(days=1)} to {s - timedelta(days=1)}; "
                      f"using coverage up to {end} only.")
                break
            end = max(end, e)
        out[sensor] = {"start": start.isoformat(), "end": end.isoformat()}
    return out


def clean_observations(raw: dict[str, pd.DataFrame], source_cov: dict[str, dict], adm1, districts: list[dict]):
    """raw: {SOURCE: DataFrame of FIRMS CSV columns as strings}. Returns (clean DataFrame, audit dict)."""
    audit = {s: {"loaded": 0, **{k: 0 for k in STEPS}, "kept": 0} for s in SENSORS}
    frames = []
    for source, df in raw.items():
        if df is None or not len(df):
            continue
        df = df.copy()
        for col in REQUIRED + ["confidence", "frp", "type", "version"]:
            if col not in df.columns:
                df[col] = np.nan
        df["source"] = source
        df["sensor"] = SOURCES[source]["sensor"]
        df["processing"] = SOURCES[source]["processing"]
        frames.append(df)
    if not frames:
        return empty_clean(), audit
    df = pd.concat(frames, ignore_index=True)
    for s in SENSORS:
        audit[s]["loaded"] = int((df["sensor"] == s).sum())

    def drop(mask, step):
        nonlocal df
        mask = mask.fillna(False).astype(bool)
        for s in SENSORS:
            audit[s][step] += int((mask & (df["sensor"] == s)).sum())
        df = df[~mask].copy()

    # 1. missing or unparsable required fields
    df["lat"] = pd.to_numeric(df["latitude"], errors="coerce")
    df["lon"] = pd.to_numeric(df["longitude"], errors="coerce")
    df["date"] = pd.to_datetime(df["acq_date"], errors="coerce", format="%Y-%m-%d")
    df["time"] = df["acq_time"].astype("string").str.strip().str.zfill(4)
    sat = df["satellite"].astype("string").str.strip().str.upper()
    df["satellite"] = sat.map(lambda v: SATELLITE_NAMES.get(v, v) if isinstance(v, str) else v)
    bad = df[["lat", "lon", "date"]].isna().any(axis=1) | df["time"].isna() | df["satellite"].isna() \
        | (df["satellite"].astype("string") == "")
    drop(bad, "missing_fields")

    # 2. prefer standard processing: drop NRT rows on dates the SP source covers
    nrt_dupe = pd.Series(False, index=df.index)
    for sensor in SENSORS:
        sp = [s for s, v in SOURCES.items() if v["sensor"] == sensor and v["processing"] == "standard"][0]
        if sp in source_cov:
            sp_end = pd.Timestamp(source_cov[sp]["end"])
            nrt_dupe |= (df["sensor"] == sensor) & (df["processing"] == "nrt") & (df["date"] <= sp_end)
    drop(nrt_dupe, "nrt_replaced_by_sp")

    # 3. documented type field only
    type_num = pd.to_numeric(df["type"], errors="coerce")
    drop(type_num.notna() & (type_num != 0), "non_vegetation_type")

    # 4. product-specific confidence
    conf = df["confidence"].astype("string").str.strip().str.lower()
    modis_conf = pd.to_numeric(conf, errors="coerce")
    low = ((df["sensor"] == "MODIS") & ~(modis_conf >= MODIS_MIN_CONFIDENCE)) | \
          ((df["sensor"] == "VIIRS") & ~conf.isin(VIIRS_KEEP_CONFIDENCE))
    drop(low, "low_confidence")

    # 5. exact duplicates on a documented key
    key = ["sensor", "satellite", "date", "time", "lat", "lon"]
    drop(df.duplicated(subset=key, keep="first"), "exact_duplicates")

    # 6. clip to Sarawak
    inside = shapely.contains_xy(adm1, df["lon"].to_numpy(), df["lat"].to_numpy()) if len(df) else np.array([], bool)
    drop(pd.Series(~inside, index=df.index), "outside_sarawak")
    points = shapely.points(df["lon"].to_numpy(), df["lat"].to_numpy())

    # assign district and division
    area = np.full(len(df), None, dtype=object)
    division = np.full(len(df), None, dtype=object)
    if districts and len(df):
        tree = shapely.STRtree([d["geometry"] for d in districts])
        pt_idx, poly_idx = tree.query(points, predicate="within")
        # first match wins if polygons overlap at a shared edge
        seen = set()
        for p, g in zip(pt_idx, poly_idx):
            if p in seen:
                continue
            seen.add(p)
            area[p] = districts[g]["id"]
            division[p] = districts[g]["division"]
    df["areaId"] = area
    df["divisionId"] = division

    for s in SENSORS:
        audit[s]["kept"] = int((df["sensor"] == s).sum())
        audit[s]["no_district"] = int(((df["sensor"] == s) & pd.isna(df["areaId"])).sum())

    out = pd.DataFrame({
        "date": df["date"].dt.normalize(),
        "time": df["time"].astype(str),
        "lat": df["lat"].astype(float),
        "lon": df["lon"].astype(float),
        "sensor": df["sensor"],
        "satellite": df["satellite"].astype(str),
        "confidence": df["confidence"].astype("string"),
        "frp": pd.to_numeric(df["frp"], errors="coerce"),
        "processing": df["processing"],
        "sourceProduct": df["source"],
        "version": df["version"].astype("string"),
        "areaId": df["areaId"],
        "divisionId": df["divisionId"],
    }).sort_values(["date", "time", "sensor"]).reset_index(drop=True)
    return out, audit


def empty_clean() -> pd.DataFrame:
    return pd.DataFrame({c: pd.Series(dtype=t) for c, t in {
        "date": "datetime64[ns]", "time": str, "lat": float, "lon": float, "sensor": str, "satellite": str,
        "confidence": str, "frp": float, "processing": str, "sourceProduct": str, "version": str,
        "areaId": object, "divisionId": object}.items()})


def cleaning_rules() -> dict:
    """The filter settings, recorded next to the counts so the site can show them without hard-coding."""
    return {
        "modis_min_confidence": MODIS_MIN_CONFIDENCE,
        "viirs_keep_confidence": sorted(VIIRS_KEEP_CONFIDENCE),
        "type_kept": 0,
        "duplicate_key": ["sensor", "satellite", "acq_date", "acq_time", "latitude", "longitude"],
    }


def print_audit(audit: dict) -> None:
    rows = ["loaded"] + STEPS + ["kept", "no_district"]
    print(f"{'step':22s}" + "".join(f"{s:>10s}" for s in SENSORS))
    for r in rows:
        label = r if r in ("loaded", "kept", "no_district") else f"- {r}"
        print(f"{label:22s}" + "".join(f"{audit[s].get(r, 0):>10d}" for s in SENSORS))
    print("(no_district = kept points inside Sarawak but outside every ADM2 district polygon)")


def main():
    raw = {src: read_source_folder(src) for src in SOURCES}
    for sensor in SENSORS:
        if not any(len(raw[s]) for s, v in SOURCES.items() if v["sensor"] == sensor):
            folders = " or ".join(f"pipeline/raw/firms/{s}/" for s, v in SOURCES.items() if v["sensor"] == sensor)
            raise PipelineError(f"No {sensor} archive files found in {folders}. Run python pipeline/acquire.py "
                                f"first. Bara never fills missing archives with made-up observations.")
    table = load_district_table()
    adm1, districts = load_geography(table)
    source_cov = load_coverage(raw)
    clean, audit = clean_observations(raw, source_cov, adm1, districts)
    coverage = combined_coverage(source_cov)

    WORK.mkdir(parents=True, exist_ok=True)
    clean.to_parquet(WORK / "hotspots_clean.parquet", index=False)
    write_json(WORK / "coverage.json", {"sensors": coverage, "sources": source_cov}, pretty=True)
    write_json(WORK / "audit_clean.json", {"rules": cleaning_rules(), "counts": audit, "coverage": coverage},
               pretty=True)
    print_audit(audit)
    for s, c in coverage.items():
        print(f"{s} coverage: {c['start']} to {c['end']}")
    print(f"Wrote {WORK / 'hotspots_clean.parquet'} ({len(clean)} rows)")


if __name__ == "__main__":
    run_main(main)

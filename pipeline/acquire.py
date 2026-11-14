"""A1: download authentic inputs for Bara. Owner A.

    python pipeline/acquire.py                 # boundaries + all FIRMS sources
    python pipeline/acquire.py --only boundaries
    python pipeline/acquire.py --only firms

Safe to re-run: finished windows are skipped, a crash resumes from the last finished
window, failed requests retry 3 times with backoff. Credentials come only from environment
variables (pipeline/.env is loaded into the environment); the key is never printed.

You can also place FIRMS "Archive Download" CSVs in pipeline/raw/firms/<SOURCE>/ by hand;
clean.py reads every CSV in those folders. Add their date range to raw/manifest.json
(coverage_start / coverage_end) or clean.py will infer it from the data and warn.

Outputs
  raw/boundaries/sarawak_adm1.geojson         Sarawak state outline (geoBoundaries ADM1)
  raw/boundaries/sarawak_districts.geojson    ADM2 districts inside Sarawak
  raw/boundaries/district_names.txt           names to check against districts.csv
  raw/firms/<SOURCE>/<year>.csv               FIRMS rows, one file per source per year
  raw/firms/<SOURCE>/_progress.json           resume state
  raw/manifest.json                           every dataset, URL pattern, coverage, rows
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import os
import time
from collections import deque
from datetime import date, datetime, timedelta, timezone

import requests
from shapely.geometry import mapping, shape

from common import BBOX, RAW, SOURCES, PIPELINE, PipelineError, parse_date, read_json, run_main, write_json

FIRMS = "https://firms.modaps.eosdis.nasa.gov"
GEOBOUNDARIES = "https://www.geoboundaries.org/api/current/gbOpen/MYS/{level}/"
USER_AGENT = "bara-pipeline/1.0 (NASA Space Apps 2026)"


# ---------- HTTP with retries and a rate limit ----------

class RateLimiter:
    """At most one request per `interval` seconds and `max_per_window` per `window` seconds
    (FIRMS allows 5,000 per 10 minutes; we stay under 4,000)."""

    def __init__(self, interval=0.4, max_per_window=4000, window=600):
        self.interval, self.max, self.window = interval, max_per_window, window
        self.times: deque[float] = deque()

    def wait(self):
        now = time.monotonic()
        while self.times and now - self.times[0] > self.window:
            self.times.popleft()
        if len(self.times) >= self.max:
            time.sleep(self.window - (now - self.times[0]) + 1)
        if self.times and time.monotonic() - self.times[-1] < self.interval:
            time.sleep(self.interval - (time.monotonic() - self.times[-1]))
        self.times.append(time.monotonic())


SESSION = requests.Session()
SESSION.headers["User-Agent"] = USER_AGENT
LIMITER = RateLimiter()


def redact(text: str, key: str | None) -> str:
    return text.replace(key, "<MAP_KEY>") if key else text


def get(url: str, key: str | None = None, tries: int = 3, timeout: int = 90) -> requests.Response:
    last = None
    for attempt in range(1, tries + 1):
        try:
            if key:
                LIMITER.wait()
            resp = SESSION.get(url, timeout=timeout)
            if resp.status_code < 500 and resp.status_code != 429:
                return resp
            last = f"HTTP {resp.status_code}"
        except requests.RequestException as err:
            last = redact(str(err), key)
        if attempt < tries:
            time.sleep(2 ** attempt)
    raise PipelineError(f"Request failed after {tries} tries ({last}): {redact(url, key)}")


# ---------- 1. boundaries ----------

def acquire_boundaries(manifest: dict) -> None:
    out = RAW / "boundaries"
    out.mkdir(parents=True, exist_ok=True)
    adm1_path, adm2_path = out / "sarawak_adm1.geojson", out / "sarawak_districts.geojson"
    if adm1_path.exists() and adm2_path.exists():
        print("Boundaries: up to date")
        return

    downloads = {}
    for level in ("ADM1", "ADM2"):
        meta = get(GEOBOUNDARIES.format(level=level)).json()
        url = meta["gjDownloadURL"]
        print(f"Boundaries: downloading {level} from geoBoundaries ({meta.get('boundaryYearRepresented', '?')})")
        downloads[level] = (get(url).json(), url, meta)

    adm1, adm1_url, adm1_meta = downloads["ADM1"]
    sarawak = [f for f in adm1["features"] if f["properties"].get("shapeName", "").lower() == "sarawak"]
    if not sarawak:
        names = sorted(f["properties"].get("shapeName", "?") for f in adm1["features"])
        raise PipelineError(f"No ADM1 feature named Sarawak. Names found: {', '.join(names)}")
    sarawak_geom = shape(sarawak[0]["geometry"])

    adm2, adm2_url, adm2_meta = downloads["ADM2"]
    districts = []
    for feat in adm2["features"]:
        geom = shape(feat["geometry"])
        if sarawak_geom.contains(geom.representative_point()):
            districts.append({"type": "Feature", "properties": {"shapeName": feat["properties"]["shapeName"]},
                              "geometry": mapping(geom)})
    if not districts:
        raise PipelineError("No ADM2 districts fall inside Sarawak; check the geoBoundaries download.")

    write_json(adm1_path, {"type": "FeatureCollection", "features": [sarawak[0]]})
    write_json(adm2_path, {"type": "FeatureCollection", "features": districts})
    names = sorted(d["properties"]["shapeName"] for d in districts)
    (out / "district_names.txt").write_text("\n".join(names) + "\n", encoding="utf-8")
    print(f"Boundaries: {len(districts)} Sarawak districts. Check these names against districts.csv:")
    print("  " + ", ".join(names))

    manifest["datasets"]["boundaries"] = {
        "name": "geoBoundaries gbOpen Malaysia ADM1 (Sarawak) and ADM2 (districts inside Sarawak)",
        "source_urls": [adm1_url, adm2_url],
        "license": adm2_meta.get("boundaryLicense"),
        "boundary_year": adm2_meta.get("boundaryYearRepresented"),
        "districts": len(districts),
        "downloaded": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


# ---------- 2. FIRMS ----------

def key_status(key: str) -> dict | None:
    """FIRMS key status, e.g. {"transaction_limit": 5000, "current_transactions": 120}. None if the key is bad."""
    resp = get(f"{FIRMS}/mapserver/mapkey_status/?MAP_KEY={key}", key)
    try:
        status = resp.json()
    except ValueError:
        return None
    return status if resp.status_code == 200 and "transaction_limit" in status else None


def wait_for_budget(key: str, share: float = 0.8) -> None:
    """FIRMS counts transactions per key over 10 minutes and answers "Invalid MAP_KEY" once the limit is
    reached. Pause while more than `share` of the limit is used, so the download never hits it."""
    told = False
    while True:
        status = key_status(key)
        if status is None:
            raise PipelineError("FIRMS rejected FIRMS_MAP_KEY. Check the key in pipeline/.env "
                                "(get one at https://firms.modaps.eosdis.nasa.gov/api/map_key/).")
        used, limit = int(status.get("current_transactions", 0)), int(status.get("transaction_limit", 5000))
        if used < limit * share:
            if told:
                print(f"\n  Resuming: {used} of {limit} transactions used")
            return
        if not told:
            print(f"\n  FIRMS budget nearly used ({used} of {limit} in 10 minutes); pausing until it resets")
            told = True
        time.sleep(30)


def check_key(key: str) -> None:
    status = key_status(key)
    if status is None:
        raise PipelineError("FIRMS rejected FIRMS_MAP_KEY. Check the key in pipeline/.env "
                            "(get one at https://firms.modaps.eosdis.nasa.gov/api/map_key/).")
    print(f"FIRMS key OK: {status.get('current_transactions', '?')} of "
          f"{status.get('transaction_limit', '?')} transactions used in this 10-minute window")
    wait_for_budget(key)


def data_availability(key: str) -> dict[str, tuple[date, date]]:
    text = get(f"{FIRMS}/api/data_availability/csv/{key}/all", key).text
    out = {}
    for row in csv.DictReader(io.StringIO(text)):
        if row.get("data_id") in SOURCES:
            out[row["data_id"]] = (parse_date(row["min_date"]), parse_date(row["max_date"]))
    print("FIRMS data availability:")
    for src in SOURCES:
        if src in out:
            print(f"  {src:16s} {out[src][0]} to {out[src][1]}")
        else:
            print(f"  {src:16s} not listed")
    return out


def source_plan(avail: dict) -> dict[str, tuple[date, date]]:
    """Standard processing (SP) for as long as it exists, then near-real-time (NRT) to yesterday."""
    yesterday = date.today() - timedelta(days=1)
    plan = {}
    for sensor, sp, nrt in (("MODIS", "MODIS_SP", "MODIS_NRT"), ("VIIRS", "VIIRS_SNPP_SP", "VIIRS_SNPP_NRT")):
        sp_end = None
        if sp in avail:
            start = max(avail[sp][0], parse_date(SOURCES[sp]["start"]))
            sp_end = avail[sp][1]
            plan[sp] = (start, sp_end)
        if nrt in avail:
            start = (sp_end + timedelta(days=1)) if sp_end else avail[nrt][0]
            start = max(start, avail[nrt][0])
            end = min(avail[nrt][1], yesterday)
            if start <= end:
                plan[nrt] = (start, end)
    return plan


def fetch_window(key: str, source: str, start: date, days: int) -> tuple[list[str], list[list[str]]] | str:
    bbox = ",".join(str(v) for v in BBOX)
    url = f"{FIRMS}/api/area/csv/{key}/{source}/{bbox}/{days}/{start.isoformat()}"
    resp = get(url, key)
    text = resp.text.strip()
    if resp.status_code != 200 or (text and not text.startswith("latitude")):
        return redact(text[:300] or f"HTTP {resp.status_code}", key)
    if not text:
        return [], []
    rows = list(csv.reader(io.StringIO(text)))
    return rows[0], rows[1:]


def acquire_source(key: str, source: str, start: date, end: date, days: int) -> dict:
    folder = RAW / "firms" / source
    folder.mkdir(parents=True, exist_ok=True)
    prog_path = folder / "_progress.json"
    prog = read_json(prog_path) if prog_path.exists() else {}
    if prog.get("start") != start.isoformat():
        prog = {"start": start.isoformat(), "next": start.isoformat(), "rows": {}}
    nxt = parse_date(prog["next"])
    if nxt > end:
        print(f"  {source}: up to date ({start} to {end})")
        return prog

    total_windows = max(1, ((end - nxt).days // days) + 1)
    try:
        from tqdm import tqdm
        bar = tqdm(total=total_windows, desc=f"  {source}", unit="win")
    except ImportError:
        bar = None

    while nxt <= end:
        span = min(days, (end - nxt).days + 1)
        windows_done = getattr(acquire_source, "_count", 0) + 1
        acquire_source._count = windows_done
        if windows_done % 40 == 0:
            wait_for_budget(key)
        result = fetch_window(key, source, nxt, span)
        if isinstance(result, str):
            if "day" in result.lower() and "range" in result.lower() and days > 5:
                print(f"\n  FIRMS refused a {days}-day window ({result}); switching to 5-day windows")
                days = 5
                continue
            if "invalid" in result.lower() and "key" in result.lower():
                # Usually the 10-minute transaction limit, not a bad key: wait_for_budget tells them apart.
                refusals = getattr(acquire_source, "_refusals", 0) + 1
                acquire_source._refusals = refusals
                if refusals > 5:
                    raise PipelineError(f"FIRMS keeps refusing {source} from {nxt} although the key has budget left.")
                wait_for_budget(key, share=0.5 if refusals > 1 else 0.8)
                continue
            raise PipelineError(f"{source} window starting {nxt} failed: {result}")
        acquire_source._refusals = 0
        header, rows = result
        by_year: dict[str, list] = {}
        if rows:
            di = header.index("acq_date")
            for r in rows:
                by_year.setdefault(r[di][:4], []).append(r)
        for year, yrows in by_year.items():
            path = folder / f"{year}.csv"
            new = not path.exists()
            with path.open("a", newline="", encoding="utf-8") as fh:
                w = csv.writer(fh)
                if new:
                    w.writerow(header)
                w.writerows(yrows)
            prog["rows"][year] = prog["rows"].get(year, 0) + len(yrows)
        # Only after rows are written do we move the resume point forward.
        nxt = nxt + timedelta(days=span)
        prog["next"] = nxt.isoformat()
        prog["end"] = (nxt - timedelta(days=1)).isoformat()
        write_json(prog_path, prog, pretty=True)
        if bar:
            bar.update(1)
    if bar:
        bar.close()
    return prog


def acquire_firms(manifest: dict, days: int) -> None:
    key = os.environ.get("FIRMS_MAP_KEY", "").strip()
    if not key:
        raise PipelineError("FIRMS_MAP_KEY is not set. Copy pipeline/.env.example to pipeline/.env "
                            "and paste your free key from https://firms.modaps.eosdis.nasa.gov/api/map_key/")
    check_key(key)
    plan = source_plan(data_availability(key))
    if not plan:
        raise PipelineError("FIRMS listed none of the MODIS/VIIRS S-NPP sources we need.")

    started = time.monotonic()
    for source, (start, end) in plan.items():
        prog = acquire_source(key, source, start, end, days)
        rows = dict(sorted(prog.get("rows", {}).items()))
        manifest["datasets"][source] = {
            "name": f"NASA FIRMS {source}",
            "sensor": SOURCES[source]["sensor"],
            "processing": SOURCES[source]["processing"],
            "url_pattern": f"{FIRMS}/api/area/csv/<MAP_KEY>/{source}/{','.join(map(str, BBOX))}/<DAYS>/<YYYY-MM-DD>",
            "coverage_start": prog.get("start"),
            "coverage_end": prog.get("end"),
            "rows_per_year": rows,
            "rows": sum(rows.values()),
            "downloaded": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
    print(f"FIRMS finished in {time.monotonic() - started:.0f} s")
    print("Rows per source per year:")
    for source in plan:
        rows = manifest["datasets"][source]["rows_per_year"]
        print(f"  {source:16s} " + (", ".join(f"{y}: {n}" for y, n in rows.items()) or "no rows"))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--only", choices=["boundaries", "firms"])
    parser.add_argument("--days", type=int, default=5, help="days per FIRMS request (FIRMS allows 1 to 5)")
    args = parser.parse_args()

    try:
        from dotenv import load_dotenv
        load_dotenv(PIPELINE / ".env")
    except ImportError:
        pass

    manifest_path = RAW / "manifest.json"
    manifest = read_json(manifest_path) if manifest_path.exists() else {"datasets": {}}
    try:
        if args.only in (None, "boundaries"):
            acquire_boundaries(manifest)
        if args.only in (None, "firms"):
            acquire_firms(manifest, args.days)
    finally:
        manifest["updated"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        write_json(manifest_path, manifest, pretty=True)
    print(f"Manifest: {manifest_path}")


if __name__ == "__main__":
    run_main(main)

"""D-05: rainfall per area and a one-month hotspot outlook. Owner A.

    python pipeline/forecast.py

Reads   raw/rain/power_monthly.json (+ power_daily_*.json)   NASA POWER rainfall grid (acquire.py --only rain)
        work/harmonized.parquet                              monthly hotspot counts (harmonize.py)
        raw/boundaries/*.geojson, districts.csv              area shapes
Writes  work/rain.json       monthly rainfall (mm) per division and Sarawak, area-weighted
        work/forecast.json   outlook for the month after the last complete month

How the outlook works (per division and for Sarawak):
  * Learns from TRAIN_START on (the VIIRS era: observed counts, not estimates).
  * Main model, using only what is known when the outlook is made:
      hotspots(t) ~ calendar month + year trend + log(1 + hotspots(t-1))
    Poisson regression; negative binomial when over-dispersed (Pearson chi2 / df > 2). The range is the
    10th to 90th percentile of the fitted distribution.
    Chosen on the validation years VALID (trained to the year before): rain of the two previous months did not
    lower the error there (0.591 with or without it, four divisions), so it is reported as context only.
  * Honesty test: refitted on months up to TRAIN_END, asked for every month of TEST_YEAR one month ahead
    (only earlier data), and compared with two simple guesses: the typical count for that calendar month over
    the last 5 training years, and "same as last month". The model is shown only where it beats the
    typical-month guess; otherwise the typical-month outlook is shown and labelled.
  * Scenarios: the same model plus the rain of the target month itself, evaluated at a dry (25th percentile),
    normal (median) and wet (75th percentile) month from history. "What if" values, never a forecast: nobody
    knows the coming month's rain. This is where rain matters (strong negative effect in every division).
"""
from __future__ import annotations

import calendar
import warnings
from datetime import date

import numpy as np
import pandas as pd
from shapely.geometry import box
from shapely.ops import unary_union

from common import RAW, WORK, PipelineError, load_district_table, read_json, run_main, write_json

TRAIN_START = "2012-03"  # first month with an observed VIIRS count for the previous month
VALID = ("2022-01", "2024-12")
TRAIN_END = "2024-12"
TEST_YEAR = 2025
TYPICAL_YEARS = 5
MAIN = "y ~ C(cm) + t + lagc"
SCENARIO = MAIN + " + anom0"
RAIN_PARAM = "PRECTOTCORR"
QUANTILES = {"dry": 0.25, "normal": 0.5, "wet": 0.75}
SMALL_EFFECT = 1.15  # dry/wet expected ratio below this = "rain made little difference"


# ---------- rainfall ----------

def rain_grid(monthly: dict, dailies: list[dict]) -> pd.DataFrame:
    """POWER grid -> rows (lon, lat, month 'YYYY-MM', mm for the whole month)."""
    rows = []
    for f in monthly["features"]:
        lon, lat = f["geometry"]["coordinates"][:2]
        for k, v in f["properties"]["parameter"][RAIN_PARAM].items():
            if k.endswith("13") or v is None or v == -999:  # "13" = annual value
                continue
            y, m = int(k[:4]), int(k[4:])
            rows.append((lon, lat, f"{y}-{m:02d}", v * calendar.monthrange(y, m)[1]))
    for d in dailies:
        for f in d["features"]:
            lon, lat = f["geometry"]["coordinates"][:2]
            vals = f["properties"]["parameter"][RAIN_PARAM]
            k = next(iter(vals))
            rows.append((lon, lat, f"{k[:4]}-{k[4:6]}", float(sum(vals.values()))))
    df = pd.DataFrame(rows, columns=["lon", "lat", "month", "mm"])
    return df.groupby(["lon", "lat", "month"], as_index=False)["mm"].mean()


def area_weights(grid: pd.DataFrame, polygons: dict) -> dict[str, list[tuple[float, float, float]]]:
    """Share of each area covered by each rain grid cell (cell = box around the grid point)."""
    lons = np.sort(grid["lon"].unique())
    lats = np.sort(grid["lat"].unique())
    dx = float(np.median(np.diff(lons))) if len(lons) > 1 else 0.625
    dy = float(np.median(np.diff(lats))) if len(lats) > 1 else 0.5
    out = {}
    for aid, geom in polygons.items():
        ws = []
        for lon in lons:
            for lat in lats:
                a = geom.intersection(box(lon - dx / 2, lat - dy / 2, lon + dx / 2, lat + dy / 2)).area
                if a > 0:
                    ws.append((float(lon), float(lat), a))
        total = sum(w for *_, w in ws)
        if not total:
            raise PipelineError(f"No rain grid cell overlaps {aid}")
        out[aid] = [(lon, lat, w / total) for lon, lat, w in ws]
    return out


def area_rain(grid: pd.DataFrame, weights: dict) -> pd.DataFrame:
    """Area-weighted monthly rain per area: columns area_id, month, rainMm. A month counts only if every
    overlapping grid cell has a value."""
    piv = grid.pivot_table(index="month", columns=["lon", "lat"], values="mm")
    frames = []
    for aid, ws in weights.items():
        cols = [(lon, lat) for lon, lat, _ in ws]
        w = np.array([x for *_, x in ws])
        sub = piv[cols]
        ok = sub.notna().all(axis=1)
        vals = sub[ok].to_numpy() @ w
        frames.append(pd.DataFrame({"area_id": aid, "month": sub.index[ok], "rainMm": vals}))
    return pd.concat(frames, ignore_index=True).sort_values(["area_id", "month"]).reset_index(drop=True)


# ---------- model ----------

def rain_normals(df: pd.DataFrame, last: str = TRAIN_END) -> pd.Series:
    """Median rain per calendar month over months up to `last` (training years only: no leakage)."""
    d = df[df["month"] <= last]
    return d.groupby(d["month"].str[5:7].astype(int))["rainMm"].median()


def features(df: pd.DataFrame, normals: pd.Series) -> pd.DataFrame:
    """One area: columns month, y, cm, anom0, lag1, lag2, lagc. Rows in month order, no gaps assumed."""
    d = df.sort_values("month").reset_index(drop=True).copy()
    d["cm"] = d["month"].str[5:7].astype(int)
    d["anom0"] = d["rainMm"] / d["cm"].map(normals) - 1.0
    d["lag1"] = d["anom0"].shift(1)
    d["lag2"] = d["anom0"].shift(2)
    d["lagc"] = np.log1p(d["y"].shift(1))
    d["t"] = d["month"].str[:4].astype(int) - 2012 + (d["cm"] - 1) / 12
    return d


def fit(train: pd.DataFrame, with_rain_now: bool = False):
    import statsmodels.formula.api as smf

    formula = SCENARIO if with_rain_now else MAIN
    data = train[train["month"] >= TRAIN_START].dropna(subset=["y", "lagc"] + (["anom0"] if with_rain_now else []))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        import statsmodels.api as sm

        pois = smf.glm(formula, data=data, family=sm.families.Poisson()).fit()
        disp = float(pois.pearson_chi2 / max(pois.df_resid, 1))
        if disp <= 2:
            return {"kind": "poisson", "res": pois, "alpha": 0.0, "dispersion": disp, "n": int(len(data))}
        nb = smf.negativebinomial(formula, data=data).fit(disp=0, maxiter=200)
        alpha = float(nb.params["alpha"])
        return {"kind": "negative binomial", "res": nb, "alpha": alpha, "dispersion": disp, "n": int(len(data))}


def predict(model, rows: pd.DataFrame) -> np.ndarray:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return np.asarray(model["res"].predict(rows), dtype=float)


def interval(model, mu: float, lo: float = 0.1, hi: float = 0.9) -> tuple[int, int]:
    from scipy import stats

    if model["alpha"] > 0:
        n = 1.0 / model["alpha"]
        p = n / (n + mu)
        return int(stats.nbinom.ppf(lo, n, p)), int(stats.nbinom.ppf(hi, n, p))
    return int(stats.poisson.ppf(lo, mu)), int(stats.poisson.ppf(hi, mu))


def metrics(pred, actual) -> dict:
    pred = np.asarray(pred, dtype=float)
    actual = np.asarray(actual, dtype=float)
    err = np.abs(pred - actual)
    s = actual.sum()
    return {"MAE": round(float(err.mean()), 2), "WAPE": round(float(err.sum() / s), 4) if s > 0 else None,
            "biasPct": round(float(100 * (pred - actual).sum() / s), 1) if s > 0 else None}


def score_window(d: pd.DataFrame, train_end: str, start: str, end: str) -> dict:
    """Fit on TRAIN_START..train_end, predict start..end one month ahead; compare with the simple guesses."""
    train = d[d["month"] <= train_end]
    test = d[(d["month"] >= start) & (d["month"] <= end)].dropna(subset=["lagc"])
    model = fit(train)
    pred = predict(model, test)
    y_last = int(train_end[:4])
    recent = train[train["month"].str[:4].astype(int) > y_last - TYPICAL_YEARS]
    clim_pred = test["cm"].map(recent.groupby("cm")["y"].median()).to_numpy()
    pers_pred = np.expm1(test["lagc"].to_numpy())
    covered = [lo <= a <= hi for (lo, hi), a in zip((interval(model, m) for m in pred), test["y"])]
    return {"n": int(len(test)), "model": metrics(pred, test["y"]), "typicalMonth": metrics(clim_pred, test["y"]),
            "sameAsLastMonth": metrics(pers_pred, test["y"]), "rangeHit": round(float(np.mean(covered)), 3)}


def evaluate(d: pd.DataFrame) -> dict:
    """Validation (model choice) and the one-time test on TEST_YEAR. Exported for tests."""
    if len(d[d["month"].str.startswith(f"{TEST_YEAR}-")]) < 12:
        raise PipelineError(f"{TEST_YEAR} is not complete in the data; cannot test the outlook")
    valid_end_year = int(VALID[0][:4]) - 1
    val = score_window(d, f"{valid_end_year}-12", *VALID)
    test = score_window(d, TRAIN_END, f"{TEST_YEAR}-01", f"{TEST_YEAR}-12")
    out = {"trainStart": TRAIN_START, "trainEnd": TRAIN_END, "testYear": TEST_YEAR,
           "typicalMonthYears": TYPICAL_YEARS, "validation": {"window": list(VALID), **val}, **test}
    mw, cw = out["model"]["WAPE"], out["typicalMonth"]["WAPE"]
    out["beatsTypicalMonth"] = bool(mw is not None and cw is not None and mw < cw)
    return out


def area_outlook(series: pd.DataFrame, rain: pd.DataFrame, target: str, ref_years: tuple[int, int]) -> dict:
    """series: month, y (harmonized counts). rain: month, rainMm. Returns the outlook dict for one area."""
    df = series.merge(rain, on="month", how="inner").sort_values("month")
    df["y"] = df["y"].round().astype(int)
    normals = rain_normals(df)
    d = features(df, normals)
    ev = evaluate(d)

    full = fit(d)
    with_rain = fit(d, with_rain_now=True)
    last = d.iloc[-1]
    tm = int(target[5:7])
    ty = int(target[:4])
    row = pd.DataFrame([{"cm": tm, "t": ty - 2012 + (tm - 1) / 12, "lagc": np.log1p(last["y"])}])
    mu = float(predict(full, row)[0])
    low, high = interval(full, mu)

    # Typical month (fallback): same calendar month over the last TYPICAL_YEARS complete years.
    y0, y1 = ref_years
    same = d[(d["cm"] == tm) & d["month"].str[:4].astype(int).between(y1 - TYPICAL_YEARS + 1, y1)]["y"]
    typical = {"expected": round(float(same.median()), 1),
               "low": int(np.floor(same.quantile(0.1))), "high": int(np.ceil(same.quantile(0.9)))}

    # Driver: rain in the last two complete months vs their normal.
    last2 = d.iloc[-2:]
    pct = 100 * (last2["rainMm"].sum() / last2["cm"].map(normals).sum() - 1)
    names = [calendar.month_name[int(m[5:7])] for m in last2["month"]]
    word = "below" if pct < 0 else "above"
    driver = (f"Rainfall in {names[0]} and {names[1]} was {abs(pct):.0f}% {word} normal."
              if abs(pct) >= 5 else f"Rainfall in {names[0]} and {names[1]} was close to normal.")

    # Scenarios: rain of the target month itself at dry / normal / wet levels from history.
    hist = d[(d["cm"] == tm) & d["month"].str[:4].astype(int).between(y0, y1)]["rainMm"]
    raw = {}
    for key, q in QUANTILES.items():
        mm = float(hist.quantile(q))
        r = row.assign(anom0=mm / normals[tm] - 1.0)
        raw[key] = (mm, float(predict(with_rain, r)[0]))
    ratio = raw["dry"][1] / max(raw["wet"][1], 0.1)
    # The rain effect is a multiplier relative to a normal-rain month, applied to the number the panel shows
    # (the model where it won the test, else the typical month), so "Normal" always equals the headline.
    show = "model" if ev["beatsTypicalMonth"] else "typical"
    shown = mu if show == "model" else typical["expected"]
    scen = {key: {"rainMm": round(mm, 1), "factor": round(e / max(raw["normal"][1], 1e-9), 3),
                  "expected": round(shown * e / max(raw["normal"][1], 1e-9), 1)}
            for key, (mm, e) in raw.items()}

    return {
        "show": show,
        "expected": round(mu, 1), "low": low, "high": high,
        "typical": {**typical, "years": [y1 - TYPICAL_YEARS + 1, y1]},
        "driver": driver,
        "rainLast2Pct": round(float(pct), 1),
        "scenarios": scen,
        "rainEffect": round(float(ratio), 2),
        "rainMattered": bool(ratio >= SMALL_EFFECT),
        "model": {"kind": full["kind"], "formula": MAIN, "dispersion": round(full["dispersion"], 2),
                  "trainedMonths": full["n"], "trendPerYear": round(float(full["res"].params.get("t", np.nan)), 3),
                  "rainCoefSameMonth": round(float(with_rain["res"].params.get("anom0", np.nan)), 3),
                  "pastRainUsed": False},
        "evaluation": ev,
        "lastMonthUsed": str(last["month"]),
    }


def next_month(m: str) -> str:
    y, mm = int(m[:4]), int(m[5:7])
    return f"{y + (mm == 12)}-{mm % 12 + 1:02d}"


# ---------- main ----------

def load_polygons() -> dict:
    from clean import load_geography

    table = load_district_table()
    adm1, districts = load_geography(table)
    by_div: dict[str, list] = {}
    for d in districts:
        if d["division"]:
            by_div.setdefault(d["division"], []).append(d["geometry"])
    polys = {div: unary_union(geoms) for div, geoms in by_div.items()}
    polys["sarawak"] = adm1
    return polys


def main():
    rain_dir = RAW / "rain"
    if not (rain_dir / "power_monthly.json").exists():
        raise PipelineError("raw/rain/power_monthly.json is missing. Run: python pipeline/acquire.py --only rain")
    if not (WORK / "harmonized.parquet").exists():
        raise PipelineError("work/harmonized.parquet is missing. Run harmonize.py first.")

    monthly = read_json(rain_dir / "power_monthly.json")
    dailies = [read_json(p) for p in sorted(rain_dir.glob("power_daily_*.json"))]
    grid = rain_grid(monthly, dailies)
    polys = load_polygons()
    rain = area_rain(grid, area_weights(grid, polys))

    h = pd.read_parquet(WORK / "harmonized.parquet")
    last_complete = h.loc[h["harmonized"].notna(), "month"].max()
    target = next_month(last_complete)
    ref = (2001, int(last_complete[:4]) - (last_complete[5:7] != "12"))
    names = dict(zip(h["area_id"], h["name"]))

    areas = {}
    for aid in polys:
        s = h[h["area_id"] == aid][["month", "harmonized"]].rename(columns={"harmonized": "y"}).dropna()
        r = rain[rain["area_id"] == aid][["month", "rainMm"]]
        if r["month"].max() < last_complete:
            raise PipelineError(f"Rain for {aid} ends {r['month'].max()}, before {last_complete}; rerun acquire.py --only rain")
        areas[aid] = area_outlook(s[s["month"] <= last_complete], r[r["month"] <= last_complete], target, ref)
        a = areas[aid]
        ev = a["evaluation"]
        print(f"{names.get(aid, aid):18s} {a['model']['kind']:17s} test WAPE model {ev['model']['WAPE']:.2f} vs "
              f"typical {ev['typicalMonth']['WAPE']:.2f} vs last-month {ev['sameAsLastMonth']['WAPE']:.2f} "
              f"-> show {a['show']:7s} | {target}: {a['expected']:.0f} ({a['low']}-{a['high']}); typical "
              f"{a['typical']['expected']:.0f} | dry {a['scenarios']['dry']['expected']:.0f} / normal "
              f"{a['scenarios']['normal']['expected']:.0f} / wet {a['scenarios']['wet']['expected']:.0f}")

    src = read_json(RAW / "manifest.json").get("datasets", {}).get("rain", {})
    source = {"name": "NASA POWER, precipitation corrected (PRECTOTCORR)",
              "basis": "MERRA-2 reanalysis (weather model), GEOS-IT for the latest days; about 50 km grid",
              "url": "https://power.larc.nasa.gov/", "coverage": [src.get("coverage_start"), src.get("coverage_end")],
              "dailyFilled": src.get("daily_filled", [])}
    write_json(WORK / "forecast.json", {
        "issued": date.today().isoformat(), "basedOn": last_complete, "target": target,
        "method": (f"Poisson or negative binomial regression on calendar month, a year trend and last month's count, "
                   f"learned from {TRAIN_START}; chosen on {VALID[0]} to {VALID[1]}, tested once on {TEST_YEAR}. "
                   "Scenarios add the target month's own rain at dry, normal and wet levels."),
        "rainSource": source, "areas": areas,
    }, pretty=True)
    months = sorted(rain["month"].unique())
    write_json(WORK / "rain.json", {
        "units": "mm per month, area-weighted", "source": source, "months": months,
        "normalYears": [2001, int(TRAIN_END[:4])],
        "areas": {aid: {"rainMm": [round(float(v), 1) if v == v else None for v in
                                   rain[rain["area_id"] == aid].set_index("month")["rainMm"].reindex(months)],
                        "normalMm": [round(float(rain_normals(rain[rain["area_id"] == aid]).get(m, np.nan)), 1)
                                     for m in range(1, 13)]}
                  for aid in polys},
    }, pretty=False)
    print(f"Wrote work/forecast.json (outlook for {target}, from data to {last_complete}) and work/rain.json")


if __name__ == "__main__":
    run_main(main)

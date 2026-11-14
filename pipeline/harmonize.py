"""A2: put MODIS and VIIRS S-NPP counts on one comparable monthly scale. Owner A.

    python pipeline/harmonize.py [--train 2012-01:2021-12] [--validation 2022-01:2024-12] [--test 2025-01:2025-12]

Unit of fitting: base units (listed districts + "other Sarawak"), months where BOTH sensors
covered the whole month. Estimates are made per base unit and summed upwards, so a division
always equals the sum of its districts and Sarawak equals the sum of everything.

Methods (both predict a VIIRS-equivalent count from a MODIS count):
  ratio       per calendar month m: r_m = (sum VIIRS_m + a * R) / (sum MODIS_m + a), where R is the
              overall VIIRS/MODIS ratio. The pseudo-count a shrinks thin months toward R
              (low-count smoothing); a is chosen on the validation block.
  regression  ordinary least squares of log1p(VIIRS) on log1p(MODIS) plus 11 calendar-month
              dummies; back-transformed with Duan's smearing: estimate = exp(Xb) * mean(exp(residual)) - 1,
              floored at 0.

Protocol (no leakage):
  1. fit every candidate on the train block only; score on the validation block
  2. choose the candidate with the lowest validation WAPE (the test block is never read here)
  3. refit each method's chosen settings on train + validation
  4. score once on the untouched test block; report MAE, WAPE, signed bias, sparse and zero months,
     next to the raw-MODIS baseline (no adjustment)
Evaluation unit: division-months (sum of district estimates vs observed VIIRS). If no divisions
exist, Sarawak-months.

Continuity: from the first complete VIIRS S-NPP month onward, harmonizedCount = observed VIIRS.
Earlier months = the chosen method applied to MODIS (Terra + Aqua; Terra only before July 2002).

Output: work/harmonized.parquet, work/harmonize.json
"""
from __future__ import annotations

import argparse

import numpy as np
import pandas as pd

from aggregate import rollup
from common import OTHER_UNIT, WORK, PipelineError, clean_number, load_district_table, run_main, write_json

DEFAULT_WINDOWS = {"train": ("2012-01", "2021-12"), "validation": ("2022-01", "2024-12"), "test": ("2025-01", "2025-12")}
RATIO_ALPHAS = [0, 5, 20, 50, 200]
SPARSE_BELOW = 5
METHOD_VERSION = "baseline-v1"
METHOD_NAMES = {"ratio": "Seasonal ratio with low-count smoothing",
                "regression": "Log-linear regression with calendar-month effects",
                "raw-modis": "Raw MODIS count, no adjustment (baseline)"}


# ---------- models ----------

def _cal(months) -> np.ndarray:
    return np.array([int(m[5:7]) for m in months])


def _design(modis, months) -> np.ndarray:
    cal = _cal(months)
    X = np.zeros((len(cal), 13))
    X[:, 0] = 1.0
    X[:, 1] = np.log1p(modis)
    for m in range(2, 13):
        X[:, m] = (cal == m)
    return X


def fit(method: str, train: pd.DataFrame, alpha: float = 0.0) -> dict:
    d = train.dropna(subset=["modis", "viirs"])
    if len(d) == 0:
        raise PipelineError("No months where both sensors overlap in the training block.")
    if method == "ratio":
        total_m = d["modis"].sum()
        if total_m <= 0:
            raise PipelineError("MODIS saw no hotspots in the training block; cannot fit a ratio.")
        overall = d["viirs"].sum() / total_m
        cal = _cal(d["month"])
        ratios = []
        for m in range(1, 13):
            sel = cal == m
            num = d["viirs"].to_numpy()[sel].sum() + alpha * overall
            den = d["modis"].to_numpy()[sel].sum() + alpha
            ratios.append(float(num / den) if den > 0 else float(overall))
        return {"method": "ratio", "alpha": alpha, "overallRatio": float(overall), "monthRatio": ratios}
    if method == "regression":
        X = _design(d["modis"].to_numpy(), d["month"])
        y = np.log1p(d["viirs"].to_numpy())
        beta, *_ = np.linalg.lstsq(X, y, rcond=None)
        resid = y - X @ beta
        return {"method": "regression", "coef": beta.tolist(), "smearing": float(np.mean(np.exp(resid)))}
    if method == "raw-modis":
        return {"method": "raw-modis"}
    raise ValueError(method)


def predict(model: dict, modis, months) -> np.ndarray:
    modis = np.asarray(modis, dtype=float)
    if model["method"] == "ratio":
        r = np.asarray(model["monthRatio"])[_cal(months) - 1]
        return r * modis
    if model["method"] == "regression":
        X = _design(np.nan_to_num(modis), months)
        out = np.exp(X @ np.asarray(model["coef"])) * model["smearing"] - 1.0
        out = np.maximum(out, 0.0)
        out[np.isnan(modis)] = np.nan
        return out
    if model["method"] == "raw-modis":
        return modis.copy()
    raise ValueError(model["method"])


# ---------- evaluation ----------

def metrics(actual, pred) -> dict:
    a, p = np.asarray(actual, float), np.asarray(pred, float)
    ok = ~(np.isnan(a) | np.isnan(p))
    a, p = a[ok], p[ok]
    if len(a) == 0:
        return {"n": 0, "MAE": None, "WAPE": None, "biasPct": None, "sparseMonths": 0, "zeroMonths": 0}
    err = p - a
    total = a.sum()
    return {
        "n": int(len(a)),
        "MAE": clean_number(np.abs(err).mean(), 2),
        "WAPE": clean_number(np.abs(err).sum() / total, 4) if total > 0 else None,
        "biasPct": clean_number(100 * err.sum() / total, 1) if total > 0 else None,
        "sparseMonths": int((a < SPARSE_BELOW).sum()),
        "zeroMonths": int((a == 0).sum()),
    }


def in_window(df: pd.DataFrame, window: tuple[str, str]) -> pd.DataFrame:
    return df[(df["month"] >= window[0]) & (df["month"] <= window[1])]


def evaluation_pairs(model: dict, units: pd.DataFrame, table: list[dict], window) -> tuple[np.ndarray, np.ndarray]:
    sub = in_window(units, window).dropna(subset=["modis", "viirs"]).copy()
    if sub.empty:
        return np.array([]), np.array([])
    sub["pred"] = predict(model, sub["modis"], sub["month"])
    rolled = rollup(sub[["area_id", "month", "pred", "viirs"]], table, ["pred", "viirs"])
    level = "division" if (rolled["area_type"] == "division").any() else "sarawak"
    rolled = rolled[rolled["area_type"] == level].dropna(subset=["pred", "viirs"])
    return rolled["viirs"].to_numpy(), rolled["pred"].to_numpy()


def check_windows(units: pd.DataFrame, windows: dict) -> None:
    order = [windows["train"], windows["validation"], windows["test"]]
    for (a0, a1), (b0, _) in zip(order, order[1:]):
        if not (a0 <= a1 < b0):
            raise PipelineError(f"Windows must be in order train < validation < test without overlap: {windows}")
    both = units.dropna(subset=["modis", "viirs"])["month"].unique()
    for name, minimum in (("train", 24), ("validation", 6)):
        w = windows[name]
        n = sum(w[0] <= m <= w[1] for m in both)
        if n < minimum:
            raise PipelineError(f"The {name} window {w[0]} to {w[1]} has {n} months where both sensors cover "
                                f"the whole month; at least {minimum} are needed. Adjust --{name}.")


def harmonize(monthly: pd.DataFrame, table: list[dict], windows: dict = DEFAULT_WINDOWS):
    """Returns (harmonized DataFrame for all areas, report dict for harmonize.json)."""
    units = monthly[monthly["area_type"].isin(["district", "other"])][["area_id", "month", "modis", "viirs"]].copy()
    check_windows(units, windows)
    test_start = windows["test"][0]
    # Everything used for choosing a method stops before the test block.
    selectable = units[units["month"] < test_start].copy()
    assert selectable["month"].max() < test_start
    train = in_window(selectable, windows["train"])
    train_val = in_window(selectable, (windows["train"][0], windows["validation"][1]))

    candidates = [("ratio", a) for a in RATIO_ALPHAS] + [("regression", 0.0)]
    scored = []
    for method, alpha in candidates:
        model = fit(method, train, alpha)
        val = metrics(*evaluation_pairs(model, selectable, table, windows["validation"]))
        scored.append((method, alpha, model, val))
    best = {}
    for method, alpha, model, val in scored:
        w = val["WAPE"] if val["WAPE"] is not None else np.inf
        if method not in best or w < best[method][3]:
            best[method] = (alpha, model, val, w)
    chosen = min(best, key=lambda m: best[m][3])

    methods_out, final_models = [], {}
    for method in ("ratio", "regression", "raw-modis"):
        alpha = best[method][0] if method in best else 0.0
        val = best[method][2] if method in best else metrics(*evaluation_pairs(fit("raw-modis", train), selectable, table, windows["validation"]))
        final = fit(method, train_val, alpha)
        final_models[method] = final
        test = metrics(*evaluation_pairs(final, units, table, windows["test"]))
        entry = {"id": method, "name": METHOD_NAMES[method], "validation": val, "test": test}
        if method == "ratio":
            entry["params"] = {"alpha": alpha, "overallRatio": round(final["overallRatio"], 4),
                               "monthRatio": [round(r, 4) for r in final["monthRatio"]]}
        elif method == "regression":
            entry["params"] = {"coef": [round(c, 5) for c in final["coef"]], "smearing": round(final["smearing"], 5)}
        methods_out.append(entry)

    # Uncertainty band from validation (model fit on train only, so the band is out-of-sample).
    a, p = evaluation_pairs(best[chosen][1], selectable, table, windows["validation"])
    keep = p >= SPARSE_BELOW
    uncertainty = None
    if keep.sum() >= 10:
        ratios = a[keep] / p[keep]
        uncertainty = {"lowFactor": round(float(np.quantile(ratios, 0.1)), 3),
                       "highFactor": round(float(np.quantile(ratios, 0.9)), 3),
                       "basis": f"10th and 90th percentile of observed / estimated on {int(keep.sum())} validation "
                                f"evaluation months with an estimate of at least {SPARSE_BELOW}"}

    model = final_models[chosen]
    units = units.copy()
    est = predict(model, units["modis"], units["month"])
    units["harmonized"] = np.where(units["viirs"].notna(), units["viirs"], est)
    harmonized = rollup(units[["area_id", "month", "modis", "viirs", "harmonized"]], table,
                        ["modis", "viirs", "harmonized"])
    harmonized["status"] = np.where(harmonized["viirs"].notna(), "observed",
                                    np.where(harmonized["modis"].notna(), "estimated", "missing"))
    harmonized.loc[harmonized["status"] == "missing", "harmonized"] = np.nan

    chosen_test = next(m["test"] for m in methods_out if m["id"] == chosen)
    test_available = chosen_test["n"] > 0
    report = {
        "methodVersion": METHOD_VERSION,
        "method": chosen,
        "methodName": METHOD_NAMES[chosen],
        "chosenOn": f"lowest WAPE on validation {windows['validation'][0]} to {windows['validation'][1]}",
        "finalTestYear": int(windows["test"][0][:4]),
        "metrics": {k: chosen_test[k] for k in ("MAE", "WAPE", "biasPct", "n", "sparseMonths", "zeroMonths")},
        "trainWindow": list(windows["train"]),
        "validationWindow": list(windows["validation"]),
        "testWindow": list(windows["test"]),
        "evaluationUnit": "division-months: sum of district estimates compared with observed VIIRS S-NPP"
                          if (monthly["area_type"] == "division").any() else "Sarawak-months",
        "metricDefinitions": {
            "MAE": "mean absolute error, detections per evaluation month",
            "WAPE": "sum of absolute errors / sum of observed counts (fraction, 0.2 = 20%)",
            "biasPct": "100 * sum(estimate - observed) / sum(observed); positive = overestimate",
            "sparseMonths": f"test evaluation months with fewer than {SPARSE_BELOW} observed detections",
            "zeroMonths": "test evaluation months with zero observed detections",
        },
        "methods": methods_out,
        "uncertainty": uncertainty,
        "continuity": "From the first complete VIIRS S-NPP month, harmonizedCount is the observed VIIRS count. "
                      "Earlier months are estimates from MODIS Terra + Aqua (Terra only before July 2002).",
        "notes": ("Counts are satellite hotspot detections, not distinct fires. Estimates are aggregate monthly "
                  "counts, not new detections at exact places. Months before July 2002 use Terra only, so "
                  "estimates there are likely low. Small counts have large relative error."
                  + ("" if test_available else " Test metrics are null because the test window has no months "
                                               "where both sensors cover the whole month.")),
    }
    return harmonized, report


def parse_window(text: str) -> tuple[str, str]:
    a, b = text.split(":")
    return a, b


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    for name, (a, b) in DEFAULT_WINDOWS.items():
        parser.add_argument(f"--{name}", default=f"{a}:{b}", help=f"YYYY-MM:YYYY-MM (default {a}:{b})")
    args = parser.parse_args()
    path = WORK / "monthly.parquet"
    if not path.exists():
        raise PipelineError(f"{path} is missing. Run python pipeline/aggregate.py first.")
    windows = {n: parse_window(getattr(args, n)) for n in DEFAULT_WINDOWS}
    harmonized, report = harmonize(pd.read_parquet(path), load_district_table(), windows)
    harmonized.to_parquet(WORK / "harmonized.parquet", index=False)
    write_json(WORK / "harmonize.json", report, pretty=True)

    print(f"Chosen method: {report['methodName']} ({report['chosenOn']})")
    for m in report["methods"]:
        v, t = m["validation"], m["test"]
        print(f"  {m['id']:11s} validation WAPE {v['WAPE']}  test WAPE {t['WAPE']}  test MAE {t['MAE']}  "
              f"test bias {t['biasPct']}%  (n={t['n']}, sparse={t['sparseMonths']})")
    sar = harmonized[harmonized["area_id"] == "sarawak"].copy()
    sar["year"] = sar["month"].str[:4]
    annual = sar[sar["year"].between("2009", "2014")].groupby("year")[["modis", "viirs", "harmonized"]].sum(min_count=1)
    print("Sanity check, Sarawak annual totals around the 2011/2012 sensor change:")
    print(annual.round(0).to_string())
    print(f"Wrote {WORK / 'harmonized.parquet'} and {WORK / 'harmonize.json'}")


if __name__ == "__main__":
    run_main(main)

"""D-05: rainfall weighting and the outlook model, on synthetic data with known answers."""
import numpy as np
import pandas as pd
from shapely.geometry import box

import forecast as F


def months(start="2005-01", end="2026-10"):
    return [str(p) for p in pd.period_range(start, end, freq="M")]


def synthetic(seed=1, rain_effect=-1.5):
    """Hotspots driven by season, a decline, and the SAME month's rain (strongly), like the real data."""
    rng = np.random.default_rng(seed)
    ms = months()
    cm = np.array([int(m[5:7]) for m in ms])
    season = 1 + 2.5 * np.exp(-((cm - 8) ** 2) / 2)
    normal_rain = 300 - 150 * np.exp(-((cm - 8) ** 2) / 3)
    rain = normal_rain * rng.lognormal(0, 0.35, len(ms))
    t = np.array([int(m[:4]) - 2012 for m in ms])
    mu = np.exp(np.log(8 * season) - 0.05 * t + rain_effect * (rain / normal_rain - 1))
    y = rng.poisson(mu)
    return pd.DataFrame({"month": ms, "y": y.astype(int), "rainMm": rain})


def test_area_rain_weights_by_overlap():
    grid = pd.DataFrame([(110.0, 2.0, "2020-01", 100.0), (110.5, 2.0, "2020-01", 300.0)],
                        columns=["lon", "lat", "month", "mm"])
    # A polygon covering 3/4 of the first cell and 1/4 of the second.
    poly = {"x": box(109.875, 1.75, 110.375, 2.25)}
    w = F.area_weights(grid, poly)
    got = F.area_rain(grid, w)
    assert abs(got["rainMm"].iloc[0] - (0.75 * 100 + 0.25 * 300)) < 1e-6


def test_rain_normals_use_training_years_only():
    d = synthetic()
    d.loc[d["month"] >= "2025-01", "rainMm"] = 1e6  # absurd future rain must not move the normals
    normals = F.rain_normals(d)
    assert normals.max() < 1000


def test_lag_uses_previous_month_only():
    d = F.features(synthetic(), F.rain_normals(synthetic()))
    assert np.isnan(d["lagc"].iloc[0])
    assert d["lagc"].iloc[5] == np.log1p(d["y"].iloc[4])


def test_evaluation_never_sees_the_test_year():
    d0 = synthetic()
    d1 = d0.copy()
    d1.loc[d1["month"].str.startswith("2025-"), "y"] *= 50  # change only the test-year targets
    e0 = F.evaluate(F.features(d0, F.rain_normals(d0)))
    e1 = F.evaluate(F.features(d1, F.rain_normals(d1)))
    # Validation (2022-2024, trained to 2021) cannot depend on 2025 at all.
    assert e0["validation"] == e1["validation"]
    assert e0["n"] == 12 and e0["testYear"] == 2025


def test_scenarios_follow_the_rain_effect_and_show_rule():
    d = synthetic()
    out = F.area_outlook(d[["month", "y"]], d[["month", "rainMm"]], "2026-11", (2005, 2025))
    sc = out["scenarios"]
    assert sc["dry"]["rainMm"] < sc["normal"]["rainMm"] < sc["wet"]["rainMm"]
    assert sc["dry"]["expected"] > sc["normal"]["expected"] > sc["wet"]["expected"]  # less rain, more hotspots
    assert out["rainMattered"]
    assert out["model"]["rainCoefSameMonth"] < 0
    assert out["show"] == ("model" if out["evaluation"]["beatsTypicalMonth"] else "typical")
    assert out["low"] <= out["high"]


def test_no_rain_effect_is_reported_honestly():
    d = synthetic(rain_effect=0.0)
    out = F.area_outlook(d[["month", "y"]], d[["month", "rainMm"]], "2026-11", (2005, 2025))
    assert out["rainEffect"] < 1.5

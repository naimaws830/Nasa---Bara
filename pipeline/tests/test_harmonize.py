"""A2 TESTS: no leakage of test observations into model selection; sensor availability and zero-vs-null."""
import numpy as np
import pandas as pd
import pytest

from aggregate import monthly_counts, rollup
from common import PipelineError, month_range
from harmonize import harmonize

TABLE = [{"district_name": "A", "district_id": "dist:a", "division_id": "div:x", "division_name": "X", "verified": True},
         {"district_name": "B", "district_id": "dist:b", "division_id": "div:x", "division_name": "X", "verified": True},
         {"district_name": "C", "district_id": "dist:c", "division_id": "div:y", "division_name": "Y", "verified": True}]


def test_zero_vs_null_and_partial_months():
    clean = pd.DataFrame({
        "date": pd.to_datetime(["2001-01-10", "2001-03-20", "2001-02-05"]),
        "sensor": ["MODIS", "MODIS", "VIIRS"],
        "areaId": ["dist:a", "dist:a", "dist:zzz"],   # dist:zzz is not listed, so it counts in Sarawak only
    })
    cov = {"MODIS": {"start": "2001-01-01", "end": "2001-03-15"},   # March incomplete
           "VIIRS": {"start": "2001-02-01", "end": "2001-03-31"}}   # January not covered
    m = monthly_counts(clean, cov, TABLE, "2001-01", "2001-03").set_index(["area_id", "month"])
    assert m.loc[("dist:a", "2001-01"), "modis"] == 1
    assert m.loc[("dist:a", "2001-02"), "modis"] == 0                 # covered, nothing seen: 0
    assert np.isnan(m.loc[("dist:a", "2001-03"), "modis"])            # partial month: null, detection dropped
    assert np.isnan(m.loc[("dist:a", "2001-01"), "viirs"])            # sensor not covering: null
    assert m.loc[("dist:b", "2001-02"), "viirs"] == 0
    assert m.loc[("div:x", "2001-02"), "viirs"] == 0
    assert m.loc[("sarawak", "2001-02"), "viirs"] == 1                # unlisted district still in Sarawak
    assert m.loc[("div:x", "2001-01"), "modis"] == 1


def synthetic_monthly(seed=1):
    rng = np.random.default_rng(seed)
    months = month_range("2008-01", "2025-12")
    rows = []
    for unit, w in (("dist:a", 8), ("dist:b", 4), ("dist:c", 6), ("dist:_other", 3)):
        for mo in months:
            season = 3.0 if mo[5:7] in ("07", "08", "09") else 1.0
            lam = w * season * rng.uniform(0.6, 1.4)
            modis = rng.poisson(lam)
            viirs = rng.poisson(lam * 3.5) if mo >= "2012-01" else np.nan
            rows.append({"area_id": unit, "month": mo, "modis": float(modis), "viirs": float(viirs)})
    return rollup(pd.DataFrame(rows), TABLE, ["modis", "viirs"])


def test_no_test_leakage_into_selection():
    base = synthetic_monthly()
    _, rep1 = harmonize(base, TABLE)
    poisoned = base.copy()
    test = poisoned["month"].str.startswith("2025")
    poisoned.loc[test, "viirs"] = poisoned.loc[test, "viirs"] * 50 + 999
    _, rep2 = harmonize(poisoned, TABLE)
    assert rep1["method"] == rep2["method"]
    for a, b in zip(rep1["methods"], rep2["methods"]):
        assert a["validation"] == b["validation"]
        assert a.get("params") == b.get("params")
    assert rep1["uncertainty"] == rep2["uncertainty"]
    assert rep1["metrics"] != rep2["metrics"]          # only the test score changed


def test_continuity_and_status():
    h, rep = harmonize(synthetic_monthly(), TABLE)
    h = h.set_index(["area_id", "month"])
    assert h.loc[("sarawak", "2011-12"), "status"] == "estimated"
    assert h.loc[("sarawak", "2012-01"), "status"] == "observed"
    assert h.loc[("sarawak", "2012-01"), "harmonized"] == h.loc[("sarawak", "2012-01"), "viirs"]
    # a division equals the sum of its districts, for estimates too
    div = h.loc[("div:x", "2010-08"), "harmonized"]
    assert div == pytest.approx(h.loc[("dist:a", "2010-08"), "harmonized"] + h.loc[("dist:b", "2010-08"), "harmonized"])
    assert rep["metrics"]["n"] > 0 and rep["metrics"]["WAPE"] is not None


def test_windows_without_overlap_are_rejected():
    with pytest.raises(PipelineError):
        harmonize(synthetic_monthly(), TABLE, {"train": ("2005-01", "2008-12"), "validation": ("2009-01", "2010-12"),
                                               "test": ("2025-01", "2025-12")})

"""A3 TESTS: a corrupted calendar month must fail validation; production check fails closed on mock data."""
import json
import shutil

import pytest

from export import write_outputs
from make_mock import build_files
from validate import validate_dir


@pytest.fixture(scope="module")
def mock_dir(tmp_path_factory):
    files, _, _ = build_files()
    out = tmp_path_factory.mktemp("data")
    write_outputs(files, out)
    return out


def corrupt(folder, rel, fn):
    p = folder / rel
    obj = json.loads(p.read_text(encoding="utf-8"))
    fn(obj)
    p.write_text(json.dumps(obj), encoding="utf-8")


def test_mock_export_is_valid(mock_dir):
    assert validate_dir(mock_dir).errors == []


def test_corrupt_calendar_month_fails(mock_dir, tmp_path):
    d = shutil.copytree(mock_dir, tmp_path / "bad")
    corrupt(d, "calendar/div_mukah.json", lambda o: o["rawViirsCount"].__setitem__(200, -3))
    errors = validate_dir(d).errors
    assert any("calendar/div_mukah.json" in e and "non-negative" in e for e in errors)


def test_missing_month_with_value_fails(mock_dir, tmp_path):
    d = shutil.copytree(mock_dir, tmp_path / "bad2")
    corrupt(d, "calendar/sarawak.json", lambda o: o["status"].__setitem__(10, "missing"))
    assert any("is missing but harmonizedCount" in e for e in validate_dir(d).errors)


def test_nan_is_rejected(mock_dir, tmp_path):
    d = shutil.copytree(mock_dir, tmp_path / "bad3")
    p = d / "calendar" / "sarawak.json"
    p.write_text(p.read_text(encoding="utf-8").replace('"harmonizedCount":[', '"harmonizedCount":[NaN,', 1),
                 encoding="utf-8")
    assert any("not valid JSON" in e for e in validate_dir(d).errors)


def test_swapped_coordinates_fail(mock_dir, tmp_path):
    d = shutil.copytree(mock_dir, tmp_path / "bad4")

    def swap(o):
        cell = o["cells"][0]
        cell["lon"], cell["lat"] = cell["lat"], cell["lon"]
    corrupt(d, "map/2015.json", swap)
    assert any("are lon and lat swapped" in e for e in validate_dir(d).errors)


def test_production_fails_closed_on_mock(mock_dir):
    assert any("mock data" in e for e in validate_dir(mock_dir, production=True).errors)


def test_production_fails_when_no_real_data(tmp_path):
    assert validate_dir(tmp_path / "empty", production=True).errors

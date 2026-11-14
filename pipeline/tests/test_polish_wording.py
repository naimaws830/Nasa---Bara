"""The safety checks on AI wording suggestions (no network: only the check function)."""
import json

from common import PIPELINE
from polish_wording import check


def test_good_rewrite_passes():
    assert check("Satellites spotted {n} hotspots in {area} in {month}.",
                 "Satellites saw {n} hotspots in {area} in {month}.") == []


def test_placeholder_changes_are_rejected():
    assert "placeholders changed" in check("About {n} hotspots in {area}.", "About 40 hotspots in {area}.")
    assert "placeholders changed" in check("About {n} hotspots.", "About {n} hotspots in {area}.")


def test_fixed_numbers_must_stay():
    assert "fixed numbers changed" in check("Above 100 is unhealthy.", "Above 150 is unhealthy.")
    assert "fixed numbers changed" in check("Call 999.", "Call for help.")


def test_alarm_words_and_jargon_are_rejected():
    assert "alarm word" in check("Watch haze news.", "Danger: watch haze news.")
    assert check("In an emergency, call 999.", "In an emergency, call 999.") == []  # already in the original
    assert any(p.startswith("jargon") for p in check("A normal month.", "The median month."))


def test_catalog_is_well_formed():
    cat = json.loads((PIPELINE / "wording_catalog.json").read_text(encoding="utf-8"))
    ids = [i["id"] for i in cat["items"]]
    assert len(ids) == len(set(ids))
    for i in cat["items"]:
        assert i["template"] and i["example"] and i["where"]

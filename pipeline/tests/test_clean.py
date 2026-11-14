"""A1 TEST: fixture with 2 sensors, missing fields and a duplicate row; counts and rejected rows must match."""
import pandas as pd
from shapely.geometry import box

from clean import clean_observations

ADM1 = box(110, 1, 114, 4)
DISTRICTS = [{"id": "dist:a", "name": "A", "division": "div:x", "geometry": box(110, 1, 112, 4)},
             {"id": "dist:b", "name": "B", "division": "div:x", "geometry": box(112, 1, 114, 4)}]
COV = {"MODIS_SP": {"start": "2015-01-01", "end": "2015-12-31"},
       "MODIS_NRT": {"start": "2016-01-01", "end": "2016-02-01"},
       "VIIRS_SNPP_SP": {"start": "2015-01-01", "end": "2015-12-31"}}


def modis(lat, lon, date="2015-08-01", time="0130", conf="80", type_="0", sat="T"):
    return {"latitude": lat, "longitude": lon, "acq_date": date, "acq_time": time, "satellite": sat,
            "confidence": conf, "frp": "12.5", "version": "6.1", "type": type_}


def fixture():
    modis_sp = pd.DataFrame([
        modis("2.0", "111.0"),                    # kept, dist:a
        modis("2.0", "111.0"),                    # exact duplicate
        modis(None, "111.2"),                     # missing latitude
        modis("2.1", "111.3", conf="20"),         # low confidence (below 30)
        modis("2.2", "111.4", type_="2"),         # other static land source
        modis("2.0", "115.0"),                    # outside Sarawak
        modis("3.0", "113.0", conf="30"),         # kept at the threshold, dist:b
    ], dtype=object)
    # NRT file: no type column; its date is covered by standard processing
    modis_nrt = pd.DataFrame([modis("2.5", "111.5", date="2015-08-02")], dtype=object).drop(columns="type")
    # VIIRS file has no frp or type column at all (fields that are not required)
    viirs_sp = pd.DataFrame([
        {"latitude": "2.0", "longitude": "111.0", "acq_date": "2015-08-01", "acq_time": "0130", "satellite": "N", "confidence": "n"},
        {"latitude": "2.3", "longitude": "111.6", "acq_date": "2015-08-01", "acq_time": "0131", "satellite": "N", "confidence": "l"},
        {"latitude": "3.3", "longitude": "113.3", "acq_date": "2015-08-03", "acq_time": "1800", "satellite": "N", "confidence": "h"},
        {"latitude": "3.4", "longitude": "113.4", "acq_date": "2015-08-03", "acq_time": None, "satellite": "N", "confidence": "h"},
    ], dtype=object)
    return {"MODIS_SP": modis_sp, "MODIS_NRT": modis_nrt, "VIIRS_SNPP_SP": viirs_sp}


def test_counts_and_rejections_match():
    clean, audit = clean_observations(fixture(), COV, ADM1, DISTRICTS)
    assert audit["MODIS"] == {"loaded": 8, "missing_fields": 1, "nrt_replaced_by_sp": 1, "non_vegetation_type": 1,
                              "low_confidence": 1, "exact_duplicates": 1, "outside_sarawak": 1, "kept": 2,
                              "no_district": 0}
    assert audit["VIIRS"] == {"loaded": 4, "missing_fields": 1, "nrt_replaced_by_sp": 0, "non_vegetation_type": 0,
                              "low_confidence": 1, "exact_duplicates": 0, "outside_sarawak": 0, "kept": 2,
                              "no_district": 0}
    assert len(clean) == 4


def test_output_columns_and_values():
    clean, _ = clean_observations(fixture(), COV, ADM1, DISTRICTS)
    assert list(clean.columns) == ["date", "time", "lat", "lon", "sensor", "satellite", "confidence", "frp",
                                   "processing", "sourceProduct", "version", "areaId", "divisionId"]
    m = clean[clean["sensor"] == "MODIS"].sort_values("lon")
    assert m["areaId"].tolist() == ["dist:a", "dist:b"]
    assert m["satellite"].tolist() == ["Terra", "Terra"]
    assert set(clean["processing"]) == {"standard"}
    # A MODIS and a VIIRS detection at the same place and time are both kept (not cross-sensor duplicates)
    same = clean[(clean["lat"] == 2.0) & (clean["lon"] == 111.0)]
    assert sorted(same["sensor"]) == ["MODIS", "VIIRS"]
    assert clean[clean["sensor"] == "VIIRS"]["frp"].isna().all()

"""Offline wording help: ask Kimi (Moonshot AI) for plainer versions of Bara's sentence patterns.

    python pipeline/polish_wording.py            # needs KIMI_API_KEY in pipeline/.env

Reads   pipeline/wording_catalog.json   every reader-facing sentence pattern, with {placeholders}
Writes  docs/wording_suggestions.md     original vs suggestion, with automatic checks, for a person to review
        pipeline/work/wording_suggestions.json

Nothing on the website changes by itself: a person copies the approved wording into site/js. The AI only
rewrites words; numbers always come from the data. A suggestion is flagged (and must not be used) if it
changes the {placeholders}, adds or drops a fixed number, uses alarm words or jargon, or gets much longer.
The key is never printed or written anywhere except pipeline/.env (ignored by git).
"""
from __future__ import annotations

import json
import os
import re
import time

import requests

from common import DOCS, PIPELINE, WORK, PipelineError, run_main, write_json

API = "https://api.moonshot.ai/v1/chat/completions"
MODEL = "kimi-k2.6"
PLACEHOLDER = re.compile(r"\{[a-z0-9_]+\}")
NUMBER = re.compile(r"\d+")
ALARM = re.compile(r"\b(danger\w*|alert\w*|warning\w*|evacuat\w*|emergenc\w*|deadly|disaster\w*|crisis)\b", re.I)
JARGON = re.compile(r"\b(median|anomal\w*|harmoni\w*|model\w*|percentile\w*|regression|WAPE|statistic\w*|"
                    r"dataset|algorithm\w*|detections?)\b", re.I)

RULES = """You rewrite short sentences for a public website about fire hotspots in Sarawak, Malaysia.
Readers are ordinary residents, not data experts; many read English as a second language (reading age about 12).

For EACH item, write one improved version of "template" that is clearer and friendlier, following these rules:
1. Keep every {placeholder} exactly as written (same spelling, same braces) and use each one exactly once.
   Do not add new placeholders. Do not write any numbers in place of placeholders.
2. Keep every fixed number that is in the original (such as 2012, 100, 999, N95, 25). Do not add new numbers.
3. Keep the meaning. Do not add facts, advice, causes or promises that are not in the original.
4. Plain everyday English: short words, active voice, at most about 20 words per sentence. Prefer shorter.
5. Calm and factual. Never use: danger, alert, warning, evacuate, emergency (unless the original already has it),
   deadly, disaster, crisis.
6. No technical words: median, anomaly, harmonized, model, percentile, regression, statistics, dataset, detection.
7. If the original is already as clear as it can be, return it unchanged.

Reply with ONLY a JSON object: {"<id>": {"text": "<new template>", "why": "<under 12 words>"}, ...} for every id."""


def check(orig: str, new: str) -> list[str]:
    problems = []
    if sorted(PLACEHOLDER.findall(orig)) != sorted(PLACEHOLDER.findall(new)):
        problems.append("placeholders changed")
    if sorted(NUMBER.findall(PLACEHOLDER.sub("", orig))) != sorted(NUMBER.findall(PLACEHOLDER.sub("", new))):
        problems.append("fixed numbers changed")
    if ALARM.search(new) and not ALARM.search(orig):
        problems.append("alarm word")
    jargon_new = {w.lower() for w in JARGON.findall(new)} - {w.lower() for w in JARGON.findall(orig)}
    if jargon_new:
        problems.append(f"jargon: {', '.join(sorted(jargon_new))}")
    if len(new.split()) > len(orig.split()) * 1.3 + 4:
        problems.append("much longer")
    if not new.strip():
        problems.append("empty")
    return problems


def ask_kimi(key: str, items: list[dict], audience: str) -> dict:
    payload = [{"id": i["id"], "where": i["where"], "template": i["template"], "example": i["example"]} for i in items]
    body = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": RULES},
            {"role": "user", "content": f"Audience: {audience}\n\nItems:\n{json.dumps(payload, ensure_ascii=False, indent=1)}"},
        ],
        "response_format": {"type": "json_object"},
    }
    last = None
    for attempt in range(3):
        try:
            r = requests.post(API, headers={"Authorization": f"Bearer {key}"}, json=body, timeout=300)
        except requests.RequestException as err:
            last = str(err).replace(key, "<KEY>")
        else:
            if r.ok:
                content = r.json()["choices"][0]["message"]["content"]
                content = re.sub(r"^```(?:json)?\s*|\s*```$", "", content.strip())
                return json.loads(content)
            last = f"HTTP {r.status_code}: {r.text[:300]}".replace(key, "<KEY>")
            if r.status_code in (400, 401, 403):
                break
        time.sleep(2 ** attempt)
    raise PipelineError(f"Kimi request failed: {last}")


def main():
    try:
        from dotenv import load_dotenv
        load_dotenv(PIPELINE / ".env")
    except ImportError:
        pass
    key = os.environ.get("KIMI_API_KEY", "").strip()
    if not key:
        raise PipelineError("KIMI_API_KEY is not set in pipeline/.env")
    catalog = json.loads((PIPELINE / "wording_catalog.json").read_text(encoding="utf-8"))
    items = catalog["items"]
    print(f"Asking {MODEL} about {len(items)} sentence patterns...")
    answers = ask_kimi(key, items, catalog["audience"])

    rows = []
    for it in items:
        a = answers.get(it["id"]) or {}
        new = (a.get("text") if isinstance(a, dict) else str(a)) or ""
        problems = check(it["template"], new) if new else ["missing"]
        rows.append({"id": it["id"], "where": it["where"], "original": it["template"], "suggestion": new,
                     "why": a.get("why", "") if isinstance(a, dict) else "", "unchanged": new == it["template"],
                     "problems": problems})
    WORK.mkdir(parents=True, exist_ok=True)
    write_json(WORK / "wording_suggestions.json", {"model": MODEL, "items": rows}, pretty=True)

    ok = [r for r in rows if not r["problems"] and not r["unchanged"]]
    bad = [r for r in rows if r["problems"]]
    lines = [f"# Wording suggestions from {MODEL}", "",
             f"{len(rows)} patterns: {len(ok)} new suggestions passed the checks, "
             f"{sum(r['unchanged'] for r in rows)} unchanged, {len(bad)} rejected by the checks.",
             "", "Checks: placeholders kept, fixed numbers kept, no alarm words, no jargon, not much longer. "
             "A person still reviews every suggestion before it goes into site/js.", ""]
    for r in rows:
        status = "REJECTED: " + "; ".join(r["problems"]) if r["problems"] else ("unchanged" if r["unchanged"] else "passed checks")
        lines += [f"## {r['id']}  ({status})", f"*{r['where']}*", "", f"- Now: {r['original']}",
                  f"- Suggested: {r['suggestion']}", f"- Why: {r['why']}", ""]
    (DOCS / "wording_suggestions.md").write_text("\n".join(lines), encoding="utf-8", newline="\n")
    print(f"{len(ok)} suggestions passed, {len(bad)} rejected. Review docs/wording_suggestions.md")


if __name__ == "__main__":
    run_main(main)

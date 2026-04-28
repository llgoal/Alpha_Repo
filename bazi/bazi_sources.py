from __future__ import annotations

import json
import re
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, Optional

USER_AGENT = "Mozilla/5.0"


def _post_json(url: str, payload: Dict[str, Any], extra_headers: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
    }
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=90) as response:
        return json.loads(response.read().decode("utf-8", "ignore"))


def _get_text(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as response:
        return response.read().decode("utf-8", "ignore")


def _normalize_pillars(raw: Dict[str, Any]) -> Dict[str, Optional[str]]:
    return {
        "year": raw.get("yearPillar") or raw.get("年柱"),
        "month": raw.get("monthPillar") or raw.get("月柱"),
        "day": raw.get("dayPillar") or raw.get("日柱"),
        "hour": raw.get("hourPillar") or raw.get("时柱"),
    }


def fetch_bazi_lab_sxtwl(*, birth_year: int, birth_month: int, birth_day: int, birth_hour: int,
                         birth_minute: int = 0, gender: str = "male", user_name: str = "",
                         calendar_type: str = "solar") -> Dict[str, Any]:
    payload = {
        "userData": {
            "calendarType": calendar_type,
            "birthYear": birth_year,
            "birthMonth": birth_month,
            "birthDay": birth_day,
            "birthHour": birth_hour,
            "birthMinute": birth_minute,
            "gender": gender,
            "userName": user_name,
        }
    }
    data = _post_json("https://www.bazi-lab.com/api/sxtwl", payload)
    chart = data.get("chart", {})
    return {
        "source": "bazi_lab_sxtwl",
        "pillars": _normalize_pillars(chart),
        "dayMaster": (chart.get("日柱") or "")[:1] or None,
        "raw": data,
    }


def fetch_bazi_lab_deepseek(*, birth_year: int, birth_month: int, birth_day: int, birth_hour: int,
                            birth_minute: int = 0, gender: str = "male", user_name: str = "",
                            location: str = "Beijing", calendar_type: str = "solar") -> Dict[str, Any]:
    payload = {
        "calendarType": calendar_type,
        "birthYear": birth_year,
        "birthMonth": birth_month,
        "birthDay": birth_day,
        "birthHour": birth_hour,
        "birthMinute": birth_minute,
        "gender": gender,
        "userName": user_name,
        "location": location,
    }
    data = _post_json("https://www.bazi-lab.com/api/deepseek/calculate", payload)
    chart = data.get("chart", {})
    return {
        "source": "bazi_lab_deepseek",
        "pillars": _normalize_pillars(chart),
        "dayMaster": (chart.get("dayPillar") or "")[:1] or None,
        "analysis": chart.get("analysis"),
        "raw": data,
    }


def fetch_jiufengshui(*, year: int, month: int, day: int, hour: int, gender: str = "male",
                      name: str = "", use_solar_time: bool = False, bj_hour: Optional[int] = None,
                      bj_minute: int = 0, province: str = "", city: str = "", longitude: float = 0.0) -> Dict[str, Any]:
    payload = {
        "name": name,
        "gender": gender,
        "year": year,
        "month": month,
        "day": day,
        "hour": hour,
        "useSolarTime": use_solar_time,
        "bjHour": bj_hour if bj_hour is not None else hour,
        "bjMinute": bj_minute,
        "province": province,
        "city": city,
        "longitude": longitude,
    }
    data = _post_json("https://jiufengshui.com/api/tools/bazi-analysis/", payload)
    inner = data.get("data", {})
    return {
        "source": "jiufengshui",
        "pillars": _normalize_pillars(inner.get("bazi", {})),
        "dayMaster": inner.get("day_master", {}).get("element"),
        "wuxing": inner.get("wuxing_distribution"),
        "analysis": inner.get("day_master", {}).get("analysis"),
        "raw": data,
    }


def fetch_yisuan(*, year: int, month: int, day: int, hour: int, sex: int = 1) -> Dict[str, Any]:
    query = urllib.parse.urlencode({
        "_year": year,
        "_month": month,
        "_day": day,
        "_hour": hour,
        "_sex": sex,
    })
    html = _get_text(f"https://yisuan.net/app/bazi-wuxing?{query}")

    def extract(label: str) -> Optional[str]:
        match = re.search(label + r"：</h3>(.*?)<", html)
        return match.group(1).strip() if match else None

    pillar_match = re.search(
        r"<td><b>四柱</b></td><td>(.*?)</td><td>(.*?)</td><td>(.*?)</td><td>(.*?)</td>",
        html,
        re.S,
    )
    pillars = None
    if pillar_match:
        cleaned = [re.sub(r"<.*?>", "", item).strip() for item in pillar_match.groups()]
        pillars = {
            "year": cleaned[0],
            "month": cleaned[1],
            "day": cleaned[2],
            "hour": cleaned[3],
        }

    scores = {}
    for element in ["金", "木", "水", "火", "土"]:
        m = re.search(element + r"：([0-9.]+)", html)
        if m:
            scores[element] = float(m.group(1))

    return {
        "source": "yisuan_html",
        "pillars": pillars,
        "favorableElements": extract("喜用神"),
        "wuxingScores": scores or None,
        "rawExcerpt": html[html.find("喜用神") : html.find("日干论命")] if "喜用神" in html and "日干论命" in html else None,
    }


def fetch_all_sources(sample: Dict[str, Any]) -> Dict[str, Any]:
    sex_num = 1 if sample.get("gender", "male") == "male" else 0
    jobs = {
        "bazi_lab_sxtwl": lambda: fetch_bazi_lab_sxtwl(
            birth_year=sample["year"],
            birth_month=sample["month"],
            birth_day=sample["day"],
            birth_hour=sample["hour"],
            birth_minute=sample.get("minute", 0),
            gender=sample.get("gender", "male"),
            user_name=sample.get("name", ""),
            calendar_type=sample.get("calendarType", "solar"),
        ),
        "bazi_lab_deepseek": lambda: fetch_bazi_lab_deepseek(
            birth_year=sample["year"],
            birth_month=sample["month"],
            birth_day=sample["day"],
            birth_hour=sample["hour"],
            birth_minute=sample.get("minute", 0),
            gender=sample.get("gender", "male"),
            user_name=sample.get("name", ""),
            location=sample.get("location", "Beijing"),
            calendar_type=sample.get("calendarType", "solar"),
        ),
        "jiufengshui": lambda: fetch_jiufengshui(
            year=sample["year"],
            month=sample["month"],
            day=sample["day"],
            hour=sample["hour"],
            gender=sample.get("gender", "male"),
            name=sample.get("name", ""),
            use_solar_time=sample.get("useSolarTime", False),
            bj_hour=sample.get("hour"),
            bj_minute=sample.get("minute", 0),
            longitude=sample.get("longitude", 0.0),
            province=sample.get("province", ""),
            city=sample.get("city", ""),
        ),
        "yisuan_html": lambda: fetch_yisuan(
            year=sample["year"],
            month=sample["month"],
            day=sample["day"],
            hour=sample["hour"],
            sex=sex_num,
        ),
    }
    results: Dict[str, Any] = {}
    for name, job in jobs.items():
        try:
            results[name] = job()
        except Exception as exc:
            results[name] = {"source": name, "error": str(exc)}
    return results

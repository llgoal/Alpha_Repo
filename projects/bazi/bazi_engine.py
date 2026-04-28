from __future__ import annotations

from dataclasses import dataclass, asdict, field
from datetime import datetime, timedelta
from typing import Dict, List

STEMS = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"]
BRANCHES = ["子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥"]
STEM_ELEMENTS = {
    "甲": "木", "乙": "木", "丙": "火", "丁": "火", "戊": "土",
    "己": "土", "庚": "金", "辛": "金", "壬": "水", "癸": "水",
}
BRANCH_ELEMENTS = {
    "子": "水", "丑": "土", "寅": "木", "卯": "木", "辰": "土", "巳": "火",
    "午": "火", "未": "土", "申": "金", "酉": "金", "戌": "土", "亥": "水",
}
MONTH_BRANCH_BY_ORDER = ["寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥", "子", "丑"]
YEAR_STEM_TO_MONTH_STEM_START = {
    "甲": "丙", "己": "丙",
    "乙": "戊", "庚": "戊",
    "丙": "庚", "辛": "庚",
    "丁": "壬", "壬": "壬",
    "戊": "甲", "癸": "甲",
}
# Approximate solar-term boundaries for month pillars. Good enough for comparison work,
# but still not a replacement for a full astronomy-backed implementation.
SOLAR_TERM_BOUNDARIES = [
    (2, 4, 0),   # 寅月 starts near 立春
    (3, 6, 1),
    (4, 5, 2),
    (5, 6, 3),
    (6, 6, 4),
    (7, 7, 5),
    (8, 8, 6),
    (9, 8, 7),
    (10, 8, 8),
    (11, 7, 9),
    (12, 7, 10),
    (1, 6, 11),  # 丑月
]


@dataclass
class LocationContext:
    timezone_offset_hours: float = 8.0
    longitude: float = 116.4074
    use_true_solar_time: bool = False


@dataclass
class BirthInput:
    birth_datetime: datetime
    gender: str = "male"
    name: str = ""
    calendar_type: str = "solar"
    day_rollover_hour: int = 0
    location: LocationContext = field(default_factory=LocationContext)


class UnsupportedCalendarError(ValueError):
    pass


def stem_branch(index: int) -> str:
    return STEMS[index % 10] + BRANCHES[index % 12]


def true_solar_time(dt: datetime, location: LocationContext) -> datetime:
    standard_meridian = location.timezone_offset_hours * 15
    delta_minutes = (location.longitude - standard_meridian) * 4
    return dt + timedelta(minutes=delta_minutes)


def normalize_birth_input(birth: BirthInput) -> BirthInput:
    if birth.calendar_type != "solar":
        raise UnsupportedCalendarError(
            "Only solar input is implemented in the local engine right now. "
            "Lunar conversion should be added next with a dedicated calendar library."
        )
    if birth.location.use_true_solar_time:
        birth = BirthInput(
            birth_datetime=true_solar_time(birth.birth_datetime, birth.location),
            gender=birth.gender,
            name=birth.name,
            calendar_type=birth.calendar_type,
            location=birth.location,
        )
    return birth


def get_year_pillar(dt: datetime) -> str:
    year = dt.year
    if (dt.month, dt.day) < (2, 4):
        year -= 1
    return stem_branch(year - 1984)


def get_month_order(dt: datetime) -> int:
    current = 11
    for month, day, order in SOLAR_TERM_BOUNDARIES:
        if dt.month > month or (dt.month == month and dt.day >= day):
            current = order
    if dt.month == 1 and dt.day < 6:
        current = 10
    return current


def get_month_pillar(dt: datetime, year_pillar: str) -> str:
    year_stem = year_pillar[0]
    month_order = get_month_order(dt)
    month_branch = MONTH_BRANCH_BY_ORDER[month_order]
    start_stem = YEAR_STEM_TO_MONTH_STEM_START[year_stem]
    start_index = STEMS.index(start_stem)
    stem = STEMS[(start_index + month_order) % 10]
    return stem + month_branch


def get_day_pillar(dt: datetime, day_rollover_hour: int = 0) -> str:
    # Calibrated against the structured BaZi Lab /api/sxtwl output:
    # 1984-01-31 is 甲子 day in that engine.
    base = datetime(1984, 1, 31)
    day_basis = datetime(dt.year, dt.month, dt.day)
    if day_rollover_hour == 23 and dt.hour >= 23:
        day_basis += timedelta(days=1)
    diff_days = (day_basis - base).days
    return stem_branch(diff_days)


def get_hour_branch_index(hour: int, minute: int) -> int:
    total_minutes = hour * 60 + minute
    shifted = (total_minutes + 60) % (24 * 60)
    return shifted // 120


def get_hour_pillar(dt: datetime, day_pillar: str) -> str:
    day_stem = day_pillar[0]
    hour_branch_index = get_hour_branch_index(dt.hour, dt.minute)
    hour_branch = BRANCHES[hour_branch_index]
    stem_start = {
        "甲": "甲", "己": "甲",
        "乙": "丙", "庚": "丙",
        "丙": "戊", "辛": "戊",
        "丁": "庚", "壬": "庚",
        "戊": "壬", "癸": "壬",
    }[day_stem]
    stem = STEMS[(STEMS.index(stem_start) + hour_branch_index) % 10]
    return stem + hour_branch


def count_wuxing(pillars: List[str]) -> Dict[str, int]:
    scores = {"木": 0, "火": 0, "土": 0, "金": 0, "水": 0}
    for pillar in pillars:
        scores[STEM_ELEMENTS[pillar[0]]] += 1
        scores[BRANCH_ELEMENTS[pillar[1]]] += 1
    return scores


def build_chart(birth: BirthInput) -> Dict:
    birth = normalize_birth_input(birth)
    dt = birth.birth_datetime
    year = get_year_pillar(dt)
    month = get_month_pillar(dt, year)
    day = get_day_pillar(dt, birth.day_rollover_hour)
    hour = get_hour_pillar(dt, day)
    pillars = [year, month, day, hour]
    wuxing = count_wuxing(pillars)
    strongest = max(wuxing, key=wuxing.get)
    weakest = min(wuxing, key=wuxing.get)
    return {
        "engine": "local_approx_v2",
        "calendarType": birth.calendar_type,
        "name": birth.name,
        "gender": birth.gender,
        "birthDateTime": dt.isoformat(timespec="minutes"),
        "location": asdict(birth.location),
        "dayRolloverHour": birth.day_rollover_hour,
        "pillars": {
            "year": year,
            "month": month,
            "day": day,
            "hour": hour,
        },
        "dayMaster": day[0],
        "wuxing": wuxing,
        "dominantElement": strongest,
        "weakestElement": weakest,
        "notes": [
            "Uses solar input only.",
            f"Day rollover hour = {birth.day_rollover_hour:02d}:00.",
            "Day pillar is calibrated to the BaZi Lab structured source using 1984-01-31 = 甲子.",
            "Month pillar is based on approximate solar-term cutovers.",
            "True solar time is supported via longitude offset.",
        ],
    }

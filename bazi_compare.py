from __future__ import annotations

import argparse
import json
from datetime import datetime
from typing import Dict

from bazi_engine import BirthInput, LocationContext, build_chart
from bazi_sources import fetch_all_sources


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Compare local BaZi calculation with multiple web sources.")
    parser.add_argument("--date", required=True, help="Birth date, e.g. 1990-01-01")
    parser.add_argument("--time", default="12:00", help="Birth time, e.g. 09:30")
    parser.add_argument("--name", default="")
    parser.add_argument("--gender", default="male", choices=["male", "female"])
    parser.add_argument("--calendar-type", default="solar", choices=["solar", "lunar"])
    parser.add_argument("--timezone-offset", type=float, default=8.0)
    parser.add_argument("--longitude", type=float, default=116.4074)
    parser.add_argument("--use-true-solar-time", action="store_true")
    parser.add_argument("--location", default="Beijing")
    parser.add_argument("--province", default="")
    parser.add_argument("--city", default="")
    parser.add_argument("--minute", type=int, default=None, help="Override minute value if needed")
    parser.add_argument("--json", action="store_true", help="Emit JSON only")
    return parser.parse_args()


def build_sample(args: argparse.Namespace) -> Dict:
    birth_dt = datetime.strptime(f"{args.date} {args.time}", "%Y-%m-%d %H:%M")
    minute = args.minute if args.minute is not None else birth_dt.minute
    return {
        "name": args.name,
        "gender": args.gender,
        "year": birth_dt.year,
        "month": birth_dt.month,
        "day": birth_dt.day,
        "hour": birth_dt.hour,
        "minute": minute,
        "location": args.location,
        "province": args.province,
        "city": args.city,
        "longitude": args.longitude,
        "useSolarTime": args.use_true_solar_time,
        "timezoneOffset": args.timezone_offset,
        "calendarType": args.calendar_type,
    }


def summarize(result: Dict) -> str:
    lines = []
    local = result["local"]
    lines.append("[local]")
    lines.append("  pillars: " + json.dumps(local["pillars"], ensure_ascii=False))
    lines.append("  wuxing:  " + json.dumps(local["wuxing"], ensure_ascii=False))
    for key, value in result["sources"].items():
        lines.append(f"[{key}]")
        if isinstance(value, dict) and value.get("error"):
            lines.append(f"  error: {value['error']}")
            continue
        lines.append("  pillars: " + json.dumps(value.get("pillars"), ensure_ascii=False))
        if value.get("favorableElements"):
            lines.append(f"  favorable: {value['favorableElements']}")
        if value.get("dayMaster"):
            lines.append(f"  dayMaster: {value['dayMaster']}")
    return "\n".join(lines)


def main() -> None:
    args = parse_args()
    sample = build_sample(args)
    birth_dt = datetime.strptime(f"{args.date} {args.time}", "%Y-%m-%d %H:%M")

    local_result = build_chart(
        BirthInput(
            birth_datetime=birth_dt,
            gender=args.gender,
            name=args.name,
            calendar_type=args.calendar_type,
            location=LocationContext(
                timezone_offset_hours=args.timezone_offset,
                longitude=args.longitude,
                use_true_solar_time=args.use_true_solar_time,
            ),
        )
    )

    sources: Dict[str, Dict] = {}
    for key, fn_result in fetch_all_sources(sample).items():
        sources[key] = fn_result

    result = {"input": sample, "local": local_result, "sources": sources}
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(summarize(result))


if __name__ == "__main__":
    main()

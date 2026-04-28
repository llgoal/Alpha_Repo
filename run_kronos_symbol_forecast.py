#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

WORKSPACE = Path("/Users/amuro/.openclaw/workspace")
SKILL_FORECAST = WORKSPACE / "skills" / "kronos-forecast" / "scripts" / "forecast_csv.py"
INSTALL_SCRIPT = WORKSPACE / "skills" / "kronos-forecast" / "scripts" / "install_kronos.py"
RUNTIME_ROOT = WORKSPACE / "tmp" / "kronos-runtime"
VENV_PYTHON = RUNTIME_ROOT / "venv" / "bin" / "python"


def run(cmd: list[str]) -> None:
    print("+", " ".join(map(str, cmd)))
    subprocess.run(cmd, check=True)


def fetch_yahoo_chart(symbol: str, interval: str, range_: str, include_prepost: bool) -> dict:
    base = f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol)}"
    params = {
        "interval": interval,
        "range": range_,
        "includePrePost": "true" if include_prepost else "false",
        "events": "div,splits",
    }
    url = base + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json,text/plain,*/*",
        "Referer": "https://finance.yahoo.com/",
        "Origin": "https://finance.yahoo.com",
    })
    with urllib.request.urlopen(req, timeout=60) as response:
        return json.loads(response.read().decode("utf-8", "ignore"))


def chart_to_rows(chart: dict) -> list[dict]:
    result = chart["chart"]["result"][0]
    timestamps = result.get("timestamp") or []
    quote = (result.get("indicators") or {}).get("quote", [{}])[0]
    opens = quote.get("open") or []
    highs = quote.get("high") or []
    lows = quote.get("low") or []
    closes = quote.get("close") or []
    volumes = quote.get("volume") or []
    rows: list[dict] = []
    for i, ts in enumerate(timestamps):
        vals = [opens[i], highs[i], lows[i], closes[i]]
        if any(v is None for v in vals):
            continue
        dt = datetime.fromtimestamp(ts, tz=timezone.utc).astimezone()
        close_v = float(closes[i])
        volume_v = float(volumes[i]) if i < len(volumes) and volumes[i] is not None else 0.0
        rows.append({
            "timestamps": dt.isoformat(),
            "open": float(opens[i]),
            "high": float(highs[i]),
            "low": float(lows[i]),
            "close": close_v,
            "volume": volume_v,
            "amount": close_v * volume_v,
        })
    return rows


def write_temp_csv(rows: list[dict]) -> str:
    tmp = tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False, newline="")
    with tmp:
        writer = csv.DictWriter(tmp, fieldnames=["timestamps", "open", "high", "low", "close", "volume", "amount"])
        writer.writeheader()
        writer.writerows(rows)
    return tmp.name


def main() -> None:
    parser = argparse.ArgumentParser(description="Fetch Yahoo OHLCV and run a Kronos forecast for one symbol.")
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--interval", default="5m")
    parser.add_argument("--range", dest="range_", default="5d")
    parser.add_argument("--lookback", type=int, default=256)
    parser.add_argument("--pred-len", type=int, default=4)
    parser.add_argument("--output", required=True)
    parser.add_argument("--include-prepost", action="store_true")
    args = parser.parse_args()

    if not VENV_PYTHON.exists():
        run([sys.executable, str(INSTALL_SCRIPT)])

    chart = fetch_yahoo_chart(args.symbol, args.interval, args.range_, args.include_prepost)
    rows = chart_to_rows(chart)
    if len(rows) < args.lookback:
        raise SystemExit(f"Not enough rows for {args.symbol}: need {args.lookback}, got {len(rows)}")
    temp_csv = write_temp_csv(rows)
    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    run([
        str(VENV_PYTHON),
        str(SKILL_FORECAST),
        "--csv", temp_csv,
        "--output", str(out_path),
        "--lookback", str(args.lookback),
        "--pred-len", str(args.pred_len),
    ])


if __name__ == "__main__":
    main()

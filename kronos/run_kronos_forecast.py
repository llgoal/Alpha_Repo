#!/usr/bin/env python3
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

WORKSPACE = Path("/Users/amuro/.openclaw/workspace")
SKILL_SCRIPT = WORKSPACE / "skills" / "kronos-forecast" / "scripts" / "forecast_csv.py"
INSTALL_SCRIPT = WORKSPACE / "skills" / "kronos-forecast" / "scripts" / "install_kronos.py"
RUNTIME_ROOT = WORKSPACE / "tmp" / "kronos-runtime"
VENV_PYTHON = RUNTIME_ROOT / "venv" / "bin" / "python"


def run(cmd: list[str]) -> None:
    print("+", " ".join(map(str, cmd)))
    subprocess.run(cmd, check=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Workspace wrapper for Kronos CSV forecasting.")
    parser.add_argument("--csv", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--lookback", type=int, default=256)
    parser.add_argument("--pred-len", type=int, default=16)
    args = parser.parse_args()

    if not VENV_PYTHON.exists():
        run([sys.executable, str(INSTALL_SCRIPT)])

    run([
        str(VENV_PYTHON),
        str(SKILL_SCRIPT),
        "--csv", args.csv,
        "--output", args.output,
        "--lookback", str(args.lookback),
        "--pred-len", str(args.pred_len),
    ])


if __name__ == "__main__":
    main()

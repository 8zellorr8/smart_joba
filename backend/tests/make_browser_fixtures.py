"""Prepare clearly synthetic files for the local browser smoke, never college data."""
from pathlib import Path
import os
from backend.app.config import ROOT
from .s1_fixtures import ROW, workbook


def main():
    output = ROOT / ".local" / "qa"
    output.mkdir(parents=True, exist_ok=True)
    first = list(ROW)
    first[0], first[1], first[3] = "Синтетикалық мұғалім", "Импортты тексеру пәні", os.environ.get("SMART_JOBA_SMOKE_GROUP", "TEST-IMPORT-A")
    second = list(first)
    second[0], second[1], second[6] = "ВАКАНСИЯ", "Нақтылауды қажет ететін пән", "=1+1"
    (output / "synthetic-s1-demo.xlsx").write_bytes(workbook([first, second], stray=True))
    updated = list(first)
    updated[5] = 102
    (output / "synthetic-s1-updated.xlsx").write_bytes(workbook([updated, second]))


if __name__ == "__main__":
    main()

"""Reproducible synthetic ENG-007/008 and NFR-004 measurement; no database.

Run from the repository: python -m scripts.benchmark_planning
RSS is sampled for the complete process (native allocations included), while
tracemalloc measures Python allocations for validation only. Neither is a hard
OS memory reservation or a guarantee for another dataset/computer.
"""
from copy import deepcopy
from datetime import datetime, timezone
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import threading
import time
import tracemalloc

import psutil

from backend.app.domain.validation import validate_schedule
from backend.app.infrastructure.solver import materialize, solve
from backend.tests.planning_fixtures import rules_document, snapshot


def control():
    data = snapshot()
    cal = deepcopy(data["calendars"]["c0"])
    cal["end"] = "2026-09-14"
    cal["periods"][0]["end"] = cal["end"]
    cal["slots"] += [{"id": "third", "label": "SYNTHETIC TEST", "start": "13:00", "end": "14:30"},
                     {"id": "fourth", "label": "SYNTHETIC TEST", "start": "14:30", "end": "16:00"}]
    template = data["demands"][0]
    data["demands"] = [{**deepcopy(template), "id": f"d{i}", "group_id": f"g{i // 2}", "group": f"SYNTHETIC group {i // 2}",
        "subject": f"SYNTHETIC subject {i}", "teacher_id": f"t{i % 8}", "teacher": f"SYNTHETIC teacher {i % 8}",
        "assignment_id": f"a{i}", "assignment_source_revision_id": f"rev{i}", "calendar_id": f"c{i // 2}",
        "source_row_id": f"row{i}", "source": {"row_id": f"row{i}", "coordinate": f"K{i+2}"}, "source_amount": "8"} for i in range(32)]
    data["group_ids"] = [f"g{i}" for i in range(16)]
    data["calendars"] = {f"c{i}": deepcopy(cal) for i in range(16)}
    data["rooms"] = [{**deepcopy(data["rooms"][0]), "id": f"room{i}", "code": f"SYNTHETIC room {i}"} for i in range(4)]
    data["rules"] = rules_document(data["group_ids"], [f"t{i}" for i in range(8)], [f"room{i}" for i in range(4)], [f"d{i}" for i in range(32)])
    for window in data["rules"]["availability"]: window["end"] = "16:00"
    data["dependencies"]["calendars"] = {f"c{i}": 1 for i in range(16)}
    data["dependencies"]["rooms"] = {f"room{i}": 1 for i in range(4)}
    return data


def main():
    data = control()
    stop = threading.Event(); rss = []
    def sample():
        process = psutil.Process()
        while not stop.wait(.01): rss.append(process.memory_info().rss)
    monitor = threading.Thread(target=sample, daemon=True); monitor.start()
    start = time.perf_counter(); result = solve(data, 30); solve_elapsed = time.perf_counter() - start
    # Validator benchmark always uses 128 actual occurrences, even if the search
    # reaches its limit. This deterministic control is not a claimed solver result.
    days = ["2026-09-" + str(d).zfill(2) for d in (1, 2, 3, 4, 7, 8, 9, 10, 11, 14)]
    order = list(range(0, 32, 2)) + list(range(1, 32, 2))
    selected = []
    for repetition in range(4):
        for index, demand_index in enumerate(order):
            demand = data["demands"][demand_index]
            rank = repetition * 32 + index
            slot = data["calendars"][demand["calendar_id"]]["slots"][(rank // 4) % 4]
            selected.append({"demand_id": demand["id"], "group_id": demand["group_id"], "teacher_id": demand["teacher_id"],
                "date": days[rank // 16], "start": slot["start"], "end": slot["end"], "slot_id": slot["id"], "room_id": f"room{rank % 4}"})
    validation_events = materialize(data, selected)
    tracemalloc.start(); start = time.perf_counter()
    report = validate_schedule(data, validation_events)
    validation_elapsed = time.perf_counter() - start
    _, python_peak = tracemalloc.get_traced_memory(); tracemalloc.stop()
    stop.set(); monitor.join()
    measured = {"date_utc": datetime.now(timezone.utc).isoformat(), "synthetic_only": True,
        "control_assumption": "Synthetic engineering control, not a college-approved capacity dataset",
        "platform": platform.platform(), "machine": platform.machine(), "processor": platform.processor(),
        "logical_cpus": os.cpu_count(), "physical_ram_bytes": psutil.virtual_memory().total,
        "python": platform.python_version(), "ortools": importlib.metadata.version("ortools"), "psutil": importlib.metadata.version("psutil"),
        "groups": 16, "demands": 32, "teachers": 8, "rooms": 4, "search_limit_seconds": 30,
        "candidate_count": result.get("candidate_count"), "solver_events": len(result["events"]), "status": result["status"], "raw_status": result["raw_status"],
        "solve_wall_seconds": round(solve_elapsed, 6), "solver_wall_seconds": result.get("solver_seconds"),
        "validation_wall_seconds": round(validation_elapsed, 6), "validation_valid": report["valid"], "validation_complete": report["complete"],
        "validation_event_count": len(validation_events), "validation_input": "Deterministic synthetic control independent of the solver outcome",
        "sampled_process_peak_rss_bytes": max(rss, default=psutil.Process().memory_info().rss), "validation_python_peak_bytes": python_peak,
        "sampling_interval_seconds": .01, "worker_memory_limit_mib": 768, "workers": 1}
    destination = Path("docs/implementation/stage-5-planning-benchmark.json")
    destination.write_text(json.dumps(measured, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(measured, ensure_ascii=False, indent=2))


if __name__ == "__main__": main()

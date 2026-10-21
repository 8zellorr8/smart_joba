from copy import deepcopy
import random

import pytest

from backend.app.domain.planning import candidates, readiness
from backend.app.domain.validation import pairwise_conflicts, validate_schedule
from backend.app.infrastructure.solver import build_model, classify_status, solve
from backend.app.domain.schedule import find_conflicts
from .planning_fixtures import snapshot


def test_feasible_model_is_independently_valid_complete_and_exact():
    data = snapshot()
    result = solve(data, 2)
    assert result["status"] == "feasible"
    report = validate_schedule(data, result["events"])
    assert report["valid"] and report["complete"] and not report["has_conflicts"]
    assert all(h["planned_minutes"] == 180 and h["remaining_minutes"] == 0 for h in report["hours"])
    assert report["notes"] == ["EXTERNAL_OCCUPANCY_UNVERIFIED"]


@pytest.mark.parametrize("change,expected", [
    (lambda d: d.update(rules=None), "RULES_UNCONFIRMED"),
    (lambda d: d["demands"][0].update(whole_group=False), "SUBGROUP_OR_JOINT_UNSUPPORTED"),
    (lambda d: d["demands"][0].update(confirmed=False), "ASSIGNMENT_UNCONFIRMED"),
    (lambda d: d["demands"][0].update(source_amount=None), "HOURS_UNCONFIRMED"),
    (lambda d: d["rules"].update(needs=[]), "ROOM_NEEDS_UNKNOWN"),
    (lambda d: d["rules"].update(availability=[]), "AVAILABILITY_UNKNOWN"),
    (lambda d: d["rules"]["groups"][0].update(size=None), "GROUP_SIZE_UNKNOWN"),
    (lambda d: d["rules"]["rooms"][0].update(capacity=None), "ROOM_CAPACITY_UNKNOWN"),
    (lambda d: d["rooms"][0].update(exclusive=None), "ROOM_MODEL_UNCONFIRMED"),
    (lambda d: d["calendars"]["c0"].update(confirmed=False), "CALENDAR_UNCONFIRMED"),
])
def test_unknowns_are_blocking_questions(change, expected):
    data = snapshot(); change(data)
    assert expected in {q["code"] for q in readiness(data)}


def test_impossible_model_is_proven_infeasible_not_timeout():
    data = snapshot()
    data["demands"][0]["source_amount"] = "100"
    result = solve(data, 2)
    assert result["status"] == "infeasible" and result["raw_status"] == "INFEASIBLE"
    assert result["diagnostics"][0]["source"]["coordinate"].startswith("K")


def test_actual_solver_time_limit_is_not_infeasible():
    result = solve(snapshot(), 0)
    assert result["status"] == "time_limit_without_solution" and result["raw_status"] == "UNKNOWN"


def test_native_invalid_and_time_limited_feasible_statuses_remain_distinct():
    from ortools.sat.python import cp_model
    model = cp_model.CpModel(); model.new_int_var(5, 1, "invalid_bounds")
    solver = cp_model.CpSolver(); native = solver.solve(model)
    assert solver.status_name(native) == "MODEL_INVALID"
    assert classify_status(solver.status_name(native)) == "failed"
    assert classify_status("FEASIBLE") == "feasible"
    assert classify_status("OPTIMAL") == "feasible"
    # A test-only objective exercises CP-SAT's native FEASIBLE status at a time
    # limit. Production remains a feasibility model with no quality objective.
    import time
    limited = cp_model.CpModel()
    value = limited.new_int_var(0, 1000000, "native_status_control")
    limited.maximize(value)
    limited.add_decision_strategy([value], cp_model.CHOOSE_FIRST, cp_model.SELECT_MIN_VALUE)
    solver = cp_model.CpSolver()
    solver.parameters.cp_model_presolve = False
    solver.parameters.search_branching = cp_model.FIXED_SEARCH
    solver.parameters.num_search_workers = 1
    solver.parameters.max_time_in_seconds = 1
    class CrossTimeLimit(cp_model.CpSolverSolutionCallback):
        def on_solution_callback(self): time.sleep(1.1)
    native = solver.solve(limited, CrossTimeLimit())
    assert solver.status_name(native) == "FEASIBLE"
    assert classify_status(solver.status_name(native)) == "feasible"


def test_solver_adapter_exposes_invalid_model_without_infeasible_claim(monkeypatch):
    from ortools.sat.python import cp_model
    from backend.app.infrastructure import solver
    model = cp_model.CpModel(); model.new_int_var(5, 1, "invalid_bounds")
    monkeypatch.setattr(solver, "build_model", lambda data: (model, [], []))
    result = solver.solve(snapshot(), 2)
    assert result["status"] == "failed" and result["raw_status"] == "MODEL_INVALID"


def test_candidate_budget_is_an_error_not_infeasibility(monkeypatch):
    from backend.app.domain import planning
    monkeypatch.setattr(planning, "MAX_CANDIDATES", 1)
    result = solve(snapshot(), 2)
    assert result["status"] == "failed" and result["raw_status"] == "MODEL_SIZE_LIMIT"


def test_confirmed_pin_is_kept_and_other_events_rebuilt():
    data = snapshot(); first = solve(data, 2)
    pin = {**first["events"][0], "pinned": True}; data["pins"] = [pin]
    result = solve(data, 2)
    assert pin in result["events"] and validate_schedule(data, result["events"])["valid"]


def test_cancelled_pin_is_preserved_and_not_reinstated_under_another_id():
    data = snapshot(); first = solve(data, 2)
    # Lower the amount to leave spare domain capacity for the cancellation.
    data["demands"][0]["source_amount"] = "2"
    pin = {**next(e for e in first["events"] if e["demand_id"] == "d0"), "pinned": True, "cancelled": True}
    data["pins"] = [pin]
    result = solve(data, 2)
    assert pin in result["events"] and validate_schedule(data, result["events"])["valid"]
    active = [e for e in result["events"] if not e["cancelled"]]
    assert not any(all(e[k] == pin[k] for k in ("demand_id", "date", "start", "end", "room_id")) for e in active)


@pytest.mark.parametrize("mutation,code", [
    (lambda e: e[0].update(date="2026-11-10"), "CALENDAR_FORBIDDEN"),
    (lambda e: e[0].update(start="08:30"), "TIME_GRID_INVALID"),
    (lambda e: e[0].update(teacher_id="forged"), "ASSIGNMENT_MISMATCH"),
    (lambda e: e[0].update(subject="forged label"), "ASSIGNMENT_MISMATCH"),
    (lambda e: e.pop(), "HOURS_INCOMPLETE"),
    (lambda e: e.append(deepcopy(e[0])), "EVENT_MALFORMED"),
    (lambda e: e[0].update(date="broken"), "EVENT_MALFORMED"),
    (lambda e: e[0].update(room_revision=999), "ROOM_CHANGED"),
])
def test_independent_validator_rejects_corrupted_result(mutation, code):
    data = snapshot(); events = solve(data, 2)["events"]; mutation(events)
    report = validate_schedule(data, events)
    assert not report["valid"] and code in {e["code"] for e in report["errors"]}


def test_validator_rebuilds_conflicts_ignoring_solver_exclusivity_flags():
    data = snapshot(); events = solve(data, 2)["events"]
    events[1].update(date=events[0]["date"], start=events[0]["start"], end=events[0]["end"], room_exclusive=False)
    report = validate_schedule(data, events)
    assert not report["valid"] and report["has_conflicts"]


def test_room_features_capacity_availability_and_known_busy_are_checked():
    data = snapshot(); events = solve(data, 2)["events"]
    data["rules"]["rooms"][0]["capacity"] = 5
    data["rules"]["availability"] = []
    data["rules"]["busy"] = [{"resource_type": "teacher", "resource_id": "t", "date": events[0]["date"], "start": "09:00", "end": "12:00", "source": "SYNTHETIC outside occupancy"}]
    report = validate_schedule(data, events)
    assert {"ROOM_UNSUITABLE", "RESOURCE_UNAVAILABLE", "EXTERNAL_BUSY"} <= {e["code"] for e in report["errors"]}
    assert not candidates(data)


def test_pin_change_is_detected_without_solver_status():
    data = snapshot(); events = solve(data, 2)["events"]
    data["pins"] = [{**events[0], "pinned": True}]
    assert "PIN_CHANGED" in {e["code"] for e in validate_schedule(data, events)["errors"]}


def test_sweep_matches_independent_pairwise_oracle_random_and_boundaries():
    rng = random.Random(20261021)
    for _ in range(100):
        events = []
        for i in range(25):
            start = rng.randrange(8, 15)
            events.append({"id": str(i), "date": f"2026-09-0{rng.randrange(1, 4)}", "start": f"{start:02}:00", "end": f"{start+1:02}:00",
                "teacher_id": str(rng.randrange(4)), "group_id": str(rng.randrange(4)), "room_id": str(rng.randrange(4)), "room_exclusive": True,
                "cancelled": rng.choice([False, False, True])})
        fast = find_conflicts(events, 5000)
        assert {(e["resource_type"], e["resource_id"], *e["event_ids"]) for e in fast["conflicts"]} == pairwise_conflicts(events)


def test_domain_validator_has_no_framework_or_solver_imports():
    import ast
    from pathlib import Path
    source = Path("backend/app/domain/validation.py").read_text()
    tree = ast.parse(source)
    imports = [n.module or "" for n in ast.walk(tree) if isinstance(n, ast.ImportFrom)]
    assert not any(x in name for name in imports for x in ("infrastructure", "application", "fastapi", "sqlalchemy", "ortools"))
    assert validate_schedule(snapshot(), [])["valid"] is False


def test_available_windows_merge_touching_intervals_but_not_gaps():
    from backend.app.domain.planning import available
    rules = snapshot()["rules"]
    template = rules["availability"][0]
    rules["availability"] = [{**template, "start": "09:00", "end": "10:00"}, {**template, "start": "10:00", "end": "12:00"}]
    assert available(rules, "teacher", "t", "2026-09-01", "09:00", "10:30")
    rules["availability"][1]["start"] = "10:01"
    assert not available(rules, "teacher", "t", "2026-09-01", "09:00", "10:30")


def test_validator_runs_in_fresh_interpreter_with_http_db_and_solver_imports_blocked():
    import json
    import subprocess
    import sys
    code = """import sys,json
sys.modules.update({name: None for name in ('fastapi','sqlalchemy','ortools')})
from backend.app.domain.validation import validate_schedule
print(json.dumps(validate_schedule(json.load(sys.stdin), [])['valid']))
"""
    result = subprocess.run([sys.executable, "-c", code], input=json.dumps(snapshot()), text=True, capture_output=True, timeout=15)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "false"

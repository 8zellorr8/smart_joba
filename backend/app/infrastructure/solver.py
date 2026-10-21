"""Finite feasibility model; the independent validator does not import this file."""
from collections import defaultdict
from time import perf_counter
import uuid

from ortools.sat.python import cp_model

from ..domain.planning import MAX_EVENTS, candidates, event_minutes, required_minutes, resource_keys

def classify_status(raw):
    # There is no quality objective in MVP. A raw OPTIMAL proves feasibility,
    # not a best timetable; preserve it separately without advertising optimality.
    return {"OPTIMAL": "feasible", "FEASIBLE": "feasible", "INFEASIBLE": "infeasible",
            "UNKNOWN": "time_limit_without_solution", "MODEL_INVALID": "failed"}.get(raw, "failed")


def build_model(snapshot):
    domain = candidates(snapshot)
    model = cp_model.CpModel()
    variables, by_demand, intervals, by_key = [], defaultdict(list), defaultdict(list), {}
    for i, event in enumerate(domain):
        variable = model.new_bool_var(f"x_{i}")
        variables.append(variable)
        by_demand[event["demand_id"]].append(event_minutes(event) * variable)
        interval = model.new_optional_fixed_size_interval_var(
            int(event["start"][:2]) * 60 + int(event["start"][3:]), event_minutes(event), variable, f"o_{i}")
        for kind, resource in resource_keys(event):
            intervals[(event["date"], kind, resource)].append(interval)
        by_key[(event["demand_id"], event["date"], event["start"], event["end"], event["room_id"])] = variable
    for demand in snapshot["demands"]:
        model.add(sum(by_demand[demand["id"]]) == required_minutes(demand, snapshot["calendars"][demand["calendar_id"]]))
    for bucket in intervals.values():
        model.add_no_overlap(bucket)
    model.add(sum(variables) <= MAX_EVENTS - sum(e["cancelled"] for e in snapshot["pins"]))
    for event in snapshot["pins"]:
        key = (event["demand_id"], event["date"], event["start"], event["end"], event["room_id"])
        if key in by_key:
            model.add(by_key[key] == (0 if event["cancelled"] else 1))
        elif not event["cancelled"]:
            model.add(False)  # A confirmed pin cannot be silently removed.
    return model, domain, variables


def materialize(snapshot, selected):
    demands = {d["id"]: d for d in snapshot["demands"]}
    rooms = {r["id"]: r for r in snapshot["rooms"]}
    pins = {(e["demand_id"], e["date"], e["start"], e["end"], e["room_id"]): e for e in snapshot["pins"] if not e["cancelled"]}
    events = [dict(e) for e in snapshot["pins"] if e["cancelled"]]
    for item in selected:
        key = (item["demand_id"], item["date"], item["start"], item["end"], item["room_id"])
        if key in pins:
            events.append(dict(pins[key]))
            continue
        demand, room = demands[item["demand_id"]], rooms[item["room_id"]]
        event = {k: demand[k] for k in ("assignment_id", "assignment_source_revision_id", "teacher_id", "teacher", "group_id", "group", "subject", "calendar_id", "calendar_revision")}
        events.append({**event, **item, "id": str(uuid.uuid5(uuid.UUID(snapshot["snapshot_id"]), "|".join(key))),
                       "base_date": item["date"], "assignment_revision": demand["revision"], "semester": snapshot["semester"],
                       "room": room["code"], "room_revision": room["revision"], "room_exclusive": True,
                       "source_row_id": demand["source_row_id"], "source_coordinate": demand["source"]["coordinate"],
                       "cancelled": False, "pinned": False})
    return events


def solve(snapshot, seconds=30, stage=lambda name: None):
    started = perf_counter()
    stage("building")
    try:
        model, domain, variables = build_model(snapshot)
    except ValueError as error:
        return {"status": "failed", "raw_status": "MODEL_SIZE_LIMIT", "diagnostics": [{"code": str(error)}], "events": []}
    invalid = model.validate()
    if invalid:
        return {"status": "failed", "raw_status": "MODEL_INVALID", "diagnostics": [{"code": "MODEL_INVALID"}], "events": []}
    stage("searching")
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = seconds
    solver.parameters.num_search_workers = 1
    solver.parameters.random_seed = 0
    solver.parameters.log_search_progress = False
    native_status = solver.solve(model)
    raw = solver.status_name(native_status)
    status = classify_status(raw)
    events = materialize(snapshot, [e for e, v in zip(domain, variables) if solver.value(v)]) if status == "feasible" else []
    diagnostics = [{"code": "DEMAND_DOMAIN", "demand_id": d["id"], "source": d["source"],
                    "subject": d["subject"], "group": d["group"],
                    "required_minutes": required_minutes(d, snapshot["calendars"][d["calendar_id"]]),
                    "candidate_count": sum(e["demand_id"] == d["id"] for e in domain)} for d in snapshot["demands"]]
    return {"status": status, "raw_status": raw, "events": events, "diagnostics": diagnostics,
            "candidate_count": len(domain), "solver_seconds": solver.wall_time, "elapsed_seconds": round(perf_counter() - started, 6)}

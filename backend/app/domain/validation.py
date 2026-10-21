"""ENG-007: rebuild validity and completeness from concrete occurrences.

No solver, HTTP, ORM, candidate-domain or cached-occupancy dependency. Shared
calendar/rule meanings are reused; all checked quantities are reconstructed.
"""
from collections import defaultdict
from datetime import date
from time import perf_counter

from .calendar import amount_text, calendar_dates, minute_of_day
from .planning import (RULE_VERSION, available, busy_intersections, readiness,
                       required_minutes, resource_keys, room_suitable)
from .schedule import find_conflicts
from fractions import Fraction


def pairwise_conflicts(events):
    """Small, deliberately simple test oracle, not used by the solver."""
    found = set()
    for i, a in enumerate(events):
        if a["cancelled"]:
            continue
        for b in events[i + 1:]:
            if (b["cancelled"] or a["date"] != b["date"] or a["start"] >= b["end"] or b["start"] >= a["end"]):
                continue
            for kind in ("teacher", "group", "room"):
                if a[kind + "_id"] == b[kind + "_id"]:
                    found.add((kind, a[kind + "_id"], *sorted((a["id"], b["id"]))))
    return found


def validate_schedule(snapshot, events, identity=None):
    started = perf_counter()
    questions = readiness(snapshot)
    errors, usable, seen, totals = [], [], set(), defaultdict(int)
    demands = {d["id"]: d for d in snapshot["demands"]}
    rooms = {r["id"]: r for r in snapshot["rooms"]}
    rules = snapshot.get("rules")

    def error(code, event=None, **values):
        demand = demands.get(event.get("demand_id") if event else values.get("demand_id"))
        labels = {k: demand[k] for k in ("subject", "group")} if demand else {}
        errors.append({"code": code, **labels, **({"event_id": event.get("id"), "date": event.get("date")} if event else {}), **values})

    for event in events:
        try:
            if not isinstance(event.get("cancelled"), bool) or not isinstance(event.get("pinned"), bool):
                raise ValueError()
            date.fromisoformat(event["date"])
            for field in ("start", "end"):
                h, m = event[field].split(":")
                if len(h) != 2 or len(m) != 2 or not (0 <= int(h) <= 23 and 0 <= int(m) <= 59):
                    raise ValueError()
            minutes = minute_of_day(event["end"]) - minute_of_day(event["start"])
            if minutes <= 0 or not event["id"] or event["id"] in seen:
                raise ValueError()
            seen.add(event["id"])
            if event["cancelled"]:
                continue
            demand = demands.get(event["demand_id"])
            if not demand:
                error("ASSIGNMENT_OUTSIDE_SCOPE", event)
                continue
            calendar = snapshot["calendars"].get(demand["calendar_id"])
            if not calendar:
                error("CALENDAR_UNCONFIRMED", event)
                continue
            expected = {"assignment_id": demand["assignment_id"], "assignment_revision": demand["revision"],
                        "assignment_source_revision_id": demand["assignment_source_revision_id"],
                        "group_id": demand["group_id"], "teacher_id": demand["teacher_id"],
                        "calendar_id": demand["calendar_id"], "calendar_revision": demand["calendar_revision"],
                        "subject": demand["subject"], "group": demand["group"], "teacher": demand["teacher"],
                        "source_row_id": demand["source_row_id"], "source_coordinate": demand["source"]["coordinate"],
                        "semester": snapshot["semester"]}
            if any(event.get(k) != v for k, v in expected.items()):
                error("ASSIGNMENT_MISMATCH", event, source=demand["source"])
            room = rooms.get(event["room_id"])
            if not room or event.get("room_revision") != room["revision"] or event.get("room") != room["code"]:
                error("ROOM_CHANGED", event)
            day = calendar_dates(calendar, event["date"], event["date"])[0]
            if not day["allowed"] or day["semester"] != snapshot["semester"]:
                error("CALENDAR_FORBIDDEN", event)
            if (event["start"], event["end"]) not in {(s["start"], s["end"]) for s in calendar["slots"]}:
                error("TIME_GRID_INVALID", event)
            if rules:
                if not room_suitable(rules, demand, event["room_id"]):
                    error("ROOM_UNSUITABLE", event, source=rules["source"])
                for kind in ("teacher", "room"):
                    if not available(rules, kind, event[kind + "_id"], event["date"], event["start"], event["end"]):
                        error("RESOURCE_UNAVAILABLE", event, resource_type=kind, resource_id=event[kind + "_id"])
                for busy in busy_intersections(rules, event):
                    error("EXTERNAL_BUSY", event, resource_type=busy["resource_type"], resource_id=busy["resource_id"], source=busy["source"])
            totals[demand["id"]] += minutes
            # Never trust a solver-provided room_exclusive flag to hide conflicts.
            usable.append({**event, "room_exclusive": True})
        except (KeyError, TypeError, ValueError, AttributeError):
            error("EVENT_MALFORMED", event if isinstance(event, dict) else None)
    conflict_report = find_conflicts(usable)
    by_id = {e["id"]: e for e in usable}
    names = {(kind, d[kind + "_id"]): d[kind] for d in demands.values() for kind in ("teacher", "group")}
    names.update({("room", r["id"]): r["code"] for r in rooms.values()})
    for conflict in conflict_report["conflicts"]:
        conflict["resource_name"] = names.get((conflict["resource_type"], conflict["resource_id"]), "?")
        conflict["events"] = [{k: by_id[i].get(k) for k in ("id", "date", "start", "end", "subject", "group")} for i in conflict["event_ids"]]
    for pin in snapshot.get("pins", []):
        actual = next((e for e in events if e.get("id") == pin["id"]), None)
        if actual is None or any(actual.get(k) != v for k, v in pin.items() if k != "series_id"):
            error("PIN_CHANGED", pin)
        if pin["cancelled"] and any(not e.get("cancelled", True) and all(e.get(k) == pin[k] for k in ("demand_id", "date", "start", "end", "room_id")) for e in events):
            error("PIN_CHANGED", pin)
    hours = []
    for demand in demands.values():
        calendar = snapshot["calendars"].get(demand["calendar_id"])
        required = required_minutes(demand, calendar) if calendar else None
        planned = totals[demand["id"]]
        remaining = None if required is None else required - planned
        norm = calendar["academic_minutes"] if calendar else 45
        hours.append({"demand_id": demand["id"], "subject": demand["subject"], "group": demand["group"],
                      "required_minutes": required, "planned_minutes": planned, "remaining_minutes": remaining,
                      "planned": amount_text(Fraction(planned, norm)),
                      "required": amount_text(Fraction(required, norm)) if required is not None else None,
                      "remaining": amount_text(Fraction(remaining, norm)) if remaining is not None else None})
        if remaining is None or remaining != 0:
            error("HOURS_INCOMPLETE", demand_id=demand["id"], source=demand["source"])
    if not demands:
        error("DRAFT_EMPTY")
    complete = bool(demands) and all(h["remaining_minutes"] == 0 for h in hours)
    return {"identity": identity or snapshot.get("identity"), "dependencies": snapshot["dependencies"],
            "rule_version": RULE_VERSION, "check_scope": {"group_ids": snapshot["group_ids"], "semester": snapshot["semester"],
            "context_id": snapshot["context_id"]}, "errors": errors[:200], "errors_truncated": len(errors) > 200,
            "questions": questions[:200], "questions_truncated": len(questions) > 200,
            **conflict_report, "hours": hours, "complete": complete,
            "valid": complete and not errors and not questions and not conflict_report["has_conflicts"],
            "notes": [] if rules and rules["external_confirmed"] else ["EXTERNAL_OCCUPANCY_UNVERIFIED"],
            "event_count": len(events), "actual_registered": False, "elapsed_seconds": round(perf_counter() - started, 6)}

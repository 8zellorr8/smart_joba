"""Shared meanings of RULE-003/005, not the solver's occupancy or answer.

All quantities are civil minutes. Unknown inputs are readiness questions, never
implicit availability, an empty equipment requirement, or zero required hours.
"""
from datetime import date
from fractions import Fraction

from .calendar import calendar_dates, minute_of_day

RULE_VERSION = "whole-group-concrete-dates-v1"
ALGORITHM_VERSION = "cp-sat-whole-group-v1"
MAX_CANDIDATES = 20000
MAX_EVENTS = 10000


def required_minutes(demand, calendar):
    amount = demand.get("source_amount")
    factor = {"minute": 1, "academic_hour": calendar["academic_minutes"],
              "pair": calendar["pair_minutes"]}.get(demand.get("source_unit"))
    if amount is None or factor is None:
        return None
    result = Fraction(amount) * factor
    return result.numerator if result.denominator == 1 and result >= 0 else None


def resource_keys(event):
    return [(kind, event[kind + "_id"]) for kind in ("teacher", "group", "room")]


def available(rules, kind, resource_id, day, start, end):
    windows = sorted((w["start"], w["end"]) for w in rules["availability"]
        if w["resource_type"] == kind and w["resource_id"] == resource_id
        and w["start_date"] <= day <= w["end_date"] and date.fromisoformat(day).weekday() in w["weekdays"])
    cursor = start
    for left, right in windows:
        if left > cursor: break
        if right > cursor: cursor = right
        if cursor >= end: return True
    return False


def busy_intersections(rules, event):
    keys = set(resource_keys(event))
    return [b for b in rules["busy"] if (b["resource_type"], b["resource_id"]) in keys
            and b["date"] == event["date"] and b["start"] < event["end"] and event["start"] < b["end"]]


def room_suitable(rules, demand, room_id):
    room = next((r for r in rules["rooms"] if r["room_id"] == room_id), None)
    group = next((g for g in rules["groups"] if g["group_id"] == demand["group_id"]), None)
    need = next((n for n in rules["needs"] if n["demand_id"] == demand["id"]), None)
    return bool(room and group and need and room["capacity"] is not None and group["size"] is not None
                and room["capacity"] >= group["size"] and set(need["features"]) <= set(room["features"]))


def readiness(snapshot):
    questions = list(snapshot.get("source_questions", []))
    rules = snapshot.get("rules")
    if not rules or not rules["confirmed"] or not rules["source"].strip():
        questions.append({"code": "RULES_UNCONFIRMED"})
        return questions
    if not snapshot["demands"]:
        questions.append({"code": "DEMANDS_EMPTY"})
    if not snapshot["rooms"]:
        questions.append({"code": "ROOMS_EMPTY"})
    timezones = set()
    for demand in snapshot["demands"]:
        def issue(code):
            questions.append({"code": code, "demand_id": demand["id"], "source": demand["source"], "subject": demand["subject"], "group": demand["group"]})
        if not demand.get("confirmed"):
            issue("ASSIGNMENT_UNCONFIRMED")
        if not demand.get("whole_group"):
            issue("SUBGROUP_OR_JOINT_UNSUPPORTED")
        calendar = snapshot["calendars"].get(demand["calendar_id"])
        if not calendar or not all(calendar[k] for k in ("confirmed", "units_confirmed", "timezone_confirmed")):
            issue("CALENDAR_UNCONFIRMED")
            continue
        timezones.add(calendar["timezone"])
        if required_minutes(demand, calendar) is None:
            issue("HOURS_UNCONFIRMED")
        if not any(g["group_id"] == demand["group_id"] and g["size"] is not None for g in rules["groups"]):
            issue("GROUP_SIZE_UNKNOWN")
        if not any(n["demand_id"] == demand["id"] for n in rules["needs"]):
            issue("ROOM_NEEDS_UNKNOWN")
        if not any(w["resource_type"] == "teacher" and w["resource_id"] == demand["teacher_id"] for w in rules["availability"]):
            issue("AVAILABILITY_UNKNOWN")
    for room in snapshot["rooms"]:
        if not room["confirmed"] or room["exclusive"] is not True:
            questions.append({"code": "ROOM_MODEL_UNCONFIRMED", "room_id": room["id"], "resource_name": room["code"]})
        if not any(r["room_id"] == room["id"] and r["capacity"] is not None for r in rules["rooms"]):
            questions.append({"code": "ROOM_CAPACITY_UNKNOWN", "room_id": room["id"], "resource_name": room["code"]})
        if not any(w["resource_type"] == "room" and w["resource_id"] == room["id"] for w in rules["availability"]):
            questions.append({"code": "AVAILABILITY_UNKNOWN", "room_id": room["id"], "resource_name": room["code"]})
    for pin in snapshot.get("pins", []):
        demand = next((d for d in snapshot["demands"] if d["id"] == pin["demand_id"]), None)
        calendar = snapshot["calendars"].get(pin["calendar_id"])
        room = next((r for r in snapshot["rooms"] if r["id"] == pin["room_id"]), None)
        if (not demand or not calendar or not room or pin["assignment_revision"] != demand["revision"]
                or pin["calendar_revision"] != demand["calendar_revision"] or pin["room_revision"] != room["revision"]
                or pin["teacher_id"] != demand["teacher_id"]
                or not any((s["start"], s["end"]) == (pin["start"], pin["end"]) for s in calendar["slots"])):
            questions.append({"code": "PIN_INPUT_CHANGED", "event_id": pin["id"]})
    if len(timezones) > 1:
        questions.append({"code": "MIXED_TIMEZONES_UNSUPPORTED"})
    return questions


def candidates(snapshot):
    """Finite CP-SAT variable domain, bounded before allocating solver variables."""
    result = []
    for demand in snapshot["demands"]:
        calendar = snapshot["calendars"][demand["calendar_id"]]
        for day in calendar_dates(calendar):
            if not day["allowed"] or day["semester"] != snapshot["semester"]:
                continue
            for slot in calendar["slots"]:
                if not available(snapshot["rules"], "teacher", demand["teacher_id"], day["date"], slot["start"], slot["end"]):
                    continue
                for room in snapshot["rooms"]:
                    event = {"demand_id": demand["id"], "teacher_id": demand["teacher_id"], "group_id": demand["group_id"],
                             "room_id": room["id"], "date": day["date"], "start": slot["start"], "end": slot["end"], "slot_id": slot["id"]}
                    if (room_suitable(snapshot["rules"], demand, room["id"])
                            and available(snapshot["rules"], "room", room["id"], day["date"], slot["start"], slot["end"])
                            and not busy_intersections(snapshot["rules"], event)):
                        result.append(event)
                        if len(result) > MAX_CANDIDATES:
                            raise ValueError("MODEL_SIZE_LIMIT")
    return result


def event_minutes(event):
    return minute_of_day(event["end"]) - minute_of_day(event["start"])

"""CAL/HRS: explicit civil dates and exact durations, independent of HTTP/DB.

Intervals are inclusive calendar boundaries; time intervals are [start, end).
No weekly/semester conversion and no registration of actual attendance occur here.
"""
from datetime import date, timedelta
from decimal import Decimal, localcontext
from fractions import Fraction
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


class CalendarError(Exception):
    def __init__(self, code):
        self.code = code


def dates_between(start, end):
    start, end = date.fromisoformat(start), date.fromisoformat(end)
    if end < start or (end - start).days > 731:
        raise CalendarError("CALENDAR_RANGE_INVALID")
    return [start + timedelta(days=i) for i in range((end - start).days + 1)]


def minute_of_day(value):
    hour, minute = map(int, value.split(":"))
    return hour * 60 + minute


def validate_profile(document):
    days = dates_between(document["start"], document["end"])
    try:
        ZoneInfo(document["timezone"])
    except (ZoneInfoNotFoundError, ValueError):
        raise CalendarError("CALENDAR_TIMEZONE_INVALID") from None
    if document["confirmed"] and not document["source"].strip():
        raise CalendarError("CALENDAR_SOURCE_REQUIRED")
    if document["units_confirmed"] and not document["units_source"].strip():
        raise CalendarError("CALENDAR_SOURCE_REQUIRED")
    if document["timezone_confirmed"] and not document["timezone_source"].strip():
        raise CalendarError("CALENDAR_SOURCE_REQUIRED")
    occupied = set()
    for period in document["periods"]:
        covered = {d.isoformat() for d in dates_between(period["start"], period["end"])}
        if period["start"] < document["start"] or period["end"] > document["end"]:
            raise CalendarError("CALENDAR_PERIOD_OUTSIDE")
        if occupied & covered:
            raise CalendarError("CALENDAR_PERIOD_OVERLAP")
        occupied |= covered
    slots = sorted(document["slots"], key=lambda slot: slot["start"])
    if len({slot["id"] for slot in slots}) != len(slots):
        raise CalendarError("CALENDAR_SLOT_DUPLICATE")
    for i, slot in enumerate(slots):
        if minute_of_day(slot["end"]) <= minute_of_day(slot["start"]):
            raise CalendarError("CALENDAR_TIME_INVALID")
        if i and slots[i - 1]["end"] > slot["start"]:
            raise CalendarError("CALENDAR_SLOT_OVERLAP")
    if len({item["date"] for item in document["exceptions"]}) != len(document["exceptions"]):
        raise CalendarError("CALENDAR_EXCEPTION_DUPLICATE")
    for item in document["exceptions"]:
        if item["date"] < document["start"] or item["date"] > document["end"]:
            raise CalendarError("CALENDAR_EXCEPTION_OUTSIDE")
        if not item["reason"].strip():
            raise CalendarError("CALENDAR_SOURCE_REQUIRED")
    return days


def calendar_dates(document, start=None, end=None):
    days = dates_between(start or document["start"], end or document["end"])
    exceptions = {item["date"]: item for item in document["exceptions"]}
    result = []
    for day in days:
        key = day.isoformat()
        period = next((p for p in document["periods"] if p["start"] <= key <= p["end"]), None)
        inside = document["start"] <= key <= document["end"]
        kind = period["kind"] if inside and period else "unknown"
        exception = exceptions.get(key) if inside else None
        allowed = kind == "theory"
        if exception:
            allowed = exception["allowed"]
        result.append({"date": key, "weekday": day.weekday(), "kind": kind,
                       "semester": period.get("semester") if inside and period else None,
                       "allowed": allowed, "exception": exception,
                       "period_label": period["label"] if inside and period else ""})
    return result


def amount_text(value):
    if value is None:
        return None
    with localcontext() as context:
        context.prec = 28
        number = Decimal(value.numerator) / Decimal(value.denominator)
        return format(number.quantize(Decimal("0.000001")), "f").rstrip("0").rstrip(".") or "0"


def exact(value):
    return f"{value.numerator}/{value.denominator}"


def calculate_plan(document, patterns, demand=None):
    """Return EventOccurrence projections; callers persist only future drafts.

    Rejected/cancelled occurrences are retained in diagnostics and contribute no
    active minutes. This preview never claims a valid complete timetable.
    """
    validate_profile(document)
    if len({p["id"] for p in patterns}) != len(patterns):
        raise CalendarError("CALENDAR_PATTERN_DUPLICATE")
    slots = {slot["id"]: slot for slot in document["slots"]}
    occurrences, total_minutes = [], 0
    for pattern in patterns:
        if pattern["slot_id"] not in slots:
            raise CalendarError("CALENDAR_SLOT_UNKNOWN")
        slot = slots[pattern["slot_id"]]
        days = dates_between(pattern["start"], pattern["end"])
        if pattern["dates"]:
            dates = set(pattern["dates"])
            if len(dates) != len(pattern["dates"]) or not dates.issubset({d.isoformat() for d in days}):
                raise CalendarError("CALENDAR_PATTERN_DATES_INVALID")
        else:
            dates = {d.isoformat() for d in days if d.weekday() in pattern["weekdays"]}
        if not dates or not set(pattern["cancelled_dates"]).issubset(dates):
            raise CalendarError("CALENDAR_PATTERN_DATES_INVALID")
        for item in calendar_dates(document, pattern["start"], pattern["end"]):
            if item["date"] not in dates:
                continue
            cancelled = item["date"] in pattern["cancelled_dates"]
            status = "cancelled" if cancelled else ("planned" if item["allowed"] else "blocked")
            duration = minute_of_day(slot["end"]) - minute_of_day(slot["start"])
            if status == "planned":
                total_minutes += duration
            occurrences.append({**item, "pattern_id": pattern["id"], "slot_id": slot["id"],
                                "start": slot["start"], "end": slot["end"], "status": status,
                                "duration_minutes": duration})
    if len(occurrences) > 10000:
        raise CalendarError("CALENDAR_OCCURRENCE_LIMIT")
    academic = Fraction(total_minutes, document["academic_minutes"])
    pairs = Fraction(total_minutes, document["pair_minutes"])
    required_minutes, comparison_issue = None, None
    if demand and demand.get("confirmed") and demand["semester_amount"] is not None:
        multiplier = {"minute": 1, "academic_hour": document["academic_minutes"], "pair": document["pair_minutes"]}.get(demand["unit"])
        active = [o for o in occurrences if o["status"] == "planned"]
        if not document["confirmed"] or not demand.get("semester") or any(o["semester"] is None for o in active):
            comparison_issue = "CALENDAR_SEMESTER_UNCONFIRMED"
        elif any(o["semester"] != demand["semester"] for o in active):
            raise CalendarError("CALENDAR_DEMAND_PERIOD_MISMATCH")
        elif multiplier:
            required_minutes = Fraction(str(demand["semester_amount"])) * multiplier
    remaining = None if required_minutes is None else (required_minutes - total_minutes) / document["academic_minutes"]
    blocked = [o for o in occurrences if o["status"] == "blocked"]
    assumptions = []
    for key in ("confirmed", "units_confirmed", "timezone_confirmed"):
        if not document[key]:
            assumptions.append(key)
    return {"occurrences": sorted(occurrences, key=lambda o: (o["date"], o["start"], o["pattern_id"])),
            "valid": not blocked, "ready_for_generation": not blocked and not assumptions,
            "assumptions": assumptions, "blocked_count": len(blocked),
            "active_count": sum(o["status"] == "planned" for o in occurrences),
            "cancelled_count": sum(o["status"] == "cancelled" for o in occurrences),
            "planned_minutes": total_minutes, "planned_academic_hours": amount_text(academic),
            "planned_academic_exact": exact(academic), "planned_pairs": amount_text(pairs),
            "planned_pairs_exact": exact(pairs), "demand": demand, "comparison_issue": comparison_issue,
            "required_academic_hours": amount_text(None if required_minutes is None else required_minutes / document["academic_minutes"]),
            "remaining_academic_hours": amount_text(remaining),
            "remaining_academic_exact": None if remaining is None else exact(remaining),
            "actual_registered": False}

from copy import deepcopy
from fractions import Fraction
import ast
from pathlib import Path

import pytest

from backend.app.domain.calendar import CalendarError, calculate_plan, calendar_dates, validate_profile
from .calendar_fixtures import document, pattern


def test_ac008a_ten_90_minute_occurrences_equal_20_academic_hours():
    result = calculate_plan(document(), [pattern()])
    assert (result["active_count"], result["planned_minutes"], result["planned_academic_hours"]) == (10, 900, "20")
    assert result["planned_academic_exact"] == "20/1"


def test_ac008b_one_cancellation_changes_plan_to_18_hours():
    result = calculate_plan(document(), [pattern(cancelled_dates=["2026-09-08"])])
    assert result["planned_academic_hours"] == "18" and result["cancelled_count"] == 1


def test_ac007a_forbidden_ordinary_placement_is_invalid_and_not_active():
    result = calculate_plan(document(), [pattern(start="2026-11-10", end="2026-11-10")])
    assert not result["valid"] and result["blocked_count"] == 1 and result["planned_minutes"] == 0


def test_ac007b_tuesday_monday_interval_is_preserved_exactly():
    days = calendar_dates(document(), "2026-10-27", "2026-11-02")
    assert [d["date"] for d in days] == ["2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]
    assert days[0]["weekday"] == 1 and days[-1]["weekday"] == 0


def test_ac008c_plan_projection_never_registers_actual_and_does_not_mutate_inputs():
    doc, patterns = document(), [pattern()]
    before = deepcopy((doc, patterns))
    assert calculate_plan(doc, patterns)["actual_registered"] is False
    assert (doc, patterns) == before


def test_ac008d_confirmed_semester_need_remains_separate_from_plan():
    demand = {"semester_amount": "36", "weekly_amount": "2", "unit": "academic_hour", "confirmed": True, "semester": 1}
    result = calculate_plan(document(), [pattern()], demand)
    assert result["required_academic_hours"] == "36" and result["remaining_academic_hours"] == "16"
    assert result["demand"] == demand


@pytest.mark.parametrize("unit,amount", [("minute", "1620"), ("pair", "18"), ("academic_hour", "36")])
def test_confirmed_units_compare_same_semester_need(unit, amount):
    result = calculate_plan(document(), [pattern()], {"semester_amount": amount, "unit": unit, "confirmed": True, "semester": 1})
    assert result["remaining_academic_hours"] == "16"


@pytest.mark.parametrize("need", [
    {"semester_amount": "36", "unit": "source_hour", "confirmed": True, "semester": 1},
    {"semester_amount": "36", "unit": "academic_hour", "confirmed": False},
    {"semester_amount": None, "weekly_amount": "2", "unit": "academic_hour", "confirmed": True, "semester": 1},
])
def test_unknown_unit_unconfirmed_or_weekly_only_cannot_invent_semester_need(need):
    assert calculate_plan(document(), [pattern()], need)["remaining_academic_hours"] is None


def test_negative_remaining_is_visible_as_excess_not_clamped():
    result = calculate_plan(document(), [pattern()], {"semester_amount": "18", "unit": "academic_hour", "confirmed": True, "semester": 1})
    assert result["remaining_academic_hours"] == "-2"


def test_fractional_hours_keep_exact_value_and_explicit_pair_norm():
    doc = document(); doc["academic_minutes"] = 60; doc["pair_minutes"] = 100
    doc["slots"][0]["end"] = "09:20"
    result = calculate_plan(doc, [pattern(start="2026-09-01", end="2026-09-01")])
    assert result["planned_academic_exact"] == "1/3" and result["planned_pairs_exact"] == "1/5"
    assert Fraction(result["planned_academic_exact"]) * 60 == 20


def test_unknown_calendar_gap_does_not_turn_into_theory():
    doc = document(); doc["periods"] = []
    result = calculate_plan(doc, [pattern()])
    assert not result["valid"] and all(o["kind"] == "unknown" for o in result["occurrences"])


def test_exception_allows_specific_vacation_date_with_reason():
    doc = document(); doc["exceptions"] = [{"date": "2026-11-10", "allowed": True, "reason": "TEST approved exception"}]
    result = calculate_plan(doc, [pattern(start="2026-11-10", end="2026-11-10")])
    assert result["valid"] and result["active_count"] == 1
    assert result["occurrences"][0]["kind"] == "vacation"


def test_exception_can_block_theory_date():
    doc = document(); doc["exceptions"] = [{"date": "2026-09-01", "allowed": False, "reason": "TEST closure"}]
    result = calculate_plan(doc, [pattern()])
    assert not result["valid"] and result["active_count"] == 9


def test_explicit_dates_do_not_acquire_weekly_repetitions():
    result = calculate_plan(document(), [pattern(weekdays=[], dates=["2026-09-01", "2026-09-02"])])
    assert result["active_count"] == 2


def test_unconfirmed_defaults_are_marked_and_block_calendar_readiness():
    doc = document(); doc.update(confirmed=False, units_confirmed=False, timezone_confirmed=False)
    result = calculate_plan(doc, [pattern()])
    assert result["valid"] and not result["ready_for_generation"]
    assert len(result["assumptions"]) == 3


@pytest.mark.parametrize("change,code", [
    (lambda d: d.update(end="2026-08-31"), "CALENDAR_RANGE_INVALID"),
    (lambda d: d["periods"][1].update(start="2026-11-09"), "CALENDAR_PERIOD_OVERLAP"),
    (lambda d: d["periods"][0].update(start="2026-08-31"), "CALENDAR_PERIOD_OUTSIDE"),
    (lambda d: d["slots"][0].update(end="09:00"), "CALENDAR_TIME_INVALID"),
    (lambda d: d["slots"].append({"id": "second", "label": "TEST", "start": "10:00", "end": "11:00"}), "CALENDAR_SLOT_OVERLAP"),
    (lambda d: d.update(source=" "), "CALENDAR_SOURCE_REQUIRED"),
    (lambda d: d.update(timezone="TEST/unknown"), "CALENDAR_TIMEZONE_INVALID"),
    (lambda d: d.update(exceptions=[{"date": "2026-11-17", "allowed": True, "reason": "TEST"}]), "CALENDAR_EXCEPTION_OUTSIDE"),
])
def test_invalid_profiles_are_rejected(change, code):
    doc = document(); change(doc)
    with pytest.raises(CalendarError, match=code): validate_profile(doc)


def test_touching_time_slots_are_allowed():
    doc = document(); doc["slots"].append({"id": "second", "label": "TEST", "start": "10:30", "end": "11:00"})
    validate_profile(doc)


def test_pure_calendar_module_imports_no_http_database_or_solver():
    tree = ast.parse(Path("backend/app/domain/calendar.py").read_text(encoding="utf-8"))
    imports = [n.module or "" for n in ast.walk(tree) if isinstance(n, ast.ImportFrom)]
    assert not any(name.startswith(("fastapi", "sqlalchemy", "backend.app.infrastructure", "ortools")) for name in imports)


def test_missing_semester_mapping_keeps_remaining_unknown():
    doc = document(); doc["periods"][0]["semester"] = None
    result = calculate_plan(doc, [pattern()], {"semester_amount": "36", "unit": "academic_hour", "confirmed": True, "semester": 1})
    assert result["remaining_academic_hours"] is None
    assert result["comparison_issue"] == "CALENDAR_SEMESTER_UNCONFIRMED"


def test_other_semester_cannot_be_used_to_cover_selected_semester_need():
    with pytest.raises(CalendarError, match="CALENDAR_DEMAND_PERIOD_MISMATCH"):
        calculate_plan(document(), [pattern()], {"semester_amount": "36", "unit": "academic_hour", "confirmed": True, "semester": 2})

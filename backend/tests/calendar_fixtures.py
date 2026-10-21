"""Clearly synthetic calendar, never a college calendar."""
from backend.app.adapters.calendar_http import CalendarDocument


def document():
    return CalendarDocument(start="2026-09-01", end="2026-11-16", confirmed=True, source="SYNTHETIC TEST calendar",
        units_confirmed=True, units_source="SYNTHETIC TEST 45/90", timezone_confirmed=True, timezone_source="SYNTHETIC TEST Asia/Almaty",
        periods=[{"start": "2026-09-01", "end": "2026-11-09", "kind": "theory", "semester": 1, "label": "TEST theory"},
                 {"start": "2026-11-10", "end": "2026-11-16", "kind": "vacation", "semester": 1, "label": "TEST vacation"}],
        slots=[{"id": "first", "label": "TEST 90 minutes", "start": "09:00", "end": "10:30"}]).model_dump(mode="json")


def pattern(**overrides):
    return {"id": "TEST-repeat", "start": "2026-09-01", "end": "2026-11-03", "slot_id": "first",
            "weekdays": [1], "dates": [], "cancelled_dates": [], **overrides}

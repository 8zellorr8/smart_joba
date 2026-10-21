from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import uuid

import pytest
from sqlalchemy import func, select

from backend.app.application.auth import ApiError
from backend.app.application.calendars import CalendarService
from backend.app.infrastructure.models import (CalendarProfile, CalendarRevision, Group, ImportContext, Scope,
                                              TeachingAssignment, TeachingDemand)
from backend.app.seed import DEMO_SCOPE_ID
from .calendar_fixtures import document, pattern
from .conftest import csrf, login
from .s1_fixtures import ROW, workbook
from .test_imports import upload, review, apply


def create(client, app, doc=None, group_id=None, **overrides):
    if group_id is None:
        with app.state.session_factory() as db:
            group_id = str(db.scalar(select(Group.id).where(Group.scope_id == DEMO_SCOPE_ID)))
    payload = {"academic_year": "2026-2027", "data_kind": "synthetic", "group_id": group_id, "document": doc or document(), **overrides}
    return client.post(f"/api/scopes/{DEMO_SCOPE_ID}/calendars", headers=csrf(client), json=payload)


def preview(client, profile, **overrides):
    return client.post(f"/api/calendars/{profile['id']}/preview", headers=csrf(client), json={
        "expected_revision": profile["revision"], "expected_context_revision": profile["context_revision"],
        "patterns": [pattern()], **overrides})


def update(client, profile, doc=None, **overrides):
    return client.post(f"/api/calendars/{profile['id']}", headers=csrf(client), json={
        "expected_revision": profile["revision"], "expected_context_revision": profile["context_revision"],
        "document": doc or profile["document"], **overrides})


def count(app, model):
    with app.state.session_factory() as db:
        return db.scalar(select(func.count()).select_from(model))


def test_calendar_roundtrip_and_ac007b_exact_boundaries(client, app):
    login(client, app, "admin")
    response = create(client, app); assert response.status_code == 201
    profile = response.json()
    assert profile["document"] == document() and profile["revision"] == 1
    days = client.get(f"/api/calendars/{profile['id']}/dates?start=2026-10-27&end=2026-11-02").json()["dates"]
    assert days[0]["date"] == "2026-10-27" and days[-1]["date"] == "2026-11-02" and len(days) == 7
    assert count(app, CalendarRevision) == 1


def test_ac007a_api_rejects_forbidden_placement_and_ac008a_b_c(client, app):
    login(client, app, "admin")
    profile = create(client, app).json()
    rejected = preview(client, profile, patterns=[pattern(start="2026-11-10", end="2026-11-10")])
    assert rejected.status_code == 200 and rejected.json()["valid"] is False
    assert rejected.json()["occurrences"][0]["status"] == "blocked"
    assert preview(client, profile).json()["planned_academic_hours"] == "20"
    result = preview(client, profile, patterns=[pattern(cancelled_dates=["2026-09-08"])]).json()
    assert result["planned_academic_hours"] == "18" and result["actual_registered"] is False
    assert result["preview_only"] is True
    assert count(app, CalendarRevision) == 1 and count(app, TeachingDemand) == count(app, TeachingAssignment) == 0


def test_ac008d_real_import_contract_compares_only_confirmed_semester_need(client, app):
    login(client, app)
    row = list(ROW); row[10] = 36
    batch = upload(client, app, workbook([row])).json()
    batch = review(client, batch, {"room": "101", "whole_group": True}, True).json()
    assert apply(client, batch).status_code == 200
    with app.state.session_factory() as db:
        demand = db.scalar(select(TeachingDemand)); demand_id, group_id = str(demand.id), str(demand.group_id)
    login(client, app, "admin")
    profile = create(client, app, group_id=group_id).json()
    result = preview(client, profile, demand_id=demand_id).json()
    assert result["planned_academic_hours"] == "20" and result["remaining_academic_hours"] == "16"
    assert result["demand"]["semester_amount"] == "36.00" and result["demand"]["source_coordinate"] == "K2"
    assert result["dependency_token"]["context_revision"] == 1
    assert count(app, TeachingAssignment) == 1  # Preview did not create another assignment.


def test_new_source_revision_invalidates_old_calendar_preview(client, app):
    login(client, app, "admin"); profile = create(client, app).json()
    login(client, app)
    batch = upload(client, app).json(); assert apply(client, batch).status_code == 200
    assert preview(client, profile).status_code == 409
    fresh = client.get(f"/api/calendars/{profile['id']}").json()
    assert fresh["context_revision"] == 1 and fresh["revision"] == 1
    assert preview(client, fresh).status_code == 200


def test_edit_creates_immutable_history_and_old_revision_conflicts(client, app):
    login(client, app, "admin"); profile = create(client, app).json()
    changed = deepcopy(profile["document"]); changed["academic_minutes"] = 60
    fresh = update(client, profile, changed).json()
    assert fresh["revision"] == 2
    assert preview(client, profile).status_code == 409
    assert update(client, profile).status_code == 409
    history = client.get(f"/api/calendars/{profile['id']}/history").json()
    assert [r["revision"] for r in history] == [2, 1]
    assert history[1]["document"]["academic_minutes"] == 45
    assert update(client, fresh).json()["revision"] == 2 and count(app, CalendarRevision) == 2


@pytest.mark.parametrize("role", ["scheduler", "approver", "teacher", "student"])
def test_only_admin_can_write_calendar(client, app, role):
    login(client, app, "admin"); profile = create(client, app).json()
    login(client, app, role)
    assert create(client, app).status_code == 403
    assert update(client, profile).status_code == 403


@pytest.mark.parametrize("role,expected", [("scheduler", 200), ("approver", 200), ("teacher", 403), ("student", 403)])
def test_calendar_reads_and_calculation_follow_scope_roles(client, app, role, expected):
    login(client, app, "admin"); profile = create(client, app).json()
    login(client, app, role)
    assert client.get(f"/api/scopes/{DEMO_SCOPE_ID}/calendar-data").status_code == expected
    assert client.get(f"/api/calendars/{profile['id']}").status_code == expected
    assert client.get(f"/api/calendars/{profile['id']}/history").status_code == expected
    assert client.get(f"/api/calendars/{profile['id']}/dates?start=2026-10-27&end=2026-11-02").status_code == expected
    assert preview(client, profile).status_code == expected


def test_cross_scope_and_synthetic_college_mixing_are_denied(client, app):
    login(client, app, "admin")
    with app.state.session_factory.begin() as db:
        other = Scope(name="SYNTHETIC other scope", is_demo=True); db.add(other); db.flush()
        group = Group(scope_id=other.id, code="TEST-OTHER", data_kind="synthetic"); db.add(group); db.flush(); other_group = str(group.id)
    assert create(client, app, group_id=other_group).status_code == 403
    assert create(client, app, data_kind="college").status_code == 403
    assert client.get(f"/api/scopes/{other.id}/calendar-data").status_code == 403


def test_anonymous_cannot_read_calendar(client, app):
    assert client.get(f"/api/scopes/{DEMO_SCOPE_ID}/calendar-data").status_code == 401


def test_missing_csrf_and_wrong_origin_are_denied(client, app):
    login(client, app, "admin"); profile = create(client, app).json()
    payload = {"expected_revision": 1, "expected_context_revision": 0, "document": document()}
    assert client.post(f"/api/calendars/{profile['id']}", json=payload).status_code == 403
    assert client.post(f"/api/calendars/{profile['id']}", headers={**csrf(client), "Origin": "https://example.invalid"}, json=payload).status_code == 403


@pytest.mark.parametrize("overrides", [
    {"academic_year": "2026-2028"},
    {"document": {**document(), "academic_minutes": 0}},
    {"document": {**document(), "academic_minutes": True}},
    {"document": {**document(), "start": "2026-02-30"}},
    {"document": {**document(), "confirmed": "true"}},
    {"document": {**document(), "unexpected": "forbidden"}},
])
def test_invalid_input_has_controlled_error_and_no_changes(client, app, overrides):
    login(client, app, "admin")
    result = create(client, app, **overrides)
    assert result.status_code == 422 and result.json()["error"]["code"] == "VALIDATION_ERROR"
    assert count(app, CalendarProfile) == 0


def test_profile_failure_rolls_back_revision_and_head(client, app, monkeypatch):
    login(client, app, "admin"); profile = create(client, app).json()
    changed = deepcopy(profile["document"]); changed["pair_minutes"] = 120
    def fail(*args, **kwargs): raise ApiError("TEST_ROLLBACK", 503)
    monkeypatch.setattr("backend.app.application.calendars.audit", fail)
    assert update(client, profile, changed).status_code == 503
    loaded = client.get(f"/api/calendars/{profile['id']}").json()
    assert loaded["revision"] == 1 and loaded["document"]["pair_minutes"] == 90
    assert count(app, CalendarRevision) == 1


def test_concurrent_calendar_edits_preserve_one_winner(client, app):
    login(client, app, "admin"); profile = create(client, app).json()
    token = client.cookies.get("smart_joba_session")
    service = CalendarService(app.state.session_factory, app.state.auth)
    def write(minutes):
        doc = deepcopy(profile["document"]); doc["pair_minutes"] = minutes
        try:
            service.update(token, uuid.UUID(profile["id"]), 1, 0, doc, str(uuid.uuid4()))
            return 200
        except ApiError as error:
            return error.status
    with ThreadPoolExecutor(max_workers=2) as workers:
        statuses = list(workers.map(write, [100, 120]))
    assert sorted(statuses) == [200, 409] and count(app, CalendarRevision) == 2


def test_duplicate_creation_and_oversized_body_do_not_write(client, app):
    login(client, app, "admin")
    profile = create(client, app).json()
    assert create(client, app).status_code == 409
    response = client.post(f"/api/calendars/{profile['id']}/preview", headers={**csrf(client), "Content-Type": "application/json"}, content=b" " * 131073)
    assert response.status_code == 413 and count(app, CalendarRevision) == 1


def test_demand_from_wrong_group_is_not_disclosed(client, app):
    login(client, app)
    batch = upload(client, app).json(); assert apply(client, batch).status_code == 200
    with app.state.session_factory() as db: demand_id = str(db.scalar(select(TeachingDemand.id)))
    login(client, app, "admin"); profile = create(client, app).json()
    assert preview(client, profile, demand_id=demand_id).status_code == 403

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import uuid

import pytest
from sqlalchemy import func, select

from backend.app.application.auth import ApiError
from backend.app.application.editor import EditorService
from backend.app.infrastructure.models import CalendarProfile, DraftRevision, Room, ScheduleDraft, ScheduleSeries, Scope, ImportContext, TeachingDemand
from backend.app.seed import DEMO_SCOPE_ID
from .conftest import csrf, login
from .editor_fixtures import setup_editor, add_series, series_body, one_body


@pytest.fixture
def env(client, app): return setup_editor(client, app)


def edit_one(client, draft, event, **changes):
    return client.post(f"/api/drafts/{draft['id']}/occurrences/{event['id']}", headers=csrf(client), json=one_body(draft, event, **changes))


def test_ac004b_and_ac004d_teacher_conflict_reports_exact_events_and_dates(client, env):
    first = add_series(client, env); assert first.status_code == 201, first.text
    second = add_series(client, env, first.json(), index=2, room_index=1); assert second.status_code == 201, second.text
    report = second.json()["report"]
    assert {c["resource_type"] for c in report["conflicts"]} == {"teacher"}
    assert {d for c in report["conflicts"] for d in c["dates"]} == {"2026-09-01", "2026-09-08"}
    assert all(len(c["events"]) == 2 and c["resource_name"] and c["rule"] == "RULE-001" for c in report["conflicts"])


def test_ac005a_group_conflict(client, env):
    first = add_series(client, env).json()
    second = add_series(client, env, first, index=1, room_index=1).json()
    assert {c["resource_type"] for c in second["report"]["conflicts"]} == {"group"}


def test_ac005b_room_conflict(client, env):
    first = add_series(client, env).json()
    # Two different teachers and groups: create subject 1 in group A then
    # subject 2 in group B; the shared room alone is exclusive.
    # Change existing series to the other confirmed teacher first.
    sid = first["series"][0]["id"]
    changed = client.post(f"/api/drafts/{first['id']}/series/{sid}", headers=csrf(client), json=series_body(env, first, index=1)).json()
    result = add_series(client, env, changed, index=2).json()
    assert {c["resource_type"] for c in result["report"]["conflicts"]} == {"room"}


def test_ac004a_disjoint_dates_and_ac004c_touching_intervals(client, env):
    first = add_series(client, env).json()
    disjoint = add_series(client, env, first, start="2026-09-15", end="2026-09-15").json()
    assert not disjoint["report"]["conflicts"]
    touching = add_series(client, env, disjoint, slot_id="second").json()
    assert not touching["report"]["conflicts"]


def test_ac021a_edit_single_date_preserves_all_other_occurrences_and_history(client, app, env):
    draft = add_series(client, env).json(); original = deepcopy(draft["occurrences"])
    event = next(e for e in original if e["date"] == "2026-09-08")
    response = edit_one(client, draft, event, start="10:30", end="12:00", room_id=env["rooms"][1]["id"], pinned=True)
    assert response.status_code == 200, response.text
    events = {e["id"]: e for e in response.json()["occurrences"]}
    assert events[event["id"]]["start"] == "10:30" and events[event["id"]]["pinned"]
    assert all(events[e["id"]] == e for e in original if e["id"] != event["id"])
    with app.state.session_factory() as db:
        snapshot = db.scalar(select(DraftRevision).where(DraftRevision.draft_id == uuid.UUID(draft["id"]), DraftRevision.revision == draft["revision"]))
        old = next(e for e in snapshot.snapshot["series"][0]["occurrences"] if e["id"] == event["id"])
        assert old["start"] == "09:00"


def test_cancelled_occurrence_removes_its_conflicts_and_updates_saved_plan_hours(client, env):
    first = add_series(client, env).json()
    second = add_series(client, env, first, index=2, room_index=1).json()
    event = next(e for e in second["occurrences"] if e["assignment_id"] == env["assignments"][2]["id"] and e["date"] == "2026-09-01")
    cancelled = edit_one(client, second, event, cancelled=True).json()
    assert {d for c in cancelled["report"]["conflicts"] for d in c["dates"]} == {"2026-09-08"}
    hour = next(h for h in cancelled["report"]["hours"] if h["demand_id"] == env["assignments"][2]["demand_id"])
    assert hour["planned"] == "2" and hour["remaining"] == "2"
    assert cancelled["report"]["actual_registered"] is False


def test_pinned_single_date_survives_and_blocks_implicit_bulk_movement(client, env):
    draft = add_series(client, env).json(); event = draft["occurrences"][0]
    pinned = edit_one(client, draft, event, pinned=True).json()
    sid = pinned["series"][0]["id"]
    response = client.post(f"/api/drafts/{draft['id']}/series/{sid}", headers=csrf(client), json=series_body(env, pinned, slot_id="second"))
    assert response.status_code == 409 and response.json()["error"]["code"] == "EDITOR_PINNED"


def test_calendar_forbidden_and_unknown_semester_placements_are_not_saved(client, env):
    response = add_series(client, env, start="2026-11-10", end="2026-11-10")
    assert response.status_code == 422 and response.json()["error"]["code"] == "EDITOR_CALENDAR_FORBIDDEN"
    loaded = client.get(f"/api/drafts/{env['draft']['id']}").json()
    assert loaded["revision"] == 1 and not loaded["series"]


def test_date_views_filter_group_teacher_room_without_changing_draft(client, env):
    first = add_series(client, env).json(); second = add_series(client, env, first, index=2, room_index=1).json()
    for view, resource in (("group", env["assignments"][0]["group_id"]), ("teacher", env["assignments"][0]["teacher_id"]), ("room", env["rooms"][0]["id"])):
        response = client.get(f"/api/drafts/{second['id']}?start=2026-09-01&end=2026-09-01&view={view}&resource_id={resource}")
        assert response.status_code == 200
        events = response.json()["occurrences"]
        assert events and all(e[view + "_id"] == resource and e["date"] == "2026-09-01" for e in events)
    page = client.get(f"/api/drafts/{second['id']}?limit=1&offset=1").json()
    assert len(page["occurrences"]) == 1 and page["total"] == 4 and page["revision"] == second["revision"]


@pytest.mark.parametrize("role,read_status", [("admin", 403), ("approver", 200), ("teacher", 403), ("student", 403)])
def test_non_schedulers_cannot_edit_drafts(client, app, env, role, read_status):
    login(client, app, role)
    assert client.get(f"/api/drafts/{env['draft']['id']}").status_code == read_status
    assert add_series(client, env).status_code == 403
    assert client.post(f"/api/scopes/{DEMO_SCOPE_ID}/drafts", headers=csrf(client), json={"context_id": env["draft"]["context_id"], "name": "TEST"}).status_code == 403


def test_admin_resource_options_do_not_leak_draft_metadata(client, app, env):
    login(client, app, "admin")
    options = client.get(f"/api/scopes/{DEMO_SCOPE_ID}/editor-data").json()
    assert options["rooms"] and options["drafts"] == options["assignments"] == options["contexts"] == []


def test_scheduler_cannot_change_room_properties(client, env):
    response = client.post(f"/api/scopes/{DEMO_SCOPE_ID}/rooms", headers=csrf(client), json={"code": "TEST-403", "data_kind": "synthetic", "exclusive": True, "confirmed": True, "source": "TEST"})
    assert response.status_code == 403


def test_cross_scope_room_and_assignment_are_denied(client, app, env):
    with app.state.session_factory.begin() as db:
        scope = Scope(name="SYNTHETIC OTHER", is_demo=True); db.add(scope); db.flush()
        room = Room(scope_id=scope.id, data_kind="synthetic", code="TEST", exclusive=True, confirmed=True, source="TEST", revision=1); db.add(room); db.flush(); other_id = str(room.id)
    body = series_body(env); body["room_id"] = other_id
    response = client.post(f"/api/drafts/{env['draft']['id']}/series", headers=csrf(client), json=body)
    assert response.status_code == 403
    assert client.get(f"/api/scopes/{scope.id}/editor-data").status_code == 403


def test_ac021b_stale_revision_does_not_overwrite_saved_occurrences(client, env):
    fresh = add_series(client, env).json()
    assert add_series(client, env).status_code == 409
    loaded = client.get(f"/api/drafts/{fresh['id']}").json()
    assert loaded["revision"] == fresh["revision"] and loaded["occurrences"] == fresh["occurrences"]


def test_changed_room_invalidates_report_and_old_dependency_token(client, app, env):
    draft = add_series(client, env).json()
    login(client, app, "admin"); room = env["rooms"][0]
    response = client.post(f"/api/rooms/{room['id']}", headers=csrf(client), json={**{key: room[key] for key in ('code','data_kind','exclusive','confirmed','source')}, "expected_revision": room["revision"], "source": "TEST reviewed again"})
    assert response.status_code == 200
    login(client, app)
    assert add_series(client, env, draft).status_code == 409
    loaded = client.get(f"/api/drafts/{draft['id']}").json()
    assert loaded["stale"] and any(q["code"] == "ROOM_CHANGED" for q in loaded["report"]["questions"])


def test_unknown_room_structure_remains_blocking_question(client, app, env):
    login(client, app, "admin"); room = env["rooms"][0]
    changed = client.post(f"/api/rooms/{room['id']}", headers=csrf(client), json={"code": room["code"], "data_kind": "synthetic", "exclusive": None, "confirmed": False, "source": "", "expected_revision": 1}).json()
    env["rooms"][0] = changed; login(client, app)
    draft = add_series(client, env).json()
    assert any(q["code"] == "ROOM_EXCLUSIVITY_UNKNOWN" for q in draft["report"]["questions"])
    response = client.post(f"/api/drafts/{draft['id']}/submit", headers=csrf(client), json={"expected_revision": draft["revision"], "expected_workflow_revision": 1,
        "group_ids": list(env["calendars"]), "room_ids": [r["id"] for r in env["rooms"]], "semester": 1})
    assert response.status_code == 422 and response.json()["error"]["code"] == "DRAFT_HAS_ERRORS"


def test_conflicting_draft_is_saved_but_cannot_be_submitted(client, env):
    first = add_series(client, env).json(); draft = add_series(client, env, first).json()
    response = client.post(f"/api/drafts/{draft['id']}/submit", headers=csrf(client), json={"expected_revision": draft["revision"], "expected_workflow_revision": 1,
        "group_ids": list(env["calendars"]), "room_ids": [r["id"] for r in env["rooms"]], "semester": 1})
    assert response.status_code == 422 and response.json()["error"]["code"] == "DRAFT_HAS_ERRORS"
    assert client.get(f"/api/drafts/{draft['id']}").json()["status"] == "draft"


def test_failure_rolls_back_series_revision_and_audit(client, app, env, monkeypatch):
    def fail(*args, **kwargs): raise ApiError("TEST_ROLLBACK", 503)
    monkeypatch.setattr("backend.app.application.editor.audit", fail)
    assert add_series(client, env).status_code == 503
    loaded = client.get(f"/api/drafts/{env['draft']['id']}").json()
    assert loaded["revision"] == 1 and not loaded["series"]
    with app.state.session_factory() as db: assert db.scalar(select(func.count()).select_from(DraftRevision)) == 1


def test_two_concurrent_edits_have_one_winner(client, app, env):
    token = client.cookies.get("smart_joba_session"); service = EditorService(app.state.session_factory, app.state.auth)
    body = series_body(env)
    def save(_):
        try: service.save_series(token, uuid.UUID(env["draft"]["id"]), body, str(uuid.uuid4())); return 201
        except ApiError as error: return error.status
    with ThreadPoolExecutor(max_workers=2) as workers: statuses = list(workers.map(save, range(2)))
    assert sorted(statuses) == [201, 409]
    assert len(client.get(f"/api/drafts/{env['draft']['id']}").json()["series"]) == 1


def test_unconfirmed_assignment_and_bad_csrf_and_oversize_are_rejected(client, env):
    body = series_body(env); body["assignment_id"] = str(uuid.uuid4())
    assert client.post(f"/api/drafts/{env['draft']['id']}/series", headers=csrf(client), json=body).status_code == 422
    assert client.post(f"/api/drafts/{env['draft']['id']}/series", json=series_body(env)).status_code == 403
    assert client.post(f"/api/drafts/{env['draft']['id']}/series", headers={**csrf(client), "Content-Type": "application/json"}, content=b' ' * 131073).status_code == 413


def test_published_or_approved_revision_is_immutable(client, app, env):
    with app.state.session_factory.begin() as db: db.get(ScheduleDraft, uuid.UUID(env["draft"]["id"])).status = "published"
    assert add_series(client, env).status_code == 409


def test_changed_calendar_requires_explicit_series_review_instead_of_silent_one_date_rebind(client, app, env):
    draft = add_series(client, env).json()
    calendar = env["calendars"][env["assignments"][0]["group_id"]]
    login(client, app, "admin")
    doc = deepcopy(calendar["document"]); doc["source"] = "SYNTHETIC reviewed calendar"
    response = client.post(f"/api/calendars/{calendar['id']}", headers=csrf(client), json={"expected_revision": 1, "expected_context_revision": draft["dependencies"]["context_revision"], "document": doc})
    assert response.status_code == 200
    login(client, app)
    fresh = client.get(f"/api/drafts/{draft['id']}").json()
    assert fresh["stale"] and any(q["code"] == "CALENDAR_CHANGED" for q in fresh["report"]["questions"])
    response = edit_one(client, fresh, fresh["occurrences"][0], pinned=True)
    assert response.status_code == 409 and response.json()["error"]["code"] == "EDITOR_SERIES_REVIEW"
    # Explicit whole-series review uses the new reference revision.
    env["calendars"][env["assignments"][0]["group_id"]] = {**calendar, "revision": 2}
    reviewed = client.post(f"/api/drafts/{draft['id']}/series/{fresh['series'][0]['id']}", headers=csrf(client), json=series_body(env, fresh)).json()
    assert reviewed["revision"] == fresh["revision"] + 1 and not reviewed["stale"]


def test_unsupported_subgroup_assignment_is_rejected_even_by_direct_api(client, app, env):
    with app.state.session_factory.begin() as db:
        demand = db.get(TeachingDemand, uuid.UUID(env["assignments"][0]["demand_id"]))
        demand.normalized = {**demand.normalized, "whole_group": False, "subgroup": "SYNTHETIC unsupported"}
    response = add_series(client, env)
    assert response.status_code == 422 and response.json()["error"]["code"] == "EDITOR_ASSIGNMENT_UNCONFIRMED"


def test_source_context_change_rejects_old_token_without_any_schedule_write(client, app, env):
    draft = add_series(client, env).json()
    with app.state.session_factory.begin() as db:
        context = db.get(ImportContext, uuid.UUID(draft["context_id"])); context.revision += 1
    assert add_series(client, env, draft).status_code == 409
    fresh = client.get(f"/api/drafts/{draft['id']}").json()
    assert fresh["stale"] and fresh["revision"] == draft["revision"]


def test_unknown_external_occupancy_is_explicit_and_not_reported_as_checked(client, env):
    draft = add_series(client, env).json()
    assert "EXTERNAL_OCCUPANCY_UNVERIFIED" in draft["report"]["notes"]
    assert "AVAILABILITY_UNVERIFIED" in draft["report"]["notes"]

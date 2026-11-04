"""Personal results use real synthetic facts and deny peer/history access."""
import uuid

import pytest
from sqlalchemy import select, update

from backend.app.infrastructure.journal_models import Student, StudentAccountBinding, StudentMembership
from backend.app.infrastructure.lesson_models import JournalLessonStudent
from backend.app.infrastructure.models import Group, RoleGrant, Scope
from .conftest import login
from .test_journal_lessons import lesson_env, record, modify, send
from .publication_fixtures import approve, fork, publish, submit


def bind(client, app, e, student_id):
    login(client, app, "admin")
    account = client.get(e["root"] + "/setup").json()["accounts"][0]
    e["setup"]({"kind": "bind_account", "user_id": account["id"], "student_id": student_id,
               "source": "Synthetic personal results", "confirmed": True, "reason": "Synthetic binding change"})
    login(client, app, "student")


@pytest.fixture
def personal(client, app, lesson_env):
    e = lesson_env
    saved = record(client, e, grades=[{"student_id": e["students"][0], "value": 0}, {"student_id": e["students"][1], "value": 91}],
                   attendance=[{"student_id": e["students"][0], "value": "late"}, {"student_id": e["students"][1], "value": "absent"}])
    bind(client, app, e, e["students"][0])
    login(client, app, "teacher")
    saved["registry_revision"] = client.get(e["root"] + f"/lessons/{saved['lesson_id']}").json()["registry_revision"]
    login(client, app, "student")
    return {**e, "saved": saved, "url": e["root"] + "/me/results"}


def result(client, e, **params):
    response = client.get(e["url"], params=params)
    assert response.status_code == 200, response.text
    return response.json()


def test_saved_zero_and_explicit_whitelist_without_peer_or_history(client, app, personal):
    e = personal; data = result(client, e); row = data["items"][0]
    assert row["grade"] == 0 and row["attendance"] == "late"
    assert row["date"] == e["event"]["date"] and row["topic"] == "Демонстрациялық сабақ"
    assert data["student"]["id"] == e["students"][0]
    assert set(data) == {"student", "memberships", "revision", "periods", "subjects", "items", "page", "has_next"}
    assert set(row) == {"id", "revision", "date", "start", "end", "timezone", "subject", "group", "academic_year", "semester", "topic", "grade", "attendance", "active"}
    assert e["students"][1] not in str(data) and "Демо студент Б" not in str(data)
    assert client.get(e["root"] + f"/lessons/{e['saved']['lesson_id']}").status_code == 403
    assert client.get(e["root"] + f"/lessons/{e['saved']['lesson_id']}/history").status_code == 403
    assert client.get(e["root"] + "/history").status_code == 403


def test_corrections_null_and_hundred_visible_only_as_current_value(client, app, personal):
    e = personal
    login(client, app, "teacher")
    changed = send(client, e, modify(client, e, e["saved"], grades=[{"student_id": e["students"][0], "value": None}], reason="Synthetic clearing"))
    assert changed.status_code == 200
    login(client, app, "student")
    assert result(client, e)["items"][0]["grade"] is None
    login(client, app, "teacher")
    changed = send(client, e, modify(client, e, changed.json(), grades=[{"student_id": e["students"][0], "value": 100}]))
    assert changed.status_code == 200
    login(client, app, "student")
    assert result(client, e)["items"][0]["grade"] == 100


@pytest.mark.parametrize("params", [{"student_id": str(uuid.uuid4())}, {"history": "true"}, {"page": 0}, {"page_size": 101}, {"revision": "bad"}, {"semester": 21}, {"context_id": str(uuid.uuid4())}])
def test_invalid_or_identity_parameters_never_expose_records(client, personal, params):
    response = client.get(personal["url"], params=params)
    assert response.status_code == 422 and "items" not in response.json()


def test_duplicate_identity_filters_rejected(client, personal):
    assert client.get(personal["url"] + "?page=1&page=2").status_code == 422


@pytest.mark.parametrize("role", ["admin", "scheduler", "teacher", "approver"])
def test_personal_endpoint_requires_student_role(client, app, personal, role):
    login(client, app, role)
    assert client.get(personal["url"]).status_code == 403


def test_binding_revoked_rebound_and_scope_revoked_between_pages(client, app, personal):
    e = personal; old = result(client, e)
    bind(client, app, e, None)
    assert client.get(e["url"]).status_code == 403
    bind(client, app, e, e["students"][1])
    assert client.get(e["url"], params={"revision": old["revision"]}).status_code == 409
    assert result(client, e)["items"][0]["grade"] == 91
    with app.state.session_factory.begin() as db:
        db.execute(update(RoleGrant).where(RoleGrant.role == "student").values(role="scheduler"))
    assert client.get(e["url"]).status_code == 403


def test_foreign_scope_and_unbound_session_denied(client, app, personal):
    with app.state.session_factory.begin() as db:
        scope = Scope(name="Synthetic second scope", is_demo=True)
        db.add(scope); db.flush(); sid = scope.id
    assert client.get(f"/api/scopes/{sid}/journal/me/results").status_code == 403
    client.cookies.clear()
    assert client.get(personal["url"]).status_code == 401


def test_filters_and_pagination_preserve_period_subject_and_revision(client, app, personal):
    e = personal; login(client, app, "teacher")
    second = next(event for event in e["source"]["events"] if event["demand_id"] == e["event"]["demand_id"] and event["id"] != e["event"]["id"])
    record(client, {**e, "event": second})
    login(client, app, "student")
    data = result(client, e)
    filters = {"context_id": data["periods"][0]["context_id"], "semester": data["periods"][0]["semester"], "subject_id": data["subjects"][0]["id"], "page_size": 1}
    first = result(client, e, **filters)
    following = result(client, e, **filters, page=2, revision=first["revision"])
    assert first["has_next"] and not following["has_next"] and following["page"] == 2
    assert first["items"][0]["id"] != following["items"][0]["id"]
    assert {x["id"] for x in data["items"]} == {first["items"][0]["id"], following["items"][0]["id"]}
    assert client.get(e["url"], params={**filters, "page": 2}).status_code == 409
    assert client.get(e["url"], params={**filters, "page": 3, "revision": first["revision"]}).status_code == 422
    assert client.get(e["url"], params={**filters, "subject_id": str(uuid.uuid4())}).status_code == 403
    login(client, app, "teacher")
    assert send(client, e, modify(client, e, e["saved"], topic="Түзету", reason="Synthetic edit")).status_code == 200
    login(client, app, "student")
    assert client.get(e["url"], params={**filters, "page": 2, "revision": first["revision"]}).status_code == 409


def test_historical_membership_and_removed_roster_survive_transfer(client, app, personal):
    e = personal
    login(client, app, "admin")
    membership = next(m for m in client.get(e["root"] + "/setup").json()["memberships"] if m["student_id"] == e["students"][0])
    # Current directory corrected; saved membership remains the evidence.
    e["setup"]({"kind": "save_membership", "id": membership["id"], "student_id": membership["student_id"],
               "context_id": membership["context_id"], "group_id": membership["group_id"],
               "start": "2026-08-01", "end": e["event"]["date"], "source": "Synthetic transfer", "confirmed": True, "reason": "Synthetic correction"})
    other_group = next(a["group_id"] for a in e["assignments"] if a["group_id"] != membership["group_id"])
    e["setup"]({"kind": "save_membership", "student_id": membership["student_id"], "context_id": membership["context_id"],
               "group_id": other_group, "start": e["event"]["date"], "end": "2027-01-01", "source": "Synthetic transfer", "confirmed": True})
    registry = client.get(e["root"] + "/setup").json()["revision"]
    changed = send(client, e, {"operation_id": str(uuid.uuid4()), "expected_revision": e["saved"]["revision"],
        "expected_registry_revision": registry, "command": {"kind": "correct_roster", "lesson_id": e["saved"]["lesson_id"],
        "student_ids": [e["students"][1]], "reason": "Synthetic correction"}}, admin=True)
    assert changed.status_code == 200, changed.text
    with app.state.session_factory.begin() as db:
        db.execute(update(RoleGrant).where(RoleGrant.role == "student").values(group_id=uuid.UUID(other_group)))
    login(client, app, "student")
    row = result(client, e)["items"][0]
    assert row["grade"] == 0 and row["active"] is False and row["group"] == e["event"]["group"]


def test_republication_does_not_hide_or_duplicate_own_facts(client, app, personal):
    e = personal; before = result(client, e)["items"]
    login(client, app, "scheduler")
    current = client.get(f"/api/schedule-versions/{e['version']['id']}").json()
    revised = fork(client, app, current)
    publish(client, approve(client, app, submit(client, e, revised)))
    login(client, app, "student")
    assert result(client, e)["items"] == before


def test_empty_profile_is_success_and_data_kind_mismatch_has_no_results(client, app, lesson_env):
    e = lesson_env
    bind(client, app, e, e["students"][0])
    response = client.get(e["root"] + "/me/results")
    assert response.status_code == 200 and response.json()["items"] == []
    login(client, app, "teacher"); record(client, e)
    with app.state.session_factory.begin() as db:
        db.execute(update(Student).where(Student.id == uuid.UUID(e["students"][0])).values(data_kind="college"))
    login(client, app, "student")
    data = client.get(e["root"] + "/me/results").json()
    assert data["items"] == [] and data["periods"] == [] and data["subjects"] == [] and data["memberships"] == []

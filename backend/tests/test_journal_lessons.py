"""Synthetic-only facts, created through real import/generation/publication APIs."""
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, text, update
from sqlalchemy.exc import IntegrityError

from backend.app.application.auth import ApiError
from backend.app.application.journal_lessons import JournalLessonService
from backend.app.domain.publication import utc_interval
from backend.app.infrastructure.journal_models import JournalAssignment, StudentMembership
from backend.app.infrastructure.lesson_models import JournalLesson, JournalLessonChange, JournalLessonOperation, JournalLessonStudent
from backend.app.infrastructure.models import Publication, RoleGrant, Scope, TeachingDemand
from .conftest import csrf, login
from .publication_fixtures import approve, fork, publish, setup_version, submit


@pytest.fixture
def lesson_env(client, app, monkeypatch):
    env = setup_version(client, app)
    version = approve(client, app, submit(client, env))
    pub = publish(client, version)
    session = login(client, app, "admin")
    scope = session["user"]["home_scope_id"]
    root = f"/api/scopes/{scope}/journal"
    def setup(c):
        response = client.post(root + "/commands", headers=csrf(client), json={"operation_id": str(uuid.uuid4()),
            "expected_revision": client.get(root + "/setup").json()["revision"], "command": c})
        assert response.status_code == 200, response.text
        return response.json()
    assignment = env["assignments"][0]
    journal_id = setup({"kind": "create_journal", "demand_id": assignment["demand_id"], "source": "Synthetic only", "confirmed": True})["id"]
    students = []
    for label in ("Демо студент А", "Демо студент Б"):
        sid = setup({"kind": "create_student", "display_name": label, "data_kind": "synthetic"})["id"]
        setup({"kind": "save_membership", "student_id": sid, "context_id": assignment["context_id"],
            "group_id": assignment["group_id"], "start": "2026-09-01", "end": "2027-01-01", "source": "Synthetic", "confirmed": True})
        students.append(sid)
    assigned = setup({"kind": "save_assignment", "journal_id": journal_id, "teacher_id": assignment["teacher_id"],
        "start": "2026-09-01", "end": "2027-01-01", "source": "Synthetic", "confirmed": True})
    with app.state.session_factory.begin() as db:
        db.execute(update(RoleGrant).where(RoleGrant.scope_id == uuid.UUID(scope), RoleGrant.role == "teacher").values(teacher_id=uuid.UUID(assignment["teacher_id"])))
        source = db.get(Publication, uuid.UUID(pub["publication_id"])).snapshot
    event = next(e for e in source["events"] if e["demand_id"] == assignment["demand_id"])
    class PastClock(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2027, 1, 1, tzinfo=UTC)
    monkeypatch.setattr("backend.app.application.journal_lessons.datetime", PastClock)
    login(client, app, "teacher")
    return {**env, "version": version, "pub": pub, "root": root, "scope": scope, "journal_id": journal_id,
            "students": students, "event": event, "setup": setup, "assigned": assigned, "source": source}


def preview(client, e, **kwargs):
    return client.get(e["root"] + f"/journals/{e['journal_id']}/event", params={"publication_id": e["pub"]["publication_id"], "event_id": e["event"]["id"], **kwargs})


def body(client, e, **changes):
    p = preview(client, e).json()
    return {"operation_id": str(uuid.uuid4()), "expected_revision": p["revision"], "expected_registry_revision": p["registry_revision"],
            "command": {"kind": "record_lesson", "journal_id": e["journal_id"], "publication_id": e["pub"]["publication_id"],
                "event_id": e["event"]["id"], "conducted": True, "topic": "  Демонстрациялық сабақ  ", "attendance": [], **changes}}


def send(client, e, b, admin=False):
    return client.post(e["root"] + ("/lesson-admin/commands" if admin else "/lesson-commands"), headers=csrf(client), json=b)


def record(client, e, **changes):
    response = send(client, e, body(client, e, **changes))
    assert response.status_code == 200, response.text
    return response.json()


def modify(client, e, saved, **changes):
    return {"operation_id": str(uuid.uuid4()), "expected_revision": saved["revision"], "expected_registry_revision": saved["registry_revision"],
            "command": {"kind": "update_lesson", "lesson_id": saved["lesson_id"], "topic": None, "attendance": [], "reason": "", **changes}}


def get(client, e, saved):
    return client.get(e["root"] + f"/lessons/{saved['lesson_id']}")


def test_preview_has_no_fact_then_fixed_source_roster_and_null_attendance(client, app, lesson_env):
    e = lesson_env; p = preview(client, e)
    assert p.status_code == 200 and p.json()["recorded"] is False
    with app.state.session_factory() as db:
        assert db.scalar(select(JournalLesson.id)) is None
    saved = record(client, e)
    result = get(client, e, saved).json()
    assert result["topic"] == "Демонстрациялық сабақ" and result["revision"] == 1
    assert all(r["attendance"] is None for r in result["students"])
    assert result["source"]["publication_id"] == e["pub"]["publication_id"]
    assert preview(client, e).json()["id"] == saved["lesson_id"]
    with app.state.session_factory.begin() as db:
        db.execute(update(StudentMembership).values(start="2026-08-01", end=e["event"]["date"]))
    current = client.get(e["root"] + f"/journals/{e['journal_id']}/roster", params={"on": e["event"]["date"]}).json()
    assert current["students"] == []
    assert get(client, e, saved).json()["students"] == result["students"]


@pytest.mark.parametrize("changes,code", [({"conducted": False}, "JOURNAL_CONFIRM_REQUIRED"), ({"topic": "   "}, "JOURNAL_TOPIC_INVALID"), ({"topic": "x" * 2001}, "VALIDATION_ERROR"), ({"attendance": [{"student_id": str(uuid.uuid4()), "value": "unknown"}]}, "VALIDATION_ERROR")])
def test_invalid_first_record_leaves_no_facts(client, app, lesson_env, changes, code):
    e = lesson_env; response = send(client, e, body(client, e, **changes))
    assert response.status_code == 422 and response.json()["error"]["code"] == code, response.text
    with app.state.session_factory() as db:
        assert db.scalar(select(JournalLesson.id)) is None
        assert db.scalar(select(JournalLessonOperation.id)) is None


def test_end_time_boundary_uses_published_timezone(client, app, lesson_env, monkeypatch):
    e = lesson_env; end = utc_interval(e["event"], e["source"]["timezone"])[1]
    class Clock(datetime):
        instant = end - timedelta(seconds=1)
        @classmethod
        def now(cls, tz=None): return cls.instant
    monkeypatch.setattr("backend.app.application.journal_lessons.datetime", Clock)
    b = body(client, e)
    assert send(client, e, b).json()["error"]["code"] == "JOURNAL_NOT_ENDED"
    Clock.instant = end
    assert send(client, e, b).status_code == 200


def test_topic_attendance_partial_corrections_and_immutable_history(client, app, lesson_env):
    e = lesson_env; a, b = e["students"]
    saved = record(client, e, attendance=[{"student_id": a, "value": "absent"}, {"student_id": b, "value": "present"}])
    rows = get(client, e, saved).json()["students"]
    assert all(r["grade"] is None for r in rows)  # Absence never manufactures zero.
    denied = send(client, e, modify(client, e, saved, attendance=[{"student_id": a, "value": None}]))
    assert denied.status_code == 422
    changed = send(client, e, modify(client, e, saved, topic="<b>Түзетілген тақырып</b>", attendance=[{"student_id": a, "value": "late"}], reason="Synthetic correction"))
    assert changed.status_code == 200, changed.text
    result = get(client, e, saved).json()
    assert {r["student_id"]: r["attendance"] for r in result["students"]} == {a: "late", b: "present"}
    history = client.get(e["root"] + f"/lessons/{saved['lesson_id']}/history").json()["items"]
    assert history[0]["before"]["lesson"]["topic"] == "Демонстрациялық сабақ"
    assert history[0]["reason"] == "Synthetic correction" and history[0]["actor_id"]
    assert history[0]["actor_name"] and history[0]["created_at"].endswith("+00:00")
    for sql in ("UPDATE journal_lesson_changes SET reason='x'", "DELETE FROM journal_lesson_operations", "DELETE FROM journal_lesson_students", "UPDATE journal_lessons SET source='{}'", "UPDATE journal_lesson_students SET display_name='x'"):
        with app.state.engine.begin() as db:
            with pytest.raises(IntegrityError):
                with db.begin_nested(): db.execute(text(sql))


def test_invalid_row_rolls_back_topic_and_other_rows(client, app, lesson_env):
    e = lesson_env; saved = record(client, e)
    before = get(client, e, saved).json()
    response = send(client, e, modify(client, e, saved, topic="Changed", reason="Synthetic", attendance=[
        {"student_id": e["students"][0], "value": "present"}, {"student_id": str(uuid.uuid4()), "value": "absent"}]))
    assert response.status_code == 403
    assert get(client, e, saved).json() == before


def test_retry_stale_duplicate_rows_and_unknown_fields(client, app, lesson_env):
    e = lesson_env; b = body(client, e)
    first = send(client, e, b)
    assert send(client, e, b).json() == first.json()
    assert send(client, e, {**b, "command": {**b["command"], "topic": "Other"}}).json()["error"]["code"] == "JOURNAL_OPERATION_CONFLICT"
    saved = first.json(); patch = modify(client, e, saved, attendance=[{"student_id": e["students"][0], "value": "present"}])
    assert send(client, e, patch).status_code == 200
    assert send(client, e, {**patch, "operation_id": str(uuid.uuid4())}).json()["error"]["code"] == "JOURNAL_STALE"
    assert send(client, e, {**patch, "hidden_role": "admin"}).status_code == 422
    fresh = get(client, e, saved).json()
    saved.update(revision=fresh["revision"])
    dup = [{"student_id": e["students"][0], "value": "present"}] * 2
    assert send(client, e, modify(client, e, saved, attendance=dup)).json()["error"]["code"] == "JOURNAL_ROWS_DUPLICATE"
    assert send(client, e, modify(client, e, saved, attendance=dup * 51)).status_code == 422


@pytest.mark.parametrize("role", ["admin", "scheduler", "approver", "student"])
def test_no_fact_write_by_other_roles(client, app, lesson_env, role):
    e = lesson_env; b = body(client, e); saved = record(client, e)
    login(client, app, role)
    assert send(client, e, b).status_code == 403
    assert send(client, e, modify(client, e, saved, topic="Bad")).status_code == 403
    response = get(client, e, saved)
    assert response.status_code == (200 if role == "approver" else 403)


def test_revoked_assignment_blocks_old_receipt_and_read(client, app, lesson_env):
    e = lesson_env; b = body(client, e); first = send(client, e, b).json()
    with app.state.session_factory.begin() as db:
        db.execute(update(JournalAssignment).values(active=False))
    assert send(client, e, b).status_code == 403
    assert get(client, e, first).status_code == 403


def test_concurrent_same_revision_has_one_winner(client, app, lesson_env):
    e = lesson_env; saved = record(client, e)
    service = JournalLessonService(app.state.session_factory, app.state.auth)
    token = client.cookies.get("smart_joba_session")
    changes = [modify(client, e, saved, attendance=[{"student_id": e["students"][i], "value": "present"}]) for i in range(2)]
    def write(b):
        try: return service.command(token, uuid.UUID(e["scope"]), b, str(uuid.uuid4()))["revision"]
        except ApiError as err: return err.code
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(write, changes))
    assert sorted(map(str, results)) == ["2", "JOURNAL_STALE"]


def test_roster_correction_preserves_removed_personal_record(client, app, lesson_env):
    e = lesson_env; saved = record(client, e, attendance=[{"student_id": e["students"][0], "value": "late"}], grades=[{"student_id": e["students"][0], "value": 75}])
    login(client, app, "admin")
    admin = client.get(e["root"] + f"/lesson-admin/lessons/{saved['lesson_id']}/roster").json()
    assert "attendance" not in str(admin) and "topic" not in str(admin) and "grade" not in str(admin)
    b = {"operation_id": str(uuid.uuid4()), "expected_revision": saved["revision"], "expected_registry_revision": admin["registry_revision"],
        "command": {"kind": "correct_roster", "lesson_id": saved["lesson_id"], "student_ids": [e["students"][1]], "reason": "Synthetic roster correction"}}
    assert send(client, e, b, True).status_code == 200
    login(client, app, "teacher")
    result = get(client, e, saved).json()
    removed = next(r for r in result["students"] if r["student_id"] == e["students"][0])
    assert removed["active"] is False and removed["attendance"] == "late" and removed["grade"] == 75
    saved.update(revision=result["revision"], registry_revision=result["registry_revision"])
    assert send(client, e, modify(client, e, saved, attendance=[{"student_id": removed["student_id"], "value": "present"}], reason="No")).status_code == 403
    assert send(client, e, modify(client, e, saved, grades=[{"student_id": removed["student_id"], "value": None}], reason="No")).status_code == 403


def test_new_publication_requires_mapping_and_preserves_origin(client, app, lesson_env):
    e = lesson_env; saved = record(client, e, attendance=[{"student_id": e["students"][0], "value": "late"}], grades=[{"student_id": e["students"][0], "value": 100}])
    before = get(client, e, saved).json()
    login(client, app)
    current = client.get(f"/api/schedule-versions/{e['version']['id']}").json()
    version = fork(client, app, current)
    version = approve(client, app, submit(client, e, version))
    new = publish(client, version)
    with app.state.session_factory() as db:
        events = db.get(Publication, uuid.UUID(new["publication_id"])).snapshot["events"]
    event = next(x for x in events if x["demand_id"] == e["event"]["demand_id"])
    e2 = {**e, "pub": new, "event": event}
    login(client, app, "teacher")
    assert preview(client, e2).json()["blocked"] == "JOURNAL_MAPPING_REQUIRED"
    assert send(client, e2, body(client, e2)).json()["error"]["code"] == "JOURNAL_MAPPING_REQUIRED"
    login(client, app, "admin")
    b = {"operation_id": str(uuid.uuid4()), "expected_revision": saved["revision"], "expected_registry_revision": saved["registry_revision"],
        "command": {"kind": "resolve_event", "journal_id": e["journal_id"], "publication_id": new["publication_id"], "event_id": event["id"], "lesson_id": saved["lesson_id"], "reason": "Synthetic explicit correspondence"}}
    assert send(client, e, b, True).status_code == 200
    login(client, app, "teacher")
    after = preview(client, e2).json()
    assert after["id"] == saved["lesson_id"] and after["source"] == before["source"]
    assert after["students"] == before["students"] and after["source_changed"] is True
    assert len(after["current_links"]) == 1


def test_csrf_origin_body_limit_and_foreign_scope(client, app, lesson_env):
    e = lesson_env; b = body(client, e); path = e["root"] + "/lesson-commands"
    assert client.post(path, json=b).status_code == 403
    assert client.post(path, json=b, headers={**csrf(client), "Origin": "https://invalid.example"}).status_code == 403
    assert client.post(path, content=b" " * 131073, headers=csrf(client)).status_code == 413
    saved = record(client, e)
    foreign = uuid.uuid4()
    with app.state.session_factory.begin() as db: db.add(Scope(id=foreign, name="Synthetic other", is_demo=True))
    assert client.get(f"/api/scopes/{foreign}/journal/lessons/{saved['lesson_id']}").status_code == 403


def test_changed_registry_rejects_first_save_instead_of_silently_changing_roster(client, app, lesson_env):
    e = lesson_env; b = body(client, e)
    login(client, app, "admin")
    e["setup"]({"kind": "rename_student", "student_id": e["students"][0], "display_name": "Демо түзетілді", "reason": "Synthetic correction"})
    login(client, app, "teacher")
    assert send(client, e, b).json()["error"]["code"] == "JOURNAL_STALE"
    assert preview(client, e).json()["recorded"] is False


def test_failed_audit_rolls_back_fact_roster_link_and_receipt(client, app, lesson_env, monkeypatch):
    e = lesson_env; b = body(client, e)
    def fail(*args): raise RuntimeError("synthetic commit-boundary failure")
    monkeypatch.setattr("backend.app.application.journal_lessons.audit", fail)
    with pytest.raises(RuntimeError, match="commit-boundary"):
        send(client, e, b)
    with app.state.session_factory() as db:
        assert db.scalar(select(JournalLesson.id)) is None
        assert db.scalar(select(JournalLessonStudent.student_id)) is None
        assert db.scalar(select(JournalLessonChange.id)) is None
        assert db.scalar(select(JournalLessonOperation.id)) is None


def test_teacher_date_boundary_and_current_assignment_rechecked(client, app, lesson_env):
    e = lesson_env; b = body(client, e)
    with app.state.session_factory.begin() as db:
        db.execute(update(JournalAssignment).values(start="2026-08-01", end=e["event"]["date"]))
    assert send(client, e, b).status_code == 403
    assert preview(client, e).status_code == 403


def test_unconfirmed_source_and_unknown_publication_cannot_create_fact(client, app, lesson_env):
    e = lesson_env; b = body(client, e)
    bad = {**b, "command": {**b["command"], "publication_id": e["draft"]["id"]}}
    assert send(client, e, bad).status_code == 403
    with app.state.session_factory.begin() as db:
        db.execute(update(TeachingDemand).where(TeachingDemand.id == uuid.UUID(e["event"]["demand_id"])).values(open_issues=["synthetic unresolved"]))
    assert send(client, e, b).json()["error"]["code"] == "JOURNAL_SOURCE_UNCONFIRMED"


def test_archived_unrecorded_source_rejected_and_admin_explicit_new_decision(client, app, lesson_env):
    e = lesson_env; original_body = body(client, e)
    # One recorded fact makes a later profile require explicit review.
    saved = record(client, e)
    login(client, app)
    current = client.get(f"/api/schedule-versions/{e['version']['id']}").json()
    version = fork(client, app, current)
    version = approve(client, app, submit(client, e, version))
    new = publish(client, version)
    with app.state.session_factory() as db:
        events = db.get(Publication, uuid.UUID(new["publication_id"])).snapshot["events"]
        old_events = db.get(Publication, uuid.UUID(e["pub"]["publication_id"])).snapshot["events"]
    event = next(x for x in events if x["demand_id"] == e["event"]["demand_id"])
    old_event = next(x for x in old_events if x["demand_id"] == e["event"]["demand_id"] and x["id"] != e["event"]["id"])
    login(client, app, "teacher")
    stale = {**original_body, "command": {**original_body["command"], "event_id": old_event["id"]}}
    assert send(client, e, stale).json()["error"]["code"] == "JOURNAL_SOURCE_ARCHIVED"
    login(client, app, "admin")
    b = {"operation_id": str(uuid.uuid4()), "expected_revision": 0, "expected_registry_revision": saved["registry_revision"],
        "command": {"kind": "resolve_event", "journal_id": e["journal_id"], "publication_id": new["publication_id"], "event_id": event["id"], "lesson_id": None, "reason": "Synthetic new lesson decision"}}
    result = send(client, e, b, True)
    assert result.status_code == 200 and result.json()["lesson_id"] is None
    assert send(client, e, b, True).json() == result.json()
    login(client, app, "teacher")
    e2 = {**e, "pub": new, "event": event}
    new_saved = record(client, e2)
    assert new_saved["lesson_id"] != saved["lesson_id"]


def test_revoke_committed_while_waiting_for_scope_lock_prevents_save(client, app, lesson_env):
    e = lesson_env; b = body(client, e)
    token = client.cookies.get("smart_joba_session")
    service = JournalLessonService(app.state.session_factory, app.state.auth)
    started = __import__("threading").Event()
    def write():
        started.set()
        try: return service.command(token, uuid.UUID(e["scope"]), b, str(uuid.uuid4()))
        except ApiError as err: return err.code
    with ThreadPoolExecutor(max_workers=1) as pool:
        with app.state.session_factory.begin() as db:
            db.scalar(select(Scope).where(Scope.id == uuid.UUID(e["scope"])).with_for_update())
            future = pool.submit(write)
            assert started.wait(2)
            db.execute(update(JournalAssignment).values(active=False))
        assert future.result(timeout=10) == "ACCESS_DENIED"

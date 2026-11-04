"""J1 foundation: synthetic records only; lesson-fact AC remain pending."""
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import date

import pytest
from sqlalchemy import select, text, update
from sqlalchemy.exc import IntegrityError

from backend.app.infrastructure.models import Group, RoleGrant, Scope, TeachingDemand, User
from backend.app.infrastructure.journal_models import JournalSetupChange, JournalSetupOperation, Student, StudentMembership
from backend.app.application.journal_setup import JournalSetupService
from .conftest import csrf, login
from .editor_fixtures import setup_editor


@pytest.fixture
def journal(client, app):
    env = setup_editor(client, app)
    session = login(client, app, "admin")
    scope = session["user"]["home_scope_id"]
    root = f"/api/scopes/{scope}/journal"
    def send(command, **extra):
        revision = client.get(root + "/setup").json()["revision"]
        return client.post(root + "/commands", headers=csrf(client), json={"operation_id": str(uuid.uuid4()), "expected_revision": revision, "command": command, **extra})
    def student(name="Демо студент А", kind="synthetic"):
        response = send({"kind": "create_student", "display_name": name, "data_kind": kind})
        assert response.status_code == 200, response.text
        return response.json()["id"]
    data = client.get(root + "/setup").json()
    assert len(data["demands"]) == 3
    demand = data["demands"][0]
    response = send({"kind": "create_journal", "demand_id": demand["id"], "source": "Synthetic fixture", "confirmed": True})
    assert response.status_code == 200, response.text
    return {**env, "scope": scope, "root": root, "send": send, "student": student, "data": data, "demand": demand, "journal_id": response.json()["id"]}


def member(j, student, **changes):
    return {"kind": "save_membership", "student_id": student, "context_id": j["demand"]["context_id"], "group_id": j["demand"]["group_id"], "start": "2026-09-01", "end": "2027-07-01", "source": "Synthetic confirmed roster", "confirmed": True, **changes}


def assignment(j, **changes):
    return {"kind": "save_assignment", "journal_id": j["journal_id"], "teacher_id": j["data"]["teachers"][0]["id"], "start": "2026-09-01", "end": "2027-07-01", "source": "Synthetic appointment", "confirmed": True, **changes}


def test_ac_jrn007_stable_id_duplicate_names_allowed_and_history_retained(client, app, journal):
    j = journal; one = j["student"](); two = j["student"]()
    assert one != two
    changed = j["send"]({"kind": "rename_student", "student_id": one, "display_name": "  Демо студент жаңартылды  ", "reason": "Synthetic correction"})
    assert changed.status_code == 200 and changed.json()["id"] == one
    history = client.get(j["root"] + "/history").json()["items"][0]
    assert history["before"]["display_name"] == "Демо студент А"
    assert history["after"]["display_name"] == "Демо студент жаңартылды"
    assert history["reason"] == "Synthetic correction"
    with app.state.engine.begin() as db:
        with pytest.raises(IntegrityError):
            with db.begin_nested():
                db.execute(text("UPDATE journal_setup_changes SET reason='changed'"))
        with pytest.raises(IntegrityError):
            with db.begin_nested():
                db.execute(text("DELETE FROM journal_setup_operations"))


def test_membership_boundary_and_transfer_do_not_infer_names(client, app, journal):
    j = journal; student = j["student"]()
    first = j["send"](member(j, student, end="2026-10-01"))
    other = next(g for g in j["data"]["groups"] if g["id"] != j["demand"]["group_id"])
    assert first.status_code == 200
    assert j["send"](member(j, student, group_id=other["id"], start="2026-10-01")).status_code == 200
    login(client, app, "approver")
    before = client.get(j["root"] + f"/journals/{j['journal_id']}/roster?on=2026-09-30").json()
    after = client.get(j["root"] + f"/journals/{j['journal_id']}/roster?on=2026-10-01").json()
    assert before["students"] == [{"id": student, "display_name": "Демо студент А"}]
    assert after["students"] == [] and after["is_snapshot"] is False


@pytest.mark.parametrize("changes,code", [({"end": "2026-09-01"}, "JOURNAL_INTERVAL_INVALID"), ({"confirmed": False}, "JOURNAL_CONFIRM_REQUIRED"), ({"source": "  "}, "JOURNAL_REQUIRED")])
def test_invalid_membership_is_atomic(journal, client, changes, code):
    j = journal; student = j["student"]()
    previous = client.get(j["root"] + "/setup").json()["revision"]
    response = j["send"](member(j, student, **changes))
    assert response.status_code == 422 and response.json()["error"]["code"] == code
    data = client.get(j["root"] + "/setup").json()
    assert data["revision"] == previous and data["memberships"] == []


def test_overlapping_membership_and_update_reason(journal):
    j = journal; student = j["student"]()
    first = j["send"](member(j, student)).json()
    assert j["send"](member(j, student)).json()["error"]["code"] == "JOURNAL_MEMBERSHIP_OVERLAP"
    assert j["send"](member(j, student, id=first["id"], end="2026-10-01")).status_code == 422
    assert j["send"](member(j, student, id=first["id"], end="2026-10-01", reason="Synthetic transfer")).status_code == 200


def test_ac_jrn009_explicit_student_binding_own_projection_and_revocation(client, app, journal):
    j = journal; student = j["student"](); j["student"]("Демо студент Б")
    assert j["send"](member(j, student)).status_code == 200
    account = j["data"]["accounts"][0]
    login(client, app, "student")
    assert client.get(j["root"] + "/me").status_code == 403
    assert client.get(j["root"] + "/setup").status_code == 403
    login(client, app, "admin")
    bind = {"kind": "bind_account", "user_id": account["id"], "student_id": student, "source": "Synthetic binding", "confirmed": True}
    assert j["send"](bind).status_code == 200
    login(client, app, "student")
    own = client.get(j["root"] + f"/me?student_id={uuid.uuid4()}").json()
    assert own["student"]["id"] == student and "Демо студент Б" not in str(own)
    assert "source" not in str(own) and "email" not in str(own)
    assert client.get("/api/me").json()["grants"][0]["student_id"] == student
    login(client, app, "admin")
    assert j["send"]({**bind, "student_id": None, "reason": "Synthetic revoke"}).status_code == 200
    login(client, app, "student")
    assert client.get(j["root"] + "/me").status_code == 403


def test_teacher_requires_explicit_assignment_and_date_window(client, app, journal):
    j = journal; body = assignment(j, end="2026-10-01")
    with app.state.session_factory.begin() as db:
        db.execute(update(RoleGrant).where(RoleGrant.scope_id == uuid.UUID(j["scope"]), RoleGrant.role == "teacher").values(teacher_id=uuid.UUID(body["teacher_id"])))
    login(client, app, "teacher")
    assert client.get(j["root"] + "/journals").json()["journals"] == []
    login(client, app, "admin")
    assigned = j["send"](body).json()
    login(client, app, "teacher")
    assert len(client.get(j["root"] + "/journals").json()["journals"]) == 1
    path = j["root"] + f"/journals/{j['journal_id']}/roster?on="
    assert client.get(path + "2026-09-01").status_code == 200
    assert client.get(path + "2026-10-01").status_code == 403
    assert client.get(path + "2026-08-31").status_code == 403
    login(client, app, "admin")
    assert j["send"]({**body, "id": assigned["id"], "active": False, "reason": "Synthetic revoke"}).status_code == 200
    login(client, app, "teacher")
    assert client.get(path + "2026-09-01").status_code == 403


@pytest.mark.parametrize("role", ["scheduler", "approver", "teacher", "student"])
def test_setup_admin_only_and_history_is_private(client, app, journal, role):
    login(client, app, role); root = journal["root"]
    assert client.get(root + "/setup").status_code == 403
    assert client.get(root + "/history").status_code == 403
    response = client.post(root + "/commands", headers=csrf(client), json={"operation_id": str(uuid.uuid4()), "expected_revision": 1, "command": {"kind": "create_student", "display_name": "No", "data_kind": "synthetic"}})
    assert response.status_code == 403


def test_admin_cannot_read_journal_or_personal_results(client, journal):
    assert client.get(journal["root"] + "/journals").status_code == 403
    assert client.get(journal["root"] + "/me").status_code == 403


def test_retries_stale_and_changed_operation_payload(client, app, journal):
    j = journal
    body = {"operation_id": str(uuid.uuid4()), "expected_revision": 1, "command": {"kind": "create_student", "display_name": "Демо студент", "data_kind": "synthetic"}}
    first = client.post(j["root"] + "/commands", headers=csrf(client), json=body)
    assert first.status_code == 200
    second = client.post(j["root"] + "/commands", headers=csrf(client), json=body)
    assert second.json() == first.json()
    conflict = client.post(j["root"] + "/commands", headers=csrf(client), json={**body, "expected_revision": 2})
    assert conflict.json()["error"]["code"] == "JOURNAL_OPERATION_CONFLICT"
    stale = client.post(j["root"] + "/commands", headers=csrf(client), json={**body, "operation_id": str(uuid.uuid4())})
    assert stale.json()["error"]["code"] == "JOURNAL_STALE"
    with app.state.session_factory.begin() as db:
        db.execute(text("DELETE FROM role_grants WHERE role='admin'"))
    assert client.post(j["root"] + "/commands", headers=csrf(client), json=body).status_code == 403


def test_csrf_origin_unknown_fields_and_body_limit(client, journal):
    root = journal["root"]
    body = {"operation_id": str(uuid.uuid4()), "expected_revision": 1, "command": {"kind": "create_student", "display_name": "Демо студент", "data_kind": "synthetic"}}
    assert client.post(root + "/commands", json=body, headers={"Origin": "http://127.0.0.1:8000"}).status_code == 403
    assert client.post(root + "/commands", json=body, headers={**csrf(client), "Origin": "https://invalid.example"}).status_code == 403
    assert client.post(root + "/commands", json={**body, "role": "admin"}, headers=csrf(client)).status_code == 422
    assert client.post(root + "/commands", json={**body, "expected_revision": True}, headers=csrf(client)).status_code == 422
    assert client.post(root + "/commands", content=b" " * 131073, headers=csrf(client)).status_code == 413


def test_data_kind_and_scope_cannot_be_mixed(client, app, journal):
    j = journal; student = j["student"](kind="college")
    assert j["send"](member(j, student)).status_code == 403
    assert j["send"]({"kind": "bind_account", "user_id": j["data"]["accounts"][0]["id"], "student_id": student, "source": "Test", "confirmed": True}).status_code == 403
    foreign = uuid.uuid4()
    with app.state.session_factory.begin() as db:
        db.add(Scope(id=foreign, name="Synthetic other scope", is_demo=True))
        db.flush()
        foreign_student = Student(scope_id=foreign, display_name="Other", data_kind="synthetic")
        db.add(foreign_student); db.flush(); foreign_id = str(foreign_student.id)
    assert j["send"]({"kind": "rename_student", "student_id": foreign_id, "display_name": "Other", "reason": "No"}).status_code == 403
    assert client.get(f"/api/scopes/{foreign}/journal/setup").status_code == 403


def test_duplicate_journal_and_unconfirmed_demand_rejected(client, app, journal):
    j = journal
    assert j["send"]({"kind": "create_journal", "demand_id": j["demand"]["id"], "source": "Test", "confirmed": True}).json()["error"]["code"] == "JOURNAL_EXISTS"
    with app.state.session_factory.begin() as db:
        db.execute(update(TeachingDemand).where(TeachingDemand.id == uuid.UUID(j["data"]["demands"][1]["id"])).values(open_issues=["test"]))
    assert j["send"]({"kind": "create_journal", "demand_id": j["data"]["demands"][1]["id"], "source": "Test", "confirmed": True}).status_code == 422


def test_concurrent_same_revision_only_one_commits(client, app, journal):
    j = journal; token = client.cookies.get("smart_joba_session")
    service = JournalSetupService(app.state.session_factory, app.state.auth)
    def write(index):
        from backend.app.application.auth import ApiError
        try:
            return service.command(token, uuid.UUID(j["scope"]), {"operation_id": str(uuid.uuid4()), "expected_revision": 1, "command": {"kind": "create_student", "display_name": f"Concurrent {index}", "data_kind": "synthetic"}}, str(uuid.uuid4()))["revision"]
        except ApiError as e:
            return e.code
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(write, [1, 2]))
    assert sorted(map(str, results)) == ["2", "JOURNAL_STALE"]
    assert len(client.get(j["root"] + "/setup").json()["students"]) == 1


def test_failure_after_apply_rolls_back_registry_history_and_receipt(client, app, journal, monkeypatch):
    original = JournalSetupService.apply
    def fail(self, db, scope_id, actor, command):
        original(self, db, scope_id, actor, command)
        raise RuntimeError("Synthetic failure")
    monkeypatch.setattr(JournalSetupService, "apply", fail)
    service = JournalSetupService(app.state.session_factory, app.state.auth)
    with pytest.raises(RuntimeError):
        service.command(client.cookies.get("smart_joba_session"), uuid.UUID(journal["scope"]), {"operation_id": str(uuid.uuid4()), "expected_revision": 1, "command": {"kind": "create_student", "display_name": "Rollback", "data_kind": "synthetic"}}, str(uuid.uuid4()))
    data = client.get(journal["root"] + "/setup").json()
    assert data["students"] == [] and data["revision"] == 1


def test_schedule_group_sync_is_explicit_and_retains_personal_identity(client, app, journal):
    from datetime import datetime, timedelta
    from zoneinfo import ZoneInfo
    j = journal; student = j["student"]()
    today = datetime.now(ZoneInfo("Asia/Almaty")).date()
    membership = j["send"](member(j, student, start=str(today - timedelta(days=5)), end=str(today + timedelta(days=5)))).json()
    account = j["data"]["accounts"][0]
    assert j["send"]({"kind": "bind_account", "user_id": account["id"], "student_id": student, "source": "Synthetic binding", "confirmed": True}).status_code == 200
    with app.state.session_factory() as db:
        grant = db.scalar(select(RoleGrant).where(RoleGrant.user_id == uuid.UUID(account["id"]), RoleGrant.role == "student"))
        assert str(grant.group_id) == account["group_id"]
    result = j["send"]({"kind": "sync_schedule_group", "membership_id": membership["id"], "reason": "Synthetic transfer confirmed"})
    assert result.status_code == 200, result.text
    login(client, app, "student")
    grant = client.get("/api/me").json()["grants"][0]
    assert grant["student_id"] == student and grant["group_id"] == j["demand"]["group_id"]
    assert client.get(j["root"] + "/me").json()["student"]["id"] == student


def test_duplicate_student_binding_rejected_without_changing_existing_link(client, app, journal):
    from backend.app.infrastructure.journal_models import StudentAccountBinding
    j = journal; student = j["student"](); account = j["data"]["accounts"][0]
    assert j["send"]({"kind": "bind_account", "user_id": account["id"], "student_id": student, "source": "Synthetic binding", "confirmed": True}).status_code == 200
    with app.state.session_factory.begin() as db:
        target = User(email="second-student@example.test", display_name="Synthetic second account", password_hash="unused-login-disabled", home_scope_id=uuid.UUID(j["scope"]), is_active=True)
        db.add(target); db.flush()
        db.add(RoleGrant(user_id=target.id, scope_id=uuid.UUID(j["scope"]), role="student", group_id=uuid.UUID(account["group_id"])))
        target_id = str(target.id)
    response = j["send"]({"kind": "bind_account", "user_id": target_id, "student_id": student, "source": "Test", "confirmed": True})
    assert response.json()["error"]["code"] == "JOURNAL_STUDENT_ALREADY_BOUND"
    with app.state.session_factory() as db:
        binding = db.scalar(select(StudentAccountBinding).where(StudentAccountBinding.student_id == uuid.UUID(student)))
        assert str(binding.user_id) == account["id"]


def test_revocation_while_waiting_for_grant_lock_prevents_commit(client, app, journal):
    from concurrent.futures import TimeoutError
    from backend.app.application.auth import ApiError
    j = journal; token = client.cookies.get("smart_joba_session")
    service = JournalSetupService(app.state.session_factory, app.state.auth)
    def write():
        try:
            return service.command(token, uuid.UUID(j["scope"]), {"operation_id": str(uuid.uuid4()), "expected_revision": 1, "command": {"kind": "create_student", "display_name": "Must not persist", "data_kind": "synthetic"}}, str(uuid.uuid4()))
        except ApiError as e:
            return e.code
    with ThreadPoolExecutor(max_workers=1) as pool:
        with app.state.session_factory.begin() as db:
            db.execute(text("DELETE FROM role_grants WHERE role='admin'"))
            future = pool.submit(write)
            with pytest.raises(TimeoutError):
                future.result(timeout=0.3)
        assert future.result(timeout=5) == "ACCESS_DENIED"
    with app.state.session_factory() as db:
        assert db.scalar(select(Student).where(Student.display_name == "Must not persist")) is None

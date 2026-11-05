"""Cross-role journal acceptance on generated records in the disposable test database."""
import secrets
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from backend.app.infrastructure.lesson_models import (
    JournalEventLink, JournalLesson, JournalLessonChange, JournalLessonOperation, JournalLessonStudent,
)
from backend.app.infrastructure.models import RoleGrant, User
from backend.app.infrastructure.security import PASSWORDS
from .conftest import csrf, login
from .test_journal_lessons import body, lesson_env, modify, preview, record, send


@pytest.mark.parametrize("lesson_env", ["college"], indirect=True)
def test_ac_jrn_043_demo_student_rejected_by_college_lesson(client, app, lesson_env):
    lesson = lesson_env
    assert lesson["source"]["data_kind"] == "college"
    login(client, app, "admin")
    foreign = lesson["setup"]({
        "kind": "create_student", "display_name": "Демо студент", "data_kind": "synthetic",
    })["id"]
    login(client, app, "teacher")
    roster = preview(client, lesson).json()["students"]
    assert {row["student_id"] for row in roster} == set(lesson["students"])

    # Include a legitimate mark too: the rejected write must roll it back.
    legitimate = {"student_id": lesson["students"][0], "value": 82}
    attempt = body(client, lesson, grades=[legitimate, {"student_id": foreign, "value": 98}])
    rejected = send(client, lesson, attempt)
    assert rejected.status_code == 403
    assert rejected.json()["error"]["code"] == "ACCESS_DENIED"
    with app.state.session_factory() as db:
        for model in (JournalLesson, JournalLessonStudent, JournalEventLink, JournalLessonChange, JournalLessonOperation):
            assert db.scalar(select(model).limit(1)) is None
    assert preview(client, lesson).json()["recorded"] is False
    assert record(client, lesson, grades=[legitimate])["revision"] == 1


def test_corrected_mark_visible_only_in_its_own_student_session(client, app, lesson_env):
    lesson = lesson_env
    alice, boris = lesson["students"]
    login(client, app, "admin")
    first_account, = client.get(lesson["root"] + "/setup").json()["accounts"]
    peer_password = secrets.token_urlsafe(24)
    peer_email = "peer@demo.local"
    scope = uuid.UUID(lesson["scope"])
    group = uuid.UUID(lesson["event"]["group_id"])
    with app.state.session_factory.begin() as db:
        first_grant = db.scalars(select(RoleGrant).where(
            RoleGrant.user_id == uuid.UUID(first_account["id"]), RoleGrant.scope_id == scope, RoleGrant.role == "student",
        )).one()
        first_grant.group_id = group
        peer = User(email=peer_email, display_name="Демо екінші аккаунт",
                    password_hash=PASSWORDS.hash(peer_password), home_scope_id=scope)
        db.add(peer)
        db.flush()
        db.add(RoleGrant(user_id=peer.id, scope_id=scope, role="student", group_id=group))
        peer_id = str(peer.id)
    for account_id, student_id in ((first_account["id"], alice), (peer_id, boris)):
        lesson["setup"]({"kind": "bind_account", "user_id": account_id, "student_id": student_id,
                         "source": "Synthetic acceptance roster", "confirmed": True})

    login(client, app, "teacher")
    saved = record(client, lesson, topic="Демо сабақ",
                   attendance=[{"student_id": alice, "value": "present"}, {"student_id": boris, "value": "absent"}],
                   grades=[{"student_id": alice, "value": 70}, {"student_id": boris, "value": 0}])
    url = lesson["root"] + "/me/results"
    with TestClient(app, base_url=str(client.base_url)) as first, TestClient(app, base_url=str(client.base_url)) as second:
        login(first, app, "student")
        assert second.post("/api/auth/login", headers=csrf(second),
                           json={"email": peer_email, "password": peer_password}).status_code == 200
        assert first.get(url).json()["items"][0]["grade"] == 70
        assert second.get(url).json()["items"][0]["grade"] == 0

        reason = "Демо: жұмыс қайта тексерілді"
        corrected = send(client, lesson, modify(client, lesson, saved, reason=reason,
                                                grades=[{"student_id": alice, "value": 85}]))
        assert corrected.status_code == 200
        history_url = lesson["root"] + f"/lessons/{saved['lesson_id']}/history"
        change = client.get(history_url).json()["items"][0]
        assert change["reason"] == reason
        for side, expected in (("before", 70), ("after", 85)):
            assert next(r["grade"] for r in change[side]["students"] if r["student_id"] == alice) == expected

        for reader, owner, other, grade, attendance in (
            (first, alice, boris, 85, "present"), (second, boris, alice, 0, "absent"),
        ):
            response = reader.get(url)
            assert response.status_code == 200
            personal = response.json()
            assert personal["student"]["id"] == owner and other not in response.text
            item, = personal["items"]
            assert (item["topic"], item["grade"], item["attendance"]) == ("Демо сабақ", grade, attendance)
            assert reason not in response.text
            assert reader.get(url, params={"student_id": other}).status_code == 422
            assert reader.get(history_url).status_code == 403

"""Generated records only: privacy, retries, reviews and immutable attempts."""
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import date

import pytest
from sqlalchemy import select, text, update
from sqlalchemy.exc import IntegrityError
from backend.app.application.course_tasks import CourseTaskService
from backend.app.application.auth import ApiError
from backend.app.application.courses import CourseService
from backend.app.infrastructure.journal_models import JournalAssignment, StudentAccountBinding, StudentMembership
from backend.app.infrastructure.models import RoleGrant
from backend.app.infrastructure.task_models import CourseReview, CourseSubmission, CourseTask
from .conftest import csrf, login
from .test_courses import PDF, course, journal


@pytest.fixture
def task(client, course):
    _, url = course
    assert client.post(url + "/open", headers=csrf(client)).status_code == 200
    topic = {"id": str(uuid.uuid4()), "title": "Демо тема"}
    assert client.post(url + "/topics", headers=csrf(client), json=topic).status_code == 200
    body = {"id": str(uuid.uuid4()), "topic_id": topic["id"], "title": "Демо задание", "instructions": "Write a greeting.", "due_on": "2000-01-01"}
    assert client.post(url + "/tasks", headers=csrf(client), json=body).status_code == 200
    return {"url": url + "/tasks/" + body["id"], "course": url, "body": body}


def submit(client, task, *, attempt=0, operation=None, pdf=False, **extra):
    data = {"id": operation or str(uuid.uuid4()), "expected_attempt": str(attempt), **extra}
    if not pdf:
        data.setdefault("text", "Hello!")
    files = {"file": ("response.pdf", PDF, "application/pdf")} if pdf else None
    return client.post(task["url"] + "/submissions", headers=csrf(client), data=data, files=files)


def review(client, task, submission, **extra):
    body = {"id": str(uuid.uuid4()), "expected_revision": 0, "outcome": "graded", "grade": 0, "feedback": "Checked", **extra}
    return client.post(task["url"] + f"/submissions/{submission}/reviews", headers=csrf(client), json=body)


def test_task_submit_return_resubmit_grade_and_history(client, app, task):
    login(client, app, "student")
    assert client.get(task["url"]).json()["attempts"] == []
    first = submit(client, task).json()["id"]
    own = client.get(task["url"]).json()["attempts"][0]
    assert own["text"] == "Hello!" and own["late"] is True and own["review"] is None
    assert submit(client, task, attempt=1).json()["error"]["code"] == "TASK_ALREADY_SUBMITTED"
    login(client, app, "teacher")
    assert client.get(task["url"] + "/submissions").json()["items"][0]["id"] == first
    assert review(client, task, first, outcome="returned", grade=None, feedback="Add a dialogue").status_code == 200
    login(client, app, "student")
    assert client.get(task["url"]).json()["attempts"][0]["review"]["feedback"] == "Add a dialogue"
    second = submit(client, task, attempt=1, pdf=True).json()["id"]
    assert client.get(task["url"] + f"/submissions/{second}/pdf").content == PDF
    login(client, app, "teacher")
    assert review(client, task, first, expected_revision=1, reason="Old attempt").status_code == 409
    assert review(client, task, second, grade=100).status_code == 200
    assert review(client, task, second, expected_revision=1, grade=0).json()["error"]["code"] == "TASK_REASON_REQUIRED"
    assert review(client, task, second, expected_revision=1, grade=0, reason="Private correction").status_code == 200
    staff = client.get(task["url"] + f"/submissions/{second}").json()["attempts"]
    assert [r["grade"] for r in staff[0]["reviews"]] == [0, 100]
    assert staff[0]["reviews"][0]["reason"] == "Private correction"
    login(client, app, "student")
    response = client.get(task["url"])
    attempts = response.json()["attempts"]
    assert [a["attempt"] for a in attempts] == [2, 1]
    assert attempts[0]["review"]["grade"] == 0
    assert "Private correction" not in response.text and "reviewer_id" not in response.text


def test_student_cannot_read_peer_attempts_or_pdf(client, app, task, journal):
    login(client, app, "student")
    submission = submit(client, task, pdf=True).json()["id"]
    login(client, app, "admin")
    peer = journal["student"]("Демо екінші студент")
    from .test_journal_setup import member
    assert journal["send"](member(journal, peer, start="2000-01-01", end="2200-01-01")).status_code == 200
    assert journal["send"]({"kind": "bind_account", "user_id": journal["data"]["accounts"][0]["id"], "student_id": peer,
                            "confirmed": True, "source": "Synthetic switch", "reason": "Synthetic switch"}).status_code == 200
    login(client, app, "student")
    assert client.get(task["url"]).json()["attempts"] == []
    for tail in ("", "/pdf"):
        assert client.get(task["url"] + f"/submissions/{submission}" + tail).status_code == 403
    assert client.get(task["url"] + "/submissions").status_code == 403
    assert review(client, task, submission).status_code == 403


@pytest.mark.parametrize("role", ["admin", "scheduler", "approver", "teacher"])
def test_only_confirmed_student_can_submit(client, app, task, role):
    login(client, app, role)
    assert submit(client, task).status_code == 403
    with app.state.session_factory() as db:
        assert db.scalar(select(CourseSubmission)) is None


def test_retries_stale_revisions_and_object_scope(client, app, task):
    assert client.post(task["course"] + "/tasks", headers=csrf(client), json=task["body"]).status_code == 200
    assert client.post(task["course"] + "/tasks", headers=csrf(client), json={**task["body"], "instructions": "Changed"}).status_code == 409
    login(client, app, "student")
    operation = str(uuid.uuid4())
    first = submit(client, task, operation=operation)
    assert first.status_code == 200
    assert submit(client, task, operation=operation).json() == first.json()
    assert submit(client, task, operation=operation, text="Changed").status_code == 409
    assert submit(client, task).json()["error"]["code"] == "TASK_STALE"
    fake = {**task, "url": task["url"].replace(task["body"]["id"], str(uuid.uuid4()))}
    assert submit(client, fake).status_code == 403
    login(client, app, "teacher")
    rid = str(uuid.uuid4())
    r = review(client, task, operation, id=rid)
    assert r.status_code == 200 and review(client, task, operation, id=rid).json() == r.json()
    assert review(client, task, operation, id=rid, grade=1).status_code == 409
    assert review(client, task, operation).json()["error"]["code"] == "TASK_STALE"
    with app.state.session_factory.begin() as db:
        db.execute(update(JournalAssignment).values(active=False))
    assert review(client, task, operation, id=rid).status_code == 403
    assert client.get(task["url"] + f"/submissions/{operation}").status_code == 403


@pytest.mark.parametrize("grade", [-1, 101, 75.5, True, "90", None])
def test_invalid_grades_are_atomic(client, app, task, grade):
    login(client, app, "student")
    submission = submit(client, task).json()["id"]
    login(client, app, "teacher")
    assert review(client, task, submission, grade=grade).status_code == 422
    with app.state.session_factory() as db:
        assert db.scalar(select(CourseReview)) is None


def test_scope_csrf_body_limits_and_return_feedback(client, app, task):
    login(client, app, "student")
    data = {"id": str(uuid.uuid4()), "expected_attempt": "0", "text": "Answer"}
    url = task["url"] + "/submissions"
    assert client.post(url, data=data).status_code == 403
    assert client.post(url, headers={**csrf(client), "Origin": "https://foreign.example"}, data=data).status_code == 403
    assert submit(client, task, text=" ").status_code == 422
    assert submit(client, task, text="x" * 20001).status_code == 422
    assert client.post(url, headers=csrf(client), data={k:v for k,v in data.items() if k != "text"}, files={"file":("a.pdf",b"not-pdf")}).status_code == 422
    assert client.post(url, headers=csrf(client), data={k:v for k,v in data.items() if k != "text"}, files={"file":("a.pdf",b"%PDF-" + b"x"*(5*1024*1024) + b"%%EOF")}).status_code == 413
    assert client.get(task["url"].replace(task["url"].split("/")[3], str(uuid.uuid4()))).status_code == 403
    submission = submit(client, task).json()["id"]
    login(client, app, "teacher")
    assert review(client, task, submission, outcome="returned", grade=None, feedback=" ").status_code == 422
    assert review(client, task, submission, outcome="returned", feedback="Again").status_code == 422
    assert client.get(url + "?student_id=" + str(uuid.uuid4())).status_code == 422


def test_history_is_immutable_and_grade_does_not_write_journal(client, app, task):
    login(client, app, "student")
    submission = submit(client, task).json()["id"]
    login(client, app, "teacher")
    assert review(client, task, submission, grade=85).status_code == 200
    with app.state.engine.begin() as db:
        for table in ("course_tasks", "course_submissions", "course_reviews"):
            for sql in (f"DELETE FROM {table}", f"UPDATE {table} SET id=id"):
                with pytest.raises(IntegrityError):
                    with db.begin_nested(): db.execute(text(sql))
        assert db.scalar(text("SELECT count(*) FROM journal_lessons")) == 0


def test_parallel_submission_retry_and_revoked_membership(client, app, task):
    login(client, app, "student")
    token = client.cookies.get("smart_joba_session")
    service = CourseTaskService(CourseService(app.state.session_factory, app.state.auth))
    parts = task["url"].split("/")
    scope_id, course_id, task_id = (uuid.UUID(parts[i]) for i in (3, 5, 7))
    operation = uuid.uuid4()
    def save(_):
        return service.submit(token, scope_id, course_id, task_id, operation, 0, "Hello", None)
    with ThreadPoolExecutor(max_workers=2) as pool:
        receipts = list(pool.map(save, range(2)))
    assert receipts[0] == receipts[1]
    with app.state.session_factory.begin() as db:
        assert len(db.scalars(select(CourseSubmission)).all()) == 1
        db.execute(update(StudentMembership).values(end=date(2001, 1, 1)))
    assert submit(client, task, operation=str(operation), text="Hello").status_code == 403
    assert client.get(task["url"]).status_code == 403


def test_concurrent_reviews_cannot_overwrite_each_other(client, app, task):
    login(client, app, "student")
    submission = uuid.UUID(submit(client, task).json()["id"])
    login(client, app, "teacher")
    token = client.cookies.get("smart_joba_session")
    service = CourseTaskService(CourseService(app.state.session_factory, app.state.auth))
    parts = task["url"].split("/")
    scope, course_id, task_id = (uuid.UUID(parts[i]) for i in (3, 5, 7))
    def save(grade):
        try:
            service.review(token, scope, course_id, task_id, submission,
                {"id": uuid.uuid4(), "expected_revision": 0, "outcome": "graded", "grade": grade, "feedback": "Checked", "reason": ""})
            return 200
        except ApiError as error:
            return error.status
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(save, (70, 90))) == [200, 409]
    with app.state.session_factory() as db:
        assert len(db.scalars(select(CourseReview)).all()) == 1


def test_task_creation_validation_and_forged_topic(client, app, task):
    for changes in ({"instructions": " "}, {"title": "x" * 161}, {"due_on": "not-a-date"}, {"student_id": str(uuid.uuid4())}):
        assert client.post(task["course"] + "/tasks", headers=csrf(client), json={**task["body"], "id": str(uuid.uuid4()), **changes}).status_code == 422
    assert client.post(task["course"] + "/tasks", headers=csrf(client), json={**task["body"], "id": str(uuid.uuid4()), "topic_id": str(uuid.uuid4())}).status_code == 403
    login(client, app, "student")
    assert client.post(task["course"] + "/tasks", headers=csrf(client), json={**task["body"], "id": str(uuid.uuid4())}).status_code == 403

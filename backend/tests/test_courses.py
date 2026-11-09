"""Real course API and private material downloads, using generated records only."""
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import date

import pytest
from sqlalchemy import select, update

from backend.app.application.courses import CourseService
from backend.app.infrastructure.course_models import Course, CourseTopic
from backend.app.infrastructure.journal_models import JournalAssignment, Student, StudentMembership
from backend.app.infrastructure.models import CalendarProfile, Group, ImportContext, RoleGrant, Scope, Subject, Teacher
from .conftest import csrf, login
from .test_journal_setup import assignment, journal, member

PDF = b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n"


@pytest.fixture
def course(client, app, journal):
    j = journal
    teacher = j["data"]["teachers"][0]["id"]
    with app.state.session_factory.begin() as db:
        db.execute(update(RoleGrant).where(RoleGrant.role == "teacher").values(teacher_id=uuid.UUID(teacher)))
        db.execute(update(RoleGrant).where(RoleGrant.role == "student").values(group_id=uuid.UUID(j["demand"]["group_id"])))
    sid = j["student"]()
    interval = {"start": "2000-01-01", "end": "2200-01-01"}
    assert j["send"](member(j, sid, **interval)).status_code == 200
    assert j["send"](assignment(j, teacher_id=teacher, **interval)).status_code == 200
    assert j["send"]({"kind": "bind_account", "user_id": j["data"]["accounts"][0]["id"],
        "student_id": sid, "confirmed": True, "source": "Synthetic course test"}).status_code == 200
    login(client, app, "teacher")
    root = f"/api/scopes/{j['scope']}/courses"
    return root, root + "/" + j["journal_id"]


def content(client, course, *, file=False):
    root, url = course
    assert client.post(url + "/open", headers=csrf(client)).is_success
    topic = {"id": str(uuid.uuid4()), "title": "Сәлемдесу"}
    assert client.post(url + "/topics", headers=csrf(client), json=topic).is_success
    path = url + "/topics/" + topic["id"] + "/materials"
    data = {"id": str(uuid.uuid4()), "title": "Демо материал"}
    files = {"file": ("example.pdf", PDF, "application/pdf")} if file else None
    if not file:
        data["text"] = "Hello, how are you?"
    assert client.post(path, headers=csrf(client), data=data, files=files).is_success
    return path, data, url + "/materials/" + data["id"]


def test_course_workflow_and_safe_retries(client, app, course):
    root, url = course
    assert client.get(root).json()[0]["opened"] is False
    login(client, app, "student")
    assert client.get(root).json() == []
    assert client.get(url).status_code == 403
    login(client, app, "teacher")
    path, material, read_url = content(client, course)
    assert client.post(path, headers=csrf(client), data=material).is_success
    assert client.post(path, headers=csrf(client), data={**material, "text": "Other"}).status_code == 409
    login(client, app, "student")
    assert client.get(root).json()[0]["can_manage"] is False
    topics = client.get(url).json()["topics"]
    assert len(topics) == 1 and topics[0]["materials"] == [{"id": material["id"], "title": material["title"], "kind": "text"}]
    assert client.get(read_url).json() == {"title": material["title"], "text": material["text"]}
    assert client.post(path, headers=csrf(client), data=material).status_code == 403
    assert client.post(url + "/open", headers=csrf(client)).status_code == 403
    with app.state.session_factory.begin() as db:
        db.execute(update(StudentMembership).values(end=date(2001, 1, 1)))
    assert client.get(root).json() == []
    assert client.get(read_url).status_code == client.get(url).status_code == 403


def test_teacher_can_edit_text_material_with_stale_revision_protection(client, app, course):
    _, url = course
    _, data, read_url = content(client, course)
    edit_url = read_url + "/edit"
    assert client.get(edit_url).json() == {
        "id": data["id"], "title": data["title"], "kind": "text",
        "text": data["text"], "revision": 1,
    }
    update_url = read_url
    changed = {"expected_revision": "1", "title": "Updated reading", "text": "Revised text"}
    response = client.put(update_url, headers=csrf(client), data=changed)
    assert response.status_code == 200 and response.json()["revision"] == 2
    assert client.put(update_url, headers=csrf(client), data=changed).json()["revision"] == 2
    stale = client.put(update_url, headers=csrf(client), data={**changed, "title": "Another title"})
    assert stale.status_code == 409 and stale.json()["error"]["code"] == "COURSE_MATERIAL_STALE"
    login(client, app, "student")
    assert client.get(read_url).json() == {"title": "Updated reading", "text": "Revised text"}
    assert client.get(edit_url).status_code == 403
    assert client.put(update_url, headers=csrf(client), data={**changed, "expected_revision": "2"}).status_code == 403
    login(client, app, "admin")
    assert client.get(edit_url).status_code == 403


def test_teacher_can_rename_pdf_without_replacing_its_file(client, app, course):
    _, _, read_url = content(client, course, file=True)
    response = client.put(read_url, headers=csrf(client), data={
        "expected_revision": "1", "title": "Updated handout",
    })
    assert response.status_code == 200 and response.json()["revision"] == 2
    login(client, app, "student")
    downloaded = client.get(read_url)
    assert downloaded.status_code == 200 and downloaded.content == PDF
    assert "Updated%20handout.pdf" in downloaded.headers["content-disposition"]


def test_pdf_download_and_direct_access_boundaries(client, app, course):
    root, url = course
    path, data, read_url = content(client, course, file=True)
    login(client, app, "student")
    response = client.get(read_url)
    assert response.status_code == 200 and response.content == PDF
    assert response.headers["content-disposition"].startswith("attachment;")
    assert response.headers["cache-control"] == "no-store"
    assert client.get(root + f"/{uuid.uuid4()}/materials/{data['id']}").status_code == 403
    for role in ("admin", "scheduler", "approver"):
        login(client, app, role)
        assert client.get(root).status_code == client.get(read_url).status_code == 403
    login(client, app, "teacher")
    with app.state.session_factory.begin() as db:
        db.execute(update(JournalAssignment).values(active=False))
        scope = Scope(name="Synthetic other scope", is_demo=True)
        db.add(scope)
        db.flush()
        foreign_scope = str(scope.id)
    assert client.get(root).json() == []
    assert client.get(read_url).status_code == client.post(path, headers=csrf(client), data=data,
        files={"file": ("test.pdf", PDF)}).status_code == 403
    assert client.get(read_url.replace(root, f"/api/scopes/{foreign_scope}/courses")).status_code == 403
    client.cookies.clear()
    assert client.get(read_url).status_code == 401


def test_course_rejects_invalid_uploads_forged_parent_and_csrf(client, course):
    _, url = course
    path, _, _ = content(client, course)
    payload = {"id": str(uuid.uuid4()), "title": "Test"}
    for file, status in ((b"<html>not a pdf", 422), (b"%PDF-" + b"x" * (5 * 1024 * 1024) + b"%%EOF", 413)):
        assert client.post(path, headers=csrf(client), data=payload, files={"file": ("fake.pdf", file)}).status_code == status
    assert client.post(path, headers=csrf(client), data={**payload, "text": " "}).status_code == 422
    assert client.post(path, headers=csrf(client), data={**payload, "text": "sample"}, files={"file": ("a.pdf", PDF)}).status_code == 422
    assert client.post(path, headers={"Origin": "http://127.0.0.1:8000"}, data={**payload, "text": "x"}).status_code == 403
    assert client.post(url + f"/topics/{uuid.uuid4()}/materials", headers=csrf(client), data={**payload, "text": "x"}).status_code == 403
    assert len(client.get(url).json()["topics"][0]["materials"]) == 1


@pytest.mark.parametrize("data_kind", ["synthetic", "college"])
def test_matching_data_kind_and_current_binding_required(client, app, course, data_kind):
    # All values are generated test data, including records marked college.
    with app.state.session_factory.begin() as db:
        for model in (Group, ImportContext, Subject, Teacher, Student):
            db.execute(update(model).values(data_kind=data_kind))
    root, url = course
    _, _, read_url = content(client, course)
    assert client.get(root).json()[0]["data_kind"] == data_kind
    login(client, app, "student")
    assert client.get(read_url).status_code == 200
    with app.state.session_factory.begin() as db:
        db.execute(update(Student).values(data_kind="college" if data_kind == "synthetic" else "synthetic"))
    assert client.get(root).json() == []
    assert client.get(read_url).status_code == 403
    login(client, app, "teacher")
    with app.state.session_factory.begin() as db:
        db.execute(update(Teacher).values(data_kind="college" if data_kind == "synthetic" else "synthetic"))
    assert client.get(url).status_code == 403
    assert client.post(url + "/open", headers=csrf(client)).status_code == 403


@pytest.mark.parametrize("model", [Group, Subject])
def test_inconsistent_catalog_cannot_expose_course(client, app, course, model):
    root, url = course
    content(client, course)
    with app.state.session_factory.begin() as db:
        db.execute(update(model).values(data_kind="college"))
    assert client.get(root).json() == []
    assert client.get(url).status_code == 403


def test_unconfirmed_timezone_and_future_assignment_hide_course(client, app, course):
    root, url = course
    content(client, course)
    with app.state.session_factory.begin() as db:
        db.execute(update(JournalAssignment).values(start=date(2199, 1, 1)))
    assert client.get(root).json() == []
    assert client.get(url).status_code == 403
    with app.state.session_factory.begin() as db:
        db.execute(update(JournalAssignment).values(start=date(2000, 1, 1)))
        for calendar in db.scalars(select(CalendarProfile)):
            calendar.document = {**calendar.document, "timezone_confirmed": False}
    assert client.get(root).json() == []
    login(client, app, "student")
    assert client.get(url).status_code == 403


def test_parallel_open_and_topic_retries_create_one_record(client, app, course):
    root, url = course
    scope = uuid.UUID(root.split("/")[3])
    course_id = uuid.UUID(url.rsplit("/", 1)[1])
    token = client.cookies.get("smart_joba_session")
    service = CourseService(app.state.session_factory, app.state.auth)
    topic_id = uuid.uuid4()
    def create(_):
        service.open_course(token, scope, course_id)
        return service.add_topic(token, scope, course_id, topic_id, "Concurrent topic")
    with ThreadPoolExecutor(max_workers=2) as pool:
        receipts = list(pool.map(create, range(2)))
    assert receipts == [{"id": topic_id}] * 2
    with app.state.session_factory() as db:
        assert len(db.scalars(select(Course)).all()) == len(db.scalars(select(CourseTopic)).all()) == 1
    conflict = client.post(url + "/topics", headers=csrf(client), json={"id": str(topic_id), "title": "Changed"})
    assert conflict.status_code == 409
    assert client.get(url).json()["topics"][0]["title"] == "Concurrent topic"


def test_upload_limits_origin_and_topic_validation(client, course):
    _, url = course
    path, _, _ = content(client, course)
    for title in (" ", "a" * 161):
        assert client.post(url + "/topics", headers=csrf(client), json={"id": str(uuid.uuid4()), "title": title}).status_code == 422
    headers = {**csrf(client), "Origin": "https://unrelated.example"}
    payload = {"id": str(uuid.uuid4()), "title": "Text", "text": "No"}
    assert client.post(path, headers=headers, data=payload).status_code == 403
    payload["text"] = "a" * 20001
    assert client.post(path, headers=csrf(client), data=payload).status_code == 422
    payload["text"] = "Оқу мәтіні " * 1000
    assert client.post(path, headers=csrf(client), data=payload).status_code == 200
    assert len(client.get(url).json()["topics"][0]["materials"]) == 2


@pytest.mark.parametrize("week", [1, 10])
def test_course_topics_can_be_assigned_to_first_and_last_week(client, course, week):
    _, url = course
    topic = {
        "id": str(uuid.uuid4()),
        "title": "Апталық тақырып",
        "week_number": week,
    }
    assert client.post(url + "/open", headers=csrf(client)).is_success
    response = client.post(url + "/topics", headers=csrf(client), json=topic)
    assert response.status_code == 200
    assert client.get(url).json()["topics"][0]["week_number"] == week


@pytest.mark.parametrize("week", [0, 11, 1.5, "2"])
def test_course_topic_rejects_invalid_week_number(client, course, week):
    _, url = course
    assert client.post(url + "/open", headers=csrf(client)).is_success
    response = client.post(url + "/topics", headers=csrf(client), json={
        "id": str(uuid.uuid4()), "title": "Қате апта", "week_number": week,
    })
    assert response.status_code == 422

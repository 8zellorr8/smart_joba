"""Confirmed synthetic schedules only; use real workflow and PostgreSQL."""
import uuid

from backend.app.application.editor import EditorService
from backend.app.application.versions import VersionService
from backend.app.application.publications import PublicationService
from backend.app.infrastructure.solver import solve
from .conftest import csrf, login
from .planning_fixtures import create_job, setup_planning
from .test_generation import mark_running, service as generator_service


def services(app):
    versions = VersionService(EditorService(app.state.session_factory, app.state.auth))
    return versions, PublicationService(versions)


def setup_version(client, app):
    env = setup_planning(client, app)
    job = create_job(client, env).json()
    inputs = mark_running(app, job)
    generator_service(app).finish(uuid.UUID(job["id"]), solve(inputs, 3))
    job = client.get(f"/api/solver-jobs/{job['id']}").json()
    assert job["result_draft_id"], job
    env["version"] = client.get(f"/api/schedule-versions/{job['result_draft_id']}").json()
    return env


def expected(version):
    return {"expected_revision": version["revision"], "expected_workflow_revision": version["workflow_revision"]}


def submit(client, env, version=None, **selection):
    version = version or env["version"]
    selected = {k: env["selection"][k] for k in ("group_ids", "room_ids", "semester")}
    response = client.post(f"/api/schedule-versions/{version['id']}/submit", headers=csrf(client), json={**expected(version), **selected, **selection})
    assert response.status_code == 200, response.text
    return response.json()


def approve(client, app, version):
    login(client, app, "approver")
    response = client.post(f"/api/schedule-versions/{version['id']}/approve", headers=csrf(client),
        json={**expected(version), "submission_id": version["submission"]["id"], "comment": "SYNTHETIC TEST reviewed"})
    assert response.status_code == 200, response.text
    return response.json()


def ready(client, version):
    response = client.get('/api/readiness', params={"schedule_version_id": version["id"], "expected_revision": version["revision"]})
    assert response.status_code == 200, response.text
    return response.json()


def publication_body(client, version):
    checked = ready(client, version)
    return {**expected(version), "approval_id": version["decision"]["id"], "readiness_token": checked["token"], "idempotency_key": str(uuid.uuid4())}


def publish(client, version, body=None):
    body = body or publication_body(client, version)
    response = client.post(f"/api/schedule-versions/{version['id']}/publish", headers=csrf(client), json=body)
    assert response.status_code == 200, response.text
    return response.json()


def fork(client, app, version):
    login(client, app)
    response = client.post(f"/api/schedule-versions/{version['id']}/fork", headers=csrf(client),
        json={**expected(version), "name": "SYNTHETIC TEST revised schedule"})
    assert response.status_code == 201, response.text
    return response.json()

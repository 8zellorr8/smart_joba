from copy import deepcopy
from datetime import datetime, timezone
import uuid

import pytest
from sqlalchemy import func, select

from backend.app.application.editor import EditorService
from backend.app.application.generation import GenerationService
from backend.app.infrastructure.models import (CalendarProfile, DraftRevision, PlanningRules, PlanningRulesRevision,
    Room, ScheduleDraft, SolverJob, TeachingDemand, ValidationReport)
from backend.app.infrastructure.solver import solve
from backend.app.seed import DEMO_SCOPE_ID
from backend.app.worker import failure, run_one
from .conftest import csrf, login
from .editor_fixtures import add_series, one_body
from .planning_fixtures import create_job, preview, setup_planning


def mark_running(app, job):
    with app.state.session_factory.begin() as db:
        row = db.get(SolverJob, uuid.UUID(job["id"]))
        row.status, row.stage, row.started_at = "running", "searching", datetime.now(timezone.utc)
        return deepcopy(row.snapshot)


def service(app):
    return GenerationService(EditorService(app.state.session_factory, app.state.auth))


def test_real_worker_creates_exactly_one_new_draft_and_independent_report(client, app):
    env = setup_planning(client, app)
    before = client.get(f"/api/drafts/{env['draft']['id']}").json()
    checked = preview(client, env).json()
    assert checked["ready"] and checked["demands"] == 3
    job = create_job(client, env).json()
    assert job["status"] == "queued"
    assert run_one(app.state.session_factory)
    done = client.get(f"/api/solver-jobs/{job['id']}").json()
    assert done["status"] == "feasible", done.get("result")
    assert done["result"]["validation"]["valid"] and done["result_draft_id"] != before["id"]
    assert done["result"]["peak_rss_bytes"] > 0
    draft = client.get(f"/api/drafts/{done['result_draft_id']}").json()
    assert draft["revision"] == 1 and draft["total"] == 6
    assert client.get(f"/api/drafts/{before['id']}").json()["revision"] == before["revision"]
    reports = client.get(f"/api/drafts/{draft['id']}/validations").json()
    assert reports[0]["report"]["identity"]["draft_id"] == draft["id"] and not reports[0]["stale"]
    event = draft["occurrences"][0]
    assert client.post(f"/api/drafts/{draft['id']}/occurrences/{event['id']}", headers=csrf(client), json=one_body(draft, event, cancelled=True)).status_code == 200
    assert client.get(f"/api/solver-jobs/{job['id']}").json()["validation_stale"]
    # Finish retry is safe and creates no duplicate draft.
    service(app).finish(uuid.UUID(job["id"]), {"status": "failed"})
    assert client.get(f"/api/solver-jobs/{job['id']}").json()["result_draft_id"] == draft["id"]
    assert not run_one(app.state.session_factory)


@pytest.mark.parametrize("dependency", ["calendar", "room", "rules", "source", "base"])
def test_changed_dependency_marks_running_and_finished_result_stale(client, app, dependency):
    env = setup_planning(client, app)
    env["selection"]["base_draft_id"] = env["draft"]["id"]
    job = create_job(client, env).json(); snapshot = mark_running(app, job)
    with app.state.session_factory.begin() as db:
        if dependency == "calendar": db.get(CalendarProfile, uuid.UUID(next(iter(snapshot["dependencies"]["calendars"])))) .revision += 1
        elif dependency == "room": db.get(Room, uuid.UUID(env["rooms"][0]["id"])).revision += 1
        elif dependency == "rules": db.get(PlanningRules, uuid.UUID(env["draft"]["context_id"])).revision += 1
        elif dependency == "source":
            from backend.app.infrastructure.models import ImportContext
            db.get(ImportContext, uuid.UUID(env["draft"]["context_id"])).revision += 1
        else: db.get(ScheduleDraft, uuid.UUID(env["draft"]["id"])).revision += 1
    current = client.get(f"/api/solver-jobs/{job['id']}").json()
    assert current["status"] == "stale" and current["execution_status"] == "running"
    service(app).finish(uuid.UUID(job["id"]), solve(snapshot, 2))
    done = client.get(f"/api/solver-jobs/{job['id']}").json()
    assert done["status"] == "stale" and done["result_draft_id"] is None


def test_corrupt_feasible_result_is_independently_rejected_before_draft_creation(client, app):
    env = setup_planning(client, app); job = create_job(client, env).json()
    snapshot = mark_running(app, job); result = solve(snapshot, 2)
    result["events"][0]["teacher_id"] = str(uuid.uuid4())
    service(app).finish(uuid.UUID(job["id"]), result)
    done = client.get(f"/api/solver-jobs/{job['id']}").json()
    assert done["status"] == "failed" and done["result_draft_id"] is None
    assert not done["result"]["validation"]["valid"]


@pytest.mark.parametrize("case,expected", [("subgroup", "SUBGROUP_OR_JOINT_UNSUPPORTED"), ("joint", "SUBGROUP_OR_JOINT_UNSUPPORTED"), ("unknown", "HOURS_UNCONFIRMED")])
def test_readiness_blocks_unsupported_or_unknown_inputs(client, app, case, expected):
    env = setup_planning(client, app)
    with app.state.session_factory.begin() as db:
        demand = db.get(TeachingDemand, uuid.UUID(env["assignments"][0]["demand_id"]))
        if case == "unknown": demand.semester_amount = None
        else: demand.normalized = {**demand.normalized, "whole_group": case != "subgroup", "joint": case == "joint"}
    checked = preview(client, env).json()
    assert not checked["ready"] and expected in {q["code"] for q in checked["questions"]}
    response = create_job(client, env)
    assert response.status_code == 422 and response.json()["error"]["code"] == "GENERATION_NOT_READY"
    with app.state.session_factory() as db:
        assert db.scalar(select(func.count()).select_from(SolverJob)) == 0


def test_missing_confirmed_rules_blocks_start_and_exposes_source_question(client, app):
    from .editor_fixtures import setup_editor
    env = setup_editor(client, app)
    env["selection"] = {"context_id": env["draft"]["context_id"], "group_ids": list(env["calendars"]), "room_ids": [r["id"] for r in env["rooms"]], "semester": 1}
    checked = preview(client, env).json()
    assert not checked["ready"] and checked["questions"][0]["code"] == "RULES_UNCONFIRMED"


def test_unresolved_accepted_source_row_blocks_selected_scope(client, app):
    from .s1_fixtures import ROW, workbook
    from .test_imports import upload, review, apply
    env = setup_planning(client, app)
    row = list(ROW); row[0] = "SYNTHETIC Teacher A; SYNTHETIC Teacher B"
    row[1] = "SYNTHETIC unresolved source"; row[2] = "SYNTHETIC-OPEN"; row[3] = "TEST-EDITOR-A"; row[10] = None
    batch = upload(client, app, workbook([row])).json()
    batch = review(client, batch, {"whole_group": True}, False).json()
    assert apply(client, batch).status_code == 200
    checked = preview(client, env).json()
    assert not checked["ready"] and "SOURCE_QUESTIONS" in {q["code"] for q in checked["questions"]}
    assert create_job(client, env).status_code == 422


def test_preview_revision_conflict_and_queue_bound(client, app):
    env = setup_planning(client, app)
    old = preview(client, env).json()
    with app.state.session_factory.begin() as db:
        db.get(Room, uuid.UUID(env["rooms"][0]["id"])).revision += 1
    response = create_job(client, env, token=old["token"])
    assert response.status_code == 409 and response.json()["error"]["code"] == "PLANNING_STALE"
    assert create_job(client, env).status_code == 201
    assert create_job(client, env).json()["error"]["code"] == "GENERATOR_QUEUE_FULL"


def test_cancellation_and_worker_failure_do_not_mutate_existing_draft(client, app):
    env = setup_planning(client, app); old = env["draft"]
    queued = create_job(client, env).json()
    response = client.post(f"/api/solver-jobs/{queued['id']}/cancel", headers=csrf(client))
    assert response.json()["status"] == "cancelled" and not run_one(app.state.session_factory)
    running = create_job(client, env).json(); snapshot = mark_running(app, running)
    client.post(f"/api/solver-jobs/{running['id']}/cancel", headers=csrf(client))
    service(app).finish(uuid.UUID(running["id"]), solve(snapshot, 2))
    assert client.get(f"/api/solver-jobs/{running['id']}").json()["status"] == "cancelled"
    failed = create_job(client, env).json(); mark_running(app, failed)
    service(app).finish(uuid.UUID(failed["id"]), failure("WORKER_INTERRUPTED"))
    assert client.get(f"/api/solver-jobs/{failed['id']}").json()["status"] == "failed"
    assert client.get(f"/api/drafts/{old['id']}").json()["revision"] == old["revision"]


def test_generator_preserves_pinned_assignment_from_selected_base(client, app):
    env = setup_planning(client, app)
    draft = add_series(client, env).json(); event = draft["occurrences"][0]
    pinned = client.post(f"/api/drafts/{draft['id']}/occurrences/{event['id']}", headers=csrf(client), json=one_body(draft, event, pinned=True)).json()
    env["selection"]["base_draft_id"] = pinned["id"]
    job = create_job(client, env).json(); snapshot = mark_running(app, job)
    result = solve(snapshot, 2)
    assert any(e["id"] == event["id"] and e["pinned"] for e in result["events"])
    service(app).finish(uuid.UUID(job["id"]), result)
    assert client.get(f"/api/solver-jobs/{job['id']}").json()["result"]["validation"]["valid"]


def test_validation_checks_all_selected_demands_and_report_gets_stale(client, app):
    env = setup_planning(client, app); draft = add_series(client, env).json()
    body = {k: env["selection"][k] for k in ("group_ids", "room_ids", "semester")}; body["expected_revision"] = draft["revision"]
    response = client.post(f"/api/drafts/{draft['id']}/validate", headers=csrf(client), json=body)
    assert response.status_code == 201, response.text
    report = response.json()
    assert not report["report"]["complete"] and len(report["report"]["hours"]) == 3
    assert report["report"]["identity"]["revision"] == draft["revision"]
    event = draft["occurrences"][0]
    updated = client.post(f"/api/drafts/{draft['id']}/occurrences/{event['id']}", headers=csrf(client), json=one_body(draft, event, cancelled=True))
    assert updated.status_code == 200
    assert client.get(f"/api/drafts/{draft['id']}/validations").json()[0]["stale"]
    assert client.post(f"/api/drafts/{draft['id']}/validate", headers=csrf(client), json=body).status_code == 409


@pytest.mark.parametrize("role", ["admin", "approver", "teacher", "student"])
def test_generator_run_rights_are_checked_server_side(client, app, role):
    env = setup_planning(client, app); job = create_job(client, env).json()
    login(client, app, role)
    assert preview(client, env).status_code == 403
    assert client.post(f"/api/solver-jobs/{job['id']}/cancel", headers=csrf(client)).status_code == 403
    expected = 200 if role == "approver" else 403
    assert client.get(f"/api/solver-jobs/{job['id']}").status_code == expected


def test_config_rights_and_rule_revision_history(client, app):
    env = setup_planning(client, app); context = env["draft"]["context_id"]
    body = {"expected_revision": 1, "document": env["rules"]}
    assert client.post(f"/api/planning-contexts/{context}/rules", headers=csrf(client), json=body).status_code == 403
    login(client, app, "admin")
    bad = deepcopy(body); bad["document"]["groups"][0]["group_id"] = str(uuid.uuid4())
    assert client.post(f"/api/planning-contexts/{context}/rules", headers=csrf(client), json=bad).status_code == 403
    bad = deepcopy(body); bad["document"]["source"] = ""
    assert client.post(f"/api/planning-contexts/{context}/rules", headers=csrf(client), json=bad).status_code == 422
    changed = deepcopy(body); changed["document"]["rooms"][0]["capacity"] = 31
    assert client.post(f"/api/planning-contexts/{context}/rules", headers=csrf(client), json=changed).json()["revision"] == 2
    assert client.post(f"/api/planning-contexts/{context}/rules", headers=csrf(client), json=body).status_code == 409
    with app.state.session_factory() as db:
        assert db.scalar(select(func.count()).select_from(PlanningRulesRevision)) == 2
    assert not client.get(f"/api/scopes/{DEMO_SCOPE_ID}/planning-data").json()["drafts"]


def test_cross_scope_csrf_and_body_limits(client, app):
    env = setup_planning(client, app)
    assert client.post(f"/api/scopes/{uuid.uuid4()}/generation-preview", headers=csrf(client), json=env["selection"]).status_code == 403
    assert client.post(f"/api/scopes/{DEMO_SCOPE_ID}/generation-preview", headers={"Origin": "http://127.0.0.1:8000"}, json=env["selection"]).status_code == 403
    assert client.post(f"/api/scopes/{DEMO_SCOPE_ID}/generation-preview", headers=csrf(client), content=b" "*131073).status_code == 413
    client.post("/api/auth/logout", headers=csrf(client))
    assert preview(client, env).status_code == 401


def slow_child(snapshot, parameters, pipe):
    import time
    pipe.send(("stage", "searching"))
    time.sleep(10)


def crashed_child(snapshot, parameters, pipe):
    import os
    os._exit(7)


@pytest.mark.parametrize("reason", ["cancel", "wall", "memory", "crash"])
def test_worker_enforces_process_limits_and_cancellation(client, app, reason):
    from concurrent.futures import ThreadPoolExecutor
    import time
    env = setup_planning(client, app); job = create_job(client, env).json()
    with app.state.session_factory.begin() as db:
        row = db.get(SolverJob, uuid.UUID(job["id"]))
        if reason == "wall": row.parameters = {**row.parameters, "process_wall_seconds": .2}
        if reason == "memory": row.parameters = {**row.parameters, "memory_mib": 1}
    with ThreadPoolExecutor(1) as pool:
        future = pool.submit(run_one, app.state.session_factory, crashed_child if reason == "crash" else slow_child)
        if reason == "cancel":
            for _ in range(60):
                with app.state.session_factory.begin() as db:
                    row = db.get(SolverJob, uuid.UUID(job["id"]))
                    if row.status == "running":
                        row.cancel_requested = True; break
                time.sleep(.05)
        assert future.result(timeout=15)
    done = client.get(f"/api/solver-jobs/{job['id']}").json()
    assert done["status"] == ("cancelled" if reason == "cancel" else "failed"), done["result"]
    assert done["result_draft_id"] is None
    if reason != "cancel":
        assert done["result"]["raw_status"] == {"wall": "PROCESS_WALL_LIMIT", "memory": "MEMORY_LIMIT", "crash": "WORKER_INTERRUPTED"}[reason]
    assert client.get(f"/api/drafts/{env['draft']['id']}").json()["revision"] == 1


def test_failure_before_commit_rolls_back_new_draft_and_revision(client, app, monkeypatch):
    env = setup_planning(client, app); job = create_job(client, env).json(); data = mark_running(app, job)
    result = solve(data, 2)
    def broken(*args, **kwargs): raise RuntimeError("SYNTHETIC persistence fault")
    monkeypatch.setattr(EditorService, "record", broken)
    with pytest.raises(RuntimeError): service(app).finish(uuid.UUID(job["id"]), result)
    with app.state.session_factory() as db:
        assert db.scalar(select(func.count()).select_from(ScheduleDraft)) == 1
        assert db.scalar(select(func.count()).select_from(ValidationReport)) == 0
        assert db.scalar(select(func.count()).select_from(DraftRevision)) == 1
        assert db.get(SolverJob, uuid.UUID(job["id"])).status == "running"


def test_atomic_concurrent_queue_admission(client, app):
    from concurrent.futures import ThreadPoolExecutor
    from backend.app.application.auth import ApiError
    env = setup_planning(client, app); checked = preview(client, env).json()
    body = {**env["selection"], "token": checked["token"], "seconds": 2}
    token = client.cookies.get("smart_joba_session")
    def create():
        try: return service(app).create(token, DEMO_SCOPE_ID, body, str(uuid.uuid4()))["status"]
        except ApiError as error: return error.code
    with ThreadPoolExecutor(2) as pool: results = list(pool.map(lambda _: create(), range(2)))
    assert sorted(results) == ["GENERATOR_QUEUE_FULL", "queued"]


def test_restart_recovery_keeps_snapshot_and_source_draft(client, app):
    from backend.app.worker import recover_interrupted
    env = setup_planning(client, app); job = create_job(client, env).json(); original = mark_running(app, job)
    recover_interrupted(app.state.session_factory)
    done = client.get(f"/api/solver-jobs/{job['id']}").json()
    assert done["status"] == "failed" and done["result"]["raw_status"] == "WORKER_INTERRUPTED"
    with app.state.session_factory() as db:
        assert db.get(SolverJob, uuid.UUID(job["id"])).snapshot == original
        assert db.scalar(select(func.count()).select_from(ScheduleDraft)) == 1


@pytest.mark.parametrize("revoke", ["account", "grant"])
def test_worker_rechecks_actor_permissions_before_saving_result(client, app, revoke):
    from backend.app.infrastructure.models import RoleGrant, User
    env = setup_planning(client, app); job = create_job(client, env).json(); data = mark_running(app, job)
    with app.state.session_factory.begin() as db:
        row = db.get(SolverJob, uuid.UUID(job["id"]))
        if revoke == "account": db.get(User, row.created_by).is_active = False
        else:
            grant = db.scalar(select(RoleGrant).where(RoleGrant.user_id == row.created_by, RoleGrant.role == "scheduler"))
            db.delete(grant)
    service(app).finish(uuid.UUID(job["id"]), solve(data, 2))
    with app.state.session_factory() as db:
        row = db.get(SolverJob, uuid.UUID(job["id"]))
        assert row.status == "failed" and row.result_draft_id is None
        assert row.result["raw_status"] == "AUTHORIZATION_CHANGED"
        assert db.scalar(select(func.count()).select_from(ScheduleDraft)) == 1

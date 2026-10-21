from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
import uuid

import pytest
from sqlalchemy import func, select, text, update
from sqlalchemy.exc import IntegrityError

from backend.app.application.auth import ApiError
from backend.app.application.publications import PUBLICATION_LOCK, PublicationService
from backend.app.infrastructure.models import (CalendarProfile, ImportContext, PlanningRules, Publication, PublicationHead,
    PublicationOperation, RoleGrant, Room, ScheduleDraft, ScheduleSeries, VersionDecision, VersionSubmission, VersionTransition)
from backend.app.seed import DEMO_SCOPE_ID
from .conftest import csrf, login
from .editor_fixtures import add_series
from .publication_fixtures import approve, expected, fork, publication_body, publish, ready, services, setup_version, submit


@pytest.fixture
def env(client, app):
    return setup_version(client, app)


def count(app, model):
    with app.state.session_factory() as db: return db.scalar(select(func.count()).select_from(model))


def test_exact_revision_workflow_publishes_a_reader_snapshot_without_internal_data(client, app, env):
    submitted = submit(client, env)
    assert submitted["status"] == "submitted" and submitted["workflow_revision"] == 2
    assert submitted["submission"]["report"]["valid"]
    draft = client.get(f"/api/drafts/{submitted['id']}").json()
    assert add_series(client, env, draft).status_code == 409
    approved = approve(client, app, submitted)
    assert approved["status"] == "approved" and approved["decision"]["revision"] == approved["revision"]
    assert ready(client, approved)["ready"]
    receipt = publish(client, approved)
    listed = client.get(f"/api/scopes/{DEMO_SCOPE_ID}/publications").json()
    assert listed[0]["publication_id"] == receipt["publication_id"] and listed[0]["is_current"]
    view = client.get(f"/api/publications/{receipt['publication_id']}").json()
    assert len(view["events"]) == 6 and view["version_number"] == approved["version_number"]
    assert view["revision"] == approved["revision"] and view["scope_name"] and view["published_at"]
    serialized = json.dumps(view)
    for private in ("source_row_id", "source_coordinate", "assignment_id", "inputs", "SYNTHETIC TEST reviewed"):
        assert private not in serialized
    history = client.get(f"/api/schedule-versions/{approved['id']}").json()["history"]
    assert [h["action"] for h in history] == ["submit", "approve", "publish"]
    assert all(h["actor"] and h["created_at"] for h in history)


def test_rejection_needs_reason_and_old_workflow_command_cannot_cross_a_reopen_cycle(client, app, env):
    submitted = submit(client, env)
    login(client, app, "approver")
    body = {**expected(submitted), "submission_id": submitted["submission"]["id"], "comment": "   "}
    url = f"/api/schedule-versions/{submitted['id']}"
    assert client.post(url + '/reject', headers=csrf(client), json=body).status_code == 422
    assert count(app, VersionDecision) == 0
    body["comment"] = "SYNTHETIC TEST correct the source"
    rejected = client.post(url + '/reject', headers=csrf(client), json=body).json()
    assert rejected["status"] == "rejected" and rejected["decision"]["comment"] == body["comment"]
    login(client, app)
    reopened = client.post(url + '/reopen', headers=csrf(client), json=expected(rejected)).json()
    assert reopened["status"] == "draft"
    again = submit(client, env, reopened)
    login(client, app, "approver")
    assert client.post(url + '/approve', headers=csrf(client), json=body).status_code == 409
    assert client.post(url + '/approve', headers=csrf(client), json={**body, **expected(again)}).status_code == 409
    assert approve(client, app, again)["status"] == "approved"


@pytest.mark.parametrize("role", ["admin", "scheduler", "teacher", "student"])
def test_direct_approval_cannot_be_granted_by_client_role_or_scope_parameters(client, app, env, role):
    submitted = submit(client, env)
    login(client, app, role)
    response = client.post(f"/api/schedule-versions/{submitted['id']}/approve?scope_id={uuid.uuid4()}&role=approver",
        headers=csrf(client), json={**expected(submitted), "submission_id": submitted["submission"]["id"]})
    assert response.status_code == 403 and count(app, VersionDecision) == 0


def test_author_with_an_added_approver_role_still_cannot_approve_own_content(client, app, env):
    submitted = submit(client, env)
    user_id = uuid.UUID(client.get('/api/me').json()["id"])
    with app.state.session_factory.begin() as db:
        db.add(RoleGrant(user_id=user_id, scope_id=DEMO_SCOPE_ID, role="approver", can_publish=True))
    response = client.post(f"/api/schedule-versions/{submitted['id']}/approve", headers=csrf(client),
        json={**expected(submitted), "submission_id": submitted["submission"]["id"]})
    assert response.status_code == 403 and response.json()["error"]["code"] == "VERSION_SELF_APPROVAL"


def test_approval_does_not_imply_permission_to_publish_and_revocation_is_immediate(client, app, env):
    approved = approve(client, app, submit(client, env))
    body = publication_body(client, approved)
    with app.state.session_factory.begin() as db:
        db.execute(update(RoleGrant).where(RoleGrant.role == 'approver').values(can_publish=False))
    assert client.post(f"/api/schedule-versions/{approved['id']}/publish", headers=csrf(client), json=body).status_code == 403
    assert count(app, Publication) == 0


@pytest.mark.parametrize("dependency", ["content", "context", "calendar", "room", "rules"])
def test_old_approval_and_readiness_never_authorize_changed_inputs(client, app, env, dependency):
    approved = approve(client, app, submit(client, env))
    body = publication_body(client, approved)
    with app.state.session_factory.begin() as db:
        if dependency == 'content': db.get(ScheduleDraft, uuid.UUID(approved["id"])).revision += 1
        if dependency == 'context': db.get(ImportContext, uuid.UUID(approved["context_id"])).revision += 1
        if dependency == 'calendar': db.get(CalendarProfile, uuid.UUID(next(iter(env["calendars"].values()))["id"])).revision += 1
        if dependency == 'room': db.get(Room, uuid.UUID(env["rooms"][0]["id"])).revision += 1
        if dependency == 'rules': db.get(PlanningRules, uuid.UUID(approved["context_id"])).revision += 1
    if dependency == 'content': body["expected_revision"] += 1
    response = client.post(f"/api/schedule-versions/{approved['id']}/publish", headers=csrf(client), json=body)
    assert response.status_code == 409 and count(app, Publication) == 0


def test_a_report_for_version_a_is_rejected_for_version_b(client, app, env):
    a = approve(client, app, submit(client, env))
    a_ready = ready(client, a)
    b = fork(client, app, a)
    b = approve(client, app, submit(client, env, b))
    body = publication_body(client, b); body["readiness_token"] = a_ready["token"]
    response = client.post(f"/api/schedule-versions/{b['id']}/publish", headers=csrf(client), json=body)
    assert response.status_code == 409 and response.json()["error"]["code"] == "PUBLICATION_READINESS_STALE"
    assert count(app, Publication) == 0


def test_independent_submission_check_rebuilds_hours_instead_of_trusting_old_report(client, app, env):
    with app.state.session_factory.begin() as db:
        series = db.scalar(select(ScheduleSeries).where(ScheduleSeries.draft_id == uuid.UUID(env["version"]["id"])))
        series.occurrences = [{**e, "cancelled": True} for e in series.occurrences]
    response = client.post(f"/api/schedule-versions/{env['version']['id']}/submit", headers=csrf(client),
        json={**expected(env["version"]), **{k: env["selection"][k] for k in ('group_ids','room_ids','semester')}})
    assert response.status_code == 422 and not response.json()["error"]["params"]["report"]["valid"]
    assert count(app, VersionSubmission) == 0


def test_idempotent_replay_and_a_different_request_with_the_same_key(client, app, env):
    approved = approve(client, app, submit(client, env)); body = publication_body(client, approved)
    first = publish(client, approved, body)
    assert publish(client, approved, body) == first
    wrong = {**body, "expected_revision": approved["revision"] + 1}
    response = client.post(f"/api/schedule-versions/{approved['id']}/publish", headers=csrf(client), json=wrong)
    assert response.status_code == 409 and response.json()["error"]["code"] == "PUBLICATION_KEY_REUSED"
    assert count(app, Publication) == count(app, PublicationOperation) == 1


def test_rollback_after_pointer_switch_preserves_previous_publication_and_allows_retry(client, app, env, monkeypatch):
    original = approve(client, app, submit(client, env)); old_body = publication_body(client, original)
    old_receipt = publish(client, original, old_body)
    old_snapshot = client.get(f"/api/publications/{old_receipt['publication_id']}").json()
    old = client.get(f"/api/schedule-versions/{original['id']}").json()
    new = fork(client, app, old); new = approve(client, app, submit(client, env, new)); body = publication_body(client, new)
    normal = PublicationService.switch
    def fail(self, db, publication, version, user_id):
        normal(self, db, publication, version, user_id); db.flush()
        raise ApiError("TEST_PUBLICATION_ROLLBACK", 503)
    monkeypatch.setattr(PublicationService, 'switch', fail)
    response = client.post(f"/api/schedule-versions/{new['id']}/publish", headers=csrf(client), json=body)
    assert response.status_code == 503 and count(app, Publication) == count(app, PublicationOperation) == 1
    assert client.get(f"/api/publications/{old_receipt['publication_id']}").json() == old_snapshot
    assert client.get(f"/api/schedule-versions/{new['id']}").json()["status"] == 'approved'
    monkeypatch.setattr(PublicationService, 'switch', normal)
    new_receipt = publish(client, new, body)
    assert new_receipt["publication_id"] != old_receipt["publication_id"]
    assert client.get(f"/api/schedule-versions/{old['id']}").json()["status"] == 'archived'
    assert client.get(f"/api/publications/{old_receipt['publication_id']}").json()["events"] == old_snapshot["events"]
    listed = client.get(f"/api/scopes/{DEMO_SCOPE_ID}/publications").json()
    assert len(listed) == 1 and listed[0]["publication_id"] == new_receipt["publication_id"]
    assert publish(client, original, old_body) == old_receipt
    assert client.get(f"/api/scopes/{DEMO_SCOPE_ID}/publications").json() == listed


def test_concurrent_retries_commit_exactly_one_publication(client, app, env):
    approved = approve(client, app, submit(client, env)); body = publication_body(client, approved)
    token = client.cookies.get('smart_joba_session'); _, publication = services(app)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: publication.publish(token, uuid.UUID(approved["id"]), body, str(uuid.uuid4())), range(2)))
    assert results[0] == results[1] and count(app, Publication) == 1


def test_exhausted_global_lock_retry_returns_a_controlled_conflict_without_writes(client, app, env):
    original = approve(client, app, submit(client, env)); old_receipt = publish(client, original)
    old_snapshot = client.get(f"/api/publications/{old_receipt['publication_id']}").json()
    listed = client.get(f"/api/scopes/{DEMO_SCOPE_ID}/publications").json()
    old = client.get(f"/api/schedule-versions/{original['id']}").json()
    revised = fork(client, app, old)
    approved = approve(client, app, submit(client, env, revised)); body = publication_body(client, approved)
    with app.state.engine.begin() as locked:
        locked.execute(text('SELECT pg_advisory_xact_lock(:key)'), {"key": PUBLICATION_LOCK})
        response = client.post(f"/api/schedule-versions/{approved['id']}/publish", headers=csrf(client), json=body)
    assert response.status_code == 409 and response.json()["error"]["code"] == 'PUBLICATION_BUSY'
    assert count(app, Publication) == count(app, PublicationOperation) == 1
    assert client.get(f"/api/publications/{old_receipt['publication_id']}").json() == old_snapshot
    assert client.get(f"/api/scopes/{DEMO_SCOPE_ID}/publications").json() == listed
    assert client.get(f"/api/schedule-versions/{approved['id']}").json()["status"] == 'approved'
    assert publish(client, approved, body)["publication_id"] != old_receipt["publication_id"]


@pytest.mark.parametrize("role,kind", [("teacher", "teacher"), ("student", "group")])
def test_reader_bindings_filter_every_read_and_cannot_be_bypassed_by_ids(client, app, env, role, kind):
    approved = approve(client, app, submit(client, env)); receipt = publish(client, approved)
    full = client.get(f"/api/publications/{receipt['publication_id']}").json()
    login(client, app, role)
    assert client.get(f"/api/scopes/{DEMO_SCOPE_ID}/publications").json() == []
    assert client.get(f"/api/publications/{receipt['publication_id']}").status_code == 403
    own_id = env["assignments"][0][kind + '_id']
    with app.state.session_factory.begin() as db:
        db.execute(update(RoleGrant).where(RoleGrant.role == role).values(**{kind + '_id': uuid.UUID(own_id)}))
    visible = client.get(f"/api/publications/{receipt['publication_id']}").json()
    assert visible["total"] == 4 and len(visible["resources"][kind]) == 1
    for entry in visible["events"]:
        assert entry[kind] == env["assignments"][0][kind]
    foreign = next(r["id"] for r in full["resources"][kind] if r["id"] != own_id)
    assert client.get(f"/api/publications/{receipt['publication_id']}?view={kind}&resource_id={foreign}").status_code == 403
    assert client.get(f"/api/schedule-versions/{approved['id']}").status_code == 403
    with app.state.session_factory.begin() as db:
        db.execute(text('DELETE FROM role_grants WHERE role=:role'), {"role": role})
    assert client.get(f"/api/publications/{receipt['publication_id']}").status_code == 403


@pytest.mark.parametrize("table,key", [("publications", "id"), ("version_submissions", "id"),
    ("version_decisions", "id"), ("version_transitions", "id"), ("publication_operations", "key")])
def test_publication_and_workflow_records_are_immutable_in_postgresql(client, app, env, table, key):
    publish(client, approve(client, app, submit(client, env)))
    with pytest.raises(IntegrityError, match='Immutable schedule record'):
        with app.state.engine.begin() as db: db.execute(text(f'UPDATE {table} SET {key}={key}'))


def test_published_source_cannot_be_edited_and_fork_keeps_original_unchanged(client, app, env):
    approved = approve(client, app, submit(client, env)); receipt = publish(client, approved)
    original = client.get(f"/api/schedule-versions/{approved['id']}").json()
    login(client, app)
    draft = client.get(f"/api/drafts/{original['id']}").json()
    assert add_series(client, env, draft).status_code == 409
    new = fork(client, app, original)
    assert new["parent_id"] == original["id"] and new["version_number"] > original["version_number"]
    assert new["status"] == 'draft' and new["decision"] is None and new["revision"] == 1
    assert client.get(f"/api/schedule-versions/{original['id']}").json() == original
    assert client.get(f"/api/publications/{receipt['publication_id']}").json()["is_current"]


def subset_version(client, app, env, indexes):
    login(client, app)
    response = client.post(f'/api/scopes/{DEMO_SCOPE_ID}/drafts', headers=csrf(client),
        json={'context_id': env['version']['context_id'], 'name': 'SYNTHETIC TEST separate publication profile'})
    assert response.status_code == 201, response.text
    draft = response.json()
    for index in indexes:
        response = add_series(client, env, draft, index=index, slot_id='second' if index == 1 else 'first')
        assert response.status_code == 201, response.text
        draft = response.json()
    version = client.get(f"/api/schedule-versions/{draft['id']}").json()
    group_ids = sorted({env['assignments'][i]['group_id'] for i in indexes})
    return approve(client, app, submit(client, env, version, group_ids=group_ids))


def test_concurrent_conflicting_profiles_cannot_both_become_active(client, app, env):
    a = subset_version(client, app, env, (0,1)); b = subset_version(client, app, env, (2,))
    bodies = [publication_body(client, a), publication_body(client, b)]
    token = client.cookies.get('smart_joba_session'); _, publisher = services(app)
    def attempt(pair):
        version, body = pair
        try: return publisher.publish(token, uuid.UUID(version['id']), body, str(uuid.uuid4()))
        except ApiError as problem: return problem.code
    with ThreadPoolExecutor(max_workers=2) as pool: results = list(pool.map(attempt, zip((a,b), bodies)))
    assert sum(isinstance(result, dict) for result in results) == 1
    assert count(app, PublicationHead) == count(app, Publication) == 1
    loser = b if isinstance(results[0], dict) else a
    checked = ready(client, loser)
    assert not checked['ready'] and any(i['code'] == 'PUBLICATION_RESOURCE_CONFLICT' for i in checked['issues'])
    response = client.post(f"/api/schedule-versions/{loser['id']}/publish", headers=csrf(client), json=publication_body(client, loser))
    assert response.status_code == 422 and count(app, PublicationHead) == 1


def test_partial_overlap_does_not_silently_replace_part_of_a_whole_snapshot(client, app, env):
    publish(client, approve(client, app, submit(client, env)))
    part = subset_version(client, app, env, (0,1))
    checked = ready(client, part)
    assert not checked['ready'] and any(i['code'] == 'PUBLICATION_PROFILE_OVERLAP' for i in checked['issues'])


def test_a_reader_request_observes_one_consistent_snapshot_during_pointer_replacement(client, app, env, monkeypatch):
    original = approve(client, app, submit(client, env)); old_receipt = publish(client, original)
    old = client.get(f"/api/schedule-versions/{original['id']}").json()
    new = approve(client, app, submit(client, env, fork(client, app, old)))
    body = publication_body(client, new); token = client.cookies.get('smart_joba_session'); _, publisher = services(app)
    normal = PublicationService.metadata; replaced = []
    def replace_during_read(db, publication, events):
        if not replaced:
            replaced.append(publisher.publish(token, uuid.UUID(new['id']), body, str(uuid.uuid4())))
        return normal(db, publication, events)
    monkeypatch.setattr(PublicationService, 'metadata', staticmethod(replace_during_read))
    during = client.get(f'/api/scopes/{DEMO_SCOPE_ID}/publications').json()
    assert during[0]['publication_id'] == old_receipt['publication_id'] and during[0]['is_current']
    after = client.get(f'/api/scopes/{DEMO_SCOPE_ID}/publications').json()
    assert after[0]['publication_id'] == replaced[0]['publication_id'] and after[0]['is_current']


def test_generator_cancellation_and_real_child_crash_leave_active_publication_unchanged(client, app, env):
    from .planning_fixtures import create_job
    from .test_generation import crashed_child
    from backend.app.worker import run_one
    receipt = publish(client, approve(client, app, submit(client, env)))
    login(client, app)
    before = client.get(f"/api/publications/{receipt['publication_id']}").json()
    queued = create_job(client, env).json()
    assert client.post(f"/api/solver-jobs/{queued['id']}/cancel", headers=csrf(client)).status_code == 200
    second = create_job(client, env).json()
    assert run_one(app.state.session_factory, crashed_child)
    assert client.get(f"/api/solver-jobs/{second['id']}").json()['status'] == 'failed'
    assert client.get(f"/api/publications/{receipt['publication_id']}").json() == before


def test_source_changes_do_not_rewrite_the_already_published_snapshot(client, app, env):
    receipt = publish(client, approve(client, app, submit(client, env)))
    before = client.get(f"/api/publications/{receipt['publication_id']}").json()
    with app.state.session_factory.begin() as db:
        db.get(ImportContext, uuid.UUID(env['version']['context_id'])).revision += 1
        db.get(PlanningRules, uuid.UUID(env['version']['context_id'])).revision += 1
    assert client.get(f"/api/publications/{receipt['publication_id']}").json() == before


def test_authorized_independent_check_of_published_content_does_not_mutate_publication(client, app, env):
    approved = approve(client, app, submit(client, env)); receipt = publish(client, approved)
    before = client.get(f"/api/publications/{receipt['publication_id']}").json()
    response = client.post(f"/api/drafts/{approved['id']}/validate", headers=csrf(client),
        json={"expected_revision": approved['revision'], **{k:env['selection'][k] for k in ('group_ids','room_ids','semester')}})
    assert response.status_code == 201 and response.json()['report']['valid']
    assert client.get(f"/api/publications/{receipt['publication_id']}").json() == before


def test_version_mutations_require_authorization_csrf_strict_contract_and_bounded_body(client, app, env):
    url=f"/api/schedule-versions/{env['version']['id']}/submit"
    body={**expected(env['version']), **{k:env['selection'][k] for k in ('group_ids','room_ids','semester')}}
    assert client.post(url, json=body).status_code == 403
    assert client.post(url, headers=csrf(client), json={**body,'role':'approver'}).status_code == 422
    assert client.post(url, headers=csrf(client), json={**body,'padding':'x'*140000}).status_code == 413
    client.post('/api/auth/logout',headers=csrf(client))
    assert client.post(url,headers=csrf(client),json=body).status_code == 401
    assert count(app, VersionSubmission) == 0


def test_readiness_requires_version_and_revision_and_publish_cannot_take_only_an_id(client, app, env):
    approved=approve(client,app,submit(client,env))
    assert client.get('/api/readiness',params={'schedule_version_id':approved['id']}).status_code == 422
    assert client.get('/api/readiness',params={'schedule_version_id':approved['id'],'expected_revision':approved['revision']+1}).status_code == 409
    assert client.post(f"/api/schedule-versions/{approved['id']}/publish",headers=csrf(client),json={}).status_code == 422
    assert count(app, Publication) == 0


def test_readiness_a_cannot_publish_a_conflicting_unapproved_draft_b(client, app, env):
    a = approve(client, app, submit(client, env)); a_body = publication_body(client, a)
    b = fork(client, app, a)
    draft = client.get(f"/api/drafts/{b['id']}").json()
    # Add a repeated occurrence at an existing group's first occupied slot.
    with app.state.session_factory.begin() as db:
        row = db.scalar(select(ScheduleSeries).where(ScheduleSeries.draft_id==uuid.UUID(b['id'])))
        duplicate = {**deepcopy(row.occurrences[0]), 'id':str(uuid.uuid4())}
        row.occurrences = [*row.occurrences,duplicate]
    b = client.get(f"/api/schedule-versions/{b['id']}").json()
    login(client, app, 'approver')
    response = client.post(f"/api/schedule-versions/{b['id']}/publish",headers=csrf(client),
        json={**a_body,**expected(b),'idempotency_key':str(uuid.uuid4())})
    assert response.status_code == 409 and count(app, Publication) == 0


def test_publication_area_caption_is_part_of_the_immutable_snapshot(client, app, env):
    from backend.app.infrastructure.models import Scope
    receipt=publish(client,approve(client,app,submit(client,env)))
    before=client.get(f"/api/publications/{receipt['publication_id']}").json()
    with app.state.session_factory.begin() as db: db.get(Scope,DEMO_SCOPE_ID).name='SYNTHETIC TEST renamed area'
    assert client.get(f"/api/publications/{receipt['publication_id']}").json() == before

import json
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select, update

from backend.app.adapters.http import CSRF_COOKIE, SESSION_COOKIE
from backend.app.config import Settings
from backend.app.domain.permissions import permissions_for
from backend.app.infrastructure.models import AuditEvent, AuthSession, ImportContext, RoleGrant, ScheduleDraft, Scope, User
from backend.app.infrastructure.security import token_hash
from backend.app.infrastructure.security import valid_csrf
from backend.app.seed import prepare_accounts
from .conftest import csrf, login


def test_ac024c_prepared_account_opens_its_scoped_workspace(client, app):
    session = login(client, app)
    response = client.get(f"/api/scopes/{session['user']['home_scope_id']}/workspace")
    assert response.status_code == 200
    assert response.json()["role_codes"] == ["scheduler"]
    assert response.json()["scope"]["is_demo"] is True
    assert "draft.edit" in response.json()["permissions"]
    assert "draft.approve" not in response.json()["permissions"]


def test_ac024a_unknown_and_bad_password_have_identical_public_error(client, app):
    def attempt(email):
        return client.post("/api/auth/login", headers=csrf(client), json={"email": email, "password": "incorrect-test-value"})
    bad = attempt(app.state.test_accounts["scheduler"]["email"])
    unknown = attempt("missing@test.example")
    assert bad.status_code == unknown.status_code == 401
    assert bad.json()["error"]["code"] == unknown.json()["error"]["code"] == "AUTH_INVALID_CREDENTIALS"
    assert bad.json()["error"]["params"] == unknown.json()["error"]["params"] == {}


def test_ac024b_logout_revokes_the_old_session_even_if_cookie_is_replayed(client, app):
    login(client, app)
    old = client.cookies.get(SESSION_COOKIE)
    response = client.post("/api/auth/logout", headers=csrf(client))
    assert response.status_code == 204
    client.cookies.set(SESSION_COOKIE, old)
    assert client.get("/api/me").status_code == 401


def test_expired_session_and_blocked_account_cannot_access_closed_api(client, app):
    login(client, app)
    token = client.cookies.get(SESSION_COOKIE)
    with app.state.session_factory.begin() as db:
        db.execute(update(AuthSession).where(AuthSession.token_hash == token_hash(token)).values(expires_at=datetime.now(UTC) - timedelta(seconds=1)))
    assert client.get("/api/me").status_code == 401
    login(client, app)
    with app.state.session_factory.begin() as db:
        db.execute(update(User).where(User.email == app.state.test_accounts["scheduler"]["email"]).values(is_active=False))
    assert client.get("/api/me").status_code == 401


def test_ac010a_direct_approval_is_rejected_for_scheduler_and_admin(client, app):
    for role in ("scheduler", "admin"):
        session = login(client, app, role)
        response = client.post(f"/api/schedule-versions/{uuid.uuid4()}/approve?scope_id={session['user']['home_scope_id']}", headers=csrf(client), json={"expected_revision": 1, "expected_workflow_revision": 1, "submission_id": str(uuid.uuid4())})
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "ACCESS_DENIED"
    session = login(client, app, "approver")
    response = client.post(f"/api/schedule-versions/{uuid.uuid4()}/approve?scope_id={session['user']['home_scope_id']}", headers=csrf(client), json={"expected_revision": 1, "expected_workflow_revision": 1, "submission_id": str(uuid.uuid4())})
    assert response.status_code == 404  # A real loaded version, never a query scope, determines access.


def test_scope_idor_and_cross_scope_role_escalation(client, app):
    session = login(client, app)
    foreign_id = uuid.uuid4()
    with app.state.session_factory.begin() as db:
        db.add(Scope(id=foreign_id, name="Synthetic other scope", is_demo=True))
        db.flush()
        db.add(RoleGrant(user_id=uuid.UUID(session["user"]["id"]), scope_id=foreign_id, role="approver", can_publish=False))
    home = session["user"]["home_scope_id"]
    assert "draft.approve" not in client.get(f"/api/scopes/{home}/workspace").json()["permissions"]
    assert "draft.approve" in client.get(f"/api/scopes/{foreign_id}/workspace").json()["permissions"]
    assert client.get(f"/api/scopes/{uuid.uuid4()}/workspace").status_code == 403
    with app.state.session_factory.begin() as db:
        context = ImportContext(scope_id=uuid.UUID(home), academic_year="2026-2027", data_kind="synthetic", revision=0, version_counter=1)
        db.add(context); db.flush()
        version = ScheduleDraft(context_id=context.id, name="SYNTHETIC scope check", revision=1, version_number=1,
            status="draft", dependencies={}, created_by=uuid.UUID(session["user"]["id"]))
        db.add(version); db.flush(); version_id = str(version.id)
    response = client.post(f"/api/schedule-versions/{version_id}/approve?scope_id={foreign_id}", headers=csrf(client), json={"expected_revision": 1, "expected_workflow_revision": 1, "submission_id": str(uuid.uuid4())})
    assert response.status_code == 403


def test_revoked_grant_takes_effect_without_issuing_a_new_session(client, app):
    session = login(client, app)
    with app.state.session_factory.begin() as db:
        db.execute(delete(RoleGrant).where(RoleGrant.user_id == uuid.UUID(session["user"]["id"])))
    assert client.get(f"/api/scopes/{session['user']['home_scope_id']}/workspace").status_code == 403
    assert client.get("/api/me").json()["grants"] == []


def test_publication_is_not_an_implicit_admin_or_approver_right():
    scope = str(uuid.uuid4())
    assert "draft.approve" not in permissions_for([{"role": "admin", "scope_id": scope}], scope)
    assert "draft.publish" not in permissions_for([{"role": "approver", "scope_id": scope}], scope)
    assert "draft.publish" in permissions_for([{"role": "approver", "scope_id": scope, "can_publish": True}], scope)


def test_non_ascii_csrf_is_a_controlled_rejection():
    assert valid_csrf("қате", "қате", "test-secret") is False
    assert valid_csrf("ascii", "қате", "test-secret") is False


def test_configuration_does_not_echo_secrets_and_refuses_insecure_network_mode():
    secret = "private-test-configuration-secret-value"
    dsn = "postgresql+psycopg://test:private-test-db-value@127.0.0.1/example"
    with pytest.raises(ValueError) as error:
        Settings(database_url=dsn, app_secret=secret, local_only=False, cookie_secure=False)
    assert secret not in str(error.value)
    assert "private-test-db-value" not in str(error.value)


@pytest.mark.parametrize("role,binding,permission", [("teacher", "teacher_id", "publication.read.own"), ("student", "group_id", "publication.read.group")])
def test_readers_require_confirmed_binding(role, binding, permission):
    scope = str(uuid.uuid4())
    grant = {"role": role, "scope_id": scope}
    assert permissions_for([grant], scope) == []
    grant[binding] = str(uuid.uuid4())
    assert permission in permissions_for([grant], scope)
    assert "publication.read" not in permissions_for([grant], scope)


def test_login_and_logout_require_csrf_and_allowed_origin(client, app):
    account = app.state.test_accounts["scheduler"]
    body = {"email": account["email"], "password": account["password"]}
    assert client.post("/api/auth/login", json=body).status_code == 403
    headers = csrf(client)
    assert client.post("/api/auth/login", headers={**headers, "Origin": "https://foreign.example"}, json=body).json()["error"]["code"] == "ORIGIN_INVALID"
    assert client.post("/api/auth/login", headers={**headers, "X-CSRF-Token": "forged"}, json=body).json()["error"]["code"] == "CSRF_INVALID"
    assert client.post("/api/auth/login", headers=headers, json=body).status_code == 200
    assert client.post("/api/auth/logout", headers={"Origin": "http://127.0.0.1:8000"}).status_code == 403


def test_host_header_and_nonloopback_requests_rejected(client, app):
    assert client.get("/api/health", headers={"Host": "attacker.example"}).status_code == 400
    with TestClient(app, base_url="http://127.0.0.1:8000", client=("192.0.2.1", 12345)) as remote:
        assert remote.get("/api/health").status_code == 403


def test_cookies_are_httponly_no_store_and_tokens_rotate(client, app):
    before = client.get("/api/auth/session")
    assert "HttpOnly" in before.headers["set-cookie"]
    assert "SameSite=strict" in before.headers["set-cookie"]
    assert before.headers["Cache-Control"] == "no-store"
    login(client, app)
    old = client.cookies.get(SESSION_COOKIE)
    login(client, app)
    new = client.cookies.get(SESSION_COOKIE)
    assert new != old
    with app.state.session_factory() as db:
        rows = db.scalars(select(AuthSession)).all()
        assert all(row.token_hash not in (old, new) for row in rows)
        assert db.scalar(select(AuthSession).where(AuthSession.token_hash == token_hash(old))).revoked_at is not None


def test_ac024d_limit_survives_new_clients_and_concurrent_requests(app):
    email = app.state.test_accounts["scheduler"]["email"]
    def attempt(_):
        with TestClient(app, base_url="http://127.0.0.1:8000") as client:
            return client.post("/api/auth/login", headers=csrf(client), json={"email": email, "password": "incorrect"}).status_code
    with ThreadPoolExecutor(max_workers=8) as pool:
        statuses = list(pool.map(attempt, range(8)))
    assert statuses.count(401) == app.state.settings.login_max_attempts
    assert statuses.count(429) == 3
    with TestClient(app, base_url="http://127.0.0.1:8000") as client:
        limited = client.post("/api/auth/login", headers=csrf(client), json={"email": email, "password": app.state.test_accounts["scheduler"]["password"]})
        assert limited.status_code == 429
        assert int(limited.headers["Retry-After"]) > 0


def test_ip_throttle_limits_attempts_across_different_email_addresses(client, app):
    app.state.settings.login_max_attempts = 2  # IP limit = 20; per-account counters stay below 2.
    headers = csrf(client)
    responses = [client.post("/api/auth/login", headers=headers,
                             json={"email": f"unknown-{index}@test.example", "password": "incorrect-test-value"})
                 for index in range(21)]
    assert [response.status_code for response in responses[:20]] == [401] * 20
    assert responses[20].status_code == 429
    assert responses[20].json()["error"]["code"] == "AUTH_RATE_LIMITED"
    assert int(responses[20].headers["Retry-After"]) > 0


def test_ac026d_audit_and_validation_do_not_expose_secrets(client, app, caplog):
    session = login(client, app)
    token = client.cookies.get(SESSION_COOKIE)
    password = app.state.test_accounts["scheduler"]["password"]
    response = client.post("/api/auth/login", headers=csrf(client), json={"email": "wrong@test.example", "password": password, "role": "admin"})
    assert response.status_code == 422
    assert password not in response.text
    assert "input" not in response.text
    client.post("/api/auth/logout", headers=csrf(client))
    with app.state.session_factory() as db:
        events = db.scalars(select(AuditEvent)).all()
        audit_json = json.dumps([{col.name: str(getattr(row, col.name)) for col in AuditEvent.__table__.columns} for row in events])
    for secret in (password, token, session["csrf_token"]):
        assert secret not in audit_json
        assert secret not in caplog.text
    assert {event.action for event in events} >= {"auth.login", "auth.logout"}


def test_health_and_unauthenticated_closed_reads(client):
    assert client.get("/api/health").json() == {"status": "ok", "database": "ok", "stage": 6}
    assert client.get("/api/me").status_code == 401
    assert client.get(f"/api/scopes/{uuid.uuid4()}/workspace").status_code == 401


def test_seed_is_idempotent_and_uses_argon2_without_college_data(app):
    path = app.state.test_credentials_dir / "accounts.json"
    before = path.read_bytes()
    assert prepare_accounts(app.state.settings, app.state.test_credentials_dir) is False
    assert path.read_bytes() == before
    with app.state.session_factory() as db:
        users = db.scalars(select(User)).all()
        assert len(users) == 5
        assert all(user.email.endswith("@demo.local") and user.password_hash.startswith("$argon2id$") for user in users)
        assert len(db.scalars(select(RoleGrant)).all()) == 5

import os
from urllib.parse import urlsplit

import pytest
from dotenv import dotenv_values
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect, text
from alembic import command
from alembic.config import Config

from backend.app.adapters.http import create_app
from backend.app.config import ROOT, Settings
from backend.app.infrastructure.models import Base
from backend.app.seed import prepare_accounts


@pytest.fixture(scope="session")
def test_database_url():
    url = os.environ.get("TEST_DATABASE_URL") or dotenv_values(ROOT / ".env").get("TEST_DATABASE_URL")
    if not url:
        pytest.skip("TEST_DATABASE_URL must point to an isolated PostgreSQL test database")
    # Destructive fixture operations are strictly limited to a local test DB.
    parsed = urlsplit(url.replace("postgresql+psycopg://", "postgresql://"))
    if parsed.hostname not in {"127.0.0.1", "localhost", "::1"} or not parsed.path.rsplit("/", 1)[-1].endswith("_test"):
        pytest.fail("Test database must be loopback and its name must end in _test")
    engine = create_engine(url, hide_parameters=True)
    # Stage 1 test fixtures had no Alembic version. Only this verified disposable
    # test DB may be reset to exercise both real migrations from a clean schema.
    if not inspect(engine).has_table("alembic_version"):
        Base.metadata.drop_all(engine)
    with engine.begin() as connection:
        config = Config(str(ROOT / "backend/alembic.ini"))
        config.attributes["connection"] = connection
        command.upgrade(config, "head")
    engine.dispose()
    return url


@pytest.fixture
def app(tmp_path, test_database_url):
    url = test_database_url
    settings = Settings(database_url=url, app_secret="test-only-secret-" * 4, allowed_origins="http://127.0.0.1:8000", login_max_attempts=5)
    application = create_app(settings)
    # All tables were created by the real versioned migrations above.
    with application.state.engine.begin() as connection:
        connection.execute(text("TRUNCATE TABLE audit_events, login_throttle, auth_sessions, role_grants, users, teachers, groups, scopes CASCADE"))
    prepare_accounts(settings, tmp_path)
    import json
    application.state.test_accounts = {row["role"]: row for row in json.loads((tmp_path / "accounts.json").read_text(encoding="utf-8"))["accounts"]}
    application.state.test_credentials_dir = tmp_path
    yield application
    application.state.engine.dispose()


@pytest.fixture
def client(app):
    with TestClient(app, base_url="http://127.0.0.1:8000") as client:
        yield client


def csrf(client):
    response = client.get("/api/auth/session")
    assert response.status_code == 200
    return {"Origin": "http://127.0.0.1:8000", "X-CSRF-Token": response.json()["csrf_token"]}


def login(client, app, role="scheduler"):
    account = app.state.test_accounts[role]
    response = client.post("/api/auth/login", headers=csrf(client), json={"email": account["email"], "password": account["password"]})
    assert response.status_code == 200, response.text
    return response.json()

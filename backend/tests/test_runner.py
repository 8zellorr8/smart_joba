"""Runner regression checks: isolated files and mocked process operations only."""
import importlib.util
import json
from pathlib import Path

import pytest


@pytest.fixture
def runner(tmp_path, monkeypatch):
    source = Path(__file__).resolve().parents[2] / "scripts" / "dev.py"
    spec = importlib.util.spec_from_file_location("smart_joba_runner_under_test", source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "ROOT", tmp_path)
    monkeypatch.setattr(module, "LOCAL", tmp_path / ".local")
    monkeypatch.setattr(module, "STATE", module.LOCAL / "runtime.json")
    monkeypatch.setattr(module, "API_STATE", module.LOCAL / "api-process.json")
    monkeypatch.setattr(module, "WORKER_STATE", module.LOCAL / "worker-process.json")
    monkeypatch.setattr(module, "DATA", module.LOCAL / "postgres" / "data")
    module.LOCAL.mkdir()
    # Any unexpected OS action fails the test instead of affecting the machine.
    monkeypatch.setattr(module, "run", lambda *args, **kwargs: pytest.fail("Unexpected child process invocation"))
    monkeypatch.setattr(module, "windows_creation_time", lambda pid: pytest.fail("Creation-time lookup must be mocked explicitly"))
    monkeypatch.setattr(module, "postgres_bin", lambda: tmp_path / "fake-pg-bin")
    monkeypatch.setattr(module, "pg_running", lambda pg: pytest.fail("A test must not query a real PostgreSQL process"))
    return module


def managed_environment(runner):
    state = {"app_password": "synthetic-test-db-password", "app_secret": "synthetic-test-application-secret"}
    runner.STATE.write_text(json.dumps(state), encoding="utf-8")
    expected = {
        "DATABASE_URL": f"postgresql+psycopg://smart_joba:{state['app_password']}@127.0.0.1:{runner.PORT}/smart_joba",
        "TEST_DATABASE_URL": f"postgresql+psycopg://smart_joba:{state['app_password']}@127.0.0.1:{runner.PORT}/smart_joba_test",
        "APP_SECRET": state["app_secret"],
    }
    (runner.ROOT / ".env").write_text("\n".join(f"{key}={value}" for key, value in expected.items()), encoding="utf-8")
    return expected


@pytest.mark.parametrize("changed_key", ["DATABASE_URL", "TEST_DATABASE_URL", "APP_SECRET"])
def test_runner_rejects_foreign_env_without_exposing_its_values(runner, changed_key):
    expected = managed_environment(runner)
    foreign_value = "postgresql+psycopg://foreign:private-foreign-test-value@foreign.invalid/unrelated"
    altered = {**expected, changed_key: foreign_value}
    (runner.ROOT / ".env").write_text("\n".join(f"{key}={value}" for key, value in altered.items()), encoding="utf-8")
    with pytest.raises(RuntimeError) as failure:
        runner.app_environment()
    message = str(failure.value)
    assert "No migration, seed, test or API was started" in message
    assert foreign_value not in message
    assert "private-foreign-test-value" not in message
    assert all(value not in message for value in expected.values())


def test_runner_parent_environment_cannot_redirect_managed_subprocesses(runner, monkeypatch):
    expected = managed_environment(runner)
    for key in expected:
        monkeypatch.setenv(key, "unrelated-parent-value")
    monkeypatch.setenv("LOCAL_ONLY", "false")
    monkeypatch.setenv("COOKIE_SECURE", "true")
    monkeypatch.setenv("ALLOWED_ORIGINS", "https://foreign.invalid")
    environment = runner.app_environment()
    assert {key: environment[key] for key in expected} == expected
    assert environment["LOCAL_ONLY"] == "true"
    assert environment["COOKIE_SECURE"] == "false"
    assert "foreign.invalid" not in environment["ALLOWED_ORIGINS"]


def test_runner_unknown_creation_time_never_establishes_api_ownership(runner, monkeypatch):
    runner.API_STATE.write_text(json.dumps({"pid": 13579, "created": None}), encoding="utf-8")
    lookups = []
    monkeypatch.setattr(runner, "windows_creation_time", lambda pid: lookups.append(pid))
    assert runner.api_owned() is None
    assert lookups == []


@pytest.mark.parametrize("observed_creation", [None, 999999])
def test_runner_stop_does_not_target_missing_or_reused_pid(runner, monkeypatch, observed_creation):
    runner.API_STATE.write_text(json.dumps({"pid": 13579, "created": 123456}), encoding="utf-8")
    lookups = []
    def observed(pid):
        lookups.append(pid)
        return observed_creation
    monkeypatch.setattr(runner, "windows_creation_time", observed)
    runner.stop()
    assert lookups == [13579]
    # runner.run remains a fail-fast sentinel: even one attempted kill fails.


def test_runner_stop_rechecks_creation_time_immediately_before_targeting_pid(runner, monkeypatch):
    runner.API_STATE.write_text(json.dumps({"pid": 13579, "created": 123456}), encoding="utf-8")
    observations = iter([123456, 999999])
    lookups = []
    def observed(pid):
        lookups.append(pid)
        return next(observations)
    monkeypatch.setattr(runner, "windows_creation_time", observed)
    runner.stop()
    assert lookups == [13579, 13579]
    # A PID reused between ownership lookup and stop never reaches taskkill.


def test_runner_stop_targets_only_the_verified_owned_pid(runner, monkeypatch):
    runner.API_STATE.write_text(json.dumps({"pid": 13579, "created": 123456}), encoding="utf-8")
    monkeypatch.setattr(runner, "windows_creation_time", lambda pid: 123456 if pid == 13579 else None)
    invoked = []
    monkeypatch.setattr(runner, "run", lambda args, **kwargs: invoked.append([str(argument) for argument in args]))
    runner.stop()
    assert len(invoked) == 1
    assert invoked[0][1:] == ["/PID", "13579", "/T", "/F"]
    assert not runner.API_STATE.exists()

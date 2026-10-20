"""Local Windows runner. Owns only this checkout's .local PostgreSQL cluster."""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / ".local"
DATA = LOCAL / "postgres" / "data"
STATE = LOCAL / "runtime.json"
API_STATE = LOCAL / "api-process.json"
PYTHON = ROOT / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
PORT = 55432
NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


def run(args, *, cwd=ROOT, env=None, data=None, capture=False):
    result = subprocess.run([str(x) for x in args], cwd=cwd, env=env, input=data,
                            text=True, encoding="utf-8", errors="replace", check=True,
                            capture_output=True, creationflags=NO_WINDOW)
    if not capture:
        LOCAL.mkdir(exist_ok=True)
        (LOCAL / "last-command.log").write_text(result.stdout + result.stderr, encoding="utf-8")
    return result


def pg_environment():
    environment = os.environ.copy()
    # PostgreSQL probes its child version via _popen/cmd. A user's AutoRun that
    # prints "chcp ..." otherwise corrupts the version line. Disable it only
    # for these processes, without editing the user's registry settings.
    source = ROOT / "scripts" / "win_cmd_proxy.cs"
    version = hashlib.sha256(source.read_bytes()).hexdigest()[:12]
    proxy = LOCAL / "tools" / f"cmd-no-autorun-{version}.exe"
    if not proxy.exists():
        proxy.parent.mkdir(parents=True, exist_ok=True)
        compiler = Path(os.environ.get("WINDIR", "C:/Windows")) / "Microsoft.NET/Framework64/v4.0.30319/csc.exe"
        if not compiler.exists():
            raise RuntimeError("Windows .NET Framework compiler is required for the local PostgreSQL launcher.")
        run([compiler, "/nologo", "/target:exe", f"/out:{proxy}", source], capture=True)
    environment["COMSPEC"] = str(proxy)
    return environment


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2), encoding="utf-8")
    temporary.replace(path)


def postgres_bin():
    configured = os.environ.get("SMART_JOBA_PG_BIN")
    candidates = [Path(configured)] if configured else []
    installed = Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "PostgreSQL"
    if installed.exists():
        candidates.extend(sorted(installed.glob("*/bin"), reverse=True))
    located = shutil.which("pg_ctl")
    if located:
        candidates.append(Path(located).parent)
    for candidate in candidates:
        if (candidate / "pg_ctl.exe").exists() and (candidate / "initdb.exe").exists():
            return candidate
    raise RuntimeError("Install PostgreSQL 18 binaries, or set SMART_JOBA_PG_BIN. Existing databases are not used.")


def npm():
    found = shutil.which("npm.cmd") or shutil.which("npm")
    if not found:
        raise RuntimeError("Node.js with npm is required.")
    return found


def listening(port):
    with socket.socket() as connection:
        connection.settimeout(0.3)
        return connection.connect_ex(("127.0.0.1", port)) == 0


def credentials():
    if not STATE.exists():
        raise RuntimeError("Run setup first.")
    return json.loads(STATE.read_text(encoding="utf-8"))


def pg_running(pg):
    result = subprocess.run([str(pg / "pg_ctl.exe"), "-D", str(DATA), "status"],
                            capture_output=True, env=pg_environment(), creationflags=NO_WINDOW)
    return result.returncode == 0


def pg_start(pg):
    if pg_running(pg):
        return
    if listening(PORT):
        raise RuntimeError(f"Port {PORT} is occupied by another process; no existing server will be modified.")
    # The Windows launcher can retain inherited handles for the server's lifetime;
    # a real log file avoids waiting for EOF on a captured subprocess pipe.
    with (LOCAL / "postgres" / "launcher.log").open("ab") as log:
        subprocess.run([str(pg / "pg_ctl.exe"), "-D", str(DATA), "-l", str(LOCAL / "postgres" / "server.log"),
                        "-w", "-t", "30", "-o", f"-h 127.0.0.1 -p {PORT}", "start"],
                       env=pg_environment(), stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                       check=True, creationflags=NO_WINDOW)


def psql(pg, state, sql, database="postgres"):
    environment = pg_environment()
    environment["PGPASSWORD"] = state["bootstrap_password"]
    environment["PGCLIENTENCODING"] = "UTF8"
    return run([pg / "psql.exe", "-X", "-w", "-h", "127.0.0.1", "-p", str(PORT),
                "-U", "sj_bootstrap", "-d", database, "-v", "ON_ERROR_STOP=1", "-At"],
               env=environment, data=sql, capture=True).stdout.strip()


def provision_database():
    pg = postgres_bin()
    LOCAL.mkdir(exist_ok=True)
    if STATE.exists():
        state = credentials()
    else:
        if DATA.exists():
            raise RuntimeError("Unrecognized local data directory; preserve it and inspect manually.")
        state = {"bootstrap_password": secrets.token_urlsafe(36),
                 "app_password": secrets.token_urlsafe(36), "app_secret": secrets.token_urlsafe(48)}
        save(STATE, state)
    if not (DATA / "PG_VERSION").exists():
        if DATA.exists() and any(DATA.iterdir()):
            raise RuntimeError("Incomplete PostgreSQL initialization; inspect .local/postgres/data before retrying.")
        DATA.parent.mkdir(parents=True, exist_ok=True)
        password_file = LOCAL / "postgres" / "init-password.txt"
        password_file.write_text(state["bootstrap_password"], encoding="utf-8")
        try:
            run([pg / "initdb.exe", "-D", DATA, "-U", "sj_bootstrap", "--encoding=UTF8",
                 "--locale=C", "--auth-local=scram-sha-256", "--auth-host=scram-sha-256",
                 f"--pwfile={password_file}"], env=pg_environment(), capture=True)
        finally:
            password_file.unlink(missing_ok=True)
    pg_start(pg)
    if psql(pg, state, "SELECT 1 FROM pg_roles WHERE rolname='smart_joba';") != "1":
        # Password is generated from URL-safe ASCII; SQL travels through stdin, never argv or logs.
        psql(pg, state, "CREATE ROLE smart_joba LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '"
             + state["app_password"] + "';")
    for database in ("smart_joba", "smart_joba_test"):
        if psql(pg, state, f"SELECT 1 FROM pg_database WHERE datname='{database}';") != "1":
            psql(pg, state, f"CREATE DATABASE {database} OWNER smart_joba;")
        psql(pg, state, f"REVOKE ALL ON DATABASE {database} FROM PUBLIC;")
    environment_file = ROOT / ".env"
    if not environment_file.exists():
        environment_file.write_text(
            f"DATABASE_URL=postgresql+psycopg://smart_joba:{state['app_password']}@127.0.0.1:{PORT}/smart_joba\n"
            f"TEST_DATABASE_URL=postgresql+psycopg://smart_joba:{state['app_password']}@127.0.0.1:{PORT}/smart_joba_test\n"
            f"APP_SECRET={state['app_secret']}\nLOCAL_ONLY=true\nCOOKIE_SECURE=false\n"
            "ALLOWED_ORIGINS=http://127.0.0.1:8000,http://localhost:8000,http://127.0.0.1:5173,http://localhost:5173\n",
            encoding="utf-8")
    print("Project PostgreSQL: 127.0.0.1:55432. Existing PostgreSQL services were not changed.")


def app_environment():
    state = credentials()
    expected = {
        "DATABASE_URL": f"postgresql+psycopg://smart_joba:{state['app_password']}@127.0.0.1:{PORT}/smart_joba",
        "TEST_DATABASE_URL": f"postgresql+psycopg://smart_joba:{state['app_password']}@127.0.0.1:{PORT}/smart_joba_test",
        "APP_SECRET": state["app_secret"],
    }
    configured = {}
    for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
        if line.strip() and not line.lstrip().startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            configured[key.strip()] = value.strip()
    if any(configured.get(key) != value for key, value in expected.items()):
        raise RuntimeError("Local .env differs from the managed project database. No migration, seed, test or API was started.")
    environment = os.environ.copy()
    # Parent environment variables must never redirect migrations to another DB.
    environment.update(expected)
    environment.update(LOCAL_ONLY="true", COOKIE_SECURE="false",
                       ALLOWED_ORIGINS="http://127.0.0.1:8000,http://localhost:8000,http://127.0.0.1:5173,http://localhost:5173")
    return environment


def setup(skip_install):
    provision_database()
    if not PYTHON.exists():
        run([sys.executable, "-m", "venv", ROOT / ".venv"])
    if not skip_install:
        print("Installing backend dependencies...")
        run([PYTHON, "-m", "pip", "install", "-r", ROOT / "backend/requirements.lock.txt"])
        print("Installing frontend dependencies...")
        run([npm(), "ci", "--cache", ".npm-cache", "--no-audit", "--no-fund"], cwd=ROOT / "frontend")
    environment = app_environment()
    print("Applying migrations and preparing accounts...")
    run([PYTHON, "-m", "alembic", "upgrade", "head"], cwd=ROOT / "backend", env=environment)
    run([PYTHON, "-m", "backend.app.seed"], env=environment)
    print("Building the Kazakh interface...")
    run([npm(), "run", "build"], cwd=ROOT / "frontend")
    print("Setup complete. Prepared credentials: .local/accounts.txt (keep private).")


def windows_creation_time(pid):
    if os.name != "nt":
        raise RuntimeError("This local runner currently supports Windows process management.")
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.OpenProcess(0x1000, False, pid)
    if not handle:
        return None
    try:
        values = [wintypes.FILETIME() for _ in range(4)]
        if not kernel.GetProcessTimes(handle, *(ctypes.byref(value) for value in values)):
            return None
        return (values[0].dwHighDateTime << 32) | values[0].dwLowDateTime
    finally:
        kernel.CloseHandle(handle)


def api_owned():
    if not API_STATE.exists():
        return None
    state = json.loads(API_STATE.read_text(encoding="utf-8"))
    if not isinstance(state.get("pid"), int) or state["pid"] <= 0 or not isinstance(state.get("created"), int):
        return None
    actual = windows_creation_time(state["pid"])
    return state if actual is not None and actual == state["created"] else None


def start():
    credentials()
    if not (ROOT / "frontend/dist/index.html").exists():
        raise RuntimeError("Run setup to build the frontend first.")
    pg_start(postgres_bin())
    if api_owned():
        print("Already running: http://127.0.0.1:8000")
        return
    if listening(8000):
        raise RuntimeError("Port 8000 belongs to another process. It will not be stopped.")
    with (LOCAL / "api.log").open("ab") as logfile:
        process = subprocess.Popen([str(PYTHON), "-m", "uvicorn", "backend.app.main:app",
                                    "--app-dir", str(ROOT), "--host", "127.0.0.1", "--port", "8000",
                                    "--no-access-log", "--no-proxy-headers"], cwd=ROOT, stdout=logfile, stderr=logfile,
                                   env=app_environment(), stdin=subprocess.DEVNULL, creationflags=NO_WINDOW)
    save(API_STATE, {"pid": process.pid, "created": windows_creation_time(process.pid)})
    for _ in range(60):
        if process.poll() is not None:
            raise RuntimeError("API exited. Inspect private .local/api.log.")
        try:
            with urllib.request.urlopen("http://127.0.0.1:8000/api/health", timeout=1) as response:
                if response.status == 200:
                    print("Open http://127.0.0.1:8000 ; credentials are in .local/accounts.txt")
                    return
        except OSError:
            time.sleep(0.25)
    raise RuntimeError("API readiness timed out. Inspect .local/api.log.")


def stop():
    state = api_owned()
    if state:
        # Windows venv Python may have a launcher child. Stop only the verified
        # owned process tree so that a child cannot keep serving after "stop".
        if windows_creation_time(state["pid"]) == state["created"]:
            run([Path(os.environ.get("WINDIR", "C:/Windows")) / "System32/taskkill.exe",
                 "/PID", str(state["pid"]), "/T", "/F"], capture=True)
        API_STATE.unlink(missing_ok=True)
    pg = postgres_bin()
    if DATA.exists() and pg_running(pg):
        run([pg / "pg_ctl.exe", "-D", DATA, "-w", "-t", "30", "-m", "fast", "stop"], env=pg_environment(), capture=True)
    print("Only this checkout's API and PostgreSQL cluster were stopped.")


def status():
    print("Project PostgreSQL:", "running" if DATA.exists() and pg_running(postgres_bin()) else "stopped")
    print("Project API:", "running at http://127.0.0.1:8000" if api_owned() else "stopped")


def test():
    credentials()
    pg_start(postgres_bin())
    run([PYTHON, "-m", "pytest", "backend/tests", "-q", "-p", "no:cacheprovider"], env=app_environment())
    print("PASS: backend and local-runner tests")
    run([npm(), "test", "--", "--run"], cwd=ROOT / "frontend")
    print("PASS: frontend tests")
    run([npm(), "run", "build"], cwd=ROOT / "frontend")
    print("PASS: TypeScript and production build")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["database", "setup", "start", "stop", "status", "test"])
    parser.add_argument("--skip-install", action="store_true")
    args = parser.parse_args()
    if args.action == "setup":
        setup(args.skip_install)
    else:
        {"database": provision_database, "start": start, "stop": stop, "status": status, "test": test}[args.action]()


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        # Child output may include credentials. Keep it in an ignored local diagnostic file.
        LOCAL.mkdir(exist_ok=True)
        (LOCAL / "setup-error.log").write_text(str(error.stdout or "") + str(error.stderr or ""), encoding="utf-8")
        print("Command failed. Inspect private .local/setup-error.log.", file=sys.stderr)
        sys.exit(1)
    except (RuntimeError, OSError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)

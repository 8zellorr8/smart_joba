"""One durable local worker; CP-SAT runs in a disposable bounded child process.

Run as `python -m backend.app.worker`. The database session advisory lock permits
one worker per database and makes recovery of interrupted jobs unambiguous.
"""
import multiprocessing as mp
import time
from datetime import datetime, timezone

import psutil
from sqlalchemy import select, text

from .application.editor import EditorService
from .application.generation import GenerationService
from .config import Settings
from .infrastructure.database import create_database
from .infrastructure.models import SolverJob


def child_calculate(snapshot, parameters, pipe):
    try:
        from .infrastructure.solver import solve
        result = solve(snapshot, parameters["seconds"], lambda stage: pipe.send(("stage", stage)))
        pipe.send(("result", result))
    except Exception as error:
        # Source rows, credentials and native tracebacks never enter public logs.
        pipe.send(("result", {"status": "failed", "raw_status": "WORKER_ERROR", "diagnostics": [{"code": "WORKER_ERROR"}], "error_type": type(error).__name__, "events": []}))
    finally:
        pipe.close()


def failure(code):
    return {"status": "failed", "raw_status": code, "diagnostics": [{"code": code}], "events": []}


def run_one(factory, calculate=child_calculate):
    """Claim once, commit quickly, search without DB locks, then atomically finish."""
    with factory.begin() as db:
        job = db.scalar(select(SolverJob).where(SolverJob.status == "queued").order_by(SolverJob.created_at).with_for_update(skip_locked=True).limit(1))
        if not job:
            return False
        job.status, job.stage, job.started_at = "running", "starting", datetime.now(timezone.utc)
        job_id, snapshot, parameters = job.id, job.snapshot, job.parameters
    process = None
    started, peak, result = time.monotonic(), 0, None
    receive, send = mp.get_context("spawn").Pipe(duplex=False)
    try:
        process = mp.get_context("spawn").Process(target=calculate, args=(snapshot, parameters, send), daemon=True)
        process.start(); send.close()
        while True:
            while True:
                try:
                    if not receive.poll(): break
                    kind, payload = receive.recv()
                except (EOFError, OSError):
                    break
                if kind == "result":
                    result = payload
                    break
                elif kind == "stage":
                    with factory.begin() as db:
                        row = db.get(SolverJob, job_id)
                        row.stage = payload
            if result is not None:
                break
            if not process.is_alive():
                break
            try:
                observed = psutil.Process(process.pid)
                rss = sum(p.memory_info().rss for p in [observed, *observed.children(recursive=True)] if p.is_running())
                peak = max(peak, rss)
            except psutil.Error:
                pass
            with factory() as db:
                cancelled = db.get(SolverJob, job_id).cancel_requested
            if cancelled:
                result = {"status": "cancelled", "raw_status": "CANCEL_REQUESTED", "events": []}; break
            if peak > parameters["memory_mib"] * 1024 * 1024:
                result = failure("MEMORY_LIMIT"); break
            if time.monotonic() - started > parameters["process_wall_seconds"]:
                result = failure("PROCESS_WALL_LIMIT"); break
            time.sleep(0.1)
        process.join(0.5)
        if process.is_alive(): process.terminate()
        process.join(5)
        if process.is_alive(): process.kill(); process.join(5)
        if result is None: result = failure("WORKER_INTERRUPTED")
        result = {**result, "worker_elapsed_seconds": round(time.monotonic() - started, 6), "peak_rss_bytes": peak}
        service = GenerationService(EditorService(factory, None))
        service.finish(job_id, result)
    except Exception as error:
        if process and process.is_alive(): process.terminate(); process.join(5)
        GenerationService(EditorService(factory, None)).finish(job_id, {**failure("WORKER_ERROR"), "error_type": type(error).__name__})
    finally:
        receive.close(); send.close()
    return True


def recover_interrupted(factory):
    """Call only after acquiring the worker's exclusive session lock."""
    with factory.begin() as db:
        for row in db.scalars(select(SolverJob).where(SolverJob.status == "running")):
            row.status, row.stage = "failed", "finished"
            row.finished_at = datetime.now(timezone.utc)
            row.result = failure("WORKER_INTERRUPTED")


def main():
    engine, factory = create_database(Settings().database_url)
    try:
        with engine.connect() as ownership:
            if not ownership.scalar(text("SELECT pg_try_advisory_lock(5815002)")):
                raise SystemExit("A worker for this database is already running.")
            ownership.commit()
            recover_interrupted(factory)
            while True:
                # Detect ownership-connection loss before claiming another job.
                ownership.execute(text("SELECT 1")); ownership.commit()
                if not run_one(factory): time.sleep(0.5)
    finally:
        engine.dispose()


if __name__ == "__main__":
    mp.freeze_support()
    try:
        main()
    except KeyboardInterrupt:
        pass
    except Exception:
        # Connection/native exception messages may contain local credentials.
        raise SystemExit("Worker stopped after an internal error; restart the local project.") from None

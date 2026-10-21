import uuid
from collections import defaultdict
from datetime import datetime, timezone

from sqlalchemy import func, select, text

from .auth import ApiError, audit
from .planning_inputs import PlanningInputs, current_dependencies
from .version_numbers import next_version_number
from ..domain.planning import ALGORITHM_VERSION, MAX_CANDIDATES, MAX_EVENTS, readiness
from ..domain.validation import validate_schedule
from ..domain.permissions import permissions_for
from ..infrastructure.models import (ImportContext, RoleGrant, ScheduleDraft, ScheduleSeries, Scope, SolverJob, User, ValidationReport)

ACTIVE = ("queued", "running")


def series_key(event):
    return tuple(event[k] for k in ("assignment_id", "calendar_id", "room_id", "start", "end", "pinned"))


class GenerationService:
    def __init__(self, editor):
        self.editor, self.factory = editor, editor.factory
        self.inputs = PlanningInputs(editor)

    def access(self, db, token, job_id, write=False):
        if self.editor.auth.resolve(db, token) is None: raise ApiError("AUTH_REQUIRED", 401)
        job = db.get(SolverJob, job_id)
        if not job: raise ApiError("NOT_FOUND", 404)
        context, user = self.inputs.context(db, token, job.context_id, "generator.run" if write else "draft.read", write)
        job = db.scalar(select(SolverJob).where(SolverJob.id == job_id).with_for_update(read=not write).execution_options(populate_existing=True))
        return job, context, user

    @staticmethod
    def dto(db, job):
        stale = current_dependencies(db, job.snapshot) != job.snapshot["dependencies"]
        now = datetime.now(timezone.utc)
        elapsed = ((job.finished_at or now) - (job.started_at or job.created_at)).total_seconds()
        result_draft = db.get(ScheduleDraft, job.result_draft_id) if job.result_draft_id else None
        return {"id": str(job.id), "context_id": str(job.context_id), "academic_year": job.snapshot["academic_year"], "data_kind": job.snapshot["data_kind"], "status": "stale" if stale and job.status not in ("cancelled", "failed") else job.status,
            "execution_status": job.status, "stage": job.stage, "stale": stale, "elapsed_seconds": round(max(0, elapsed), 1),
            "created_at": job.created_at.isoformat(), "algorithm_version": job.algorithm_version, "parameters": job.parameters,
            "snapshot_id": job.snapshot["snapshot_id"], "dependencies": job.snapshot["dependencies"],
            "group_ids": job.snapshot["group_ids"], "semester": job.snapshot["semester"],
            "result_draft_id": str(job.result_draft_id) if job.result_draft_id else None,
            "validation_stale": bool(result_draft and job.result and job.result.get("validation", {}).get("identity", {}).get("revision") != result_draft.revision),
            "cancel_requested": job.cancel_requested, "result": {k: v for k, v in job.result.items() if k != "events"} if job.result else None}

    def create(self, token, scope_id, body, request_id):
        with self.factory.begin() as db:
            context, user = self.inputs.context(db, token, uuid.UUID(body["context_id"]), "generator.run", True)
            if context.scope_id != scope_id: raise ApiError("ACCESS_DENIED", 403)
            snapshot = self.inputs.build(db, context, body)
            if snapshot["token"] != body["token"]: raise ApiError("PLANNING_STALE", 409)
            questions = readiness(snapshot)
            if questions: raise ApiError("GENERATION_NOT_READY", 422, {"questions": questions[:200]})
            # Serialize bounded admission across scopes; the CPU worker uses a
            # different session advisory lock and never holds this queue lock.
            db.execute(text("SELECT pg_advisory_xact_lock(5815001)"))
            count = db.scalar(select(func.count()).select_from(SolverJob).where(SolverJob.status.in_(ACTIVE)))
            if count >= 8 or db.scalar(select(SolverJob.id).where(SolverJob.context_id == context.id, SolverJob.status.in_(ACTIVE)).limit(1)):
                raise ApiError("GENERATOR_QUEUE_FULL", 409)
            job = SolverJob(context_id=context.id, snapshot=snapshot, parameters={"seconds": body["seconds"], "workers": 1,
                "memory_mib": 768, "process_wall_seconds": body["seconds"] + 30, "random_seed": 0,
                "max_candidates": MAX_CANDIDATES, "max_events": MAX_EVENTS}, algorithm_version=ALGORITHM_VERSION,
                status="queued", stage="queued", created_by=user.id, cancel_requested=False)
            db.add(job); db.flush()
            audit(db, "solver.create", "queued", request_id, user.id)
            return self.dto(db, job)

    def get(self, token, job_id):
        with self.factory.begin() as db:
            job, _, _ = self.access(db, token, job_id)
            return self.dto(db, job)

    def list(self, token, scope_id):
        with self.factory.begin() as db:
            self.editor.authorize(db, token, scope_id)
            db.scalar(select(Scope).where(Scope.id == scope_id).with_for_update(read=True))
            jobs = db.scalars(select(SolverJob).join(ImportContext).where(ImportContext.scope_id == scope_id).order_by(SolverJob.created_at.desc()).limit(30)).all()
            return [self.dto(db, j) for j in jobs]

    def cancel(self, token, job_id, request_id):
        with self.factory.begin() as db:
            job, _, user = self.access(db, token, job_id, True)
            if job.status in ACTIVE:
                job.cancel_requested = True
                if job.status == "queued":
                    job.status = job.stage = "cancelled"; job.finished_at = datetime.now(timezone.utc)
                audit(db, "solver.cancel", "requested", request_id, user.id)
            return self.dto(db, job)

    def finish(self, job_id, result):
        """One transaction: dependency guard, independent check, new draft/report.

        A retry cannot create another draft; no existing draft or publication is
        modified, even when the worker fails or returns a corrupted answer.
        """
        with self.factory.begin() as db:
            job = db.get(SolverJob, job_id)
            context = db.get(ImportContext, job.context_id)
            db.scalar(select(Scope).where(Scope.id == context.scope_id).with_for_update())
            db.scalar(select(ImportContext).where(ImportContext.id == context.id).with_for_update().execution_options(populate_existing=True))
            job = db.scalar(select(SolverJob).where(SolverJob.id == job_id).with_for_update().execution_options(populate_existing=True))
            if job.status != "running": return
            job.finished_at = datetime.now(timezone.utc)
            if job.cancel_requested:
                job.status = job.stage = "cancelled"; job.result = {"raw_status": "CANCEL_REQUESTED"}
                return
            actor = db.scalar(select(User).where(User.id == job.created_by).with_for_update(read=True))
            grants = db.scalars(select(RoleGrant).where(RoleGrant.user_id == job.created_by, RoleGrant.scope_id == context.scope_id).with_for_update(read=True)).all()
            actions = permissions_for([{"scope_id": str(g.scope_id), "role": g.role, "teacher_id": g.teacher_id, "group_id": g.group_id} for g in grants], str(context.scope_id))
            if not actor or not actor.is_active or "generator.run" not in actions or "draft.edit" not in actions:
                job.status, job.stage = "failed", "finished"
                job.result = {"raw_status": "AUTHORIZATION_CHANGED", "diagnostics": [{"code": "AUTHORIZATION_CHANGED"}]}
                audit(db, "solver.finish", "access_revoked", str(job.id), job.created_by)
                return
            stale = current_dependencies(db, job.snapshot) != job.snapshot["dependencies"]
            if result["status"] == "feasible":
                report = validate_schedule(job.snapshot, result["events"], {"job_id": str(job.id), "snapshot_id": job.snapshot["snapshot_id"]})
                result = {**result, "validation": report}
                if not report["valid"]:
                    result["status"] = "failed"
                    result["diagnostics"] = [{"code": "INDEPENDENT_VALIDATION_FAILED"}]
                elif not stale:
                    if len({series_key(e) for e in result["events"]}) > 200:
                        job.status, job.stage = "failed", "finished"
                        job.result = {**result, "status": "failed", "raw_status": "MODEL_SIZE_LIMIT", "diagnostics": [{"code": "MODEL_SIZE_LIMIT"}]}
                        audit(db, "solver.finish", "editor_size_limit", str(job.id), job.created_by)
                        return
                    draft = ScheduleDraft(context_id=context.id, name=f"Автоматты жоба · {job.snapshot['semester']} · {str(job.id)[:8]}", revision=1,
                        status="draft", dependencies={}, created_by=job.created_by, version_number=next_version_number(db, context.id))
                    db.add(draft); db.flush()
                    buckets = defaultdict(list)
                    for event in result["events"]:
                        # Single-date series preserve manual-edit semantics even
                        # when an independently moved pin has another base date.
                        buckets[series_key(event)].append(event)
                    series = []
                    for group in buckets.values():
                        e = group[0]; dates = sorted({v["date"] for v in group})
                        slot = next(s["id"] for s in job.snapshot["calendars"][e["calendar_id"]]["slots"] if (s["start"], s["end"]) == (e["start"], e["end"]))
                        template = {k: e[k] for k in ("assignment_id", "assignment_revision", "calendar_id", "calendar_revision", "room_id", "room_revision")}
                        template["pattern"] = {"id": "generated", "start": dates[0], "end": dates[-1], "slot_id": slot, "dates": dates,
                            "weekdays": [], "cancelled_dates": [v["date"] for v in group if v["cancelled"]]}
                        row = ScheduleSeries(draft_id=draft.id, template=template, occurrences=group)
                        db.add(row); series.append(row)
                    db.flush()
                    self.editor.record(db, draft, context, series, job.created_by, str(job.id))
                    report = {**report, "identity": {"draft_id": str(draft.id), "revision": draft.revision, "snapshot_id": job.snapshot["snapshot_id"]}}
                    db.add(ValidationReport(draft_id=draft.id, draft_revision=draft.revision, snapshot=job.snapshot, report=report, actor_id=job.created_by))
                    result["validation"] = report
                    job.result_draft_id = draft.id
            job.status, job.stage, job.result = result["status"], "finished", result
            audit(db, "solver.finish", "stale" if stale else job.status, str(job.id), job.created_by)

    def validate(self, token, draft_id, body, request_id):
        with self.factory.begin() as db:
            draft, context, user = self.editor.access(db, token, draft_id)
            if draft.revision != body["expected_revision"]: raise ApiError("EDITOR_STALE", 409)
            selection = {**body, "base_draft_id": str(draft.id)}
            snapshot = self.inputs.build(db, context, selection, allow_frozen=True)
            rows = self.editor.rows(db, draft)
            demand_ids = {d["id"] for d in snapshot["demands"]}
            events = [dict(e) for row in rows for e in row.occurrences
                      if (e["group_id"] in snapshot["group_ids"] and e["semester"] == snapshot["semester"]) or e["demand_id"] in demand_ids]
            report = validate_schedule(snapshot, events, {"draft_id": str(draft.id), "revision": draft.revision, "snapshot_id": snapshot["snapshot_id"]})
            record = ValidationReport(draft_id=draft.id, draft_revision=draft.revision, snapshot=snapshot, report=report, actor_id=user.id)
            db.add(record); db.flush()
            audit(db, "draft.validate", "valid" if report["valid"] else "invalid", request_id, user.id)
            return {"id": str(record.id), "stale": False, "report": report}

    def reports(self, token, draft_id):
        with self.factory.begin() as db:
            draft, _, _ = self.editor.access(db, token, draft_id)
            rows = db.scalars(select(ValidationReport).where(ValidationReport.draft_id == draft.id).order_by(ValidationReport.created_at.desc()).limit(10)).all()
            return [{"id": str(r.id), "stale": r.draft_revision != draft.revision or current_dependencies(db, r.snapshot) != r.snapshot["dependencies"], "report": r.report} for r in rows]

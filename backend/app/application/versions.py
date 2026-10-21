"""Exact-revision workflow. Content edits remain in EditorService."""
from copy import deepcopy
import uuid

from sqlalchemy import select

from .auth import ApiError, audit
from .planning_inputs import PlanningInputs, current_dependencies, input_token
from .version_numbers import next_version_number
from ..domain.permissions import permissions_for
from ..domain.publication import TRANSITIONS
from ..domain.validation import validate_schedule
from ..infrastructure.models import (DraftRevision, ImportContext, RoleGrant, ScheduleDraft, ScheduleSeries,
    Scope, User, VersionDecision, VersionSubmission, VersionTransition)


class VersionService:
    def __init__(self, editor):
        self.editor, self.factory, self.auth = editor, editor.factory, editor.auth
        self.inputs = PlanningInputs(editor)

    def access(self, db, token, version_id, action="draft.read", write=False):
        user = self.auth.resolve(db, token)
        if not user: raise ApiError("AUTH_REQUIRED", 401)
        grants = self.auth.grants(db, user.id)
        if not any(action in permissions_for(grants, g["scope_id"]) for g in grants):
            raise ApiError("ACCESS_DENIED", 403)
        version = db.get(ScheduleDraft, version_id)
        if not version: raise ApiError("NOT_FOUND", 404)
        context = db.get(ImportContext, version.context_id)
        self.editor.authorize(db, token, context.scope_id, action)
        db.scalar(select(Scope).where(Scope.id == context.scope_id).with_for_update(read=not write))
        context = db.scalar(select(ImportContext).where(ImportContext.id == context.id).with_for_update(read=not write).execution_options(populate_existing=True))
        version = db.scalar(select(ScheduleDraft).where(ScheduleDraft.id == version_id).with_for_update(read=not write).execution_options(populate_existing=True))
        if write:
            db.scalar(select(User).where(User.id == user.id).with_for_update(read=True))
            db.scalars(select(RoleGrant).where(RoleGrant.user_id == user.id, RoleGrant.scope_id == context.scope_id).with_for_update(read=True)).all()
            self.editor.authorize(db, token, context.scope_id, action)
        return version, context, user

    @staticmethod
    def expected(version, body):
        if version.revision != body["expected_revision"] or version.workflow_revision != body["expected_workflow_revision"]:
            raise ApiError("VERSION_STALE", 409)

    def events(self, db, version):
        return sorted([dict(e) for s in self.editor.rows(db, version) for e in s.occurrences], key=lambda e: e["id"])

    @staticmethod
    def submission(db, version):
        return db.scalar(select(VersionSubmission).where(VersionSubmission.version_id == version.id)
                         .order_by(VersionSubmission.workflow_revision.desc()).limit(1))

    @staticmethod
    def transition(db, version, action, user_id, comment=""):
        target = TRANSITIONS.get((version.status, action))
        if target is None: raise ApiError("VERSION_TRANSITION_INVALID", 409)
        old = version.status
        version.status, version.workflow_revision = target, version.workflow_revision + 1
        db.add(VersionTransition(version_id=version.id, revision=version.revision, workflow_revision=version.workflow_revision,
            action=action, from_status=old, to_status=target, comment=comment, actor_id=user_id))

    def check(self, db, version, context, selection):
        snapshot = self.inputs.build(db, context, {**selection, "base_draft_id": None})
        events = self.events(db, version)  # Never hide out-of-selection events.
        report = validate_schedule(snapshot, events, {"draft_id": str(version.id), "revision": version.revision, "snapshot_id": snapshot["snapshot_id"]})
        return snapshot, events, report

    def current_submission(self, db, version, context):
        submitted = self.submission(db, version)
        if not submitted: raise ApiError("VERSION_NOT_SUBMITTED", 409)
        if (submitted.revision != version.revision or current_dependencies(db, submitted.inputs) != submitted.inputs["dependencies"]
                or input_token(self.events(db, version)) != input_token(submitted.events)):
            raise ApiError("VERSION_INPUTS_STALE", 409)
        snapshot, events, report = self.check(db, version, context, submitted.selection)
        if not report["valid"]: raise ApiError("DRAFT_HAS_ERRORS", 422, {"report": report})
        return submitted, snapshot, events, report

    @staticmethod
    def summary(version, context):
        return {"id": str(version.id), "name": version.name, "context_id": str(context.id), "scope_id": str(context.scope_id),
            "academic_year": context.academic_year, "data_kind": context.data_kind, "version_number": version.version_number,
            "revision": version.revision, "workflow_revision": version.workflow_revision, "status": version.status,
            "parent_id": str(version.parent_id) if version.parent_id else None, "created_at": version.created_at.isoformat()}

    def dto(self, db, version, context):
        submitted = self.submission(db, version)
        decision = db.scalar(select(VersionDecision).where(VersionDecision.submission_id == submitted.id)) if submitted else None
        history = db.execute(select(VersionTransition, User.display_name).join(User, User.id == VersionTransition.actor_id)
            .where(VersionTransition.version_id == version.id).order_by(VersionTransition.workflow_revision)).all()
        events = self.events(db, version)
        semesters = {e["semester"] for e in events}
        selection = submitted.selection if submitted else {"group_ids": sorted({e["group_id"] for e in events}),
            "room_ids": sorted({e["room_id"] for e in events}), "semester": next(iter(semesters)) if len(semesters) == 1 else 1}
        return {**self.summary(version, context), "event_count": len(events), "selection": selection,
            "submission": {"id": str(submitted.id), "revision": submitted.revision,
                "stale": submitted.revision != version.revision or current_dependencies(db, submitted.inputs) != submitted.inputs["dependencies"],
                "report": submitted.report} if submitted else None,
            "decision": {"id": str(decision.id), "revision": decision.revision, "action": decision.action, "comment": decision.comment,
                "actor": db.get(User, decision.actor_id).display_name, "created_at": decision.created_at.isoformat()} if decision else None,
            "history": [{"action": h.action, "from_status": h.from_status, "to_status": h.to_status, "revision": h.revision,
                "workflow_revision": h.workflow_revision, "comment": h.comment, "actor": name, "created_at": h.created_at.isoformat()} for h, name in history]}

    def list(self, token, scope_id):
        with self.factory.begin() as db:
            self.editor.authorize(db, token, scope_id)
            return [self.summary(v, c) for v, c in db.execute(select(ScheduleDraft, ImportContext)
                .join(ImportContext, ImportContext.id == ScheduleDraft.context_id).where(ImportContext.scope_id == scope_id)
                .order_by(ScheduleDraft.created_at.desc(), ScheduleDraft.id))]

    def get(self, token, version_id):
        with self.factory.begin() as db:
            version, context, _ = self.access(db, token, version_id)
            return self.dto(db, version, context)

    def submit(self, token, version_id, body, request_id):
        with self.factory.begin() as db:
            version, context, user = self.access(db, token, version_id, "draft.submit", True)
            self.expected(version, body)
            if version.status != "draft": raise ApiError("VERSION_TRANSITION_INVALID", 409)
            selection = {k: body[k] for k in ("group_ids", "room_ids", "semester")}
            snapshot, events, report = self.check(db, version, context, selection)
            if not report["valid"]: raise ApiError("DRAFT_HAS_ERRORS", 422, {"report": report})
            self.transition(db, version, "submit", user.id)
            db.add(VersionSubmission(version_id=version.id, revision=version.revision, workflow_revision=version.workflow_revision,
                selection=selection, inputs=snapshot, events=events, report=report, actor_id=user.id))
            db.flush(); audit(db, "version.submit", "submitted", request_id, user.id)
            return self.dto(db, version, context)

    def decide(self, token, version_id, action, body, request_id):
        with self.factory.begin() as db:
            version, context, user = self.access(db, token, version_id, "draft." + action, True)
            self.expected(version, body)
            if version.status != "submitted": raise ApiError("VERSION_TRANSITION_INVALID", 409)
            submitted = self.submission(db, version)
            if not submitted or str(submitted.id) != body["submission_id"] or submitted.revision != version.revision:
                raise ApiError("VERSION_STALE", 409)
            comment = body["comment"].strip()
            if action == "reject" and not comment: raise ApiError("VERSION_REASON_REQUIRED", 422)
            if action == "approve":
                authors = set(db.scalars(select(DraftRevision.actor_id).where(DraftRevision.draft_id == version.id))) | {version.created_by, submitted.actor_id}
                if user.id in authors: raise ApiError("VERSION_SELF_APPROVAL", 403)
                self.current_submission(db, version, context)
            db.add(VersionDecision(submission_id=submitted.id, revision=version.revision, action=action, comment=comment, actor_id=user.id))
            self.transition(db, version, action, user.id, comment)
            db.flush(); audit(db, "version." + action, version.status, request_id, user.id)
            return self.dto(db, version, context)

    def reopen(self, token, version_id, body, request_id):
        with self.factory.begin() as db:
            version, context, user = self.access(db, token, version_id, "draft.edit", True)
            self.expected(version, body)
            self.transition(db, version, "reopen", user.id)
            db.flush(); audit(db, "version.reopen", "draft", request_id, user.id)
            return self.dto(db, version, context)

    def fork(self, token, version_id, body, request_id):
        with self.factory.begin() as db:
            parent, context, user = self.access(db, token, version_id, "draft.edit", True)
            self.expected(parent, body)
            if not body["name"].strip(): raise ApiError("EDITOR_NAME_REQUIRED", 422)
            version = ScheduleDraft(context_id=context.id, name=body["name"].strip(), revision=1, workflow_revision=1,
                version_number=next_version_number(db, context.id), status="draft", created_by=user.id, parent_id=parent.id, dependencies={})
            db.add(version); db.flush()
            rows = []
            for old in self.editor.rows(db, parent):
                events = [{**deepcopy(e), "id": str(uuid.uuid4())} for e in old.occurrences]
                row = ScheduleSeries(draft_id=version.id, template=deepcopy(old.template), occurrences=events)
                db.add(row); rows.append(row)
            db.flush()
            self.editor.record(db, version, context, rows, user.id, request_id)
            db.add(VersionTransition(version_id=version.id, revision=1, workflow_revision=1, action="fork", from_status=parent.status,
                to_status="draft", comment="", actor_id=user.id))
            db.flush(); audit(db, "version.fork", "created", request_id, user.id)
            return self.dto(db, version, context)

"""Confirmed journal catalog, without lesson facts or grade permissions.

Lock order: scope, authenticated user/session/grants, registry, affected links.
All setup writers use the scope lock; auth rows stay locked through commit.
Publication/import revisions are intentionally not advanced by this catalog.
"""
import hashlib
import json
import uuid
from datetime import UTC, date, datetime
from zoneinfo import ZoneInfo

from sqlalchemy import inspect, select

from .auth import ApiError, audit
from ..domain.permissions import permissions_for
from ..infrastructure.models import (AuthSession, CalendarProfile, Group, ImportContext, RoleGrant, Scope, Subject, Teacher, TeachingDemand, User)
from ..infrastructure.journal_models import (Journal, JournalAssignment, JournalRegistry, JournalSetupChange, JournalSetupOperation, Student, StudentAccountBinding, StudentMembership)
from ..infrastructure.security import token_hash


def snapshot(row):
    return json.loads(json.dumps({c.key: getattr(row, c.key) for c in inspect(row).mapper.column_attrs}, default=str))


def required(value, field):
    value = value.strip()
    if not value:
        raise ApiError("JOURNAL_REQUIRED", 422, {"field": field})
    return value


class JournalSetupService:
    def __init__(self, factory, auth):
        self.factory, self.auth = factory, auth

    def access(self, db, token, scope_id, action, write=False):
        user = self.auth.resolve(db, token)
        if user is None:
            raise ApiError("AUTH_REQUIRED", 401)
        # All paths use a transaction. Readers cannot observe half of a command.
        if db.scalar(select(Scope).where(Scope.id == scope_id).with_for_update(read=not write)) is None:
            raise ApiError("ACCESS_DENIED", 403)
        user = db.scalar(select(User).where(User.id == user.id).with_for_update(read=True).execution_options(populate_existing=True))
        session = db.scalar(select(AuthSession).where(AuthSession.token_hash == token_hash(token)).with_for_update(read=True).execution_options(populate_existing=True))
        if not user.is_active or not session or session.revoked_at or session.expires_at <= datetime.now(UTC):
            raise ApiError("AUTH_REQUIRED", 401)
        db.scalars(select(RoleGrant).where(RoleGrant.user_id == user.id, RoleGrant.scope_id == scope_id).order_by(RoleGrant.id).with_for_update(read=True).execution_options(populate_existing=True)).all()
        grants = self.auth.grants(db, user.id)
        permissions = permissions_for(grants, str(scope_id))
        allowed = action in permissions
        if action == "journal.catalog.read":
            allowed = bool({"journal.read", "journal.read.own"} & set(permissions))
        if not allowed:
            raise ApiError("ACCESS_DENIED", 403)
        return user, [g for g in grants if g["scope_id"] == str(scope_id)], permissions

    @staticmethod
    def revision(db, scope_id):
        registry = db.get(JournalRegistry, scope_id)
        return registry.revision if registry else 0

    @staticmethod
    def scoped(db, model, object_id, scope_id, data_kind=None):
        row = db.get(model, uuid.UUID(str(object_id)))
        if row is None or row.scope_id != scope_id or (data_kind is not None and row.data_kind != data_kind):
            raise ApiError("ACCESS_DENIED", 403)
        return row

    @staticmethod
    def journal_context(db, journal_id, scope_id):
        journal = db.get(Journal, uuid.UUID(str(journal_id)))
        context = db.get(ImportContext, journal.context_id) if journal else None
        if not context or context.scope_id != scope_id:
            raise ApiError("ACCESS_DENIED", 403)
        return journal, context

    @staticmethod
    def journal_dto(db, journal, context):
        return {**snapshot(journal), "academic_year": context.academic_year, "data_kind": context.data_kind,
                "group": db.get(Group, journal.group_id).code, "subject": db.get(Subject, journal.subject_id).name}

    @staticmethod
    def membership_dto(db, row):
        context = db.get(ImportContext, row.context_id)
        return {**snapshot(row), "academic_year": context.academic_year, "group": db.get(Group, row.group_id).code}

    @staticmethod
    def confirmed_demand(row):
        return bool(row.group_id and row.subject_id and not row.open_issues and row.normalized.get("references_confirmed") and isinstance(row.normalized.get("semester"), int))

    def setup(self, token, scope_id):
        with self.factory.begin() as db:
            self.access(db, token, scope_id, "journal.setup")
            contexts = db.scalars(select(ImportContext).where(ImportContext.scope_id == scope_id).order_by(ImportContext.academic_year, ImportContext.id)).all()
            by_context = {c.id: c for c in contexts}
            students = db.scalars(select(Student).where(Student.scope_id == scope_id).order_by(Student.display_name, Student.id)).all()
            groups = db.scalars(select(Group).where(Group.scope_id == scope_id).order_by(Group.code, Group.id)).all()
            teachers = db.scalars(select(Teacher).where(Teacher.scope_id == scope_id).order_by(Teacher.display_name, Teacher.id)).all()
            demands = db.scalars(select(TeachingDemand).where(TeachingDemand.context_id.in_(by_context)).order_by(TeachingDemand.id)).all()
            journals = db.scalars(select(Journal).where(Journal.context_id.in_(by_context)).order_by(Journal.id)).all()
            accounts = db.execute(select(User, RoleGrant).join(RoleGrant, RoleGrant.user_id == User.id).where(RoleGrant.scope_id == scope_id, RoleGrant.role == "student", User.is_active.is_(True)).order_by(User.display_name, User.id)).all()
            return {"revision": self.revision(db, scope_id), "students": [snapshot(s) for s in students],
                    "contexts": [{"id": str(c.id), "academic_year": c.academic_year, "data_kind": c.data_kind} for c in contexts],
                    "groups": [snapshot(g) for g in groups], "teachers": [snapshot(t) for t in teachers],
                    "memberships": [self.membership_dto(db, m) for m in db.scalars(select(StudentMembership).where(StudentMembership.student_id.in_([s.id for s in students])).order_by(StudentMembership.start, StudentMembership.id))],
                    "bindings": [snapshot(b) for b in db.scalars(select(StudentAccountBinding).where(StudentAccountBinding.scope_id == scope_id).order_by(StudentAccountBinding.id))],
                    "accounts": [{"id": str(u.id), "display_name": u.display_name, "email": u.email, "group_id": str(g.group_id)} for u, g in accounts],
                    "demands": [{"id": str(d.id), "context_id": str(d.context_id), "group_id": str(d.group_id), "subject": db.get(Subject, d.subject_id).name, "semester": d.normalized["semester"]} for d in demands if self.confirmed_demand(d)],
                    "journals": [self.journal_dto(db, j, by_context[j.context_id]) for j in journals],
                    "assignments": [snapshot(a) for a in db.scalars(select(JournalAssignment).where(JournalAssignment.journal_id.in_([j.id for j in journals])).order_by(JournalAssignment.start, JournalAssignment.id))]}

    def command(self, token, scope_id, body, request_id):
        digest = hashlib.sha256(json.dumps({"scope_id": str(scope_id), **body}, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        with self.factory.begin() as db:
            user, _, _ = self.access(db, token, scope_id, "journal.setup", write=True)
            previous = db.scalar(select(JournalSetupOperation).where(JournalSetupOperation.scope_id == scope_id, JournalSetupOperation.actor_id == user.id, JournalSetupOperation.operation_id == uuid.UUID(body["operation_id"])))
            if previous:
                if previous.request_hash != digest:
                    raise ApiError("JOURNAL_OPERATION_CONFLICT", 409)
                return previous.receipt
            revision = self.revision(db, scope_id)
            if revision != body["expected_revision"]:
                raise ApiError("JOURNAL_STALE", 409)
            command = dict(body["command"])
            reason = command.get("reason", "").strip()
            if "source" in command:
                command["source"] = required(command["source"], "source")
                if not command["confirmed"]:
                    raise ApiError("JOURNAL_CONFIRM_REQUIRED", 422, {"field": "confirmed"})
            before, row = self.apply(db, scope_id, user, command)
            db.flush()
            after = snapshot(row)
            registry = db.get(JournalRegistry, scope_id)
            if registry is None:
                registry = JournalRegistry(scope_id=scope_id, revision=0)
                db.add(registry)
            registry.revision = revision + 1
            receipt = {"id": str(row.id), "revision": registry.revision, "kind": command["kind"]}
            db.add(JournalSetupChange(scope_id=scope_id, revision=registry.revision, actor_id=user.id, action=command["kind"], before=before, after=after, reason=reason))
            db.add(JournalSetupOperation(scope_id=scope_id, actor_id=user.id, operation_id=uuid.UUID(body["operation_id"]), request_hash=digest, receipt=receipt))
            audit(db, "journal.setup", "saved", request_id, user.id)
            return receipt

    def apply(self, db, scope_id, actor, c):
        kind = c["kind"]
        if kind == "create_student":
            row = Student(scope_id=scope_id, data_kind=c["data_kind"], display_name=required(c["display_name"], "display_name"))
            db.add(row)
            return {}, row
        if kind == "rename_student":
            row = self.scoped(db, Student, c["student_id"], scope_id)
            before = snapshot(row)
            required(c["reason"], "reason")
            row.display_name = required(c["display_name"], "display_name")
            return before, row
        if kind == "save_membership":
            return self.save_membership(db, scope_id, actor, c)
        if kind == "bind_account":
            return self.bind_account(db, scope_id, actor, c)
        if kind == "create_journal":
            demand = db.get(TeachingDemand, uuid.UUID(c["demand_id"]))
            context = db.get(ImportContext, demand.context_id) if demand else None
            if not context or context.scope_id != scope_id:
                raise ApiError("ACCESS_DENIED", 403)
            if not self.confirmed_demand(demand):
                raise ApiError("JOURNAL_DEMAND_UNCONFIRMED", 422)
            self.scoped(db, Group, demand.group_id, scope_id, context.data_kind)
            self.scoped(db, Subject, demand.subject_id, scope_id, context.data_kind)
            existing = db.scalar(select(Journal).where(Journal.context_id == context.id, Journal.group_id == demand.group_id, Journal.subject_id == demand.subject_id, Journal.semester == demand.normalized["semester"]))
            if existing:
                raise ApiError("JOURNAL_EXISTS", 409)
            row = Journal(context_id=context.id, group_id=demand.group_id, subject_id=demand.subject_id, semester=demand.normalized["semester"], source=c["source"], confirmed_by=actor.id)
            db.add(row)
            return {}, row
        if kind == "save_assignment":
            return self.save_assignment(db, scope_id, actor, c)
        if kind == "sync_schedule_group":
            return self.sync_group(db, scope_id, c)
        raise ApiError("VALIDATION_ERROR", 422)

    def save_membership(self, db, scope_id, actor, c):
        student = self.scoped(db, Student, c["student_id"], scope_id)
        context = self.scoped(db, ImportContext, c["context_id"], scope_id, student.data_kind)
        group = self.scoped(db, Group, c["group_id"], scope_id, student.data_kind)
        start, end = date.fromisoformat(c["start"]), date.fromisoformat(c["end"])
        if start >= end:
            raise ApiError("JOURNAL_INTERVAL_INVALID", 422, {"field": "end"})
        row = db.get(StudentMembership, uuid.UUID(c["id"])) if c["id"] else None
        if c["id"] and (not row or row.student_id != student.id or row.context_id != context.id):
            raise ApiError("ACCESS_DENIED", 403)
        before = snapshot(row) if row else {}
        if row:
            required(c["reason"], "reason")
        overlap = select(StudentMembership).where(StudentMembership.student_id == student.id, StudentMembership.context_id == context.id, StudentMembership.start < end, StudentMembership.end > start)
        if row:
            overlap = overlap.where(StudentMembership.id != row.id)
        if db.scalar(overlap):
            raise ApiError("JOURNAL_MEMBERSHIP_OVERLAP", 422, {"field": "start"})
        if not row:
            row = StudentMembership(student_id=student.id, context_id=context.id)
            db.add(row)
        row.group_id, row.start, row.end, row.source, row.confirmed_by = group.id, start, end, c["source"], actor.id
        return before, row

    def bind_account(self, db, scope_id, actor, c):
        target = db.scalar(select(User).where(User.id == uuid.UUID(c["user_id"])).with_for_update(read=True).execution_options(populate_existing=True))
        grant = db.scalar(select(RoleGrant).where(RoleGrant.user_id == uuid.UUID(c["user_id"]), RoleGrant.scope_id == scope_id, RoleGrant.role == "student").with_for_update())
        if not target or not target.is_active or not grant:
            raise ApiError("ACCESS_DENIED", 403)
        student = self.scoped(db, Student, c["student_id"], scope_id) if c["student_id"] else None
        if student:
            self.scoped(db, Group, grant.group_id, scope_id, student.data_kind)
            existing = db.scalar(select(StudentAccountBinding).where(StudentAccountBinding.scope_id == scope_id, StudentAccountBinding.student_id == student.id, StudentAccountBinding.user_id != target.id))
            if existing:
                raise ApiError("JOURNAL_STUDENT_ALREADY_BOUND", 409)
        row = db.scalar(select(StudentAccountBinding).where(StudentAccountBinding.scope_id == scope_id, StudentAccountBinding.user_id == target.id))
        before = snapshot(row) if row else {}
        if row:
            required(c["reason"], "reason")
        else:
            row = StudentAccountBinding(scope_id=scope_id, user_id=target.id)
            db.add(row)
        row.student_id, row.source, row.confirmed_by = student.id if student else None, c["source"], actor.id
        return before, row

    def save_assignment(self, db, scope_id, actor, c):
        journal, context = self.journal_context(db, c["journal_id"], scope_id)
        teacher = self.scoped(db, Teacher, c["teacher_id"], scope_id, context.data_kind)
        start, end = date.fromisoformat(c["start"]), date.fromisoformat(c["end"])
        if start >= end:
            raise ApiError("JOURNAL_INTERVAL_INVALID", 422, {"field": "end"})
        row = db.get(JournalAssignment, uuid.UUID(c["id"])) if c["id"] else None
        if c["id"] and (not row or row.journal_id != journal.id):
            raise ApiError("ACCESS_DENIED", 403)
        before = snapshot(row) if row else {}
        if row:
            required(c["reason"], "reason")
        overlap = select(JournalAssignment).where(JournalAssignment.journal_id == journal.id, JournalAssignment.teacher_id == teacher.id, JournalAssignment.active.is_(True), JournalAssignment.start < end, JournalAssignment.end > start)
        if row:
            overlap = overlap.where(JournalAssignment.id != row.id)
        if c["active"] and db.scalar(overlap):
            raise ApiError("JOURNAL_ASSIGNMENT_OVERLAP", 422, {"field": "start"})
        if not row:
            row = JournalAssignment(journal_id=journal.id)
            db.add(row)
        row.teacher_id, row.start, row.end, row.active = teacher.id, start, end, c["active"]
        row.source, row.confirmed_by = c["source"], actor.id
        return before, row

    def sync_group(self, db, scope_id, c):
        required(c["reason"], "reason")
        membership = db.get(StudentMembership, uuid.UUID(c["membership_id"]))
        if not membership:
            raise ApiError("ACCESS_DENIED", 403)
        student = self.scoped(db, Student, membership.student_id, scope_id)
        context = self.scoped(db, ImportContext, membership.context_id, scope_id, student.data_kind)
        self.scoped(db, Group, membership.group_id, scope_id, student.data_kind)
        profile = db.scalar(select(CalendarProfile).where(CalendarProfile.context_id == context.id, CalendarProfile.group_id == membership.group_id))
        if not profile or not profile.document.get("timezone_confirmed"):
            raise ApiError("JOURNAL_TIMEZONE_UNCONFIRMED", 422)
        today = datetime.now(ZoneInfo(profile.document["timezone"])).date()
        if not membership.start <= today < membership.end:
            raise ApiError("JOURNAL_MEMBERSHIP_NOT_CURRENT", 422)
        binding = db.scalar(select(StudentAccountBinding).where(StudentAccountBinding.scope_id == scope_id, StudentAccountBinding.student_id == student.id))
        grant = db.scalar(select(RoleGrant).where(RoleGrant.user_id == binding.user_id, RoleGrant.scope_id == scope_id, RoleGrant.role == "student").with_for_update()) if binding else None
        if not grant:
            raise ApiError("JOURNAL_BINDING_REQUIRED", 422)
        before = snapshot(grant)
        grant.group_id = membership.group_id
        return before, grant

    def history(self, token, scope_id, before_revision=None):
        with self.factory.begin() as db:
            self.access(db, token, scope_id, "journal.setup")
            query = select(JournalSetupChange).where(JournalSetupChange.scope_id == scope_id)
            if before_revision:
                query = query.where(JournalSetupChange.revision < before_revision)
            rows = db.scalars(query.order_by(JournalSetupChange.revision.desc()).limit(51)).all()
            return {"items": [snapshot(r) for r in rows[:50]], "next_before_revision": rows[49].revision if len(rows) > 50 else None}

    @staticmethod
    def own_assignments(db, journal_id, grants, on=None):
        teacher_ids = [uuid.UUID(g["teacher_id"]) for g in grants if g["role"] == "teacher" and g.get("teacher_id")]
        query = select(JournalAssignment).where(JournalAssignment.journal_id == journal_id, JournalAssignment.teacher_id.in_(teacher_ids), JournalAssignment.active.is_(True))
        if on:
            query = query.where(JournalAssignment.start <= on, JournalAssignment.end > on)
        return db.scalars(query.order_by(JournalAssignment.start, JournalAssignment.id)).all()

    def journals(self, token, scope_id):
        with self.factory.begin() as db:
            _, grants, permissions = self.access(db, token, scope_id, "journal.catalog.read")
            pairs = db.execute(select(Journal, ImportContext).join(ImportContext, ImportContext.id == Journal.context_id).where(ImportContext.scope_id == scope_id).order_by(Journal.id)).all()
            result = []
            for journal, context in pairs:
                assignments = self.own_assignments(db, journal.id, grants)
                if "journal.read" not in permissions and not assignments:
                    continue
                item = self.journal_dto(db, journal, context)
                # The reader projection has no private confirmation sources or account IDs.
                result.append({k: item[k] for k in ("id", "group", "subject", "semester", "academic_year", "data_kind")} | {"periods": [{"start": str(a.start), "end": str(a.end)} for a in assignments]})
            return {"revision": self.revision(db, scope_id), "journals": result}

    def roster(self, token, scope_id, journal_id, on):
        with self.factory.begin() as db:
            _, grants, permissions = self.access(db, token, scope_id, "journal.catalog.read")
            journal, context = self.journal_context(db, journal_id, scope_id)
            if "journal.read" not in permissions and not self.own_assignments(db, journal.id, grants, on):
                raise ApiError("ACCESS_DENIED", 403)
            students = db.scalars(select(Student).join(StudentMembership, StudentMembership.student_id == Student.id).where(Student.scope_id == scope_id, Student.data_kind == context.data_kind, StudentMembership.context_id == context.id, StudentMembership.group_id == journal.group_id, StudentMembership.start <= on, StudentMembership.end > on).order_by(Student.display_name, Student.id)).all()
            return {"journal_id": str(journal.id), "date": str(on), "revision": self.revision(db, scope_id), "is_snapshot": False,
                    "students": [{"id": str(s.id), "display_name": s.display_name} for s in students]}

    def me(self, token, scope_id):
        with self.factory.begin() as db:
            user, _, _ = self.access(db, token, scope_id, "journal.read.self")
            binding = db.scalar(select(StudentAccountBinding).where(StudentAccountBinding.user_id == user.id, StudentAccountBinding.scope_id == scope_id))
            if not binding or not binding.student_id:
                raise ApiError("ACCESS_DENIED", 403)
            student = self.scoped(db, Student, binding.student_id, scope_id)
            memberships = db.scalars(select(StudentMembership).where(StudentMembership.student_id == student.id).order_by(StudentMembership.start, StudentMembership.id)).all()
            return {"student": {"id": str(student.id), "display_name": student.display_name, "data_kind": student.data_kind},
                    "memberships": [{k: item[k] for k in ("id", "group", "academic_year", "start", "end")} for item in [self.membership_dto(db, m) for m in memberships]]}

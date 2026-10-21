"""One protected publication operation; public DTOs contain only reader fields."""
import time
import uuid

from sqlalchemy import select, text

from .auth import ApiError, audit
from .planning_inputs import input_token
from ..domain.permissions import permissions_for
from ..domain.publication import shared_conflicts
from ..infrastructure.models import (ImportContext, Publication, PublicationHead, PublicationOperation, ScheduleDraft,
    Scope, VersionDecision)

PUBLICATION_LOCK = 5816001
PUBLISH_ATTEMPTS = 3


def profile_key(context_id, selection):
    return input_token({"context_id": str(context_id), "semester": selection["semester"], "group_ids": sorted(selection["group_ids"])})


class PublicationService:
    def __init__(self, versions):
        self.versions, self.factory, self.auth = versions, versions.factory, versions.auth

    @staticmethod
    def active(db):
        # Global registry: do not restrict to the caller's department/scope.
        return list(db.scalars(select(Publication).join(PublicationHead, PublicationHead.publication_id == Publication.id).order_by(Publication.id)))

    def ready_locked(self, db, version, context):
        if version.status != "approved": raise ApiError("VERSION_NOT_APPROVED", 409)
        submitted, inputs, events, report = self.versions.current_submission(db, version, context)
        approval = db.scalar(select(VersionDecision).where(VersionDecision.submission_id == submitted.id, VersionDecision.action == "approve"))
        if not approval or approval.revision != version.revision: raise ApiError("VERSION_APPROVAL_STALE", 409)
        key = profile_key(context.id, submitted.selection)
        active = self.active(db)
        issues = []
        others = []
        for old in active:
            if old.profile_key == key: continue  # Replace this whole profile, not a subset of its events.
            snapshot = old.snapshot
            if (old.context_id == context.id and snapshot["semester"] == submitted.selection["semester"]
                    and set(snapshot["group_ids"]) & set(submitted.selection["group_ids"])):
                issues.append({"code": "PUBLICATION_PROFILE_OVERLAP"})
            others.append(snapshot)
        timezone = next(iter(inputs["calendars"].values()))["timezone"]
        try:
            conflicts, truncated = shared_conflicts(events, timezone, others)
            issues.extend(conflicts)
        except (ValueError, KeyError) as problem:
            code = str(problem) if str(problem) in {"PUBLICATION_REGISTRY_LIMIT", "PUBLICATION_TIME_AMBIGUOUS"} else "PUBLICATION_REGISTRY_INVALID"
            issues.append({"code": code}); truncated = False
        token = input_token({"version_id": str(version.id), "revision": version.revision, "workflow_revision": version.workflow_revision,
            "approval_id": str(approval.id), "dependencies": inputs["dependencies"], "events": events,
            "profile": key, "active_publications": sorted(str(p.id) for p in active)})
        return {"ready": report["valid"] and not issues and not truncated, "token": token, "version_id": str(version.id),
            "revision": version.revision, "workflow_revision": version.workflow_revision, "approval_id": str(approval.id),
            "report": report, "issues": issues[:200], "issues_truncated": truncated}, (submitted, inputs, events, approval, key, timezone)

    def readiness(self, token, version_id, expected_revision):
        with self.factory.begin() as db:
            version, context, _ = self.versions.access(db, token, version_id)
            if version.revision != expected_revision: raise ApiError("VERSION_STALE", 409)
            return self.ready_locked(db, version, context)[0]

    @staticmethod
    def receipt(publication):
        snap = publication.snapshot
        return {"publication_id": str(publication.id), "version_id": str(publication.version_id),
            "version_number": snap["version_number"], "revision": snap["revision"], "published_at": publication.published_at.isoformat()}

    def switch(self, db, publication, version, user_id):
        """Testable commit boundary; every write here rolls back together."""
        head = db.get(PublicationHead, publication.profile_key)
        if head:
            old = db.get(Publication, head.publication_id)
            previous = db.scalar(select(ScheduleDraft).where(ScheduleDraft.id == old.version_id).with_for_update())
            self.versions.transition(db, previous, "archive", user_id)
            head.publication_id = publication.id
        else:
            db.add(PublicationHead(profile_key=publication.profile_key, publication_id=publication.id))
        self.versions.transition(db, version, "publish", user_id)

    def publish(self, token, version_id, body, request_id):
        # Reject unauthorized callers even when the publication lock is busy.
        with self.factory.begin() as db:
            self.versions.access(db, token, version_id, "draft.publish")
        for attempt in range(PUBLISH_ATTEMPTS):
            with self.factory.begin() as db:
                # This lock precedes Scope -> Context -> Version everywhere.
                # It protects overlapping resources even across access scopes.
                if db.scalar(text("SELECT pg_try_advisory_xact_lock(:key)"), {"key": PUBLICATION_LOCK}):
                    version, context, user = self.versions.access(db, token, version_id, "draft.publish", True)
                    fingerprint = input_token({"version_id": str(version_id), "actor_id": str(user.id), **body})
                    operation = db.get(PublicationOperation, uuid.UUID(body["idempotency_key"]))
                    if operation:
                        if operation.request_hash != fingerprint or operation.actor_id != user.id:
                            raise ApiError("PUBLICATION_KEY_REUSED", 409)
                        return self.receipt(db.get(Publication, operation.publication_id))
                    self.versions.expected(version, body)
                    ready, material = self.ready_locked(db, version, context)
                    if str(ready["approval_id"]) != body["approval_id"]: raise ApiError("VERSION_APPROVAL_STALE", 409)
                    if ready["token"] != body["readiness_token"]: raise ApiError("PUBLICATION_READINESS_STALE", 409)
                    if not ready["ready"]: raise ApiError("PUBLICATION_BLOCKED", 422, {"issues": ready["issues"]})
                    submitted, inputs, events, approval, key, timezone = material
                    publication = Publication(context_id=context.id, version_id=version.id, approval_id=approval.id, profile_key=key,
                        published_by=user.id, snapshot={"name": version.name, "version_number": version.version_number, "revision": version.revision,
                            "scope_name": db.get(Scope, context.scope_id).name,
                            "context_id": str(context.id), "scope_id": str(context.scope_id), "academic_year": context.academic_year,
                            "data_kind": context.data_kind, "group_ids": submitted.selection["group_ids"], "semester": submitted.selection["semester"],
                            "timezone": timezone, "events": events, "inputs": inputs, "report": ready["report"],
                            "approval_id": str(approval.id), "submission_id": str(submitted.id)})
                    db.add(publication); db.flush()
                    db.add(PublicationOperation(key=uuid.UUID(body["idempotency_key"]), actor_id=user.id, request_hash=fingerprint, publication_id=publication.id))
                    self.switch(db, publication, version, user.id)
                    audit(db, "version.publish", "published", request_id, user.id)
                    db.flush()
                    return self.receipt(publication)
            if attempt + 1 < PUBLISH_ATTEMPTS: time.sleep(0.05)
        raise ApiError("PUBLICATION_BUSY", 409)

    def reader(self, db, token, scope_id):
        user = self.auth.resolve(db, token)
        if not user: raise ApiError("AUTH_REQUIRED", 401)
        grants = [g for g in self.auth.grants(db, user.id) if g["scope_id"] == str(scope_id)]
        permissions = permissions_for(grants, str(scope_id))
        if not any(p.startswith("publication.read") for p in permissions): raise ApiError("ACCESS_DENIED", 403)
        return ("publication.read" in permissions,
            {g["teacher_id"] for g in grants if g["role"] == "teacher" and g["teacher_id"]},
            {g["group_id"] for g in grants if g["role"] == "student" and g["group_id"]})

    @staticmethod
    def visible(publication, access):
        full, teachers, groups = access
        return [e for e in publication.snapshot["events"] if not e["cancelled"]
                and (full or e["teacher_id"] in teachers or e["group_id"] in groups)]

    @staticmethod
    def metadata(db, publication, events):
        snapshot = publication.snapshot
        current = db.scalar(select(PublicationHead.profile_key).where(PublicationHead.publication_id == publication.id)) is not None
        return {**PublicationService.receipt(publication), "name": snapshot["name"], "context_id": str(publication.context_id),
            "academic_year": snapshot["academic_year"], "data_kind": snapshot["data_kind"], "semester": snapshot["semester"],
            "scope_name": snapshot["scope_name"], "timezone": snapshot["timezone"], "is_current": current,
            "groups": sorted({e["group"] for e in events}), "event_count": len(events),
            "external_verified": not bool(snapshot["report"]["notes"])}

    def list(self, token, scope_id):
        with self.factory.begin() as db:
            db.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"))
            access = self.reader(db, token, scope_id)
            publications = db.scalars(select(Publication).join(PublicationHead, PublicationHead.publication_id == Publication.id)
                .join(ImportContext, ImportContext.id == Publication.context_id).where(ImportContext.scope_id == scope_id)
                .order_by(Publication.published_at.desc(), Publication.id)).all()
            return [self.metadata(db, p, events) for p in publications if (events := self.visible(p, access))]

    def get(self, token, publication_id, start=None, end=None, view="group", resource_id=None, offset=0, limit=100):
        with self.factory.begin() as db:
            db.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"))
            if not self.auth.resolve(db, token): raise ApiError("AUTH_REQUIRED", 401)
            publication = db.get(Publication, publication_id)
            if not publication: raise ApiError("NOT_FOUND", 404)
            context = db.get(ImportContext, publication.context_id)
            access = self.reader(db, token, context.scope_id)
            events = self.visible(publication, access)
            if not events and not access[0]: raise ApiError("ACCESS_DENIED", 403)
            options = {kind: [{"id": key, "name": label} for key, label in sorted({e[kind + "_id"]: e[kind] for e in events}.items(), key=lambda item: (item[1], item[0]))]
                       for kind in ("group", "teacher", "room")}
            meta = self.metadata(db, publication, events)
            if (start is None) != (end is None) or start and end and start > end: raise ApiError("PUBLICATION_RANGE_INVALID", 422)
            if resource_id and not any(r["id"] == resource_id for r in options[view]): raise ApiError("ACCESS_DENIED", 403)
            if start: events = [e for e in events if start <= e["date"] <= end]
            if resource_id: events = [e for e in events if e[view + "_id"] == resource_id]
            events = sorted(events, key=lambda e: (e["date"], e["start"], e["group"], e["id"]))
            fields = ("id", "date", "start", "end", "subject", "group", "teacher", "room")
            return {**meta, "resources": options, "events": [{k: e[k] for k in fields} for e in events[offset:offset + limit]],
                "total": len(events), "offset": offset, "limit": limit}

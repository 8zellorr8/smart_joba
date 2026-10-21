"""Scoped calendar revisions and read-only hour previews.

Lock order matches S1: Scope -> ImportContext -> CalendarProfile. Calendar
revision and source context revision form the dependency token for later modules.
"""
import uuid

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

from .auth import ApiError, audit
from ..domain.calendar import calculate_plan, calendar_dates, validate_profile
from ..domain.permissions import permissions_for
from ..infrastructure.models import (CalendarProfile, CalendarRevision, Group, ImportContext,
                                     ImportRow, Scope, TeachingAssignment, TeachingDemand)


class CalendarService:
    def __init__(self, factory, auth):
        self.factory, self.auth = factory, auth

    def authorize(self, db, token, scope_id, write=False):
        user = self.auth.resolve(db, token)
        if user is None:
            raise ApiError("AUTH_REQUIRED", 401)
        permissions = permissions_for(self.auth.grants(db, user.id), str(scope_id))
        allowed = "calendar.manage" in permissions if write else bool({"calendar.manage", "draft.read"} & set(permissions))
        if not allowed:
            raise ApiError("ACCESS_DENIED", 403)
        return user

    def access(self, db, token, profile_id, write=False, lock=False):
        if self.auth.resolve(db, token) is None:
            raise ApiError("AUTH_REQUIRED", 401)
        profile = db.get(CalendarProfile, profile_id)
        if profile is None:
            raise ApiError("NOT_FOUND", 404)
        context = db.get(ImportContext, profile.context_id)
        user = self.authorize(db, token, context.scope_id, write)
        if lock:
            db.scalar(select(Scope).where(Scope.id == context.scope_id).with_for_update(read=not write))
            context = db.scalar(select(ImportContext).where(ImportContext.id == context.id)
                                .with_for_update(read=not write).execution_options(populate_existing=True))
            profile = db.scalar(select(CalendarProfile).where(CalendarProfile.id == profile_id)
                                .with_for_update(read=not write).execution_options(populate_existing=True))
        return profile, context, user

    @staticmethod
    def require_revision(profile, context, revision, context_revision):
        if profile.revision != revision or context.revision != context_revision:
            raise ApiError("CALENDAR_STALE", 409)

    @staticmethod
    def dto(db, profile, context):
        group = db.get(Group, profile.group_id)
        return {"id": str(profile.id), "context_id": str(context.id), "group_id": str(group.id),
                "group_code": group.code, "academic_year": context.academic_year, "data_kind": context.data_kind,
                "revision": profile.revision, "context_revision": context.revision, "document": profile.document}

    def options(self, token, scope_id):
        with self.factory() as db:
            self.authorize(db, token, scope_id)
            groups = db.scalars(select(Group).where(Group.scope_id == scope_id).order_by(Group.code)).all()
            contexts = db.scalars(select(ImportContext).where(ImportContext.scope_id == scope_id)).all()
            by_id = {c.id: c for c in contexts}
            profiles = db.scalars(select(CalendarProfile).where(CalendarProfile.context_id.in_(by_id))
                                  .order_by(CalendarProfile.id)).all()
            demands = db.scalars(select(TeachingDemand).where(TeachingDemand.context_id.in_(by_id))
                                 .order_by(TeachingDemand.id)).all()
            return {"groups": [{"id": str(g.id), "code": g.code, "data_kind": g.data_kind} for g in groups],
                    "profiles": [self.dto(db, p, by_id[p.context_id]) for p in profiles],
                    "demands": [{"id": str(d.id), "group_id": str(d.group_id) if d.group_id else None,
                                 "context_id": str(d.context_id), "subject": d.normalized["subject"],
                                 "semester": d.normalized["semester"], "semester_amount": str(d.semester_amount) if d.semester_amount is not None else None,
                                 "weekly_amount": str(d.weekly_amount) if d.weekly_amount is not None else None,
                                 "unit": d.normalized["hour_unit"], "confirmed": not d.open_issues and bool(d.normalized["references_confirmed"])} for d in demands]}

    def create(self, token, scope_id, year, data_kind, group_id, document, request_id):
        validate_profile(document)
        with self.factory.begin() as db:
            user = self.authorize(db, token, scope_id, write=True)
            db.scalar(select(Scope).where(Scope.id == scope_id).with_for_update())
            group = db.get(Group, group_id)
            if group is None or group.scope_id != scope_id or group.data_kind != data_kind:
                raise ApiError("ACCESS_DENIED", 403)
            db.execute(insert(ImportContext).values(id=uuid.uuid4(), scope_id=scope_id, academic_year=year,
                                                  data_kind=data_kind, revision=0).on_conflict_do_nothing())
            context = db.scalar(select(ImportContext).where(ImportContext.scope_id == scope_id,
                                ImportContext.academic_year == year, ImportContext.data_kind == data_kind).with_for_update())
            existing = db.scalar(select(CalendarProfile).where(CalendarProfile.context_id == context.id,
                                                                CalendarProfile.group_id == group_id))
            if existing:
                raise ApiError("CALENDAR_EXISTS", 409)
            profile = CalendarProfile(context_id=context.id, group_id=group_id, revision=1, document=document)
            db.add(profile)
            db.flush()
            db.add(CalendarRevision(profile_id=profile.id, revision=1, document=document, confirmed_by=user.id))
            audit(db, "calendar.create", "created", request_id, user.id)
            return self.dto(db, profile, context)

    def get(self, token, profile_id):
        with self.factory() as db:
            profile, context, _ = self.access(db, token, profile_id)
            return self.dto(db, profile, context)

    def update(self, token, profile_id, revision, context_revision, document, request_id):
        validate_profile(document)
        with self.factory.begin() as db:
            profile, context, user = self.access(db, token, profile_id, write=True, lock=True)
            self.require_revision(profile, context, revision, context_revision)
            if profile.document != document:
                profile.revision += 1
                profile.document = document
                db.add(CalendarRevision(profile_id=profile.id, revision=profile.revision, document=document, confirmed_by=user.id))
                audit(db, "calendar.update", "updated", request_id, user.id)
            return self.dto(db, profile, context)

    def dates(self, token, profile_id, start, end):
        with self.factory.begin() as db:
            profile, context, _ = self.access(db, token, profile_id, lock=True)
            return {"revision": profile.revision, "context_revision": context.revision,
                    "dates": calendar_dates(profile.document, start, end)}

    def history(self, token, profile_id):
        with self.factory() as db:
            self.access(db, token, profile_id)
            return [{"id": str(r.id), "revision": r.revision, "document": r.document,
                     "created_at": r.created_at.isoformat()} for r in db.scalars(select(CalendarRevision)
                     .where(CalendarRevision.profile_id == profile_id).order_by(CalendarRevision.revision.desc()))]

    def preview(self, token, profile_id, revision, context_revision, patterns, demand_id=None):
        with self.factory.begin() as db:
            profile, context, _ = self.access(db, token, profile_id, lock=True)
            self.require_revision(profile, context, revision, context_revision)
            source = None
            if demand_id:
                demand = db.get(TeachingDemand, demand_id)
                if demand is None or demand.context_id != context.id or demand.group_id != profile.group_id:
                    raise ApiError("ACCESS_DENIED", 403)
                row = db.get(ImportRow, demand.source_row_id)
                assignment = db.scalar(select(TeachingAssignment).where(TeachingAssignment.demand_id == demand.id))
                source = {"id": str(demand.id), "revision": demand.revision,
                          "semester": demand.normalized["semester"],
                          "semester_amount": str(demand.semester_amount) if demand.semester_amount is not None else None,
                          "weekly_amount": str(demand.weekly_amount) if demand.weekly_amount is not None else None,
                          "unit": demand.normalized["hour_unit"], "basis": "semester",
                          "confirmed": not demand.open_issues and bool(row.references_confirmed) and assignment is not None,
                          "source_row_id": str(row.id), "source_coordinate": f"K{row.source_row}"}
            result = calculate_plan(profile.document, patterns, source)
            # Readiness of the full generator has other owners; this is calendar
            # readiness only, and is named accordingly at the transport boundary.
            result["calendar_ready"] = result.pop("ready_for_generation")
            result["dependency_token"] = {"calendar_id": str(profile.id), "calendar_revision": profile.revision,
                                          "context_id": str(context.id), "context_revision": context.revision}
            result["preview_only"] = True
            return result

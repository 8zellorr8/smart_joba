"""Consistent, immutable input contract shared by jobs and independent checks."""
import hashlib
import json
import uuid

from sqlalchemy import select

from .auth import ApiError, audit
from .imports import ImportService
from ..domain.planning import RULE_VERSION, readiness
from ..infrastructure.models import (CalendarProfile, Group, ImportContext, ImportRow, PlanningRules,
    PlanningRulesRevision, Room, ScheduleDraft, ScheduleSeries, Scope, Teacher, TeachingAssignment, TeachingDemand)


def input_token(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def current_dependencies(db, snapshot):
    old = snapshot["dependencies"]
    context = db.get(ImportContext, uuid.UUID(snapshot["context_id"]))
    rules = db.get(PlanningRules, context.id)
    calendars = {str(c.id): c.revision for c in db.scalars(select(CalendarProfile).where(CalendarProfile.id.in_([uuid.UUID(i) for i in old["calendars"]])))}
    rooms = {str(r.id): r.revision for r in db.scalars(select(Room).where(Room.id.in_([uuid.UUID(i) for i in old["rooms"]])))}
    base = db.get(ScheduleDraft, uuid.UUID(snapshot["base_draft_id"])) if snapshot["base_draft_id"] else None
    return {"context_revision": context.revision, "rules_revision": rules.revision if rules else None,
            "calendars": {i: calendars.get(i) for i in old["calendars"]}, "rooms": {i: rooms.get(i) for i in old["rooms"]},
            "base_revision": base.revision if base else None, "rule_version": RULE_VERSION}


class PlanningInputs:
    def __init__(self, editor):
        self.editor = editor

    def context(self, db, token, context_id, action="draft.read", write=False):
        context = db.get(ImportContext, context_id)
        if context is None:
            # Authentication is still required before revealing existence.
            if self.editor.auth.resolve(db, token) is None: raise ApiError("AUTH_REQUIRED", 401)
            raise ApiError("NOT_FOUND", 404)
        user = self.editor.authorize(db, token, context.scope_id, action)
        db.scalar(select(Scope).where(Scope.id == context.scope_id).with_for_update(read=not write))
        context = db.scalar(select(ImportContext).where(ImportContext.id == context_id).with_for_update(read=not write).execution_options(populate_existing=True))
        return context, user

    def options(self, token, scope_id):
        with self.editor.factory() as db:
            user = self.editor.authorize(db, token, scope_id, "editor.options")
            contexts = db.scalars(select(ImportContext).where(ImportContext.scope_id == scope_id)).all()
            ids = [c.id for c in contexts]
            demands = db.scalars(select(TeachingDemand).where(TeachingDemand.context_id.in_(ids))).all()
            rules = {str(r.context_id): r for r in db.scalars(select(PlanningRules).where(PlanningRules.context_id.in_(ids)))}
            from ..domain.permissions import permissions_for
            read = "draft.read" in permissions_for(self.editor.auth.grants(db, user.id), str(scope_id))
            return {"contexts": [{"id": str(c.id), "academic_year": c.academic_year, "data_kind": c.data_kind, "revision": c.revision,
                "rules_revision": rules[str(c.id)].revision if str(c.id) in rules else 0,
                "rules": rules[str(c.id)].document if str(c.id) in rules else None} for c in contexts],
                "groups": [{"id": str(g.id), "code": g.code, "data_kind": g.data_kind} for g in db.scalars(select(Group).where(Group.scope_id == scope_id))],
                "teachers": [{"id": str(t.id), "name": t.display_name, "data_kind": t.data_kind} for t in db.scalars(select(Teacher).where(Teacher.scope_id == scope_id))],
                "rooms": [self.editor.room_dto(r) for r in db.scalars(select(Room).where(Room.scope_id == scope_id))],
                "demands": [{"id": str(d.id), "context_id": str(d.context_id), "group_id": str(d.group_id) if d.group_id else None,
                    "subject": d.normalized.get("subject"), "semester": d.normalized.get("semester")} for d in demands],
                "drafts": [{"id": str(d.id), "context_id": str(d.context_id), "name": d.name, "revision": d.revision} for d in
                    db.scalars(select(ScheduleDraft).where(ScheduleDraft.context_id.in_(ids)).order_by(ScheduleDraft.created_at.desc()))] if read else []}

    def save_rules(self, token, context_id, body, request_id):
        with self.editor.factory.begin() as db:
            context, user = self.context(db, token, context_id, "catalog.manage", write=True)
            rules = db.get(PlanningRules, context_id)
            if (rules.revision if rules else 0) != body["expected_revision"]:
                raise ApiError("PLANNING_STALE", 409)
            doc = body["document"]
            if doc["confirmed"] and not doc["source"].strip() or doc["external_confirmed"] and not doc["external_source"].strip():
                raise ApiError("RULES_SOURCE_REQUIRED", 422)
            groups = {str(g.id) for g in db.scalars(select(Group).where(Group.scope_id == context.scope_id, Group.data_kind == context.data_kind))}
            teachers = {str(t.id) for t in db.scalars(select(Teacher).where(Teacher.scope_id == context.scope_id, Teacher.data_kind == context.data_kind))}
            rooms = {str(r.id) for r in db.scalars(select(Room).where(Room.scope_id == context.scope_id, Room.data_kind == context.data_kind))}
            demands = {str(d.id) for d in db.scalars(select(TeachingDemand).where(TeachingDemand.context_id == context.id))}
            resources = {"group": groups, "teacher": teachers, "room": rooms}
            for key, field, allowed in (("groups", "group_id", groups), ("rooms", "room_id", rooms), ("needs", "demand_id", demands)):
                refs = [r[field] for r in doc[key]]
                if len(refs) != len(set(refs)): raise ApiError("RULES_DUPLICATE", 422)
                if not set(refs) <= allowed: raise ApiError("ACCESS_DENIED", 403)
            for row in doc["availability"] + doc["busy"]:
                if row["resource_id"] not in resources[row["resource_type"]]: raise ApiError("ACCESS_DENIED", 403)
                if row["start"] >= row["end"]: raise ApiError("CALENDAR_TIME_INVALID", 422)
            for row in doc["availability"]:
                if row["start_date"] > row["end_date"] or len(set(row["weekdays"])) != len(row["weekdays"]):
                    raise ApiError("CALENDAR_RANGE_INVALID", 422)
            if any(not row["source"].strip() for row in doc["busy"]):
                raise ApiError("RULES_SOURCE_REQUIRED", 422)
            if rules is None:
                rules = PlanningRules(context_id=context_id, revision=1, document=doc, confirmed_by=user.id)
                db.add(rules); db.flush()
            elif rules.document != doc:
                rules.revision += 1; rules.document = doc; rules.confirmed_by = user.id
            if not db.scalar(select(PlanningRulesRevision.id).where(PlanningRulesRevision.context_id == context_id, PlanningRulesRevision.revision == rules.revision)):
                db.add(PlanningRulesRevision(context_id=context_id, revision=rules.revision, document=doc, actor_id=user.id))
            audit(db, "planning.rules", "saved", request_id, user.id)
            return {"revision": rules.revision, "document": rules.document}

    def build(self, db, context, selection, allow_frozen=False):
        group_ids = set(selection["group_ids"])
        room_ids = set(selection["room_ids"])
        if len(group_ids) != len(selection["group_ids"]) or len(room_ids) != len(selection["room_ids"]):
            raise ApiError("RULES_DUPLICATE", 422)
        groups = {str(g.id): g for g in db.scalars(select(Group).where(Group.id.in_([uuid.UUID(i) for i in group_ids])))}
        rooms = list(db.scalars(select(Room).where(Room.id.in_([uuid.UUID(i) for i in room_ids]))))
        if set(groups) != group_ids or len(rooms) != len(room_ids) or any(g.scope_id != context.scope_id or g.data_kind != context.data_kind for g in groups.values()) or any(r.scope_id != context.scope_id or r.data_kind != context.data_kind for r in rooms):
            raise ApiError("ACCESS_DENIED", 403)
        calendars = {str(c.group_id): c for c in db.scalars(select(CalendarProfile).where(CalendarProfile.context_id == context.id, CalendarProfile.group_id.in_([g.id for g in groups.values()])))}
        demands, source_questions = [], []
        for d in db.scalars(select(TeachingDemand).where(TeachingDemand.context_id == context.id, TeachingDemand.group_id.in_([g.id for g in groups.values()])).order_by(TeachingDemand.id)):
            if d.normalized.get("semester") != selection["semester"]:
                if d.normalized.get("semester") is None: source_questions.append({"code": "SEMESTER_UNKNOWN", "demand_id": str(d.id)})
                continue
            a = db.scalar(select(TeachingAssignment).where(TeachingAssignment.demand_id == d.id))
            t = db.get(Teacher, a.teacher_id) if a else None
            row = db.get(ImportRow, d.source_row_id)
            cal = calendars.get(str(d.group_id))
            demands.append({"id": str(d.id), "revision": d.revision, "assignment_id": str(a.id) if a else None,
                "assignment_source_revision_id": str(a.source_revision_id) if a else None, "source_row_id": str(row.id),
                "source": {"row_id": str(row.id), "coordinate": f"K{row.source_row}"}, "subject": d.normalized["subject"],
                "group_id": str(d.group_id), "group": groups[str(d.group_id)].code, "teacher_id": str(t.id) if t else None, "teacher": t.display_name if t else None,
                "whole_group": bool(d.normalized.get("whole_group")) and not d.normalized.get("subgroup") and not d.normalized.get("joint"),
                "confirmed": bool(a and not d.open_issues and d.normalized.get("references_confirmed")),
                "source_amount": str(d.semester_amount) if d.semester_amount is not None else None, "source_unit": d.normalized["hour_unit"],
                "calendar_id": str(cal.id) if cal else "", "calendar_revision": cal.revision if cal else None})
        for group_id in group_ids:
            if not any(d["group_id"] == group_id for d in demands):
                source_questions.append({"code": "DEMANDS_EMPTY_GROUP", "group_id": group_id})
        unresolved = ImportService.unresolved_for_context(db, context.id, {g.code for g in groups.values()})
        source_questions.extend({"code": "SOURCE_QUESTIONS", **q} for q in unresolved)
        if len(demands) > 200: raise ApiError("PLANNING_LIMIT", 422)
        base_id = selection.get("base_draft_id")
        pins, base_revision = [], None
        if base_id:
            base = db.get(ScheduleDraft, uuid.UUID(base_id))
            if not base or base.context_id != context.id: raise ApiError("ACCESS_DENIED", 403)
            if base.status != "draft" and not allow_frozen: raise ApiError("DRAFT_IMMUTABLE", 409)
            base_revision = base.revision
            for row in self.editor.rows(db, base):
                pins.extend(dict(e) for e in row.occurrences if e["pinned"] and e["group_id"] in group_ids and e["semester"] == selection["semester"])
        rules = db.get(PlanningRules, context.id)
        dependencies = {"context_revision": context.revision, "rules_revision": rules.revision if rules else None,
            "calendars": {str(c.id): c.revision for c in calendars.values()}, "rooms": {str(r.id): r.revision for r in rooms},
            "base_revision": base_revision, "rule_version": RULE_VERSION}
        snapshot = {"snapshot_id": str(uuid.uuid4()), "context_id": str(context.id), "scope_id": str(context.scope_id),
            "academic_year": context.academic_year, "data_kind": context.data_kind, "group_ids": sorted(group_ids),
            "semester": selection["semester"], "base_draft_id": base_id, "pins": pins, "demands": demands,
            "calendars": {str(c.id): c.document for c in calendars.values()}, "rooms": [self.editor.room_dto(r) for r in rooms],
            "rules": rules.document if rules else None, "dependencies": dependencies, "source_questions": source_questions}
        snapshot["token"] = input_token({"dependencies": dependencies, "group_ids": sorted(group_ids), "semester": snapshot["semester"], "base_draft_id": base_id})
        return snapshot

    def preview(self, token, scope_id, selection):
        with self.editor.factory.begin() as db:
            context, _ = self.context(db, token, uuid.UUID(selection["context_id"]), "generator.run")
            if context.scope_id != scope_id: raise ApiError("ACCESS_DENIED", 403)
            snapshot = self.build(db, context, selection)
            questions = readiness(snapshot)
            return {"token": snapshot["token"], "ready": not questions, "questions": questions[:200],
                    "question_count": len(questions), "dependencies": snapshot["dependencies"], "demands": len(snapshot["demands"]),
                    "pins": len(snapshot["pins"]), "external_verified": bool(snapshot["rules"] and snapshot["rules"]["external_confirmed"])}

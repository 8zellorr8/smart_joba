"""Revisioned content edits; workflow and publication live in separate services.

Every operation derives scope from the draft and locks Scope -> Context -> Draft.
Scope locks also serialize shared calendar/room/source changes during a command.
"""
import uuid
from fractions import Fraction

from sqlalchemy import select

from .auth import ApiError, audit
from .imports import ImportService
from .version_numbers import next_version_number
from ..domain.calendar import amount_text, calculate_plan, calendar_dates, dates_between, minute_of_day
from ..domain.permissions import permissions_for
from ..domain.schedule import find_conflicts, replace_one
from ..infrastructure.models import (CalendarProfile, DraftRevision, Group, ImportContext, ImportRow, Room,
                                     ScheduleDraft, ScheduleSeries, Scope, Teacher, TeachingAssignment, TeachingDemand)

MAX_SERIES = 200
MAX_OCCURRENCES = 10000


class EditorService:
    def __init__(self, factory, auth):
        self.factory, self.auth = factory, auth

    def authorize(self, db, token, scope_id, action="draft.read"):
        user = self.auth.resolve(db, token)
        if user is None:
            raise ApiError("AUTH_REQUIRED", 401)
        permissions = permissions_for(self.auth.grants(db, user.id), str(scope_id))
        allowed = bool({"draft.read", "catalog.manage"} & set(permissions)) if action == "editor.options" else action in permissions
        if not allowed:
            raise ApiError("ACCESS_DENIED", 403)
        return user

    def access(self, db, token, draft_id, write=False):
        if self.auth.resolve(db, token) is None:
            raise ApiError("AUTH_REQUIRED", 401)
        draft = db.get(ScheduleDraft, draft_id)
        if draft is None:
            raise ApiError("NOT_FOUND", 404)
        context = db.get(ImportContext, draft.context_id)
        user = self.authorize(db, token, context.scope_id, "draft.edit" if write else "draft.read")
        db.scalar(select(Scope).where(Scope.id == context.scope_id).with_for_update(read=not write))
        context = db.scalar(select(ImportContext).where(ImportContext.id == context.id)
                            .with_for_update(read=not write).execution_options(populate_existing=True))
        draft = db.scalar(select(ScheduleDraft).where(ScheduleDraft.id == draft_id)
                          .with_for_update(read=not write).execution_options(populate_existing=True))
        if write and draft.status != "draft":
            raise ApiError("DRAFT_IMMUTABLE", 409)
        return draft, context, user

    @staticmethod
    def rows(db, draft):
        return db.scalars(select(ScheduleSeries).where(ScheduleSeries.draft_id == draft.id).order_by(ScheduleSeries.id)).all()

    @staticmethod
    def room_dto(room):
        return {"id": str(room.id), "code": room.code, "data_kind": room.data_kind, "exclusive": room.exclusive,
                "confirmed": room.confirmed, "source": room.source, "revision": room.revision}

    def room_save(self, token, scope_id, body, request_id, room_id=None):
        with self.factory.begin() as db:
            if room_id:
                room = db.get(Room, room_id)
                if room is None:
                    raise ApiError("NOT_FOUND", 404)
                scope_id = room.scope_id
            user = self.authorize(db, token, scope_id, "catalog.manage")
            db.scalar(select(Scope).where(Scope.id == scope_id).with_for_update())
            if not body["code"].strip() or (body["confirmed"] and not body["source"].strip()):
                raise ApiError("ROOM_SOURCE_REQUIRED", 422)
            if room_id:
                room = db.scalar(select(Room).where(Room.id == room_id).with_for_update().execution_options(populate_existing=True))
                if room.revision != body["expected_revision"]:
                    raise ApiError("EDITOR_STALE", 409)
                if room.code != body["code"].strip() or room.data_kind != body["data_kind"]:
                    raise ApiError("ROOM_IDENTITY_IMMUTABLE", 422)
                values = {key: body[key] for key in ("exclusive", "confirmed", "source")}
                if any(getattr(room, key) != value for key, value in values.items()):
                    for key, value in values.items(): setattr(room, key, value)
                    room.revision += 1
            else:
                if db.scalar(select(Room.id).where(Room.scope_id == scope_id, Room.data_kind == body["data_kind"], Room.code == body["code"].strip())):
                    raise ApiError("ROOM_EXISTS", 409)
                room = Room(scope_id=scope_id, code=body["code"].strip(), data_kind=body["data_kind"],
                            exclusive=body["exclusive"], confirmed=body["confirmed"], source=body["source"], revision=1)
                db.add(room); db.flush()
            audit(db, "room.review", "saved", request_id, user.id)
            return self.room_dto(room)

    def options(self, token, scope_id):
        with self.factory() as db:
            user = self.authorize(db, token, scope_id, "editor.options")
            rooms = db.scalars(select(Room).where(Room.scope_id == scope_id).order_by(Room.code)).all()
            result = {"rooms": [self.room_dto(r) for r in rooms], "contexts": [], "calendars": [], "assignments": [], "drafts": []}
            if "draft.read" not in permissions_for(self.auth.grants(db, user.id), str(scope_id)):
                return result
            contexts = db.scalars(select(ImportContext).where(ImportContext.scope_id == scope_id)).all()
            ids = [c.id for c in contexts]
            result["contexts"] = [{"id": str(c.id), "academic_year": c.academic_year, "data_kind": c.data_kind, "revision": c.revision} for c in contexts]
            result["calendars"] = [{"id": str(c.id), "context_id": str(c.context_id), "group_id": str(c.group_id),
                                    "revision": c.revision, "document": c.document} for c in db.scalars(select(CalendarProfile).where(CalendarProfile.context_id.in_(ids)))]
            for assignment, demand, teacher, group in db.execute(select(TeachingAssignment, TeachingDemand, Teacher, Group)
                    .join(TeachingDemand, TeachingDemand.id == TeachingAssignment.demand_id)
                    .join(Teacher, Teacher.id == TeachingAssignment.teacher_id).join(Group, Group.id == TeachingDemand.group_id)
                    .where(TeachingDemand.context_id.in_(ids)).order_by(Group.code, TeachingDemand.id)):
                if demand.open_issues or not demand.normalized.get("whole_group") or not demand.normalized.get("references_confirmed"):
                    continue
                result["assignments"].append({"id": str(assignment.id), "revision": demand.revision, "demand_id": str(demand.id),
                    "context_id": str(demand.context_id), "group_id": str(group.id), "group": group.code,
                    "teacher_id": str(teacher.id), "teacher": teacher.display_name, "subject": demand.normalized["subject"],
                    "semester": demand.normalized["semester"]})
            result["drafts"] = [{"id": str(d.id), "context_id": str(d.context_id), "name": d.name, "revision": d.revision, "status": d.status}
                                for d in db.scalars(select(ScheduleDraft).where(ScheduleDraft.context_id.in_(ids)).order_by(ScheduleDraft.created_at.desc()))]
            return result

    @staticmethod
    def dependencies(db, context, series):
        events = [event for row in series for event in row.occurrences]
        calendar_ids = {uuid.UUID(e["calendar_id"]) for e in events}
        room_ids = {uuid.UUID(e["room_id"]) for e in events}
        calendars = {str(c.id): c.revision for c in db.scalars(select(CalendarProfile).where(CalendarProfile.id.in_(calendar_ids)))}
        rooms = {str(r.id): r.revision for r in db.scalars(select(Room).where(Room.id.in_(room_ids)))}
        return {"context_revision": context.revision,
                "calendars": {str(key): calendars.get(str(key)) for key in sorted(calendar_ids)},
                "rooms": {str(key): rooms.get(str(key)) for key in sorted(room_ids)}}

    def require_expected(self, db, draft, context, series, body):
        if draft.revision != body["expected_revision"] or self.dependencies(db, context, series) != body["expected_dependencies"]:
            raise ApiError("EDITOR_STALE", 409)

    def create(self, token, scope_id, context_id, name, request_id):
        with self.factory.begin() as db:
            user = self.authorize(db, token, scope_id, "draft.edit")
            db.scalar(select(Scope).where(Scope.id == scope_id).with_for_update())
            context = db.get(ImportContext, context_id)
            if context is None or context.scope_id != scope_id:
                raise ApiError("ACCESS_DENIED", 403)
            if not name.strip(): raise ApiError("EDITOR_NAME_REQUIRED", 422)
            draft = ScheduleDraft(context_id=context_id, name=name.strip(), revision=1, status="draft", created_by=user.id,
                                  version_number=next_version_number(db, context_id),
                                  dependencies={"context_revision": context.revision, "calendars": {}, "rooms": {}})
            db.add(draft); db.flush()
            self.record(db, draft, context, [], user.id, request_id)
            return self.dto(db, draft, context, [])

    def references(self, db, context, body):
        assignment = db.get(TeachingAssignment, uuid.UUID(body["assignment_id"]))
        if assignment is None: raise ApiError("EDITOR_ASSIGNMENT_UNCONFIRMED", 422)
        demand = db.get(TeachingDemand, assignment.demand_id)
        if demand.context_id != context.id: raise ApiError("ACCESS_DENIED", 403)
        if demand.open_issues or not demand.normalized.get("whole_group") or not demand.normalized.get("references_confirmed"):
            raise ApiError("EDITOR_ASSIGNMENT_UNCONFIRMED", 422)
        calendar = db.get(CalendarProfile, uuid.UUID(body["calendar_id"]))
        room = db.get(Room, uuid.UUID(body["room_id"]))
        if (calendar is None or calendar.context_id != context.id or calendar.group_id != demand.group_id or
                room is None or room.scope_id != context.scope_id or room.data_kind != context.data_kind):
            raise ApiError("ACCESS_DENIED", 403)
        if (demand.revision != body["assignment_revision"] or calendar.revision != body["calendar_revision"] or room.revision != body["room_revision"]):
            raise ApiError("EDITOR_STALE", 409)
        if not all(calendar.document[k] for k in ("confirmed", "units_confirmed", "timezone_confirmed")):
            raise ApiError("EDITOR_CALENDAR_UNCONFIRMED", 422)
        row = db.get(ImportRow, demand.source_row_id)
        snapshot = {"assignment_id": str(assignment.id), "assignment_revision": demand.revision,
                    "assignment_source_revision_id": str(assignment.source_revision_id), "demand_id": str(demand.id),
                    "group_id": str(demand.group_id), "group": db.get(Group, demand.group_id).code,
                    "teacher_id": str(assignment.teacher_id), "teacher": db.get(Teacher, assignment.teacher_id).display_name,
                    "subject": demand.normalized["subject"], "semester": demand.normalized["semester"],
                    "calendar_id": str(calendar.id), "calendar_revision": calendar.revision,
                    "room_id": str(room.id), "room": room.code, "room_revision": room.revision,
                    "room_exclusive": room.exclusive if room.confirmed else None,
                    "source_row_id": str(row.id), "source_coordinate": f"K{row.source_row}"}
        return assignment, demand, calendar, room, snapshot

    def save_series(self, token, draft_id, body, request_id, series_id=None):
        with self.factory.begin() as db:
            draft, context, user = self.access(db, token, draft_id, write=True)
            series = self.rows(db, draft)
            self.require_expected(db, draft, context, series, body)
            old = next((s for s in series if s.id == series_id), None) if series_id else None
            if series_id and old is None: raise ApiError("NOT_FOUND", 404)
            if old is None and len(series) >= MAX_SERIES: raise ApiError("EDITOR_LIMIT", 422)
            _, demand, calendar, _, snapshot = self.references(db, context, body)
            plan = calculate_plan(calendar.document, [body["pattern"]], {"confirmed": True, "semester_amount": str(demand.semester_amount) if demand.semester_amount is not None else None,
                                  "semester": demand.normalized["semester"], "unit": demand.normalized["hour_unit"]})
            if not plan["valid"]: raise ApiError("EDITOR_CALENDAR_FORBIDDEN", 422)
            if plan["comparison_issue"]: raise ApiError("CALENDAR_SEMESTER_UNCONFIRMED", 422)
            previous = {e["base_date"]: e for e in old.occurrences} if old else {}
            entries = [{**snapshot, "id": previous[o["date"]]["id"] if o["date"] in previous else str(uuid.uuid4()),
                        "base_date": o["date"], "date": o["date"], "start": o["start"], "end": o["end"],
                        "cancelled": o["status"] == "cancelled", "pinned": previous.get(o["date"], {}).get("pinned", False)} for o in plan["occurrences"]]
            by_id = {e["id"]: e for e in entries}
            if old and any(e["pinned"] and (e["id"] not in by_id or by_id[e["id"]] != e) for e in old.occurrences):
                raise ApiError("EDITOR_PINNED", 409)
            template = {key: body[key] for key in ("assignment_id", "assignment_revision", "calendar_id", "calendar_revision", "room_id", "room_revision", "pattern")}
            if sum(len(s.occurrences) for s in series if s is not old) + len(entries) > MAX_OCCURRENCES:
                raise ApiError("EDITOR_LIMIT", 422)
            if old is None:
                old = ScheduleSeries(draft_id=draft.id, template=template, occurrences=entries)
                db.add(old); db.flush(); series.append(old)
            else:
                old.template, old.occurrences = template, entries
            draft.revision += 1
            self.record(db, draft, context, series, user.id, request_id)
            return self.dto(db, draft, context, series)

    def save_one(self, token, draft_id, occurrence_id, body, request_id):
        with self.factory.begin() as db:
            draft, context, user = self.access(db, token, draft_id, write=True)
            series = self.rows(db, draft)
            self.require_expected(db, draft, context, series, body)
            selected = next(((s, e) for s in series for e in s.occurrences if e["id"] == occurrence_id), None)
            if selected is None: raise ApiError("NOT_FOUND", 404)
            row, event = selected
            # Cancellations can quarantine an obsolete assignment. Restoring or
            # moving a live occurrence requires its original confirmed assignment.
            refs = {**event, "room_id": body["room_id"], "room_revision": body["room_revision"]}
            if not body["cancelled"]:
                current_calendar = db.get(CalendarProfile, uuid.UUID(event["calendar_id"]))
                current_assignment = db.get(TeachingAssignment, uuid.UUID(event["assignment_id"]))
                current_demand = db.get(TeachingDemand, uuid.UUID(event["demand_id"]))
                if (not current_calendar or current_calendar.revision != event["calendar_revision"] or
                        not current_assignment or not current_demand or current_demand.revision != event["assignment_revision"]):
                    raise ApiError("EDITOR_SERIES_REVIEW", 409)
                _, _, calendar, _, snapshot = self.references(db, context, refs)
                day = calendar_dates(calendar.document, body["date"], body["date"])[0]
                if not day["allowed"]: raise ApiError("EDITOR_CALENDAR_FORBIDDEN", 422)
                if day["semester"] != event["semester"]: raise ApiError("CALENDAR_DEMAND_PERIOD_MISMATCH", 422)
                if (body["start"], body["end"]) not in {(slot["start"], slot["end"]) for slot in calendar.document["slots"]}:
                    raise ApiError("EDITOR_TIME_GRID", 422)
            else:
                room = db.get(Room, uuid.UUID(body["room_id"]))
                if room is None or room.scope_id != context.scope_id or room.data_kind != context.data_kind:
                    raise ApiError("ACCESS_DENIED", 403)
                if room.revision != body["room_revision"]: raise ApiError("EDITOR_STALE", 409)
                snapshot = {**event, "room_id": str(room.id), "room": room.code, "room_revision": room.revision}
            if minute_of_day(body["end"]) <= minute_of_day(body["start"]): raise ApiError("CALENDAR_TIME_INVALID", 422)
            changes = {**snapshot, **{key: body[key] for key in ("date", "start", "end", "cancelled", "pinned")}}
            row.occurrences = replace_one(row.occurrences, occurrence_id, changes)
            draft.revision += 1
            self.record(db, draft, context, series, user.id, request_id)
            return self.dto(db, draft, context, series)

    def report(self, db, draft, context, series):
        events = [dict(e, series_id=str(s.id)) for s in series for e in s.occurrences]
        rooms = {str(r.id): r for r in db.scalars(select(Room).where(Room.scope_id == context.scope_id, Room.data_kind == context.data_kind))}
        calendars = {str(c.id): c for c in db.scalars(select(CalendarProfile).where(CalendarProfile.context_id == context.id))}
        demands = {str(d.id): d for d in db.scalars(select(TeachingDemand).where(TeachingDemand.context_id == context.id))}
        assignments = {str(a.id): a for a in db.scalars(select(TeachingAssignment).join(TeachingDemand).where(TeachingDemand.context_id == context.id))}
        questions, errors, planned = [], [], {}
        for event in events:
            if event["cancelled"]: continue
            def question(code): questions.append({"code": code, "event_id": event["id"], "date": event["date"]})
            room = rooms.get(event["room_id"])
            event["room_exclusive"] = room.exclusive if room and room.confirmed else None
            if not room or not room.confirmed or room.exclusive is None: question("ROOM_EXCLUSIVITY_UNKNOWN")
            elif not room.exclusive: question("ROOM_MODEL_UNSUPPORTED")
            if room and event["room_revision"] != room.revision: question("ROOM_CHANGED")
            demand, assignment, calendar = demands.get(event["demand_id"]), assignments.get(event["assignment_id"]), calendars.get(event["calendar_id"])
            if (not assignment or not demand or demand.open_issues or not demand.normalized.get("whole_group") or
                    assignment and str(assignment.source_revision_id) != event["assignment_source_revision_id"]):
                question("ASSIGNMENT_CHANGED")
            if not calendar or calendar.revision != event["calendar_revision"]: question("CALENDAR_CHANGED")
            if not calendar: continue
            if not all(calendar.document[k] for k in ("confirmed", "units_confirmed", "timezone_confirmed")): question("CALENDAR_UNCONFIRMED")
            day = calendar_dates(calendar.document, event["date"], event["date"])[0]
            if not day["allowed"]: errors.append({"code": "CALENDAR_FORBIDDEN", "event_id": event["id"], "date": event["date"]})
            if day["semester"] != event["semester"]: question("SEMESTER_MISMATCH")
            minutes = minute_of_day(event["end"]) - minute_of_day(event["start"])
            planned[event["demand_id"]] = planned.get(event["demand_id"], Fraction(0)) + Fraction(minutes, calendar.document["academic_minutes"])
        conflicts = find_conflicts(events)
        by_id = {e["id"]: e for e in events}
        for conflict in conflicts["conflicts"]:
            first = by_id[conflict["event_ids"][0]]
            conflict["resource_name"] = first[conflict["resource_type"]]
            conflict["events"] = [{key: by_id[event_id][key] for key in ("id", "series_id", "subject", "group", "teacher", "room", "date", "start", "end")} for event_id in conflict["event_ids"]]
        groups = {e["group_id"] for e in events}
        hours = []
        for demand in demands.values():
            if str(demand.group_id) not in groups: continue
            calendar = next((c for c in calendars.values() if c.group_id == demand.group_id), None)
            required = None
            if calendar and demand.semester_amount is not None and not demand.open_issues:
                factor = {"minute": Fraction(1, calendar.document["academic_minutes"]), "academic_hour": Fraction(1),
                          "pair": Fraction(calendar.document["pair_minutes"], calendar.document["academic_minutes"])}.get(demand.normalized["hour_unit"])
                if factor is not None: required = Fraction(demand.semester_amount) * factor
            total = planned.get(str(demand.id), Fraction(0))
            remaining = None if required is None else required - total
            hours.append({"demand_id": str(demand.id), "subject": demand.normalized["subject"], "group": demand.normalized["group"],
                          "semester": demand.normalized["semester"], "source_amount": str(demand.semester_amount) if demand.semester_amount is not None else None,
                          "source_unit": demand.normalized["hour_unit"], "planned": amount_text(total), "required": amount_text(required), "remaining": amount_text(remaining)})
            if remaining is None: questions.append({"code": "HOURS_UNCONFIRMED", "demand_id": str(demand.id)})
            elif remaining != 0: errors.append({"code": "HOURS_INCOMPLETE", "demand_id": str(demand.id)})
        source = ImportService.unresolved_for_context(db, context.id, {e["group"] for e in events})
        if source: questions.append({"code": "SOURCE_QUESTIONS", "count": len(source)})
        if not any(not e["cancelled"] for e in events): errors.append({"code": "DRAFT_EMPTY"})
        dependencies = self.dependencies(db, context, series)
        stale = dependencies != draft.dependencies
        return {**conflicts, "revision": draft.revision, "dependencies": dependencies, "stale": stale,
                "errors": errors[:200], "errors_truncated": len(errors) > 200, "questions": questions[:200],
                "questions_truncated": len(questions) > 200, "hours": hours,
                "has_errors": conflicts["has_conflicts"] or bool(errors) or bool(questions) or stale,
                "notes": ["AVAILABILITY_UNVERIFIED", "ROOM_PROPERTIES_UNVERIFIED", "EXTERNAL_OCCUPANCY_UNVERIFIED"],
                "check_scope": "draft_calendar_hours_and_resource_overlap", "actual_registered": False}

    def record(self, db, draft, context, series, actor_id, request_id):
        draft.dependencies = self.dependencies(db, context, series)
        if any(len(draft.dependencies[key]) > 200 for key in ("calendars", "rooms")):
            raise ApiError("EDITOR_LIMIT", 422)
        report = self.report(db, draft, context, series)
        db.add(DraftRevision(draft_id=draft.id, revision=draft.revision, actor_id=actor_id, report=report,
                            snapshot={"name": draft.name, "dependencies": draft.dependencies,
                                      "series": [{"id": str(s.id), "template": s.template, "occurrences": s.occurrences} for s in series]}))
        audit(db, "draft.edit", "saved", request_id, actor_id)
        db.flush()

    def dto(self, db, draft, context, series, start=None, end=None, view="group", resource_id=None, offset=0, limit=100):
        events = sorted([dict(e, series_id=str(s.id)) for s in series for e in s.occurrences], key=lambda e: (e["date"], e["start"], e["id"]))
        if start or end:
            if not start or not end: raise ApiError("EDITOR_RANGE_REQUIRED", 422)
            dates_between(start, end)
            events = [e for e in events if start <= e["date"] <= end]
        if resource_id: events = [e for e in events if e[view + "_id"] == resource_id]
        report = self.report(db, draft, context, series)
        return {"id": str(draft.id), "context_id": str(context.id), "name": draft.name, "status": draft.status,
                "version_number": draft.version_number, "workflow_revision": draft.workflow_revision,
                "academic_year": context.academic_year, "data_kind": context.data_kind, "revision": draft.revision,
                "dependencies": report["dependencies"], "stale": report["stale"], "report": report,
                "series": [{"id": str(s.id), "template": s.template, "count": len(s.occurrences)} for s in series],
                "occurrences": events[offset:offset + limit], "total": len(events), "offset": offset, "limit": limit}

    def get(self, token, draft_id, start=None, end=None, view="group", resource_id=None, offset=0, limit=100):
        with self.factory.begin() as db:
            draft, context, _ = self.access(db, token, draft_id)
            return self.dto(db, draft, context, self.rows(db, draft), start, end, view, resource_id, offset, limit)

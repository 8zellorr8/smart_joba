"""Lesson facts: publication lock -> scope -> auth -> catalog -> lesson.

The shared publication lock precedes every other lock, as required by the
publication writer. A source cannot be archived between validation and commit.
The scope lock serializes facts with confirmed memberships and assignments.
"""
import uuid
from datetime import UTC, date, datetime

from sqlalchemy import select, text

from .auth import ApiError, audit
from .journal_setup import JournalSetupService, required, snapshot
from .planning_inputs import input_token
from .publications import PUBLICATION_LOCK
from ..domain.journal import attendance_change, grade_change, topic_value
from ..domain.publication import utc_interval
from ..infrastructure.journal_models import Journal, JournalRegistry, Student, StudentMembership
from ..infrastructure.lesson_models import JournalEventLink, JournalLesson, JournalLessonChange, JournalLessonOperation, JournalLessonStudent
from ..infrastructure.models import Group, Publication, PublicationHead, Subject, Teacher, TeachingDemand, User


class JournalLessonService:
    def __init__(self, factory, auth):
        self.factory = factory
        self.catalog = JournalSetupService(factory, auth)

    def access(self, db, token, scope_id, action, write=False):
        db.execute(text("SELECT pg_advisory_xact_lock_shared(:key)"), {"key": PUBLICATION_LOCK})
        return self.catalog.access(db, token, scope_id, action, write)

    def journal(self, db, journal_id, scope_id):
        journal, context = self.catalog.journal_context(db, journal_id, scope_id)
        for model, ref in ((Group, journal.group_id), (Subject, journal.subject_id)):
            self.catalog.scoped(db, model, ref, scope_id, context.data_kind)
        return journal, context

    def allowed(self, db, journal, grants, permissions, on, write=False, teacher_id=None):
        if not write and "journal.read" in permissions:
            return True
        assignments = self.catalog.own_assignments(db, journal.id, grants, date.fromisoformat(on))
        return bool(assignments and (not teacher_id or any(str(a.teacher_id) == teacher_id for a in assignments)))

    def require_lesson(self, db, scope_id, lesson_id, grants=None, permissions=None, write=False):
        lesson = db.get(JournalLesson, uuid.UUID(str(lesson_id)))
        if not lesson:
            raise ApiError("ACCESS_DENIED", 403)
        journal, context = self.journal(db, lesson.journal_id, scope_id)
        if grants is not None and not self.allowed(db, journal, grants, permissions, lesson.source["date"], write):
            raise ApiError("ACCESS_DENIED", 403)
        return lesson, journal, context

    @staticmethod
    def current(db, publication):
        head = db.get(PublicationHead, publication.profile_key)
        return bool(head and head.publication_id == publication.id)

    @staticmethod
    def link(db, publication_id, event_id):
        return db.get(JournalEventLink, (uuid.UUID(str(publication_id)), uuid.UUID(str(event_id))))

    def event(self, db, scope_id, journal, context, publication_id, event_id):
        publication = db.get(Publication, uuid.UUID(str(publication_id)))
        if not publication or publication.context_id != context.id:
            raise ApiError("ACCESS_DENIED", 403)
        source = publication.snapshot
        event = next((e for e in source["events"] if e["id"] == str(event_id)), None)
        if (not event or event["cancelled"] or event["group_id"] != str(journal.group_id)
                or event["semester"] != journal.semester or source["data_kind"] != context.data_kind):
            raise ApiError("ACCESS_DENIED", 403)
        # Existing snapshots remain usable even after mutable import references change.
        link = self.link(db, publication.id, event_id)
        if link and link.journal_id != journal.id:
            raise ApiError("ACCESS_DENIED", 403)
        if not link or not link.lesson_id:
            demand = db.get(TeachingDemand, uuid.UUID(event["demand_id"]))
            if (not demand or demand.context_id != context.id or demand.group_id != journal.group_id
                    or demand.subject_id != journal.subject_id or demand.normalized.get("semester") != journal.semester):
                raise ApiError("ACCESS_DENIED", 403)
            if not self.catalog.confirmed_demand(demand) or demand.revision != event["assignment_revision"]:
                raise ApiError("JOURNAL_SOURCE_UNCONFIRMED", 422)
            self.catalog.scoped(db, Teacher, event["teacher_id"], scope_id, context.data_kind)
            published_demand = next((d for d in source["inputs"]["demands"] if d["id"] == event["demand_id"]), None)
            calendar = source["inputs"]["calendars"].get(event["calendar_id"])
            if (not published_demand or not published_demand["confirmed"] or not calendar
                    or not calendar.get("timezone_confirmed") or calendar["timezone"] != source["timezone"]):
                raise ApiError("JOURNAL_SOURCE_UNCONFIRMED", 422)
        return publication, event, link

    @staticmethod
    def origin(publication, event, journal):
        return {"publication_id": str(publication.id), "event_id": event["id"],
                "version_number": publication.snapshot["version_number"], "publication_revision": publication.snapshot["revision"],
                "context_id": str(journal.context_id), "group_id": str(journal.group_id), "subject_id": str(journal.subject_id),
                "semester": journal.semester, "timezone": publication.snapshot["timezone"],
                **{k: event[k] for k in ("date", "start", "end", "teacher_id", "teacher", "subject", "group", "room", "demand_id", "assignment_id", "assignment_revision", "calendar_id", "calendar_revision")}}

    def membership_rows(self, db, journal, context, on):
        return db.execute(select(Student, StudentMembership).join(StudentMembership, StudentMembership.student_id == Student.id)
            .where(Student.scope_id == context.scope_id, Student.data_kind == context.data_kind,
                   StudentMembership.context_id == context.id, StudentMembership.group_id == journal.group_id,
                   StudentMembership.start <= on, StudentMembership.end > on)
            .order_by(Student.display_name, Student.id)).all()

    @staticmethod
    def rows(db, lesson):
        return list(db.scalars(select(JournalLessonStudent).where(JournalLessonStudent.lesson_id == lesson.id)
                              .order_by(JournalLessonStudent.display_name, JournalLessonStudent.student_id)))

    @staticmethod
    def roster_dto(rows):
        return [{"student_id": str(r.student_id), "display_name": r.display_name, "active": r.active, "attendance": r.attendance, "grade": r.grade} for r in rows]

    def dto(self, db, lesson, permissions, grants):
        journal = db.get(Journal, lesson.journal_id)
        links = list(db.scalars(select(JournalEventLink).where(JournalEventLink.lesson_id == lesson.id)))
        current_links = [{"publication_id": str(link.publication_id), "event_id": str(link.event_id)} for link in links
                         if self.current(db, db.get(Publication, link.publication_id))]
        original_current = self.current(db, db.get(Publication, uuid.UUID(lesson.source["publication_id"])))
        return {"id": str(lesson.id), "journal_id": str(lesson.journal_id), "revision": lesson.revision,
                "registry_revision": self.catalog.revision(db, db.get(Group, journal.group_id).scope_id),
                "recorded": True, "source": lesson.source, "topic": lesson.topic,
                "students": self.roster_dto(self.rows(db, lesson)), "source_changed": not original_current,
                "current_links": current_links, "can_write": self.allowed(db, journal, grants, permissions, lesson.source["date"], True)}

    def mapping_required(self, db, journal, publication):
        # A prior fact in this profile is sufficient: never infer lesson identity by date/name.
        return any(r.source["publication_id"] != str(publication.id) for r in db.scalars(
            select(JournalLesson).where(JournalLesson.profile_key == publication.profile_key)))

    def preview(self, token, scope_id, journal_id, publication_id, event_id):
        with self.factory.begin() as db:
            _, grants, permissions = self.access(db, token, scope_id, "journal.catalog.read")
            journal, context = self.journal(db, journal_id, scope_id)
            publication, event, link = self.event(db, scope_id, journal, context, publication_id, event_id)
            if link and link.lesson_id:
                lesson, _, _ = self.require_lesson(db, scope_id, link.lesson_id, grants, permissions)
                return self.dto(db, lesson, permissions, grants)
            if not self.allowed(db, journal, grants, permissions, event["date"]):
                raise ApiError("ACCESS_DENIED", 403)
            if not self.current(db, publication):
                raise ApiError("JOURNAL_SOURCE_ARCHIVED", 409)
            rows = self.membership_rows(db, journal, context, date.fromisoformat(event["date"]))
            blocked = "JOURNAL_MAPPING_REQUIRED" if not link and self.mapping_required(db, journal, publication) else None
            ended = self.ended(event, publication.snapshot["timezone"])
            return {"id": None, "journal_id": str(journal.id), "revision": 0, "registry_revision": self.catalog.revision(db, scope_id),
                    "recorded": False, "source": self.origin(publication, event, journal), "topic": "",
                    "students": [{"student_id": str(s.id), "display_name": s.display_name, "active": True, "attendance": None, "grade": None} for s, _ in rows],
                    "source_changed": False, "current_links": [], "blocked": blocked or (None if ended else "JOURNAL_NOT_ENDED"),
                    "can_write": not blocked and ended and self.allowed(db, journal, grants, permissions, event["date"], True, event["teacher_id"])}

    @staticmethod
    def ended(event, timezone):
        try:
            return utc_interval(event, timezone)[1] <= datetime.now(UTC)
        except (ValueError, KeyError):
            raise ApiError("JOURNAL_SOURCE_UNCONFIRMED", 422) from None

    def get(self, token, scope_id, lesson_id):
        with self.factory.begin() as db:
            _, grants, permissions = self.access(db, token, scope_id, "journal.catalog.read")
            lesson, _, _ = self.require_lesson(db, scope_id, lesson_id, grants, permissions)
            return self.dto(db, lesson, permissions, grants)

    def list(self, token, scope_id, journal_id, offset=0, limit=50, admin=False, recorded_only=False):
        with self.factory.begin() as db:
            _, grants, permissions = self.access(db, token, scope_id, "journal.setup" if admin else "journal.catalog.read")
            journal, context = self.journal(db, journal_id, scope_id)
            if not admin and "journal.read" not in permissions and not self.catalog.own_assignments(db, journal.id, grants):
                raise ApiError("ACCESS_DENIED", 403)
            lessons = list(db.scalars(select(JournalLesson).where(JournalLesson.journal_id == journal.id)))
            result = []
            publications = db.scalars(select(Publication).join(PublicationHead, Publication.id == PublicationHead.publication_id)
                                      .where(Publication.context_id == context.id)).all()
            for publication in publications:
                for event in publication.snapshot["events"]:
                    if event["cancelled"] or event["group_id"] != str(journal.group_id) or event["semester"] != journal.semester:
                        continue
                    link = self.link(db, publication.id, event["id"])
                    if link and link.journal_id != journal.id:
                        continue
                    if link and link.lesson_id:
                        continue  # Recorded lesson appears once, with its original date.
                    demand = db.get(TeachingDemand, uuid.UUID(event["demand_id"]))
                    if not demand or demand.subject_id != journal.subject_id:
                        continue
                    if not admin and not self.allowed(db, journal, grants, permissions, event["date"]):
                        continue
                    blocked = None
                    try:
                        self.event(db, scope_id, journal, context, publication.id, event["id"])
                    except ApiError as problem:
                        blocked = problem.code
                    needs_mapping = not link and self.mapping_required(db, journal, publication)
                    result.append({"lesson_id": None, "publication_id": str(publication.id), "event_id": event["id"],
                                   "date": event["date"], "start": event["start"], "end": event["end"],
                                   "recorded": False, "needs_mapping": needs_mapping, "blocked": blocked})
            for lesson in lessons:
                if not admin and not self.allowed(db, journal, grants, permissions, lesson.source["date"]):
                    continue
                result.append({"lesson_id": str(lesson.id), "publication_id": lesson.source["publication_id"], "event_id": lesson.source["event_id"],
                               **{k: lesson.source[k] for k in ("date", "start", "end")}, "recorded": True, "needs_mapping": False, "blocked": None})
            result.sort(key=lambda r: (r["date"], r["start"], r["event_id"]), reverse=True)
            if recorded_only:
                result = [r for r in result if r["recorded"]]
            return {"items": result[offset:offset + limit], "total": len(result), "offset": offset, "limit": limit,
                    "registry_revision": self.catalog.revision(db, scope_id)}

    def command(self, token, scope_id, body, request_id, admin=False):
        # Omitted/empty grades have the v0008 fingerprint: outstanding old
        # operations must still replay their immutable pre-migration receipt.
        canonical = {**body, "command": dict(body["command"])}
        if not canonical["command"].get("grades"):
            canonical["command"].pop("grades", None)
        digest = input_token({"scope_id": str(scope_id), "admin": admin, **canonical})
        c = body["command"]
        with self.factory.begin() as db:
            user, grants, permissions = self.access(db, token, scope_id, "journal.setup" if admin else "journal.write.own", True)
            # Object-level permissions precede idempotency as well as revision checks.
            lesson = None
            if c.get("lesson_id"):
                lesson, journal, context = self.require_lesson(db, scope_id, c["lesson_id"], None if admin else grants, permissions, not admin)
            else:
                journal, context = self.journal(db, c["journal_id"], scope_id)
            publication = event = link = None
            if "publication_id" in c:
                if c.get("journal_id") and str(journal.id) != c["journal_id"]:
                    raise ApiError("ACCESS_DENIED", 403)
                publication, event, link = self.event(db, scope_id, journal, context, c["publication_id"], c["event_id"])
                if not admin:
                    check_date = lesson.source["date"] if lesson else event["date"]
                    if not self.allowed(db, journal, grants, permissions, check_date, True, event["teacher_id"]):
                        raise ApiError("ACCESS_DENIED", 403)
            old = db.scalar(select(JournalLessonOperation).where(JournalLessonOperation.scope_id == scope_id,
                JournalLessonOperation.actor_id == user.id, JournalLessonOperation.operation_id == uuid.UUID(body["operation_id"])))
            if old:
                if old.request_hash != digest:
                    raise ApiError("JOURNAL_OPERATION_CONFLICT", 409)
                return old.receipt
            if self.catalog.revision(db, scope_id) != body["expected_registry_revision"]:
                raise ApiError("JOURNAL_STALE", 409)
            if (lesson.revision if lesson else 0) != body["expected_revision"]:
                raise ApiError("JOURNAL_STALE", 409)
            if len({r["student_id"] for r in c.get("attendance", []) + c.get("grades", [])}) > 100:
                raise ApiError("JOURNAL_ROWS_LIMIT", 422)
            reason = c.get("reason", "").strip()
            before = self.fact_snapshot(db, lesson) if lesson else {}
            if admin:
                required(reason, "reason")
                if c["kind"] == "resolve_event":
                    if not self.current(db, publication):
                        raise ApiError("JOURNAL_SOURCE_ARCHIVED", 409)
                    if link:
                        raise ApiError("JOURNAL_EVENT_LINKED", 409)
                    db.add(JournalEventLink(publication_id=publication.id, event_id=uuid.UUID(event["id"]), journal_id=journal.id,
                                           lesson_id=lesson.id if lesson else None, decided_by=user.id, reason=reason))
                else:
                    self.correct_roster(db, lesson, journal, context, c["student_ids"])
                registry = db.get(JournalRegistry, scope_id)
                registry.revision += 1
                if lesson:
                    lesson.revision += 1
            elif c["kind"] == "record_lesson":
                if link and link.lesson_id:
                    raise ApiError("JOURNAL_EVENT_LINKED", 409)
                if not self.current(db, publication):
                    raise ApiError("JOURNAL_SOURCE_ARCHIVED", 409)
                if not link and self.mapping_required(db, journal, publication):
                    raise ApiError("JOURNAL_MAPPING_REQUIRED", 409)
                if not c["conducted"]:
                    raise ApiError("JOURNAL_CONFIRM_REQUIRED", 422, {"field": "conducted"})
                if not self.ended(event, publication.snapshot["timezone"]):
                    raise ApiError("JOURNAL_NOT_ENDED", 422)
                topic = self.topic(c["topic"])
                members = self.membership_rows(db, journal, context, date.fromisoformat(event["date"]))
                if not members:
                    raise ApiError("JOURNAL_ROSTER_EMPTY", 422)
                lesson = JournalLesson(journal_id=journal.id, profile_key=publication.profile_key,
                    source=self.origin(publication, event, journal), topic=topic, revision=1, created_by=user.id)
                db.add(lesson); db.flush()
                for student, membership in members:
                    db.add(JournalLessonStudent(lesson_id=lesson.id, student_id=student.id, display_name=student.display_name,
                                               membership=snapshot(membership), active=True, attendance=None))
                if link:
                    link.lesson_id = lesson.id
                else:
                    db.add(JournalEventLink(publication_id=publication.id, event_id=uuid.UUID(event["id"]), journal_id=journal.id,
                                           lesson_id=lesson.id, decided_by=user.id, reason=""))
                db.flush()
                self.attendance(db, lesson, c["attendance"], reason)
                self.grades(db, lesson, c.get("grades", []), reason)
            else:
                if c["topic"] is not None:
                    topic = self.topic(c["topic"])
                    if lesson.topic != topic:
                        required(reason, "reason")
                        lesson.topic = topic
                self.attendance(db, lesson, c["attendance"], reason)
                self.grades(db, lesson, c.get("grades", []), reason)
                lesson.revision += 1
            db.flush()
            after = self.fact_snapshot(db, lesson) if lesson else {"new_event": {"publication_id": str(publication.id), "event_id": event["id"]}}
            if c["kind"] == "resolve_event":
                after = {**after, "link": {"publication_id": str(publication.id), "event_id": event["id"]}}
            receipt = {"lesson_id": str(lesson.id) if lesson else None, "revision": lesson.revision if lesson else 0,
                       "registry_revision": self.catalog.revision(db, scope_id), "kind": c["kind"]}
            db.add(JournalLessonChange(scope_id=scope_id, lesson_id=lesson.id if lesson else None, actor_id=user.id,
                action=c["kind"], revision=receipt["revision"], before=before, after=after, reason=reason))
            db.add(JournalLessonOperation(scope_id=scope_id, actor_id=user.id, operation_id=uuid.UUID(body["operation_id"]), request_hash=digest, receipt=receipt))
            audit(db, "journal.lesson", "saved", request_id, user.id)
            return receipt

    @staticmethod
    def topic(value):
        try:
            return topic_value(value)
        except ValueError as e:
            raise ApiError(str(e), 422, {"field": "topic"}) from None

    def attendance(self, db, lesson, changes, reason):
        rows = {str(r.student_id): r for r in self.rows(db, lesson)}
        if len({c["student_id"] for c in changes}) != len(changes):
            raise ApiError("JOURNAL_ROWS_DUPLICATE", 422)
        for change in changes:
            row = rows.get(change["student_id"])
            if not row or not row.active:
                raise ApiError("ACCESS_DENIED", 403)
            try:
                correction = attendance_change(row.attendance, change["value"])
            except ValueError as e:
                raise ApiError(str(e), 422) from None
            if correction:
                required(reason, "reason")
            row.attendance = change["value"]

    def grades(self, db, lesson, changes, reason):
        rows = {str(r.student_id): r for r in self.rows(db, lesson)}
        if len({c["student_id"] for c in changes}) != len(changes):
            raise ApiError("JOURNAL_ROWS_DUPLICATE", 422)
        for change in changes:
            row = rows.get(change["student_id"])
            if not row or not row.active:
                raise ApiError("ACCESS_DENIED", 403)
            try:
                correction = grade_change(row.grade, change["value"])
            except ValueError as e:
                raise ApiError(str(e), 422, {"field": f"grade-{row.student_id}"}) from None
            if correction:
                required(reason, "reason")
            row.grade = change["value"]

    def correct_roster(self, db, lesson, journal, context, ids):
        if len(set(ids)) != len(ids) or not ids:
            raise ApiError("JOURNAL_ROSTER_INVALID", 422)
        rows = {str(r.student_id): r for r in self.rows(db, lesson)}
        members = {str(s.id): (s, m) for s, m in self.membership_rows(db, journal, context, date.fromisoformat(lesson.source["date"]))}
        for sid in ids:
            if sid not in rows:
                if sid not in members:
                    raise ApiError("JOURNAL_MEMBERSHIP_REQUIRED", 422)
                student, membership = members[sid]
                db.add(JournalLessonStudent(lesson_id=lesson.id, student_id=student.id, display_name=student.display_name,
                                           membership=snapshot(membership), active=True, attendance=None))
        for sid, row in rows.items():
            row.active = sid in ids  # Attendance and membership snapshots survive removal.

    def fact_snapshot(self, db, lesson):
        return {"lesson": snapshot(lesson), "students": [snapshot(r) for r in self.rows(db, lesson)]}

    def history(self, token, scope_id, lesson_id, offset=0):
        with self.factory.begin() as db:
            _, grants, permissions = self.access(db, token, scope_id, "journal.catalog.read")
            lesson, _, _ = self.require_lesson(db, scope_id, lesson_id, grants, permissions)
            rows = db.scalars(select(JournalLessonChange).where(JournalLessonChange.lesson_id == lesson.id)
                .order_by(JournalLessonChange.created_at.desc(), JournalLessonChange.id).offset(offset).limit(51)).all()
            return {"items": [{**snapshot(r), "created_at": r.created_at.astimezone(UTC).isoformat(),
                               "actor_name": db.get(User, r.actor_id).display_name} for r in rows[:50]],
                    "next_offset": offset + 50 if len(rows) > 50 else None}

    def admin_roster(self, token, scope_id, lesson_id):
        with self.factory.begin() as db:
            self.access(db, token, scope_id, "journal.setup")
            lesson, journal, context = self.require_lesson(db, scope_id, lesson_id)
            rows = self.rows(db, lesson)
            # Admin receives only identity/setup fields, never attendance, topic or fact history.
            candidates = {str(s.id): s.display_name for s, _ in self.membership_rows(db, journal, context, date.fromisoformat(lesson.source["date"]))}
            candidates.update({str(r.student_id): r.display_name for r in rows})
            return {"lesson_id": str(lesson.id), "revision": lesson.revision, "registry_revision": self.catalog.revision(db, scope_id),
                    "date": lesson.source["date"], "students": [{"student_id": sid, "display_name": name,
                    "active": any(str(r.student_id) == sid and r.active for r in rows)} for sid, name in sorted(candidates.items())]}

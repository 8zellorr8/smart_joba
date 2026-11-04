"""A private read projection over saved facts, including inactive roster rows.

The shared scope lock serializes this read with all journal/catalog writers.
No current group or publication-head join: past facts retain their identity.
"""
import hashlib
import json

from sqlalchemy import select

from .auth import ApiError
from .journal_setup import JournalSetupService
from ..infrastructure.journal_models import Journal
from ..infrastructure.lesson_models import JournalLesson, JournalLessonStudent
from ..infrastructure.models import Group, ImportContext, Subject


class StudentResultsService:
    def __init__(self, factory, auth):
        self.factory = factory
        self.catalog = JournalSetupService(factory, auth)

    def read(self, token, scope_id, context_id=None, semester=None, subject_id=None,
             page=1, page_size=20, revision=None):
        with self.factory.begin() as db:
            student = self.catalog.personal_student(db, token, scope_id)
            if (context_id is None) != (semester is None):
                raise ApiError("VALIDATION_ERROR", 422)
            # Restrict in SQL before constructing any response. The immutable
            # membership snapshot is the historical authorization evidence.
            source, member = JournalLesson.source, JournalLessonStudent.membership
            query = (select(JournalLesson, JournalLessonStudent, Journal, ImportContext)
                .join(JournalLessonStudent, JournalLessonStudent.lesson_id == JournalLesson.id)
                .join(Journal, Journal.id == JournalLesson.journal_id)
                .join(ImportContext, ImportContext.id == Journal.context_id)
                .join(Group, Group.id == Journal.group_id)
                .join(Subject, Subject.id == Journal.subject_id)
                .where(JournalLessonStudent.student_id == student.id,
                       ImportContext.scope_id == scope_id, ImportContext.data_kind == student.data_kind,
                       Group.scope_id == scope_id, Group.data_kind == student.data_kind,
                       Subject.scope_id == scope_id, Subject.data_kind == student.data_kind,
                       source["context_id"].astext == member["context_id"].astext,
                       source["group_id"].astext == member["group_id"].astext,
                       member["student_id"].astext == str(student.id),
                       member["start"].astext <= source["date"].astext,
                       member["end"].astext > source["date"].astext)
                .order_by(source["date"].astext.desc(), source["start"].astext.desc(), JournalLesson.id.desc()))
            rows = db.execute(query).all()
            periods, subjects, items = {}, {}, []
            for lesson, own, journal, context in rows:
                s = lesson.source
                # A corrupted academic link must never widen access.
                if (s["context_id"] != str(context.id) or s["group_id"] != str(journal.group_id)
                        or s["subject_id"] != str(journal.subject_id) or s["semester"] != journal.semester):
                    raise ApiError("ACCESS_DENIED", 403)
                periods[(str(context.id), journal.semester)] = {
                    "context_id": str(context.id), "semester": journal.semester,
                    "academic_year": context.academic_year}
                subjects[str(journal.subject_id)] = {"id": str(journal.subject_id), "name": s["subject"]}
                if context_id is not None and (context.id != context_id or journal.semester != semester):
                    continue
                if subject_id is not None and journal.subject_id != subject_id:
                    continue
                # Whitelist only. Do not serialize lesson DTOs, peer rows,
                # membership evidence, audit reasons, or authors to a student.
                items.append({"id": str(lesson.id), "revision": lesson.revision,
                              "date": s["date"], "start": s["start"], "end": s["end"], "timezone": s["timezone"],
                              "subject": s["subject"], "group": s["group"],
                              "academic_year": context.academic_year, "semester": journal.semester,
                              "topic": lesson.topic, "grade": own.grade, "attendance": own.attendance,
                              "active": own.active})
            if ((context_id is not None and (str(context_id), semester) not in periods)
                    or (subject_id is not None and str(subject_id) not in subjects)):
                raise ApiError("ACCESS_DENIED", 403)
            identity = [str(scope_id), str(student.id), self.catalog.revision(db, scope_id),
                        str(context_id), semester, str(subject_id), page_size, items]
            current = hashlib.sha256(json.dumps(identity, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
            if (page > 1 and not revision) or (revision is not None and revision != current):
                raise ApiError("JOURNAL_RESULTS_STALE", 409)
            start = (page - 1) * page_size
            if page > 1 and start >= len(items):
                raise ApiError("VALIDATION_ERROR", 422)
            return {**self.catalog.personal_profile(db, student), "revision": current,
                    "periods": sorted(periods.values(), key=lambda p: (p["academic_year"], p["semester"], p["context_id"]), reverse=True),
                    "subjects": sorted(subjects.values(), key=lambda s: (s["name"], s["id"])),
                    "items": items[start:start + page_size], "page": page,
                    "has_next": start + page_size < len(items)}

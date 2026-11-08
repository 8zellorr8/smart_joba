"""A private, revision-stable read projection over saved student facts."""
import hashlib
import json

from sqlalchemy import String, cast, func, select

from .auth import ApiError
from .journal_setup import JournalSetupService
from ..infrastructure.journal_models import Journal, JournalRegistry
from ..infrastructure.lesson_models import JournalLesson, JournalLessonStudent
from ..infrastructure.models import Group, ImportContext, Subject


class StudentResultsService:
    def __init__(self, factory, auth):
        self.factory = factory
        self.catalog = JournalSetupService(factory, auth)

    @staticmethod
    def owned_rows(student, scope_id):
        source, member = JournalLesson.source, JournalLessonStudent.membership
        return (select(JournalLesson.id.label("id"), JournalLesson.revision.label("revision"),
                       source["date"].astext.label("date"), source["start"].astext.label("start"),
                       source["end"].astext.label("end"), source["timezone"].astext.label("timezone"),
                       source["subject"].astext.label("subject"), source["group"].astext.label("group"),
                       JournalLesson.topic.label("topic"),
                       JournalLessonStudent.grade.label("grade"), JournalLessonStudent.attendance.label("attendance"),
                       JournalLessonStudent.active.label("active"), Journal.semester.label("semester"),
                       Journal.group_id.label("group_id"), Journal.subject_id.label("subject_id"),
                       ImportContext.id.label("context_id"), ImportContext.academic_year.label("academic_year"))
            .select_from(JournalLesson)
            .join(JournalLessonStudent, JournalLessonStudent.lesson_id == JournalLesson.id)
            .join(Journal, Journal.id == JournalLesson.journal_id)
            .join(ImportContext, ImportContext.id == Journal.context_id)
            .join(Group, Group.id == Journal.group_id)
            .join(Subject, Subject.id == Journal.subject_id)
            .where(JournalLessonStudent.student_id == student.id,
                   ImportContext.scope_id == scope_id, ImportContext.data_kind == student.data_kind,
                   Group.scope_id == scope_id, Group.data_kind == student.data_kind,
                   Subject.scope_id == scope_id, Subject.data_kind == student.data_kind,
                   member["context_id"].astext == cast(ImportContext.id, String),
                   member["group_id"].astext == cast(Journal.group_id, String),
                   source["context_id"].astext == cast(ImportContext.id, String),
                   source["group_id"].astext == cast(Journal.group_id, String),
                   source["subject_id"].astext == cast(Journal.subject_id, String),
                   source["semester"].astext == cast(Journal.semester, String),
                   source["context_id"].astext == member["context_id"].astext,
                   source["group_id"].astext == member["group_id"].astext,
                   member["student_id"].astext == str(student.id),
                   member["start"].astext <= source["date"].astext,
                   member["end"].astext > source["date"].astext))

    def read(self, token, scope_id, context_id=None, semester=None, subject_id=None,
             page=1, page_size=20, revision=None):
        with self.factory.begin() as db:
            student = self.catalog.personal_student(db, token, scope_id)
            if (context_id is None) != (semester is None):
                raise ApiError("VALIDATION_ERROR", 422)

            owned = self.owned_rows(student, scope_id).subquery()
            periods = db.execute(select(owned.c.context_id, owned.c.semester, owned.c.academic_year).distinct()).all()
            subjects = db.execute(select(func.max(owned.c.subject).label("name"),
                                         cast(Subject.id, String).label("id"))
                                  .select_from(owned.join(Subject, Subject.id == owned.c.subject_id))
                                  .group_by(Subject.id)
                                  .order_by("name", "id")).all()
            period_keys = {(str(row.context_id), row.semester) for row in periods}
            subject_ids = {row.id for row in subjects}
            if ((context_id is not None and (str(context_id), semester) not in period_keys)
                    or (subject_id is not None and str(subject_id) not in subject_ids)):
                raise ApiError("ACCESS_DENIED", 403)

            registry = db.get(JournalRegistry, scope_id)
            current = hashlib.sha256(json.dumps(
                [str(scope_id), str(student.id), registry.revision if registry else 0,
                 registry.results_revision if registry else 0, str(context_id), semester,
                 str(subject_id), page_size], separators=(",", ":")).encode()).hexdigest()
            if (page > 1 and not revision) or (revision is not None and revision != current):
                raise ApiError("JOURNAL_RESULTS_STALE", 409)

            rows_query = select(owned)
            if context_id is not None:
                rows_query = rows_query.where(owned.c.context_id == context_id, owned.c.semester == semester)
            if subject_id is not None:
                rows_query = rows_query.where(owned.c.subject_id == subject_id)
            rows = db.execute(rows_query.order_by(owned.c.date.desc(), owned.c.start.desc(), owned.c.id.desc())
                              .offset((page - 1) * page_size).limit(page_size + 1)).mappings().all()
            if page > 1 and not rows:
                raise ApiError("VALIDATION_ERROR", 422)

            items = []
            for row in rows[:page_size]:
                items.append({"id": str(row["id"]), "revision": row["revision"],
                              "date": row["date"], "start": row["start"], "end": row["end"],
                              "timezone": row["timezone"], "subject": row["subject"], "group": row["group"],
                              "academic_year": row["academic_year"], "semester": row["semester"],
                              "topic": row["topic"], "grade": row["grade"],
                              "attendance": row["attendance"], "active": row["active"]})

            return {**self.catalog.personal_profile(db, student), "revision": current,
                    "periods": sorted(({"context_id": str(p.context_id), "semester": p.semester,
                                         "academic_year": p.academic_year} for p in periods),
                                       key=lambda p: (p["academic_year"], p["semester"], p["context_id"]), reverse=True),
                    "subjects": [{"id": row.id, "name": row.name} for row in subjects],
                    "items": items, "page": page, "has_next": len(rows) > page_size}

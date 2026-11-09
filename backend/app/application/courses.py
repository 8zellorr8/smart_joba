"""Course visibility follows current, confirmed academic links, not lesson history."""
import uuid

from sqlalchemy import Date, and_, cast, desc, false, func, or_, select
from sqlalchemy.orm import aliased

from .auth import ApiError
from .journal_setup import JournalSetupService
from ..infrastructure.course_models import Course, CourseMaterial, CourseTopic
from ..infrastructure.task_models import CourseTask, CourseTaskRevision
from ..infrastructure.journal_models import Journal, JournalAssignment, Student, StudentMembership
from ..infrastructure.models import CalendarProfile, Group, ImportContext, Subject, Teacher

MAX_PDF_BYTES = 5 * 1024 * 1024


class CourseService:
    def __init__(self, factory, auth):
        self.factory = factory
        self.catalog = JournalSetupService(factory, auth)

    def accessible(self, db, token, scope_id, write=False, *, student_only=False, lock_write=False):
        action = "course.submit" if student_only else ("course.manage" if write else "course.read")
        user, grants, _ = self.catalog.access(db, token, scope_id, action, write=write or lock_write)
        teacher_ids = [uuid.UUID(g["teacher_id"]) for g in grants if g["role"] == "teacher" and g["teacher_id"]]
        students = [g for g in grants if g["role"] == "student" and g["student_id"] and g["group_id"]]
        today = cast(func.timezone(CalendarProfile.document["timezone"].astext, func.statement_timestamp()), Date)
        manages = (select(JournalAssignment.id).join(Teacher, Teacher.id == JournalAssignment.teacher_id)
            .where(JournalAssignment.journal_id == Journal.id, Teacher.id.in_(teacher_ids),
                   Teacher.scope_id == scope_id, Teacher.data_kind == ImportContext.data_kind, JournalAssignment.active.is_(True),
                   JournalAssignment.start <= today, today < JournalAssignment.end)
            .correlate(Journal, CalendarProfile, ImportContext).exists())
        visible = false() if student_only else manages
        if students and not write:
            # Role grants are unique per role and scope.
            grant = students[0]
            enrolled = (select(StudentMembership.id).join(Student, Student.id == StudentMembership.student_id)
                .where(Student.id == uuid.UUID(grant["student_id"]), Student.scope_id == scope_id,
                       Student.data_kind == ImportContext.data_kind, StudentMembership.group_id == uuid.UUID(grant["group_id"]),
                       StudentMembership.group_id == Journal.group_id, StudentMembership.context_id == Journal.context_id,
                       StudentMembership.start <= today, today < StudentMembership.end)
                .correlate(Journal, CalendarProfile, ImportContext).exists())
            visible = enrolled if student_only else or_(manages, and_(Course.journal_id.is_not(None), enrolled))
        query = (select(Journal.id.label("id"), Subject.name.label("subject"), Group.code.label("group"),
                        ImportContext.academic_year, ImportContext.data_kind, Journal.semester, manages.label("can_manage"),
                        CalendarProfile.document["timezone"].astext.label("timezone"),
                        Course.journal_id.is_not(None).label("opened"))
            .join(ImportContext, ImportContext.id == Journal.context_id)
            .join(Group, Group.id == Journal.group_id).join(Subject, Subject.id == Journal.subject_id)
            .join(CalendarProfile, and_(CalendarProfile.context_id == Journal.context_id,
                                        CalendarProfile.group_id == Journal.group_id))
            .outerjoin(Course, Course.journal_id == Journal.id)
            .where(ImportContext.scope_id == scope_id, Group.scope_id == scope_id, Subject.scope_id == scope_id,
                   Group.data_kind == ImportContext.data_kind, Subject.data_kind == ImportContext.data_kind,
                   CalendarProfile.document["timezone_confirmed"].as_boolean().is_(True), visible))
        return user, query

    def require(self, db, token, scope_id, course_id, *, write=False, opening=False, student_only=False, lock_write=False):
        user, query = self.accessible(db, token, scope_id, write, student_only=student_only, lock_write=lock_write)
        row = db.execute(query.where(Journal.id == course_id)).mappings().one_or_none()
        if row is None or (not opening and not row["opened"]):
            raise ApiError("ACCESS_DENIED", 403)
        return user, row

    def courses(self, token, scope_id):
        with self.factory.begin() as db:
            _, query = self.accessible(db, token, scope_id)
            return db.execute(query.order_by(Subject.name, Group.code, Journal.semester, Journal.id)).mappings().all()

    def open_course(self, token, scope_id, course_id):
        with self.factory.begin() as db:
            user, row = self.require(db, token, scope_id, course_id, write=True, opening=True)
            if not row["opened"]:
                db.add(Course(journal_id=course_id, created_by=user.id))
            return {"id": course_id}

    def contents(self, token, scope_id, course_id):
        with self.factory.begin() as db:
            _, course = self.require(db, token, scope_id, course_id)
            topics = {
                t.id: {
                    "id": t.id,
                    "title": t.title,
                    "week_number": t.week_number,
                    "materials": [],
                    "tasks": [],
                }
                for t in db.scalars(
                    select(CourseTopic)
                    .where(CourseTopic.journal_id == course_id)
                    .order_by(CourseTopic.created_at, CourseTopic.id)
                )
            }
            query = (select(CourseMaterial.id, CourseMaterial.topic_id, CourseMaterial.title,
                            CourseMaterial.body.is_(None).label("is_pdf"))
                     .join(CourseTopic).where(CourseTopic.journal_id == course_id)
                     .order_by(CourseMaterial.created_at, CourseMaterial.id))
            for item in db.execute(query):
                topics[item.topic_id]["materials"].append({"id": item.id, "title": item.title,
                                                          "kind": "pdf" if item.is_pdf else "text"})
            task_version = aliased(CourseTaskRevision)
            latest_revision = (select(task_version.id)
                .where(task_version.task_id == CourseTask.id)
                .order_by(desc(task_version.revision)).limit(1).correlate(CourseTask).scalar_subquery())
            task_query = (select(CourseTask.topic_id, CourseTask.id, CourseTaskRevision.title,
                                 CourseTaskRevision.due_on, CourseTaskRevision.revision)
                .join(CourseTopic).join(CourseTaskRevision, CourseTaskRevision.id == latest_revision)
                .where(CourseTopic.journal_id == course_id).order_by(CourseTask.created_at, CourseTask.id))
            for task in db.execute(task_query):
                topics[task.topic_id]["tasks"].append({"id": task.id, "title": task.title,
                    "due_on": task.due_on, "revision": task.revision})
            return {"course": dict(course), "topics": list(topics.values())}

    def add_topic(self, token, scope_id, course_id, topic_id, title, week_number=None):
        with self.factory.begin() as db:
            self.require(db, token, scope_id, course_id, write=True)
            existing = db.get(CourseTopic, topic_id)
            if existing is None:
                db.add(CourseTopic(
                    id=topic_id,
                    journal_id=course_id,
                    title=title,
                    week_number=week_number,
                ))
            elif (existing.journal_id, existing.title, existing.week_number) != (
                course_id,
                title,
                week_number,
            ):
                raise ApiError("COURSE_OPERATION_CONFLICT", 409)
            return {"id": topic_id}

    def add_material(self, token, scope_id, course_id, topic_id, material_id, title, text, pdf):
        with self.factory.begin() as db:
            self.require(db, token, scope_id, course_id, write=True)
            topic = db.get(CourseTopic, topic_id)
            if not topic or topic.journal_id != course_id:
                raise ApiError("ACCESS_DENIED", 403)
            existing = db.get(CourseMaterial, material_id)
            if existing is None:
                db.add(CourseMaterial(id=material_id, topic_id=topic_id, title=title, body=text, pdf=pdf))
            elif (existing.topic_id, existing.title, existing.body, existing.pdf) != (topic_id, title, text, pdf):
                raise ApiError("COURSE_OPERATION_CONFLICT", 409)
            return {"id": material_id}

    def material(self, token, scope_id, course_id, material_id):
        with self.factory.begin() as db:
            self.require(db, token, scope_id, course_id)
            material = db.scalar(select(CourseMaterial).join(CourseTopic)
                .where(CourseMaterial.id == material_id, CourseTopic.journal_id == course_id))
            if material is None:
                raise ApiError("ACCESS_DENIED", 403)
            return material.title, material.body, material.pdf

    def material_for_edit(self, token, scope_id, course_id, material_id):
        with self.factory.begin() as db:
            self.require(db, token, scope_id, course_id, write=True)
            material = db.execute(select(CourseMaterial.id, CourseMaterial.title, CourseMaterial.body,
                CourseMaterial.body.is_(None).label("is_pdf"), CourseMaterial.revision)
                .join(CourseTopic).where(CourseMaterial.id == material_id,
                    CourseTopic.journal_id == course_id)).mappings().one_or_none()
            if material is None:
                raise ApiError("ACCESS_DENIED", 403)
            return {"id": material["id"], "title": material["title"], "kind": "pdf" if material["is_pdf"] else "text",
                    "text": material["body"], "revision": material["revision"]}

    def update_material(self, token, scope_id, course_id, material_id, expected_revision, title, text, pdf):
        with self.factory.begin() as db:
            self.require(db, token, scope_id, course_id, write=True)
            material = db.scalar(select(CourseMaterial).join(CourseTopic)
                .where(CourseMaterial.id == material_id, CourseTopic.journal_id == course_id))
            if material is None:
                raise ApiError("ACCESS_DENIED", 403)
            body, file = (text, None) if text is not None else ((None, pdf) if pdf is not None else (material.body, material.pdf))
            if material.revision != expected_revision:
                if material.revision == expected_revision + 1 and (material.title, material.body, material.pdf) == (title, body, file):
                    return {"id": material_id, "revision": material.revision}
                raise ApiError("COURSE_MATERIAL_STALE", 409)
            if (material.title, material.body, material.pdf) != (title, body, file):
                material.title, material.body, material.pdf = title, body, file
                material.revision += 1
            return {"id": material_id, "revision": material.revision}

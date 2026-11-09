"""Task condition revisions, submissions and reviews are append-only."""
import uuid
from datetime import datetime
from zoneinfo import ZoneInfo

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import aliased
from .auth import ApiError
from ..infrastructure.course_models import CourseTopic
from ..infrastructure.journal_models import Student
from ..infrastructure.task_models import CourseReview, CourseSubmission, CourseTask, CourseTaskRevision


class CourseTaskService:
    def __init__(self, courses):
        self.courses, self.factory = courses, courses.factory

    def context(self, db, token, scope, course, task_id, *, teacher=False, student=False, write=False):
        user, course_row = self.courses.require(db, token, scope, course, write=teacher,
                                              student_only=student, lock_write=write)
        task = db.scalar(select(CourseTask).join(CourseTopic).where(
            CourseTask.id == task_id, CourseTopic.journal_id == course))
        if task is None:
            raise ApiError("ACCESS_DENIED", 403)
        return user, course_row, task

    def student_id(self, db, user, scope):
        grants = self.courses.catalog.auth.grants(db, user.id)
        grant = next((g for g in grants if g["scope_id"] == str(scope) and g["role"] == "student" and g["student_id"]), None)
        if not grant:
            raise ApiError("ACCESS_DENIED", 403)
        return uuid.UUID(grant["student_id"])

    @staticmethod
    def latest_revision(db, task_id):
        return db.scalar(select(CourseTaskRevision).where(CourseTaskRevision.task_id == task_id)
            .order_by(CourseTaskRevision.revision.desc()).limit(1))

    @staticmethod
    def task_dto(task_id, version):
        return {"id": task_id, "title": version.title, "instructions": version.instructions,
                "due_on": version.due_on, "timezone": version.timezone, "revision": version.revision}

    @staticmethod
    def last_review(db, submission):
        return db.scalar(select(CourseReview).where(CourseReview.submission_id == submission.id)
                         .order_by(CourseReview.revision.desc()).limit(1))

    @staticmethod
    def last_attempt(db, task_id, student_id):
        return db.scalar(select(CourseSubmission).where(CourseSubmission.task_id == task_id,
            CourseSubmission.student_id == student_id).order_by(CourseSubmission.attempt.desc()).limit(1))

    @staticmethod
    def review_dto(review, teacher):
        if not review:
            return None
        result = {"revision": review.revision, "outcome": review.outcome, "grade": review.grade,
                  "feedback": review.feedback, "created_at": review.created_at}
        if teacher:
            result["reason"] = review.reason
        return result

    def submission_dto(self, db, row, task, teacher, *, full=False):
        review = self.last_review(db, row)
        version = db.get(CourseTaskRevision, row.task_revision_id)
        result = {"id": row.id, "student_name": row.student_name, "attempt": row.attempt,
                  "submitted_at": row.submitted_at, "kind": "pdf" if row.body is None else "text",
                  "late": bool(version.due_on and row.submitted_at.astimezone(ZoneInfo(version.timezone)).date() > version.due_on),
                  "task_revision": version.revision,
                  "review": self.review_dto(review, teacher)}
        if full:
            result["text"] = row.body
            result["conditions"] = self.task_dto(task.id, version)
            result["reviews"] = [self.review_dto(r, teacher) for r in db.scalars(select(CourseReview)
                .where(CourseReview.submission_id == row.id).order_by(CourseReview.revision.desc()))]
        return result

    def create(self, token, scope, course, body):
        with self.factory.begin() as db:
            user, row = self.courses.require(db, token, scope, course, write=True)
            topic = db.get(CourseTopic, body["topic_id"])
            if topic is None or topic.journal_id != course:
                raise ApiError("ACCESS_DENIED", 403)
            existing = db.get(CourseTask, body["id"])
            values = {k: body[k] for k in ("topic_id", "title", "instructions", "due_on")}
            version_values = {k: body[k] for k in ("title", "instructions", "due_on")}
            if existing:
                version = db.scalar(select(CourseTaskRevision).where(
                    CourseTaskRevision.task_id == existing.id, CourseTaskRevision.revision == 1))
                if existing.created_by != user.id or not version or any(getattr(version, k) != v for k, v in version_values.items()):
                    raise ApiError("COURSE_OPERATION_CONFLICT", 409)
            else:
                db.add(CourseTask(id=body["id"], timezone=row["timezone"], created_by=user.id, **values))
                db.add(CourseTaskRevision(id=uuid.uuid4(), task_id=body["id"], revision=1,
                    timezone=row["timezone"], created_by=user.id, **version_values))
            return {"id": body["id"]}

    def update(self, token, scope, course, task_id, body):
        with self.factory.begin() as db:
            user, _, task = self.context(db, token, scope, course, task_id, teacher=True, write=True)
            current = self.latest_revision(db, task_id)
            values = {k: body[k] for k in ("title", "instructions", "due_on")}
            existing = db.get(CourseTaskRevision, body["id"])
            if existing:
                if (existing.task_id != task_id or existing.created_by != user.id or
                    existing.revision != body["expected_revision"] + 1 or
                    any(getattr(existing, k) != v for k, v in values.items())):
                    raise ApiError("COURSE_OPERATION_CONFLICT", 409)
                return {"id": task_id, "revision": existing.revision}
            if current.revision != body["expected_revision"]:
                raise ApiError("TASK_STALE", 409)
            if all(getattr(current, key) == value for key, value in values.items()):
                return {"id": task_id, "revision": current.revision}
            db.add(CourseTaskRevision(id=body["id"], task_id=task.id, revision=current.revision + 1,
                timezone=current.timezone, created_by=user.id, **values))
            return {"id": task_id, "revision": current.revision + 1}

    def details(self, token, scope, course, task_id):
        with self.factory.begin() as db:
            user, row, task = self.context(db, token, scope, course, task_id)
            version = self.latest_revision(db, task_id)
            attempts = []
            if not row["can_manage"]:
                student_id = self.student_id(db, user, scope)
                attempts = [self.submission_dto(db, a, task, False, full=True) for a in db.scalars(select(CourseSubmission)
                    .where(CourseSubmission.task_id == task_id, CourseSubmission.student_id == student_id)
                    .order_by(CourseSubmission.attempt.desc()))]
            return {"task": self.task_dto(task_id, version), "can_manage": row["can_manage"], "attempts": attempts}

    def submissions(self, token, scope, course, task_id, after=None):
        with self.factory.begin() as db:
            _, _, task = self.context(db, token, scope, course, task_id, teacher=True)
            newer = aliased(CourseSubmission)
            query = select(CourseSubmission).where(CourseSubmission.task_id == task_id,
                ~select(newer.id).where(newer.task_id == task_id, newer.student_id == CourseSubmission.student_id,
                                       newer.attempt > CourseSubmission.attempt).exists())
            if after:
                query = query.where(CourseSubmission.student_id > after)
            rows = db.scalars(query.order_by(CourseSubmission.student_id).limit(26)).all()
            return {"items": [self.submission_dto(db, a, task, True) for a in rows[:25]],
                    "next": str(rows[24].student_id) if len(rows) > 25 else None}

    def pending(self, token, scope, after_at: datetime | None = None, after_id: uuid.UUID | None = None, limit=25):
        if (after_at is None) != (after_id is None):
            raise ApiError("VALIDATION_ERROR", 422)
        with self.factory.begin() as db:
            self.courses.catalog.access(db, token, scope, "course.manage")
            _, visible = self.courses.accessible(db, token, scope)
            visible = visible.subquery()
            reviewed = select(CourseReview.id).where(CourseReview.submission_id == CourseSubmission.id).exists()
            query = (select(CourseSubmission.id, CourseSubmission.task_id, CourseSubmission.student_name,
                            CourseSubmission.submitted_at, CourseSubmission.attempt, CourseTaskRevision.title,
                            visible.c.id.label("course_id"), visible.c.subject, visible.c.group,
                            visible.c.data_kind, visible.c.timezone)
                .join(CourseTask, CourseTask.id == CourseSubmission.task_id)
                .join(CourseTopic, CourseTopic.id == CourseTask.topic_id)
                .join(visible, visible.c.id == CourseTopic.journal_id)
                .join(CourseTaskRevision, CourseTaskRevision.id == CourseSubmission.task_revision_id)
                .where(visible.c.can_manage.is_(True), visible.c.opened.is_(True), ~reviewed))
            if after_at:
                query = query.where(or_(CourseSubmission.submitted_at > after_at,
                    and_(CourseSubmission.submitted_at == after_at, CourseSubmission.id > after_id)))
            rows = db.execute(query.order_by(CourseSubmission.submitted_at, CourseSubmission.id).limit(limit + 1)).mappings().all()
            items = [dict(row) for row in rows[:limit]]
            return {"items": items, "next": {"at": rows[limit - 1]["submitted_at"], "id": rows[limit - 1]["id"]} if len(rows) > limit else None}

    def student_attempts(self, token, scope, course, task_id, submission_id):
        with self.factory.begin() as db:
            user, row, task = self.context(db, token, scope, course, task_id)
            submission = db.get(CourseSubmission, submission_id)
            if not submission or submission.task_id != task_id:
                raise ApiError("ACCESS_DENIED", 403)
            if not row["can_manage"] and submission.student_id != self.student_id(db, user, scope):
                raise ApiError("ACCESS_DENIED", 403)
            return {"attempts": [self.submission_dto(db, a, task, row["can_manage"], full=True)
                for a in db.scalars(select(CourseSubmission).where(CourseSubmission.task_id == task_id,
                    CourseSubmission.student_id == submission.student_id).order_by(CourseSubmission.attempt.desc()))]}

    def submit(self, token, scope, course, task_id, operation_id, expected_attempt, text, pdf):
        with self.factory.begin() as db:
            user, _, _ = self.context(db, token, scope, course, task_id, student=True, write=True)
            student_id = self.student_id(db, user, scope)
            existing = db.get(CourseSubmission, operation_id)
            if existing:
                if (existing.task_id, existing.student_id, existing.attempt, existing.body, existing.pdf) != (
                        task_id, student_id, expected_attempt + 1, text, pdf):
                    raise ApiError("COURSE_OPERATION_CONFLICT", 409)
                return {"id": existing.id, "attempt": existing.attempt}
            previous = self.last_attempt(db, task_id, student_id)
            version = self.latest_revision(db, task_id)
            if (previous.attempt if previous else 0) != expected_attempt:
                raise ApiError("TASK_STALE", 409)
            if previous:
                review = self.last_review(db, previous)
                if previous.task_revision_id == version.id and (not review or review.outcome != "returned"):
                    raise ApiError("TASK_ALREADY_SUBMITTED", 409)
            student = db.get(Student, student_id)
            db.add(CourseSubmission(id=operation_id, task_id=task_id, task_revision_id=version.id, student_id=student_id,
                student_name=student.display_name, attempt=expected_attempt + 1, body=text, pdf=pdf))
            return {"id": operation_id, "attempt": expected_attempt + 1}

    def review(self, token, scope, course, task_id, submission_id, body):
        with self.factory.begin() as db:
            user, _, _ = self.context(db, token, scope, course, task_id, teacher=True)
            submission = db.get(CourseSubmission, submission_id)
            if not submission or submission.task_id != task_id:
                raise ApiError("ACCESS_DENIED", 403)
            values = {k: body[k] for k in ("outcome", "grade", "feedback", "reason")}
            existing = db.get(CourseReview, body["id"])
            if existing:
                if (existing.submission_id != submission_id or existing.reviewer_id != user.id
                    or existing.revision != body["expected_revision"] + 1
                    or any(getattr(existing, k) != v for k, v in values.items())):
                    raise ApiError("COURSE_OPERATION_CONFLICT", 409)
                return {"id": existing.id, "revision": existing.revision}
            previous = self.last_review(db, submission)
            revision = previous.revision if previous else 0
            newer = aliased(CourseSubmission)
            has_newer_same_version = db.scalar(select(newer.id).where(
                newer.task_id == task_id, newer.student_id == submission.student_id,
                newer.task_revision_id == submission.task_revision_id,
                newer.attempt > submission.attempt).limit(1)) is not None
            if has_newer_same_version or revision != body["expected_revision"]:
                raise ApiError("TASK_STALE", 409)
            if revision and not body["reason"]:
                raise ApiError("TASK_REASON_REQUIRED", 422)
            db.add(CourseReview(id=body["id"], submission_id=submission_id, reviewer_id=user.id,
                               revision=revision + 1, **values))
            return {"id": body["id"], "revision": revision + 1}

    def download(self, token, scope, course, task_id, submission_id):
        with self.factory.begin() as db:
            user, row, _ = self.context(db, token, scope, course, task_id)
            submission = db.get(CourseSubmission, submission_id)
            if (not submission or submission.task_id != task_id or
                (not row["can_manage"] and submission.student_id != self.student_id(db, user, scope))):
                raise ApiError("ACCESS_DENIED", 403)
            if submission.pdf is None:
                raise ApiError("NOT_FOUND", 404)
            return submission.pdf

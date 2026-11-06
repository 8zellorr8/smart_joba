"""Task writes serialize with catalog changes; attempts and reviews are append-only."""
import uuid
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import aliased
from .auth import ApiError
from ..infrastructure.course_models import CourseTopic
from ..infrastructure.journal_models import Student
from ..infrastructure.task_models import CourseReview, CourseSubmission, CourseTask


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
    def task_dto(task):
        return {"id": task.id, "title": task.title, "instructions": task.instructions,
                "due_on": task.due_on, "timezone": task.timezone}

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
        result = {"id": row.id, "student_name": row.student_name, "attempt": row.attempt,
                  "submitted_at": row.submitted_at, "kind": "pdf" if row.body is None else "text",
                  "late": bool(task.due_on and row.submitted_at.astimezone(ZoneInfo(task.timezone)).date() > task.due_on),
                  "review": self.review_dto(review, teacher)}
        if full:
            result["text"] = row.body
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
            if existing:
                if existing.created_by != user.id or any(getattr(existing, k) != v for k, v in values.items()):
                    raise ApiError("COURSE_OPERATION_CONFLICT", 409)
            else:
                db.add(CourseTask(id=body["id"], timezone=row["timezone"], created_by=user.id, **values))
            return {"id": body["id"]}

    def details(self, token, scope, course, task_id):
        with self.factory.begin() as db:
            user, row, task = self.context(db, token, scope, course, task_id)
            attempts = []
            if not row["can_manage"]:
                student_id = self.student_id(db, user, scope)
                attempts = [self.submission_dto(db, a, task, False, full=True) for a in db.scalars(select(CourseSubmission)
                    .where(CourseSubmission.task_id == task_id, CourseSubmission.student_id == student_id)
                    .order_by(CourseSubmission.attempt.desc()))]
            return {"task": self.task_dto(task), "can_manage": row["can_manage"], "attempts": attempts}

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
            if (previous.attempt if previous else 0) != expected_attempt:
                raise ApiError("TASK_STALE", 409)
            if previous:
                review = self.last_review(db, previous)
                if not review or review.outcome != "returned":
                    raise ApiError("TASK_ALREADY_SUBMITTED", 409)
            student = db.get(Student, student_id)
            db.add(CourseSubmission(id=operation_id, task_id=task_id, student_id=student_id,
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
            latest = self.last_attempt(db, task_id, submission.student_id)
            previous = self.last_review(db, submission)
            revision = previous.revision if previous else 0
            if latest.id != submission_id or revision != body["expected_revision"]:
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

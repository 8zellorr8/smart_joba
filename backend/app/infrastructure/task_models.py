"""Versioned course tasks, student attempts and teacher reviews."""
import uuid
from datetime import date, datetime

from sqlalchemy import CheckConstraint, Date, DateTime, ForeignKey, Integer, LargeBinary, String, Text, UniqueConstraint, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column
from .models import Base


class CourseTask(Base):
    __tablename__ = "course_tasks"
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    topic_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("course_topics.id"), index=True)
    title: Mapped[str] = mapped_column(String(160))
    instructions: Mapped[str] = mapped_column(Text)
    due_on: Mapped[date | None] = mapped_column(Date)
    timezone: Mapped[str] = mapped_column(String(64))
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class CourseTaskRevision(Base):
    __tablename__ = "course_task_revisions"
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    task_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("course_tasks.id"), index=True)
    revision: Mapped[int] = mapped_column(Integer)
    title: Mapped[str] = mapped_column(String(160))
    instructions: Mapped[str] = mapped_column(Text)
    due_on: Mapped[date | None] = mapped_column(Date)
    timezone: Mapped[str] = mapped_column(String(64))
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    __table_args__ = (
        UniqueConstraint("task_id", "revision"),
        CheckConstraint("revision > 0", name="task_revision_positive"),
    )


class CourseSubmission(Base):
    __tablename__ = "course_submissions"
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    task_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("course_tasks.id"), index=True)
    task_revision_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("course_task_revisions.id"), index=True)
    student_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("students.id"))
    student_name: Mapped[str] = mapped_column(String(200))
    attempt: Mapped[int] = mapped_column(Integer)
    body: Mapped[str | None] = mapped_column(Text)
    pdf: Mapped[bytes | None] = mapped_column(LargeBinary, deferred=True)
    submitted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.clock_timestamp())
    __table_args__ = (
        UniqueConstraint("task_id", "student_id", "attempt"),
        CheckConstraint("attempt > 0", name="submission_attempt_positive"),
        CheckConstraint("(body IS NULL) <> (pdf IS NULL)", name="submission_one_format"),
    )


class CourseReview(Base):
    __tablename__ = "course_reviews"
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    submission_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("course_submissions.id"), index=True)
    revision: Mapped[int] = mapped_column(Integer)
    reviewer_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    outcome: Mapped[str] = mapped_column(String(16))
    grade: Mapped[int | None] = mapped_column(Integer)
    feedback: Mapped[str] = mapped_column(Text)
    reason: Mapped[str] = mapped_column(String(500))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.clock_timestamp())
    __table_args__ = (
        UniqueConstraint("submission_id", "revision"),
        CheckConstraint("revision > 0", name="review_revision_positive"),
        CheckConstraint("(outcome = 'graded' AND grade IS NOT NULL AND grade BETWEEN 0 AND 100) OR (outcome = 'returned' AND grade IS NULL AND length(trim(feedback)) > 0)", name="review_result"),
        CheckConstraint("revision = 1 OR length(trim(reason)) > 0", name="review_correction_reason"),
    )

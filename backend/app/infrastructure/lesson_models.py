"""Lesson facts outlive their timetable source and current group membership."""
import uuid
from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Integer, String, UniqueConstraint, Uuid, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base


class JournalLesson(Base):
    __tablename__ = "journal_lessons"
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    journal_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("journals.id", ondelete="RESTRICT"), index=True)
    profile_key: Mapped[str] = mapped_column(String(64), index=True)
    source: Mapped[dict] = mapped_column(JSONB)
    topic: Mapped[str] = mapped_column(String(2000))
    revision: Mapped[int] = mapped_column(Integer)
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    __table_args__ = (CheckConstraint("revision > 0", name="lesson_revision"), CheckConstraint("length(btrim(topic)) > 0", name="lesson_topic"))


class JournalLessonStudent(Base):
    __tablename__ = "journal_lesson_students"
    lesson_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("journal_lessons.id", ondelete="RESTRICT"), primary_key=True)
    student_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("students.id", ondelete="RESTRICT"), primary_key=True)
    display_name: Mapped[str] = mapped_column(String(160))
    membership: Mapped[dict] = mapped_column(JSONB)
    active: Mapped[bool] = mapped_column(Boolean)
    attendance: Mapped[str | None] = mapped_column(String(16), nullable=True)
    __table_args__ = (CheckConstraint("attendance IN ('present','absent','late','excused')", name="lesson_attendance"),)


class JournalEventLink(Base):
    __tablename__ = "journal_event_links"
    publication_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("publications.id", ondelete="RESTRICT"), primary_key=True)
    event_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    journal_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("journals.id", ondelete="RESTRICT"), index=True)
    # Null is an explicit administrator decision that this is a new lesson.
    lesson_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("journal_lessons.id", ondelete="RESTRICT"), nullable=True, index=True)
    decided_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    reason: Mapped[str] = mapped_column(String(500))


class JournalLessonChange(Base):
    __tablename__ = "journal_lesson_changes"
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    scope_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("scopes.id", ondelete="RESTRICT"))
    lesson_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("journal_lessons.id", ondelete="RESTRICT"), nullable=True, index=True)
    actor_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    action: Mapped[str] = mapped_column(String(32))
    revision: Mapped[int] = mapped_column(Integer)
    before: Mapped[dict] = mapped_column(JSONB)
    after: Mapped[dict] = mapped_column(JSONB)
    reason: Mapped[str] = mapped_column(String(500))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class JournalLessonOperation(Base):
    __tablename__ = "journal_lesson_operations"
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    scope_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("scopes.id", ondelete="RESTRICT"))
    actor_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    operation_id: Mapped[uuid.UUID] = mapped_column(Uuid)
    request_hash: Mapped[str] = mapped_column(String(64))
    receipt: Mapped[dict] = mapped_column(JSONB)
    __table_args__ = (UniqueConstraint("scope_id", "actor_id", "operation_id"),)

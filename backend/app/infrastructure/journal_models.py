"""Journal setup is separate from immutable timetable publications."""
import uuid
from datetime import date, datetime

from sqlalchemy import Boolean, CheckConstraint, Date, DateTime, ForeignKey, Integer, String, UniqueConstraint, Uuid, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base


class JournalRegistry(Base):
    __tablename__ = "journal_registries"
    scope_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("scopes.id", ondelete="RESTRICT"), primary_key=True)
    revision: Mapped[int] = mapped_column(Integer)
    __table_args__ = (CheckConstraint("revision >= 0", name="journal_registry_revision"),)


class Student(Base):
    __tablename__ = "students"
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    scope_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("scopes.id", ondelete="RESTRICT"), index=True)
    data_kind: Mapped[str] = mapped_column(String(16))
    display_name: Mapped[str] = mapped_column(String(160))
    __table_args__ = (CheckConstraint("data_kind IN ('college','synthetic')", name="student_data_kind"),)


class StudentMembership(Base):
    __tablename__ = "student_memberships"
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    student_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("students.id", ondelete="RESTRICT"), index=True)
    context_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("import_contexts.id", ondelete="RESTRICT"), index=True)
    group_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("groups.id", ondelete="RESTRICT"))
    start: Mapped[date] = mapped_column(Date)
    end: Mapped[date] = mapped_column(Date)
    source: Mapped[str] = mapped_column(String(300))
    confirmed_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    __table_args__ = (CheckConstraint('"start" < "end"', name="student_membership_interval"),)


class StudentAccountBinding(Base):
    __tablename__ = "student_account_bindings"
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    scope_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("scopes.id", ondelete="RESTRICT"))
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    student_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("students.id", ondelete="RESTRICT"), nullable=True)
    source: Mapped[str] = mapped_column(String(300))
    confirmed_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    __table_args__ = (UniqueConstraint("scope_id", "user_id"), UniqueConstraint("scope_id", "student_id"))


class Journal(Base):
    __tablename__ = "journals"
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    context_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("import_contexts.id", ondelete="RESTRICT"), index=True)
    group_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("groups.id", ondelete="RESTRICT"))
    subject_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("subjects.id", ondelete="RESTRICT"))
    semester: Mapped[int] = mapped_column(Integer)
    source: Mapped[str] = mapped_column(String(300))
    confirmed_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    __table_args__ = (UniqueConstraint("context_id", "group_id", "subject_id", "semester"), CheckConstraint("semester BETWEEN 1 AND 20", name="journal_semester"))


class JournalAssignment(Base):
    __tablename__ = "journal_assignments"
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    journal_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("journals.id", ondelete="RESTRICT"), index=True)
    teacher_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("teachers.id", ondelete="RESTRICT"))
    start: Mapped[date] = mapped_column(Date)
    end: Mapped[date] = mapped_column(Date)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    source: Mapped[str] = mapped_column(String(300))
    confirmed_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    __table_args__ = (CheckConstraint('"start" < "end"', name="journal_assignment_interval"),)


class JournalSetupChange(Base):
    __tablename__ = "journal_setup_changes"
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    scope_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("scopes.id", ondelete="RESTRICT"))
    revision: Mapped[int] = mapped_column(Integer)
    actor_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    action: Mapped[str] = mapped_column(String(32))
    before: Mapped[dict] = mapped_column(JSONB)
    after: Mapped[dict] = mapped_column(JSONB)
    reason: Mapped[str] = mapped_column(String(500))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    __table_args__ = (UniqueConstraint("scope_id", "revision"),)


class JournalSetupOperation(Base):
    __tablename__ = "journal_setup_operations"
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    scope_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("scopes.id", ondelete="RESTRICT"))
    actor_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    operation_id: Mapped[uuid.UUID] = mapped_column(Uuid)
    request_hash: Mapped[str] = mapped_column(String(64))
    receipt: Mapped[dict] = mapped_column(JSONB)
    __table_args__ = (UniqueConstraint("scope_id", "actor_id", "operation_id"),)

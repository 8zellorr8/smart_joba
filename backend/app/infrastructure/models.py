import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, ForeignKeyConstraint, Index, Integer, LargeBinary, Numeric, String, UniqueConstraint, Uuid, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Scope(Base):
    __tablename__ = "scopes"
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(160))
    is_demo: Mapped[bool] = mapped_column(Boolean, default=False)


class Group(Base):
    __tablename__ = "groups"
    __table_args__ = (UniqueConstraint("id", "scope_id"), UniqueConstraint("scope_id", "data_kind", "code", name="uq_groups_scope_kind_code"))
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    scope_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("scopes.id", ondelete="RESTRICT"))
    code: Mapped[str] = mapped_column(String(80))
    data_kind: Mapped[str] = mapped_column(String(16), default="synthetic", server_default="synthetic")


class Teacher(Base):
    __tablename__ = "teachers"
    __table_args__ = (UniqueConstraint("id", "scope_id"),)
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    scope_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("scopes.id", ondelete="RESTRICT"))
    display_name: Mapped[str] = mapped_column(String(160))
    data_kind: Mapped[str] = mapped_column(String(16), default="synthetic", server_default="synthetic")


class User(Base):
    __tablename__ = "users"
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(254), unique=True)
    display_name: Mapped[str] = mapped_column(String(160))
    password_hash: Mapped[str] = mapped_column(String(512))
    home_scope_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("scopes.id", ondelete="RESTRICT"))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class RoleGrant(Base):
    __tablename__ = "role_grants"
    __table_args__ = (
        UniqueConstraint("user_id", "scope_id", "role"),
        ForeignKeyConstraint(["group_id", "scope_id"], ["groups.id", "groups.scope_id"]),
        ForeignKeyConstraint(["teacher_id", "scope_id"], ["teachers.id", "teachers.scope_id"]),
        CheckConstraint("role IN ('admin','scheduler','approver','teacher','student')", name="valid_role"),
        CheckConstraint("NOT can_publish OR role = 'approver'", name="publish_requires_approver"),
        CheckConstraint("role != 'student' OR group_id IS NOT NULL", name="student_requires_group"),
        CheckConstraint("role != 'teacher' OR teacher_id IS NOT NULL", name="teacher_requires_binding"),
    )
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    scope_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("scopes.id", ondelete="RESTRICT"))
    role: Mapped[str] = mapped_column(String(20))
    can_publish: Mapped[bool] = mapped_column(Boolean, default=False)
    group_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    teacher_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)


class AuthSession(Base):
    __tablename__ = "auth_sessions"
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class LoginThrottle(Base):
    __tablename__ = "login_throttle"
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    window_started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    __table_args__ = (CheckConstraint("attempts >= 0", name="nonnegative_attempts"),)


class AuditEvent(Base):
    __tablename__ = "audit_events"
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    actor_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    action: Mapped[str] = mapped_column(String(64))
    outcome: Mapped[str] = mapped_column(String(32))
    request_id: Mapped[str] = mapped_column(String(36))
    __table_args__ = (Index("ix_audit_events_occurred_at", "occurred_at"),)


class Subject(Base):
    __tablename__ = "subjects"
    __table_args__ = (UniqueConstraint("scope_id", "data_kind", "name_sha256"),)
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    scope_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("scopes.id", ondelete="RESTRICT"))
    data_kind: Mapped[str] = mapped_column(String(16))
    name: Mapped[str] = mapped_column(String(2000))
    name_sha256: Mapped[str] = mapped_column(String(64))


class ImportContext(Base):
    __tablename__ = "import_contexts"
    __table_args__ = (UniqueConstraint("scope_id", "academic_year", "data_kind"),
                     CheckConstraint("data_kind IN ('college','synthetic')", name="import_context_kind"),
                     CheckConstraint("revision >= 0", name="import_context_revision"))
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    scope_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("scopes.id", ondelete="RESTRICT"))
    academic_year: Mapped[str] = mapped_column(String(9))
    data_kind: Mapped[str] = mapped_column(String(16))
    revision: Mapped[int] = mapped_column(Integer, default=0)


class ImportBatch(Base):
    __tablename__ = "import_batches"
    __table_args__ = (CheckConstraint("status IN ('preview','applied')", name="import_batch_status"),)
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    context_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("import_contexts.id", ondelete="RESTRICT"), index=True)
    filename: Mapped[str] = mapped_column(String(255))
    file_sha256: Mapped[str] = mapped_column(String(64))
    original_file: Mapped[bytes] = mapped_column(LargeBinary, deferred=True)
    template: Mapped[str] = mapped_column(String(32))
    sheet: Mapped[str] = mapped_column(String(31))
    last_row: Mapped[int] = mapped_column(Integer)
    hour_unit: Mapped[str] = mapped_column(String(32))
    base_revision: Mapped[int] = mapped_column(Integer)
    revision: Mapped[int] = mapped_column(Integer, default=1)
    status: Mapped[str] = mapped_column(String(16), default="preview")
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    applied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    applied_context_revision: Mapped[int | None] = mapped_column(Integer, nullable=True)


class ImportRow(Base):
    __tablename__ = "import_rows"
    __table_args__ = (UniqueConstraint("batch_id", "source_row"),)
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    batch_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("import_batches.id", ondelete="CASCADE"), index=True)
    source_row: Mapped[int] = mapped_column(Integer)
    raw: Mapped[dict] = mapped_column(JSONB)
    normalized: Mapped[dict] = mapped_column(JSONB)
    corrections: Mapped[dict] = mapped_column(JSONB, default=dict)
    references_confirmed: Mapped[bool] = mapped_column(Boolean, default=False)
    source_key: Mapped[str] = mapped_column(String(64))
    matched_demand_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)


class SourceReference(Base):
    __tablename__ = "source_references"
    __table_args__ = (UniqueConstraint("row_id", "field"),)
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    row_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("import_rows.id", ondelete="CASCADE"), index=True)
    field: Mapped[str] = mapped_column(String(32))
    coordinate: Mapped[str] = mapped_column(String(16))
    original: Mapped[dict] = mapped_column(JSONB)


class ImportIssue(Base):
    __tablename__ = "import_issues"
    __table_args__ = (UniqueConstraint("row_id", "code", "field"),)
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    row_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("import_rows.id", ondelete="CASCADE"), index=True)
    source_reference_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("source_references.id", ondelete="CASCADE"))
    code: Mapped[str] = mapped_column(String(64))
    field: Mapped[str] = mapped_column(String(32))
    blocking: Mapped[bool] = mapped_column(Boolean, default=True)
    resolved: Mapped[bool] = mapped_column(Boolean, default=False)


class TeachingDemand(Base):
    __tablename__ = "teaching_demands"
    __table_args__ = (UniqueConstraint("context_id", "source_key"), CheckConstraint("revision > 0", name="demand_revision_positive"))
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    context_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("import_contexts.id", ondelete="RESTRICT"), index=True)
    source_key: Mapped[str] = mapped_column(String(64))
    revision: Mapped[int] = mapped_column(Integer)
    source_row_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("import_rows.id", ondelete="RESTRICT"))
    normalized: Mapped[dict] = mapped_column(JSONB)
    open_issues: Mapped[list] = mapped_column(JSONB)
    group_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("groups.id", ondelete="RESTRICT"), nullable=True)
    subject_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("subjects.id", ondelete="RESTRICT"), nullable=True)
    weekly_amount: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    semester_amount: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)


class DemandRevision(Base):
    __tablename__ = "demand_revisions"
    __table_args__ = (UniqueConstraint("demand_id", "revision"),)
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    demand_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("teaching_demands.id", ondelete="RESTRICT"), index=True)
    revision: Mapped[int] = mapped_column(Integer)
    previous_revision_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("demand_revisions.id", ondelete="RESTRICT"), nullable=True)
    source_row_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("import_rows.id", ondelete="RESTRICT"))
    normalized: Mapped[dict] = mapped_column(JSONB)
    open_issues: Mapped[list] = mapped_column(JSONB)
    reference_ids: Mapped[dict] = mapped_column(JSONB)
    confirmed_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class TeachingAssignment(Base):
    __tablename__ = "teaching_assignments"
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    demand_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("teaching_demands.id", ondelete="RESTRICT"), unique=True)
    teacher_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("teachers.id", ondelete="RESTRICT"))
    source_revision_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("demand_revisions.id", ondelete="RESTRICT"))
    confirmed_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))


class CalendarProfile(Base):
    __tablename__ = "calendar_profiles"
    __table_args__ = (UniqueConstraint("context_id", "group_id"),
                     CheckConstraint("revision > 0", name="calendar_revision_positive"))
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    context_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("import_contexts.id", ondelete="RESTRICT"), index=True)
    group_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("groups.id", ondelete="RESTRICT"))
    revision: Mapped[int] = mapped_column(Integer)
    document: Mapped[dict] = mapped_column(JSONB)


class CalendarRevision(Base):
    __tablename__ = "calendar_revisions"
    __table_args__ = (UniqueConstraint("profile_id", "revision"),)
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    profile_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("calendar_profiles.id", ondelete="RESTRICT"), index=True)
    revision: Mapped[int] = mapped_column(Integer)
    document: Mapped[dict] = mapped_column(JSONB)
    confirmed_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

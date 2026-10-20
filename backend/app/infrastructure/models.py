import uuid
from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, ForeignKeyConstraint, Index, Integer, String, UniqueConstraint, Uuid, func
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
    __table_args__ = (UniqueConstraint("id", "scope_id"), UniqueConstraint("scope_id", "code"))
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    scope_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("scopes.id", ondelete="RESTRICT"))
    code: Mapped[str] = mapped_column(String(80))


class Teacher(Base):
    __tablename__ = "teachers"
    __table_args__ = (UniqueConstraint("id", "scope_id"),)
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    scope_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("scopes.id", ondelete="RESTRICT"))
    display_name: Mapped[str] = mapped_column(String(160))


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

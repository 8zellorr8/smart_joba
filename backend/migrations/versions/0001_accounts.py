"""Stage 1: scoped accounts, opaque sessions, throttle and allowlisted audit."""
from alembic import op
import sqlalchemy as sa

revision = "0001_accounts"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("scopes", sa.Column("id", sa.Uuid(), primary_key=True), sa.Column("name", sa.String(160), nullable=False), sa.Column("is_demo", sa.Boolean(), nullable=False))
    op.create_table("groups", sa.Column("id", sa.Uuid(), primary_key=True), sa.Column("scope_id", sa.Uuid(), sa.ForeignKey("scopes.id", ondelete="RESTRICT"), nullable=False), sa.Column("code", sa.String(80), nullable=False), sa.UniqueConstraint("id", "scope_id"), sa.UniqueConstraint("scope_id", "code"))
    op.create_table("teachers", sa.Column("id", sa.Uuid(), primary_key=True), sa.Column("scope_id", sa.Uuid(), sa.ForeignKey("scopes.id", ondelete="RESTRICT"), nullable=False), sa.Column("display_name", sa.String(160), nullable=False), sa.UniqueConstraint("id", "scope_id"))
    op.create_table("users", sa.Column("id", sa.Uuid(), primary_key=True), sa.Column("email", sa.String(254), nullable=False, unique=True), sa.Column("display_name", sa.String(160), nullable=False), sa.Column("password_hash", sa.String(512), nullable=False), sa.Column("home_scope_id", sa.Uuid(), sa.ForeignKey("scopes.id", ondelete="RESTRICT"), nullable=False), sa.Column("is_active", sa.Boolean(), nullable=False), sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False))
    op.create_table("role_grants", sa.Column("id", sa.Uuid(), primary_key=True), sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False), sa.Column("scope_id", sa.Uuid(), sa.ForeignKey("scopes.id", ondelete="RESTRICT"), nullable=False), sa.Column("role", sa.String(20), nullable=False), sa.Column("can_publish", sa.Boolean(), nullable=False), sa.Column("group_id", sa.Uuid(), nullable=True), sa.Column("teacher_id", sa.Uuid(), nullable=True), sa.UniqueConstraint("user_id", "scope_id", "role"), sa.ForeignKeyConstraint(["group_id", "scope_id"], ["groups.id", "groups.scope_id"]), sa.ForeignKeyConstraint(["teacher_id", "scope_id"], ["teachers.id", "teachers.scope_id"]), sa.CheckConstraint("role IN ('admin','scheduler','approver','teacher','student')", name="valid_role"), sa.CheckConstraint("NOT can_publish OR role = 'approver'", name="publish_requires_approver"), sa.CheckConstraint("role != 'student' OR group_id IS NOT NULL", name="student_requires_group"), sa.CheckConstraint("role != 'teacher' OR teacher_id IS NOT NULL", name="teacher_requires_binding"))
    op.create_table("auth_sessions", sa.Column("id", sa.Uuid(), primary_key=True), sa.Column("token_hash", sa.String(64), nullable=False, unique=True), sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False), sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False), sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True), sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False))
    op.create_index("ix_auth_sessions_user_id", "auth_sessions", ["user_id"])
    op.create_index("ix_auth_sessions_expires_at", "auth_sessions", ["expires_at"])
    op.create_table("login_throttle", sa.Column("key", sa.String(64), primary_key=True), sa.Column("window_started_at", sa.DateTime(timezone=True), nullable=False), sa.Column("attempts", sa.Integer(), nullable=False), sa.CheckConstraint("attempts >= 0", name="nonnegative_attempts"))
    op.create_table("audit_events", sa.Column("id", sa.Uuid(), primary_key=True), sa.Column("occurred_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False), sa.Column("actor_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True), sa.Column("action", sa.String(64), nullable=False), sa.Column("outcome", sa.String(32), nullable=False), sa.Column("request_id", sa.String(36), nullable=False))
    op.create_index("ix_audit_events_occurred_at", "audit_events", ["occurred_at"])


def downgrade():
    for table in ("audit_events", "login_throttle", "auth_sessions", "role_grants", "users", "teachers", "groups", "scopes"):
        op.drop_table(table)

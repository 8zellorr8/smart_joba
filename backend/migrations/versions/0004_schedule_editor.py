"""Rooms, revisioned drafts and stable concrete occurrences."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "0004_editor"
down_revision = "0003_calendar"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("rooms",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("scope_id", sa.Uuid(), sa.ForeignKey("scopes.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("data_kind", sa.String(16), nullable=False),
        sa.Column("code", sa.String(80), nullable=False),
        sa.Column("exclusive", sa.Boolean(), nullable=True),
        sa.Column("confirmed", sa.Boolean(), nullable=False),
        sa.Column("source", sa.String(300), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.UniqueConstraint("scope_id", "data_kind", "code"),
        sa.CheckConstraint("data_kind IN ('college','synthetic')", name="room_kind"),
        sa.CheckConstraint("revision > 0", name="room_revision_positive"))
    op.create_table("schedule_drafts",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("context_id", sa.Uuid(), sa.ForeignKey("import_contexts.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("name", sa.String(160), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("dependencies", JSONB(), nullable=False),
        sa.Column("created_by", sa.Uuid(), sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("revision > 0", name="draft_revision_positive"),
        sa.CheckConstraint("status IN ('draft','submitted','approved','published')", name="draft_status"))
    op.create_index("ix_schedule_drafts_context_id", "schedule_drafts", ["context_id"])
    op.create_table("schedule_series",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("draft_id", sa.Uuid(), sa.ForeignKey("schedule_drafts.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("template", JSONB(), nullable=False),
        sa.Column("occurrences", JSONB(), nullable=False))
    op.create_index("ix_schedule_series_draft_id", "schedule_series", ["draft_id"])
    op.create_table("draft_revisions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("draft_id", sa.Uuid(), sa.ForeignKey("schedule_drafts.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("snapshot", JSONB(), nullable=False),
        sa.Column("report", JSONB(), nullable=False),
        sa.Column("actor_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("draft_id", "revision"))
    op.create_index("ix_draft_revisions_draft_id", "draft_revisions", ["draft_id"])


def downgrade():
    for table in ("draft_revisions", "schedule_series", "schedule_drafts"):
        column = "context_id" if table == "schedule_drafts" else "draft_id"
        op.drop_index(f"ix_{table}_{column}", table_name=table)
        op.drop_table(table)
    op.drop_table("rooms")

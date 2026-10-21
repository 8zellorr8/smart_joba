"""Explicit calendar profiles and immutable revisions.

Revision ID: 0003_calendar
Revises: 0002_s1_import
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0003_calendar"
down_revision = "0002_s1_import"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("calendar_profiles",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("context_id", sa.Uuid(), nullable=False),
        sa.Column("group_id", sa.Uuid(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("document", postgresql.JSONB(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["context_id"], ["import_contexts.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["group_id"], ["groups.id"], ondelete="RESTRICT"),
        sa.UniqueConstraint("context_id", "group_id"),
        sa.CheckConstraint("revision > 0", name="calendar_revision_positive"))
    op.create_index("ix_calendar_profiles_context_id", "calendar_profiles", ["context_id"])
    op.create_table("calendar_revisions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("profile_id", sa.Uuid(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("document", postgresql.JSONB(), nullable=False),
        sa.Column("confirmed_by", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["profile_id"], ["calendar_profiles.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["confirmed_by"], ["users.id"], ondelete="RESTRICT"),
        sa.UniqueConstraint("profile_id", "revision"))
    op.create_index("ix_calendar_revisions_profile_id", "calendar_revisions", ["profile_id"])


def downgrade():
    op.drop_index("ix_calendar_revisions_profile_id", table_name="calendar_revisions")
    op.drop_table("calendar_revisions")
    op.drop_index("ix_calendar_profiles_context_id", table_name="calendar_profiles")
    op.drop_table("calendar_profiles")

"""Revisioned confirmed conditions, durable solver jobs and validation reports."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "0005_planning"
down_revision = "0004_editor"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("planning_rules",
        sa.Column("context_id", sa.Uuid(), sa.ForeignKey("import_contexts.id", ondelete="RESTRICT"), primary_key=True),
        sa.Column("revision", sa.Integer(), nullable=False), sa.Column("document", JSONB(), nullable=False),
        sa.Column("confirmed_by", sa.Uuid(), sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False),
        sa.CheckConstraint("revision > 0", name="planning_revision_positive"))
    op.create_table("planning_rules_revisions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("context_id", sa.Uuid(), sa.ForeignKey("planning_rules.context_id", ondelete="RESTRICT"), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False), sa.Column("document", JSONB(), nullable=False),
        sa.Column("actor_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("context_id", "revision"))
    op.create_table("solver_jobs",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("context_id", sa.Uuid(), sa.ForeignKey("import_contexts.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("snapshot", JSONB(), nullable=False), sa.Column("parameters", JSONB(), nullable=False),
        sa.Column("algorithm_version", sa.String(80), nullable=False), sa.Column("status", sa.String(40), nullable=False),
        sa.Column("stage", sa.String(40), nullable=False), sa.Column("result", JSONB(), nullable=True),
        sa.Column("result_draft_id", sa.Uuid(), sa.ForeignKey("schedule_drafts.id", ondelete="RESTRICT"), nullable=True),
        sa.Column("cancel_requested", sa.Boolean(), nullable=False),
        sa.Column("created_by", sa.Uuid(), sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True), sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("status IN ('queued','running','feasible','optimal','infeasible','time_limit_without_solution','cancelled','failed')", name="solver_status"))
    op.create_index("ix_solver_jobs_context_id", "solver_jobs", ["context_id"])
    op.create_table("validation_reports",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("draft_id", sa.Uuid(), sa.ForeignKey("schedule_drafts.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("draft_revision", sa.Integer(), nullable=False), sa.Column("snapshot", JSONB(), nullable=False),
        sa.Column("report", JSONB(), nullable=False),
        sa.Column("actor_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False))
    op.create_index("ix_validation_reports_draft_id", "validation_reports", ["draft_id"])


def downgrade():
    for table in ("validation_reports", "solver_jobs"):
        op.drop_index(f"ix_{table}_{'draft_id' if table == 'validation_reports' else 'context_id'}", table_name=table)
        op.drop_table(table)
    op.drop_table("planning_rules_revisions")
    op.drop_table("planning_rules")

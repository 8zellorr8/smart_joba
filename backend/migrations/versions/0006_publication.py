"""Version workflow, immutable decisions/publications and atomic active pointers."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "0006_publication"
down_revision = "0005_planning"
branch_labels = depends_on = None


def ident():
    return sa.Column("id", sa.Uuid(), primary_key=True)


def ref(name, target, **kwargs):
    return sa.Column(name, sa.Uuid(), sa.ForeignKey(target, ondelete="RESTRICT"), nullable=False, **kwargs)


def stamp(name="created_at"):
    return sa.Column(name, sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False)


IMMUTABLE = ("version_submissions", "version_decisions", "version_transitions", "publications", "publication_operations")


def upgrade():
    op.add_column("import_contexts", sa.Column("version_counter", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("schedule_drafts", sa.Column("version_number", sa.Integer(), nullable=True))
    op.add_column("schedule_drafts", sa.Column("workflow_revision", sa.Integer(), nullable=False, server_default="1"))
    op.add_column("schedule_drafts", sa.Column("parent_id", sa.Uuid(), nullable=True))
    op.create_foreign_key("fk_version_parent", "schedule_drafts", "schedule_drafts", ["parent_id"], ["id"], ondelete="RESTRICT")
    op.execute("""WITH numbered AS (SELECT id, row_number() OVER (PARTITION BY context_id ORDER BY created_at, id) AS n FROM schedule_drafts)
        UPDATE schedule_drafts d SET version_number=n.n FROM numbered n WHERE d.id=n.id""")
    op.execute("""UPDATE import_contexts c SET version_counter=n.maximum FROM
        (SELECT context_id, max(version_number) AS maximum FROM schedule_drafts GROUP BY context_id) n WHERE c.id=n.context_id""")
    op.alter_column("schedule_drafts", "version_number", nullable=False)
    op.create_unique_constraint("uq_schedule_version_number", "schedule_drafts", ["context_id", "version_number"])
    op.create_check_constraint("version_numbers_positive", "schedule_drafts", "version_number > 0 AND workflow_revision > 0")
    op.drop_constraint("draft_status", "schedule_drafts", type_="check")
    op.create_check_constraint("draft_status", "schedule_drafts", "status IN ('draft','submitted','rejected','approved','published','archived')")
    op.create_table("version_submissions", ident(), ref("version_id", "schedule_drafts.id"),
        sa.Column("revision", sa.Integer(), nullable=False), sa.Column("workflow_revision", sa.Integer(), nullable=False),
        *[sa.Column(name, JSONB(), nullable=False) for name in ("selection", "inputs", "events", "report")],
        ref("actor_id", "users.id"), stamp(), sa.UniqueConstraint("version_id", "workflow_revision"))
    op.create_index("ix_version_submissions_version_id", "version_submissions", ["version_id"])
    op.create_table("version_decisions", ident(), ref("submission_id", "version_submissions.id", unique=True),
        sa.Column("revision", sa.Integer(), nullable=False), sa.Column("action", sa.String(16), nullable=False),
        sa.Column("comment", sa.String(2000), nullable=False), ref("actor_id", "users.id"), stamp(),
        sa.CheckConstraint("action IN ('approve','reject')", name="version_decision_action"))
    op.create_table("version_transitions", ident(), ref("version_id", "schedule_drafts.id"),
        sa.Column("revision", sa.Integer(), nullable=False), sa.Column("workflow_revision", sa.Integer(), nullable=False),
        sa.Column("action", sa.String(24), nullable=False), sa.Column("from_status", sa.String(16), nullable=False),
        sa.Column("to_status", sa.String(16), nullable=False), sa.Column("comment", sa.String(2000), nullable=False),
        ref("actor_id", "users.id"), stamp(), sa.UniqueConstraint("version_id", "workflow_revision"))
    op.create_index("ix_version_transitions_version_id", "version_transitions", ["version_id"])
    op.create_table("publications", ident(), ref("context_id", "import_contexts.id"), ref("version_id", "schedule_drafts.id", unique=True),
        ref("approval_id", "version_decisions.id"), sa.Column("profile_key", sa.String(64), nullable=False),
        sa.Column("snapshot", JSONB(), nullable=False), ref("published_by", "users.id"), stamp("published_at"))
    op.create_index("ix_publications_context_id", "publications", ["context_id"])
    op.create_index("ix_publications_profile_key", "publications", ["profile_key"])
    op.create_table("publication_heads", sa.Column("profile_key", sa.String(64), primary_key=True),
        ref("publication_id", "publications.id", unique=True))
    op.create_table("publication_operations", sa.Column("key", sa.Uuid(), primary_key=True),
        ref("actor_id", "users.id"), sa.Column("request_hash", sa.String(64), nullable=False), ref("publication_id", "publications.id"))
    op.execute("""CREATE FUNCTION reject_immutable_schedule_record() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'Immutable schedule record' USING ERRCODE = '23514'; END; $$""")
    for name in IMMUTABLE:
        op.execute(f"CREATE TRIGGER immutable_schedule_record BEFORE UPDATE OR DELETE ON {name} FOR EACH ROW EXECUTE FUNCTION reject_immutable_schedule_record()")


def downgrade():
    if op.get_bind().scalar(sa.text("SELECT EXISTS (SELECT 1 FROM version_transitions) OR EXISTS (SELECT 1 FROM publications)")):
        raise RuntimeError("Retained workflow/publication history prevents downgrade; preserve the database backup")
    for name in IMMUTABLE:
        op.execute(f"DROP TRIGGER immutable_schedule_record ON {name}")
    for name in ("publication_operations", "publication_heads", "publications", "version_transitions", "version_decisions", "version_submissions"):
        op.drop_table(name)
    op.execute("DROP FUNCTION reject_immutable_schedule_record()")
    op.drop_constraint("draft_status", "schedule_drafts", type_="check")
    op.create_check_constraint("draft_status", "schedule_drafts", "status IN ('draft','submitted','approved','published')")
    op.drop_constraint("version_numbers_positive", "schedule_drafts", type_="check")
    op.drop_constraint("uq_schedule_version_number", "schedule_drafts", type_="unique")
    op.drop_constraint("fk_version_parent", "schedule_drafts", type_="foreignkey")
    for col in ("parent_id", "workflow_revision", "version_number"): op.drop_column("schedule_drafts", col)
    op.drop_column("import_contexts", "version_counter")

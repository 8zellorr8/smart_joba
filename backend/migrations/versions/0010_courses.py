"""Topics and materials for courses attached to existing journals."""
from alembic import op
import sqlalchemy as sa

revision = "0010_courses"
down_revision = "0009_journal_grades"
branch_labels = depends_on = None


def timestamp():
    return sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False)


def upgrade():
    op.create_table("courses",
        sa.Column("journal_id", sa.Uuid(), sa.ForeignKey("journals.id"), primary_key=True),
        sa.Column("created_by", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        timestamp())
    op.create_table("course_topics",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("journal_id", sa.Uuid(), sa.ForeignKey("courses.journal_id"), nullable=False),
        sa.Column("title", sa.String(160), nullable=False), timestamp())
    op.create_index("ix_course_topics_journal_id", "course_topics", ["journal_id"])
    op.create_table("course_materials",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("topic_id", sa.Uuid(), sa.ForeignKey("course_topics.id"), nullable=False),
        sa.Column("title", sa.String(160), nullable=False),
        sa.Column("body", sa.Text()), sa.Column("pdf", sa.LargeBinary()), timestamp(),
        sa.CheckConstraint("(body IS NULL) <> (pdf IS NULL)", name="course_material_one_format"))
    op.create_index("ix_course_materials_topic_id", "course_materials", ["topic_id"])


def downgrade():
    if op.get_bind().scalar(sa.text("SELECT EXISTS (SELECT 1 FROM courses)")):
        raise RuntimeError("Course data exists; restore a backup instead of removing it")
    op.drop_table("course_materials")
    op.drop_table("course_topics")
    op.drop_table("courses")

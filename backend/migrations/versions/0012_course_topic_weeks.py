"""Add optional week number to course topics."""
from alembic import op
import sqlalchemy as sa

revision = "0012_course_topic_weeks"
down_revision = "0011_course_tasks"
branch_labels = depends_on = None


def upgrade():
    op.add_column(
        "course_topics", sa.Column("week_number", sa.SmallInteger(), nullable=True)
    )
    op.create_check_constraint(
        "course_topic_week_number",
        "course_topics",
        "week_number IS NULL OR week_number BETWEEN 1 AND 10",
    )


def downgrade():
    op.drop_constraint("course_topic_week_number", "course_topics", type_="check")
    op.drop_column("course_topics", "week_number")

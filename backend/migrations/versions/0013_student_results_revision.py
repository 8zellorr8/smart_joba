"""Track result changes separately from journal catalog revisions."""
from alembic import op
import sqlalchemy as sa


revision = "0013_student_results_revision"
down_revision = "0012_course_topic_weeks"
branch_labels = depends_on = None


def upgrade():
    op.add_column(
        "journal_registries",
        sa.Column("results_revision", sa.Integer(), server_default="0", nullable=False),
    )
    op.create_check_constraint(
        "journal_results_revision", "journal_registries", "results_revision >= 0"
    )


def downgrade():
    op.drop_constraint(
        "journal_results_revision", "journal_registries", type_="check"
    )
    op.drop_column("journal_registries", "results_revision")

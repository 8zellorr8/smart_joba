"""Course tasks, immutable submissions and review history."""
from alembic import op
import sqlalchemy as sa

revision = "0011_course_tasks"
down_revision = "0010_courses"
branch_labels = depends_on = None


def upgrade():
    op.create_table("course_tasks",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("topic_id", sa.Uuid(), sa.ForeignKey("course_topics.id"), nullable=False),
        sa.Column("title", sa.String(160), nullable=False), sa.Column("instructions", sa.Text(), nullable=False),
        sa.Column("due_on", sa.Date()), sa.Column("timezone", sa.String(64), nullable=False),
        sa.Column("created_by", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False))
    op.create_index("ix_course_tasks_topic_id", "course_tasks", ["topic_id"])
    op.create_table("course_submissions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("task_id", sa.Uuid(), sa.ForeignKey("course_tasks.id"), nullable=False),
        sa.Column("student_id", sa.Uuid(), sa.ForeignKey("students.id"), nullable=False),
        sa.Column("student_name", sa.String(200), nullable=False), sa.Column("attempt", sa.Integer(), nullable=False),
        sa.Column("body", sa.Text()), sa.Column("pdf", sa.LargeBinary()),
        sa.Column("submitted_at", sa.DateTime(timezone=True), server_default=sa.func.clock_timestamp(), nullable=False),
        sa.UniqueConstraint("task_id", "student_id", "attempt"),
        sa.CheckConstraint("attempt > 0", name="submission_attempt_positive"),
        sa.CheckConstraint("(body IS NULL) <> (pdf IS NULL)", name="submission_one_format"))
    op.create_index("ix_course_submissions_task_id", "course_submissions", ["task_id"])
    op.create_table("course_reviews",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("submission_id", sa.Uuid(), sa.ForeignKey("course_submissions.id"), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("reviewer_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("outcome", sa.String(16), nullable=False), sa.Column("grade", sa.Integer()),
        sa.Column("feedback", sa.Text(), nullable=False), sa.Column("reason", sa.String(500), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.clock_timestamp(), nullable=False),
        sa.UniqueConstraint("submission_id", "revision"),
        sa.CheckConstraint("revision > 0", name="review_revision_positive"),
        sa.CheckConstraint("(outcome = 'graded' AND grade IS NOT NULL AND grade BETWEEN 0 AND 100) OR (outcome = 'returned' AND grade IS NULL AND length(trim(feedback)) > 0)", name="review_result"),
        sa.CheckConstraint("revision = 1 OR length(trim(reason)) > 0", name="review_correction_reason"))
    op.create_index("ix_course_reviews_submission_id", "course_reviews", ["submission_id"])
    op.execute("""CREATE FUNCTION protect_course_task_history() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'Course task history is immutable' USING ERRCODE = '23514'; END; $$""")
    for table in ("course_tasks", "course_submissions", "course_reviews"):
        op.execute(f"CREATE TRIGGER protect_course_task_history BEFORE UPDATE OR DELETE ON {table} FOR EACH ROW EXECUTE FUNCTION protect_course_task_history()")


def downgrade():
    if op.get_bind().scalar(sa.text("SELECT EXISTS (SELECT 1 FROM course_tasks)")):
        raise RuntimeError("Course task history exists; restore a backup instead of deleting it")
    for table in ("course_reviews", "course_submissions", "course_tasks"):
        op.drop_table(table)
    op.execute("DROP FUNCTION protect_course_task_history()")

"""Editable course materials and immutable task condition revisions."""
import uuid

from alembic import op
import sqlalchemy as sa

revision = "0013_course_content_revisions"
down_revision = "0013_student_results_revision"
branch_labels = depends_on = None


def upgrade():
    op.add_column("course_materials", sa.Column("revision", sa.Integer(), server_default="1", nullable=False))
    op.create_check_constraint("course_material_revision_positive", "course_materials", "revision > 0")
    op.create_table(
        "course_task_revisions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("task_id", sa.Uuid(), sa.ForeignKey("course_tasks.id"), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(160), nullable=False),
        sa.Column("instructions", sa.Text(), nullable=False),
        sa.Column("due_on", sa.Date()),
        sa.Column("timezone", sa.String(64), nullable=False),
        sa.Column("created_by", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("task_id", "revision"),
        sa.CheckConstraint("revision > 0", name="task_revision_positive"),
    )
    op.create_index("ix_course_task_revisions_task_id", "course_task_revisions", ["task_id"])

    bind = op.get_bind()
    tasks = bind.execute(sa.text("SELECT id, title, instructions, due_on, timezone, created_by, created_at FROM course_tasks"))
    revision_ids = {}
    for task in tasks:
        revision_id = uuid.uuid4()
        revision_ids[task.id] = revision_id
        bind.execute(sa.text("""
            INSERT INTO course_task_revisions (id, task_id, revision, title, instructions, due_on, timezone, created_by, created_at)
            VALUES (:id, :task_id, 1, :title, :instructions, :due_on, :timezone, :created_by, :created_at)
        """), {"id": revision_id, "task_id": task.id, "title": task.title,
              "instructions": task.instructions, "due_on": task.due_on, "timezone": task.timezone,
              "created_by": task.created_by, "created_at": task.created_at})

    op.add_column("course_submissions", sa.Column("task_revision_id", sa.Uuid(), nullable=True))
    op.execute("ALTER TABLE course_submissions DISABLE TRIGGER protect_course_task_history")
    for task_id, revision_id in revision_ids.items():
        bind.execute(sa.text("UPDATE course_submissions SET task_revision_id = :revision_id WHERE task_id = :task_id"),
                     {"revision_id": revision_id, "task_id": task_id})
    op.execute("ALTER TABLE course_submissions ENABLE TRIGGER protect_course_task_history")
    op.alter_column("course_submissions", "task_revision_id", nullable=False)
    op.create_foreign_key("fk_course_submissions_task_revision", "course_submissions", "course_task_revisions",
                          ["task_revision_id"], ["id"])
    op.create_index("ix_course_submissions_task_revision_id", "course_submissions", ["task_revision_id"])
    op.execute("CREATE TRIGGER protect_course_task_revision_history BEFORE UPDATE OR DELETE ON course_task_revisions FOR EACH ROW EXECUTE FUNCTION protect_course_task_history()")


def downgrade():
    bind = op.get_bind()
    if bind.scalar(sa.text("SELECT EXISTS (SELECT 1 FROM course_task_revisions WHERE revision > 1)")):
        raise RuntimeError("Edited task conditions exist; restore a backup instead of deleting their history")
    if bind.scalar(sa.text("SELECT EXISTS (SELECT 1 FROM course_materials WHERE revision > 1)")):
        raise RuntimeError("Edited course materials exist; restore a backup instead of discarding revisions")
    op.execute("DROP TRIGGER protect_course_task_revision_history ON course_task_revisions")
    op.drop_index("ix_course_submissions_task_revision_id", table_name="course_submissions")
    op.drop_constraint("fk_course_submissions_task_revision", "course_submissions", type_="foreignkey")
    op.drop_column("course_submissions", "task_revision_id")
    op.drop_index("ix_course_task_revisions_task_id", table_name="course_task_revisions")
    op.drop_table("course_task_revisions")
    op.drop_constraint("course_material_revision_positive", "course_materials", type_="check")
    op.drop_column("course_materials", "revision")

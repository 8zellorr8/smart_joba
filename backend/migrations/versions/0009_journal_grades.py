"""One nullable integer grade per existing lesson/student; preserve all history."""
from alembic import op
import sqlalchemy as sa

revision = "0009_journal_grades"
down_revision = "0008_journal_lessons"
branch_labels = depends_on = None


def upgrade():
    op.add_column("journal_lesson_students", sa.Column("grade", sa.Integer(), nullable=True))
    op.create_check_constraint("lesson_grade", "journal_lesson_students", "grade BETWEEN 0 AND 100")
    # Keep the original fact/link triggers and immutable history unchanged.
    op.execute("""CREATE FUNCTION protect_journal_student() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Journal fact cannot be deleted' USING ERRCODE = '23514'; END IF;
      IF (to_jsonb(NEW) - ARRAY['attendance','grade','active']) IS DISTINCT FROM
         (to_jsonb(OLD) - ARRAY['attendance','grade','active']) THEN
        RAISE EXCEPTION 'Immutable student snapshot' USING ERRCODE = '23514'; END IF;
      RETURN NEW;
    END; $$""")
    op.execute("DROP TRIGGER protect_journal_fact ON journal_lesson_students")
    op.execute("CREATE TRIGGER protect_journal_fact BEFORE UPDATE OR DELETE ON journal_lesson_students FOR EACH ROW EXECUTE FUNCTION protect_journal_student()")


def downgrade():
    # Even a cleared grade survives in history; never silently remove that contract.
    if op.get_bind().scalar(sa.text("""SELECT EXISTS (SELECT 1 FROM journal_lesson_students WHERE grade IS NOT NULL)
        OR EXISTS (SELECT 1 FROM journal_lesson_changes c,
            LATERAL jsonb_array_elements(COALESCE(c.after->'students', '[]'::jsonb)) AS s
            WHERE s ? 'grade')""")):
        raise RuntimeError("Journal grade history exists; restore a backup instead of deleting it")
    op.execute("DROP TRIGGER protect_journal_fact ON journal_lesson_students")
    op.execute("CREATE TRIGGER protect_journal_fact BEFORE UPDATE OR DELETE ON journal_lesson_students FOR EACH ROW EXECUTE FUNCTION protect_journal_fact()")
    op.execute("DROP FUNCTION protect_journal_student()")
    op.drop_constraint("lesson_grade", "journal_lesson_students", type_="check")
    op.drop_column("journal_lesson_students", "grade")

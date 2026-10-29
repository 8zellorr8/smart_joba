"""Recorded lessons, immutable origins, attendance and audit receipts."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "0008_journal_lessons"
down_revision = "0007_journal_setup"
branch_labels = depends_on = None


def ref(name, target, **kw):
    return sa.Column(name, sa.Uuid(), sa.ForeignKey(target, ondelete="RESTRICT"), nullable=kw.pop("nullable", False), **kw)


def ident():
    return sa.Column("id", sa.Uuid(), primary_key=True)


def upgrade():
    op.create_table("journal_lessons", ident(), ref("journal_id", "journals.id"), sa.Column("profile_key", sa.String(64), nullable=False), sa.Column("source", JSONB(), nullable=False), sa.Column("topic", sa.String(2000), nullable=False), sa.Column("revision", sa.Integer(), nullable=False), ref("created_by", "users.id"), sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False), sa.CheckConstraint("revision > 0", name="lesson_revision"), sa.CheckConstraint("length(btrim(topic)) > 0", name="lesson_topic"))
    op.create_table("journal_lesson_students", ref("lesson_id", "journal_lessons.id", primary_key=True), ref("student_id", "students.id", primary_key=True), sa.Column("display_name", sa.String(160), nullable=False), sa.Column("membership", JSONB(), nullable=False), sa.Column("active", sa.Boolean(), nullable=False), sa.Column("attendance", sa.String(16), nullable=True), sa.CheckConstraint("attendance IN ('present','absent','late','excused')", name="lesson_attendance"))
    op.create_table("journal_event_links", ref("publication_id", "publications.id", primary_key=True), sa.Column("event_id", sa.Uuid(), primary_key=True), ref("journal_id", "journals.id"), ref("lesson_id", "journal_lessons.id", nullable=True), ref("decided_by", "users.id"), sa.Column("reason", sa.String(500), nullable=False))
    op.create_table("journal_lesson_changes", ident(), ref("scope_id", "scopes.id"), ref("lesson_id", "journal_lessons.id", nullable=True), ref("actor_id", "users.id"), sa.Column("action", sa.String(32), nullable=False), sa.Column("revision", sa.Integer(), nullable=False), sa.Column("before", JSONB(), nullable=False), sa.Column("after", JSONB(), nullable=False), sa.Column("reason", sa.String(500), nullable=False), sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False))
    op.create_table("journal_lesson_operations", ident(), ref("scope_id", "scopes.id"), ref("actor_id", "users.id"), sa.Column("operation_id", sa.Uuid(), nullable=False), sa.Column("request_hash", sa.String(64), nullable=False), sa.Column("receipt", JSONB(), nullable=False), sa.UniqueConstraint("scope_id", "actor_id", "operation_id"))
    for table, cols in {"journal_lessons": ("journal_id", "profile_key"), "journal_event_links": ("journal_id", "lesson_id"), "journal_lesson_changes": ("lesson_id",)}.items():
        for col in cols:
            op.create_index(f"ix_{table}_{col}", table, [col])
    for table in ("journal_lesson_changes", "journal_lesson_operations"):
        op.execute(f"CREATE TRIGGER immutable_lesson_history BEFORE UPDATE OR DELETE ON {table} FOR EACH ROW EXECUTE FUNCTION reject_immutable_journal_setup()")
    op.execute("""CREATE FUNCTION protect_journal_fact() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Journal fact cannot be deleted' USING ERRCODE = '23514'; END IF;
      IF TG_TABLE_NAME = 'journal_lessons' THEN
        IF (to_jsonb(NEW) - ARRAY['topic','revision']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['topic','revision']) THEN
          RAISE EXCEPTION 'Immutable lesson origin' USING ERRCODE = '23514'; END IF;
      ELSIF TG_TABLE_NAME = 'journal_lesson_students' THEN
        IF (to_jsonb(NEW) - ARRAY['attendance','active']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['attendance','active']) THEN
          RAISE EXCEPTION 'Immutable student snapshot' USING ERRCODE = '23514'; END IF;
      ELSE
        IF OLD.lesson_id IS NOT NULL OR (to_jsonb(NEW) - 'lesson_id') IS DISTINCT FROM (to_jsonb(OLD) - 'lesson_id') THEN
          RAISE EXCEPTION 'Immutable lesson binding' USING ERRCODE = '23514'; END IF;
      END IF;
      RETURN NEW;
    END; $$""")
    for table in ("journal_lessons", "journal_lesson_students", "journal_event_links"):
        op.execute(f"CREATE TRIGGER protect_journal_fact BEFORE UPDATE OR DELETE ON {table} FOR EACH ROW EXECUTE FUNCTION protect_journal_fact()")


def downgrade():
    if op.get_bind().scalar(sa.text("SELECT EXISTS (SELECT 1 FROM journal_lesson_changes)")):
        raise RuntimeError("Journal facts exist; restore a backup instead of deleting them")
    for table in ("journal_lesson_operations", "journal_lesson_changes", "journal_event_links", "journal_lesson_students", "journal_lessons"):
        op.drop_table(table)
    op.execute("DROP FUNCTION protect_journal_fact()")

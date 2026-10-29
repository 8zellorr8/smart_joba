"""Journal students, confirmed links and assignments; no lesson facts yet."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "0007_journal_setup"
down_revision = "0006_publication"
branch_labels = depends_on = None


def ident():
    return sa.Column("id", sa.Uuid(), primary_key=True)


def ref(name, target, **kwargs):
    return sa.Column(name, sa.Uuid(), sa.ForeignKey(target, ondelete="RESTRICT"), nullable=False, **kwargs)


def interval():
    return [sa.Column("start", sa.Date(), nullable=False), sa.Column("end", sa.Date(), nullable=False)]


def evidence():
    return [sa.Column("source", sa.String(300), nullable=False), ref("confirmed_by", "users.id")]


def upgrade():
    op.create_table("journal_registries", ref("scope_id", "scopes.id", primary_key=True), sa.Column("revision", sa.Integer(), nullable=False), sa.CheckConstraint("revision >= 0", name="journal_registry_revision"))
    op.create_table("students", ident(), ref("scope_id", "scopes.id"), sa.Column("data_kind", sa.String(16), nullable=False), sa.Column("display_name", sa.String(160), nullable=False), sa.CheckConstraint("data_kind IN ('college','synthetic')", name="student_data_kind"))
    op.create_index("ix_students_scope_id", "students", ["scope_id"])
    op.create_table("student_memberships", ident(), ref("student_id", "students.id"), ref("context_id", "import_contexts.id"), ref("group_id", "groups.id"), *interval(), *evidence(), sa.CheckConstraint('"start" < "end"', name="student_membership_interval"))
    for col in ("student_id", "context_id"):
        op.create_index(f"ix_student_memberships_{col}", "student_memberships", [col])
    op.create_table("student_account_bindings", ident(), ref("scope_id", "scopes.id"), ref("user_id", "users.id"), sa.Column("student_id", sa.Uuid(), sa.ForeignKey("students.id", ondelete="RESTRICT"), nullable=True), *evidence(), sa.UniqueConstraint("scope_id", "user_id"), sa.UniqueConstraint("scope_id", "student_id"))
    op.create_table("journals", ident(), ref("context_id", "import_contexts.id"), ref("group_id", "groups.id"), ref("subject_id", "subjects.id"), sa.Column("semester", sa.Integer(), nullable=False), *evidence(), sa.UniqueConstraint("context_id", "group_id", "subject_id", "semester"), sa.CheckConstraint("semester BETWEEN 1 AND 20", name="journal_semester"))
    op.create_index("ix_journals_context_id", "journals", ["context_id"])
    op.create_table("journal_assignments", ident(), ref("journal_id", "journals.id"), ref("teacher_id", "teachers.id"), *interval(), sa.Column("active", sa.Boolean(), nullable=False), *evidence(), sa.CheckConstraint('"start" < "end"', name="journal_assignment_interval"))
    op.create_index("ix_journal_assignments_journal_id", "journal_assignments", ["journal_id"])
    op.create_table("journal_setup_changes", ident(), ref("scope_id", "scopes.id"), sa.Column("revision", sa.Integer(), nullable=False), ref("actor_id", "users.id"), sa.Column("action", sa.String(32), nullable=False), sa.Column("before", JSONB(), nullable=False), sa.Column("after", JSONB(), nullable=False), sa.Column("reason", sa.String(500), nullable=False), sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False), sa.UniqueConstraint("scope_id", "revision"))
    op.create_table("journal_setup_operations", ident(), ref("scope_id", "scopes.id"), ref("actor_id", "users.id"), sa.Column("operation_id", sa.Uuid(), nullable=False), sa.Column("request_hash", sa.String(64), nullable=False), sa.Column("receipt", JSONB(), nullable=False), sa.UniqueConstraint("scope_id", "actor_id", "operation_id"))
    op.execute("""CREATE FUNCTION reject_immutable_journal_setup() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'Immutable journal setup history' USING ERRCODE = '23514'; END; $$""")
    for table in ("journal_setup_changes", "journal_setup_operations"):
        op.execute(f"CREATE TRIGGER immutable_journal_setup BEFORE UPDATE OR DELETE ON {table} FOR EACH ROW EXECUTE FUNCTION reject_immutable_journal_setup()")


def downgrade():
    if op.get_bind().scalar(sa.text("SELECT EXISTS (SELECT 1 FROM journal_setup_changes)")):
        raise RuntimeError("Journal history exists; restore a backup instead of deleting it")
    for table in ("journal_setup_operations", "journal_setup_changes", "journal_assignments", "journals", "student_account_bindings", "student_memberships", "students", "journal_registries"):
        op.drop_table(table)
    op.execute("DROP FUNCTION reject_immutable_journal_setup()")

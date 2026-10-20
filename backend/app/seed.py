"""Prepare synthetic demo accounts; secrets are written only to ignored local files."""
import json
import os
import secrets
import uuid

from sqlalchemy import select

from .config import ROOT, Settings
from .infrastructure.database import create_database
from .infrastructure.models import Group, RoleGrant, Scope, Teacher, User
from .infrastructure.security import PASSWORDS

DEMO_SCOPE_ID = uuid.UUID("cb02d8c5-ef64-46d2-abd6-e02026d00001")
DEMO_GROUP_ID = uuid.UUID("cb02d8c5-ef64-46d2-abd6-e02026d00002")
DEMO_TEACHER_ID = uuid.UUID("cb02d8c5-ef64-46d2-abd6-e02026d00003")


def prepare_accounts(settings: Settings, output_dir=None):
    output_dir = output_dir or ROOT / ".local"
    output_dir.mkdir(exist_ok=True)
    accounts_path = output_dir / "accounts.json"
    _, factory = create_database(settings.database_url)
    names = {"admin": "Демо әкімші", "scheduler": "Демо құрастырушы", "approver": "Демо бекітуші", "teacher": "Демо оқытушы", "student": "Демо студент"}
    created = []
    with factory.begin() as db:
        existing = db.scalars(select(User).where(User.email.in_([f"{role}@demo.local" for role in names]))).all()
        if existing:
            if len(existing) != len(names) or not accounts_path.exists():
                raise RuntimeError("Demo accounts already exist but local credentials are incomplete; no passwords were changed")
            return False
        scope = db.get(Scope, DEMO_SCOPE_ID)
        if scope is None:
            db.add(Scope(id=DEMO_SCOPE_ID, name="Демонстрациялық орта · колледж деректері емес", is_demo=True))
            db.flush()
        if db.get(Group, DEMO_GROUP_ID) is None:
            db.add(Group(id=DEMO_GROUP_ID, scope_id=DEMO_SCOPE_ID, code="DEMO-GROUP"))
        if db.get(Teacher, DEMO_TEACHER_ID) is None:
            db.add(Teacher(id=DEMO_TEACHER_ID, scope_id=DEMO_SCOPE_ID, display_name="Демо оқытушы · синтетикалық дерек"))
        db.flush()
        for role, name in names.items():
            password = secrets.token_urlsafe(24)
            user = User(email=f"{role}@demo.local", display_name=name, password_hash=PASSWORDS.hash(password), home_scope_id=DEMO_SCOPE_ID, is_active=True)
            db.add(user)
            db.flush()
            db.add(RoleGrant(user_id=user.id, scope_id=DEMO_SCOPE_ID, role=role, can_publish=role == "approver", group_id=DEMO_GROUP_ID if role == "student" else None, teacher_id=DEMO_TEACHER_ID if role == "teacher" else None))
            created.append({"email": user.email, "password": password, "role": role})
        # Stage before commit so an unwritable destination never strands accounts.
        temporary = output_dir / "accounts.pending.json"
        temporary.write_text(json.dumps({"is_demo": True, "scope_id": str(DEMO_SCOPE_ID), "accounts": created}, ensure_ascii=False, indent=2), encoding="utf-8")
        os.chmod(temporary, 0o600)
    temporary.replace(accounts_path)
    text_path = output_dir / "accounts.txt"
    text_path.write_text("DEMO ONLY — synthetic accounts, no college personal data.\nKeep this file private.\n\n" + "\n\n".join(f"Role: {account['role']}\nEmail: {account['email']}\nPassword: {account['password']}" for account in created), encoding="utf-8")
    os.chmod(text_path, 0o600)
    return True


if __name__ == "__main__":
    created = prepare_accounts(Settings())
    print("Prepared demo credentials in .local/accounts.json and .local/accounts.txt" if created else "Demo accounts already prepared; unchanged")

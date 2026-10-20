"""REQ-006: permissions are evaluated within exactly one access scope.

This module knows no HTTP or persistence. A role is never a global bypass.
Reader actions remain limited to confirmed group/teacher bindings.
"""

ROLE_PERMISSIONS: dict[str, frozenset[str]] = {
    "admin": frozenset({"accounts.prepare", "catalog.manage", "calendar.manage", "import.source.read", "publication.read", "publication.export"}),
    "scheduler": frozenset({"import.write", "import.source.read", "draft.read", "draft.edit", "generator.run", "draft.submit", "publication.read", "publication.export"}),
    "approver": frozenset({"draft.read", "draft.approve", "draft.reject", "publication.read", "publication.export"}),
    "teacher": frozenset({"publication.read.own", "publication.export.own"}),
    "student": frozenset({"publication.read.group", "publication.export.group"}),
}


def permissions_for(grants: list[dict], scope_id: str) -> list[str]:
    permissions: set[str] = set()
    for grant in grants:
        if str(grant["scope_id"]) != scope_id:
            continue
        role = grant["role"]
        # A reader without an explicit confirmed binding gets no reader action.
        if role == "teacher" and not grant.get("teacher_id"):
            continue
        if role == "student" and not grant.get("group_id"):
            continue
        permissions.update(ROLE_PERMISSIONS.get(role, ()))
        if role == "approver" and grant.get("can_publish", False):
            permissions.add("draft.publish")
    return sorted(permissions)

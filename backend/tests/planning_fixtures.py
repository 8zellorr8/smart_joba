"""All data in this module is explicitly synthetic."""
from copy import deepcopy
import uuid

from backend.app.domain.planning import RULE_VERSION
from backend.app.seed import DEMO_SCOPE_ID
from .calendar_fixtures import document
from .conftest import csrf, login
from .editor_fixtures import setup_editor


def rules_document(groups, teachers, rooms, demands):
    return {"confirmed": True, "source": "SYNTHETIC TEST confirmed conditions", "external_confirmed": False, "external_source": "",
        "groups": [{"group_id": g, "size": 20} for g in groups],
        "rooms": [{"room_id": r, "capacity": 30, "features": []} for r in rooms],
        "needs": [{"demand_id": d, "features": []} for d in demands],
        "availability": [{"resource_type": kind, "resource_id": key, "start_date": "2026-09-01", "end_date": "2026-11-16",
            "weekdays": [0, 1, 2, 3, 4], "start": "09:00", "end": "12:00"} for kind, keys in (("teacher", teachers), ("room", rooms)) for key in keys], "busy": []}


def snapshot():
    calendar = deepcopy(document())
    calendar["end"] = "2026-09-02"
    calendar["periods"] = [{"start": "2026-09-01", "end": "2026-09-02", "kind": "theory", "semester": 1, "label": "SYNTHETIC TEST"}]
    calendar["slots"].append({"id": "second", "label": "SYNTHETIC TEST", "start": "10:30", "end": "12:00"})
    demands = [{"id": f"d{i}", "revision": 1, "assignment_id": f"a{i}", "assignment_source_revision_id": f"r{i}",
        "source_row_id": f"row{i}", "source": {"row_id": f"row{i}", "coordinate": f"K{i + 2}"}, "subject": f"SYNTHETIC subject {i}",
        "group_id": f"g{i}", "group": f"SYNTHETIC group {i}", "teacher_id": "t", "teacher": "SYNTHETIC teacher", "whole_group": True,
        "confirmed": True, "source_amount": "4", "source_unit": "academic_hour", "calendar_id": f"c{i}", "calendar_revision": 1} for i in range(2)]
    return {"snapshot_id": str(uuid.uuid4()), "context_id": "ctx", "scope_id": "scope", "academic_year": "2026-2027", "data_kind": "synthetic",
        "group_ids": ["g0", "g1"], "semester": 1, "base_draft_id": None, "pins": [], "demands": demands,
        "calendars": {f"c{i}": deepcopy(calendar) for i in range(2)}, "rooms": [{"id": "room", "code": "SYNTHETIC room", "revision": 1, "confirmed": True, "exclusive": True}],
        "rules": rules_document(["g0", "g1"], ["t"], ["room"], ["d0", "d1"]),
        "dependencies": {"context_revision": 1, "rules_revision": 1, "calendars": {"c0": 1, "c1": 1}, "rooms": {"room": 1}, "base_revision": None, "rule_version": RULE_VERSION},
        "source_questions": []}


def setup_planning(client, app):
    env = setup_editor(client, app)
    groups = list(env["calendars"])
    teachers = sorted({a["teacher_id"] for a in env["assignments"]})
    doc = rules_document(groups, teachers, [r["id"] for r in env["rooms"]], [a["demand_id"] for a in env["assignments"]])
    login(client, app, "admin")
    context = env["draft"]["context_id"]
    response = client.post(f"/api/planning-contexts/{context}/rules", headers=csrf(client), json={"expected_revision": 0, "document": doc})
    assert response.status_code == 200, response.text
    login(client, app)
    env["rules"] = doc
    env["selection"] = {"context_id": context, "group_ids": groups, "room_ids": [r["id"] for r in env["rooms"]], "semester": 1, "base_draft_id": None}
    return env


def preview(client, env):
    return client.post(f"/api/scopes/{DEMO_SCOPE_ID}/generation-preview", headers=csrf(client), json=env["selection"])


def create_job(client, env, **changes):
    checked = preview(client, env)
    assert checked.status_code == 200, checked.text
    return client.post(f"/api/scopes/{DEMO_SCOPE_ID}/solver-jobs", headers=csrf(client), json={**env["selection"], "token": checked.json()["token"], "seconds": 2, **changes})

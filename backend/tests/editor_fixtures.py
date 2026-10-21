"""Only synthetic assignments, rooms and calendars for editor tests."""
from copy import deepcopy

from backend.app.seed import DEMO_SCOPE_ID
from .calendar_fixtures import document, pattern
from .conftest import csrf, login
from .s1_fixtures import ROW, workbook
from .test_imports import upload, review, apply


def setup_editor(client, app):
    login(client, app)
    rows = []
    for index, group in enumerate(("TEST-EDITOR-A", "TEST-EDITOR-A", "TEST-EDITOR-B")):
        row = list(ROW); row[0] = "SYNTHETIC Editor Teacher " + ("B" if index == 1 else "A")
        row[1] = f"SYNTHETIC Subject {index}"; row[2] = f"TEST-EDITOR-{index}"; row[3] = group; row[5] = "101"; row[10] = 4
        rows.append(row)
    batch = upload(client, app, workbook(rows)).json()
    for index in range(3): batch = review(client, batch, {"whole_group": True}, True, index=index).json()
    assert apply(client, batch).status_code == 200
    login(client, app, "admin")
    rooms = []
    for code in ("TEST-101", "TEST-102"):
        response = client.post(f"/api/scopes/{DEMO_SCOPE_ID}/rooms", headers=csrf(client), json={"code": code, "data_kind": "synthetic", "exclusive": True, "confirmed": True, "source": "SYNTHETIC TEST room"})
        assert response.status_code == 201, response.text
        rooms.append(response.json())
    # Admin cannot read drafts; obtain references via scheduler, then configure
    # both calendars through the admin-only calendar contract.
    login(client, app)
    options = client.get(f"/api/scopes/{DEMO_SCOPE_ID}/editor-data").json()
    assignments = sorted(options["assignments"], key=lambda a: a["subject"])
    context_id = assignments[0]["context_id"]
    login(client, app, "admin")
    calendars = {}
    for assignment in assignments:
        if assignment["group_id"] in calendars: continue
        doc = deepcopy(document()); doc["slots"].append({"id": "second", "label": "TEST next", "start": "10:30", "end": "12:00"})
        response = client.post(f"/api/scopes/{DEMO_SCOPE_ID}/calendars", headers=csrf(client), json={"academic_year": "2026-2027", "data_kind": "synthetic", "group_id": assignment["group_id"], "document": doc})
        assert response.status_code == 201, response.text
        calendars[assignment["group_id"]] = response.json()
    login(client, app)
    response = client.post(f"/api/scopes/{DEMO_SCOPE_ID}/drafts", headers=csrf(client), json={"context_id": context_id, "name": "SYNTHETIC TEST editor draft"})
    assert response.status_code == 201, response.text
    return {"draft": response.json(), "rooms": rooms, "calendars": calendars, "assignments": assignments}


def series_body(env, draft=None, index=0, room_index=0, **pattern_changes):
    draft = draft or env["draft"]
    assignment = env["assignments"][index]; room = env["rooms"][room_index]; calendar = env["calendars"][assignment["group_id"]]
    return {"expected_revision": draft["revision"], "expected_dependencies": draft["dependencies"],
            "assignment_id": assignment["id"], "assignment_revision": assignment["revision"],
            "calendar_id": calendar["id"], "calendar_revision": calendar["revision"], "room_id": room["id"], "room_revision": room["revision"],
            "pattern": pattern(**{"start": "2026-09-01", "end": "2026-09-08", **pattern_changes})}


def add_series(client, env, draft=None, **changes):
    draft = draft or env["draft"]
    return client.post(f"/api/drafts/{draft['id']}/series", headers=csrf(client), json=series_body(env, draft, **changes))


def one_body(draft, event, **changes):
    return {"expected_revision": draft["revision"], "expected_dependencies": draft["dependencies"],
            **{key: event[key] for key in ("date", "start", "end", "room_id", "room_revision", "cancelled", "pinned")}, **changes}

from io import BytesIO
import uuid

from openpyxl import load_workbook
from sqlalchemy import text, update

from backend.app.application.publication_xlsx import build_workbook
from backend.app.infrastructure.models import RoleGrant
from .conftest import login
from .publication_fixtures import approve, fork, publish, setup_version, submit


def workbook(response):
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    assert response.headers["cache-control"] == "no-store"
    return load_workbook(BytesIO(response.content))


def test_export_uses_selected_publication_and_every_filtered_row(client, app):
    env = setup_version(client, app)
    first = publish(client, approve(client, app, submit(client, env)))
    original = client.get(f"/api/publications/{first['publication_id']}").json()
    group = original["resources"]["group"][0]
    filtered = client.get(f"/api/publications/{first['publication_id']}",
        params={"view": "group", "resource_id": group["id"], "limit": 1}).json()
    assert filtered["total"] > 1 and len(filtered["events"]) == 1
    result = client.get(f"/api/publications/{first['publication_id']}/export.xlsx",
        params={"view": "group", "resource_id": group["id"]})
    assert result.headers["content-disposition"] == f'attachment; filename="oqujol-{first["publication_id"]}.xlsx"'
    sheet = workbook(result).active
    assert sheet["A1"].value == "Оқужол · жарияланған сабақ кестесі"
    assert sheet["B2"].value == first["version_number"]
    assert sheet["B3"].value == first["publication_id"]
    assert sheet["D7"].value == group["name"]
    rows = list(sheet.iter_rows(min_row=11, values_only=True))
    assert len(rows) == filtered["total"]
    assert [(row[0], row[1], row[3], row[4]) for row in rows] == [
        (event["date"], event["start"], event["group"], event["subject"])
        for event in original["events"] if event["group"] == group["name"]]
    one_day = rows[0][0]
    day_sheet = workbook(client.get(f"/api/publications/{first['publication_id']}/export.xlsx",
        params={"start": one_day, "end": one_day})).active
    assert all(row[0] == one_day for row in day_sheet.iter_rows(min_row=11, values_only=True))
    assert workbook(client.get(f"/api/publications/{first['publication_id']}/export.xlsx",
        params={"start": "2040-01-01", "end": "2040-01-02"})).active.max_row == 10
    assert client.get(f"/api/publications/{first['publication_id']}/export.xlsx",
        params={"start": "2026-12-02", "end": "2026-12-01"}).status_code == 422

    old_version = client.get(f"/api/schedule-versions/{first['version_id']}").json()
    second = fork(client, app, old_version)
    second = publish(client, approve(client, app, submit(client, env, second)))
    assert second["version_number"] != first["version_number"]
    assert workbook(client.get(f"/api/publications/{first['publication_id']}/export.xlsx")).active["B2"].value == first["version_number"]


def test_export_obeys_live_role_bindings_and_rejects_foreign_filters(client, app):
    env = setup_version(client, app)
    receipt = publish(client, approve(client, app, submit(client, env)))
    path = f"/api/publications/{receipt['publication_id']}/export.xlsx"
    full = client.get(f"/api/publications/{receipt['publication_id']}").json()
    for role in ("admin", "scheduler", "approver"):
        login(client, app, role)
        assert workbook(client.get(path)).active.max_row - 10 == full["total"]
    client.cookies.clear()
    assert client.get(path).status_code == 401
    for role, kind in (("teacher", "teacher"), ("student", "group")):
        login(client, app, role)
        assert client.get(path).status_code == 403
        own_id = env["assignments"][0][kind + "_id"]
        with app.state.session_factory.begin() as db:
            db.execute(update(RoleGrant).where(RoleGrant.role == role).values(**{kind + "_id": uuid.UUID(own_id)}))
        visible = client.get(f"/api/publications/{receipt['publication_id']}").json()
        sheet = workbook(client.get(path)).active
        assert sheet.max_row - 10 == visible["total"]
        foreign = next(item["id"] for item in full["resources"][kind] if item["id"] != own_id)
        assert client.get(path, params={"view": kind, "resource_id": foreign}).status_code == 403
        with app.state.session_factory.begin() as db:
            db.execute(text("DELETE FROM role_grants WHERE role=:role"), {"role": role})
        assert client.get(path).status_code == 403


def test_formula_like_source_text_is_stored_as_text():
    view = {"version_number": 2, "revision": 1, "publication_id": "synthetic-publication", "published_at": "2026-01-01T00:00:00Z",
        "scope_name": "=HYPERLINK(\"https://example.invalid\")", "academic_year": "2026-2027", "semester": 1,
        "timezone": "Asia/Almaty", "data_kind": "synthetic",
        "resources": {"group": [{"id": "group", "name": "=HYPERLINK(\"https://example.invalid\")"}]},
        "events": [{"date": "2026-01-01", "start": "09:00", "end": "10:30", "group": "group",
                    "subject": "=HYPERLINK(\"https://example.invalid\")", "teacher": "+SUM(1,2)", "room": "@test"}]}
    book = load_workbook(BytesIO(build_workbook(view, None, None, "group", "group")))
    sheet = book.active
    for address in ("B4", "D7", "E11", "F11", "G11"):
        assert sheet[address].data_type == "s"
    assert sheet["E11"].value.startswith("=HYPERLINK")
    assert not book._external_links

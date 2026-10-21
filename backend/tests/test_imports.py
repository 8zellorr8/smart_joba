from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import uuid
import zipfile

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from backend.app.application.auth import ApiError
from backend.app.application.imports import ImportService
from backend.app.infrastructure.models import (DemandRevision, ImportBatch, ImportContext, ImportIssue, ImportRow,
    Scope, SourceReference, Teacher, TeachingAssignment, TeachingDemand)
from backend.app.infrastructure.s1_excel import ImportFileError, inspect_archive, read_s1
from .conftest import csrf, login
from .s1_fixtures import ROW, modify_zip, workbook


def upload(client, app, content=None, filename="synthetic.xlsx", **overrides):
    from backend.app.seed import DEMO_SCOPE_ID
    data = {"academic_year": "2026-2027", "data_kind": "synthetic", "sheet": "Жүктеме", "last_row": "237", "hour_unit": "academic_hour", **overrides}
    return client.post(f"/api/scopes/{DEMO_SCOPE_ID}/imports/s1", headers=csrf(client),
                       data=data, files={"file": (filename, content if content is not None else workbook(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})


def apply(client, batch):
    return client.post(f"/api/imports/{batch['id']}/apply", headers=csrf(client), json={"expected_revision": batch["revision"], "confirmed": True})


def review(client, batch, corrections, confirmed=False, index=0):
    return client.post(f"/api/imports/{batch['id']}/rows/{batch['rows'][index]['id']}/review", headers=csrf(client),
                       json={"expected_revision": batch["revision"], "corrections": corrections, "references_confirmed": confirmed})


def count(app, model):
    with app.state.session_factory() as db:
        return db.scalar(select(func.count()).select_from(model))


def test_ac001c_ac002a_preview_preserves_source_and_zero_room(client, app):
    login(client, app)
    response = upload(client, app)
    assert response.status_code == 201
    batch = response.json()
    row = batch["rows"][0]
    assert row["raw"]["room"]["value"] == 0 and row["normalized"]["room"] is None
    room = next(issue for issue in row["issues"] if issue["code"] == "ROOM_UNSPECIFIED")
    assert room["coordinate"] == "F2" and batch["sheet"] == "Жүктеме"
    with app.state.session_factory() as db:
        reference = db.get(SourceReference, uuid.UUID(room["source_reference_id"]))
        assert reference.original["value"] == 0
    assert count(app, TeachingDemand) == count(app, TeachingAssignment) == 0


def test_ac001a_same_batch_and_reuploaded_file_are_idempotent(client, app):
    login(client, app)
    batch = upload(client, app).json()
    batch = review(client, batch, {"room": "101", "whole_group": True}, True).json()
    assert batch["summary"]["ready"] == 1
    first = apply(client, batch)
    assert first.status_code == 200
    assert apply(client, batch).status_code == 200
    again = upload(client, app).json()
    assert again["summary"]["unchanged"] == 1 and again["summary"]["ready"] == 1
    assert apply(client, again).status_code == 200
    assert count(app, TeachingDemand) == count(app, TeachingAssignment) == count(app, DemandRevision) == 1


def test_ac001b_changed_preview_does_not_modify_active_data(client, app):
    login(client, app)
    first = upload(client, app).json()
    assert apply(client, first).status_code == 200
    changed = list(ROW); changed[5] = 102
    preview = upload(client, app, workbook([changed])).json()
    assert preview["summary"]["changed"] == 1
    with app.state.session_factory() as db:
        demand = db.scalar(select(TeachingDemand))
        assert demand.normalized["room"] is None and demand.revision == 1


def test_repeat_after_confirmed_identity_corrections_uses_same_stable_id(client, app):
    login(client, app)
    batch = upload(client, app).json()
    batch = review(client, batch, {"group": "CONFIRMED-A", "subject": "Расталған синтетикалық пән",
                                   "semester": "2", "room": "101", "whole_group": True}, True).json()
    assert apply(client, batch).status_code == 200
    with app.state.session_factory() as db:
        first_id = db.scalar(select(TeachingDemand.id))
    repeated = upload(client, app).json()
    assert repeated["summary"]["unchanged"] == 1 and repeated["summary"]["ready"] == 1
    assert apply(client, repeated).status_code == 200
    assert count(app, TeachingDemand) == count(app, DemandRevision) == 1
    with app.state.session_factory() as db:
        assert db.scalar(select(TeachingDemand.id)) == first_id
    changed = list(ROW); changed[5] = 102
    updated = upload(client, app, workbook([changed])).json()
    assert updated["summary"]["changed"] == 1 and updated["rows"][0]["normalized"]["group"] == "CONFIRMED-A"
    assert updated["rows"][0]["normalized"]["room"] == "102"  # New source value wins over an old correction.
    assert updated["rows"][0]["references_confirmed"] is False


def test_ac001d_missing_row_does_not_delete_demand(client, app):
    login(client, app)
    second = list(ROW); second[1] = "Екінші синтетикалық пән"
    first = upload(client, app, workbook([ROW, second])).json()
    assert apply(client, first).status_code == 200
    shorter = upload(client, app).json()
    assert shorter["summary"]["missing"] == 1
    assert apply(client, shorter).status_code == 200
    assert count(app, TeachingDemand) == 2


def test_ac001e_changed_record_keeps_id_and_revision_source_links(client, app):
    login(client, app)
    first = upload(client, app).json()
    assert apply(client, first).status_code == 200
    updated = list(ROW); updated[5] = 102
    second = upload(client, app, workbook([updated])).json()
    assert apply(client, second).status_code == 200
    history = client.get(f"/api/imports/{second['id']}/rows/{second['rows'][0]['id']}/history").json()
    assert [item["revision"] for item in history] == [2, 1]
    assert history[0]["previous_revision_id"] == history[1]["id"]
    assert history[0]["source"]["batch_id"] == second["id"]
    assert history[1]["source"]["batch_id"] == first["id"]
    assert count(app, TeachingDemand) == 1


def test_ac002c_ambiguous_row_remains_question_without_invented_assignment(client, app):
    login(client, app)
    ambiguous = list(ROW); ambiguous[0] = "Синтетикалық А / Синтетикалық Б"; ambiguous[6] = None; ambiguous[10] = None
    batch = upload(client, app, workbook([ambiguous])).json()
    codes = {issue["code"] for issue in batch["rows"][0]["issues"]}
    assert {"TEACHER_AMBIGUOUS", "SUBGROUP_UNSPECIFIED", "HOURS_REQUIRED"} <= codes
    assert apply(client, batch).status_code == 200
    assert count(app, TeachingDemand) == 1 and count(app, TeachingAssignment) == 0
    assert count(app, Teacher) == 1  # Only the prepared synthetic reader binding.
    with app.state.session_factory() as db:
        demand = db.scalar(select(TeachingDemand))
        assert demand.weekly_amount is None and demand.semester_amount is None
        assert ImportService.unresolved_for_context(db, demand.context_id)


def test_ac035b_room_resolution_leaves_independent_questions_open(client, app):
    login(client, app)
    batch = upload(client, app).json()
    original = {issue["id"] for issue in batch["rows"][0]["issues"] if issue["code"] != "ROOM_UNSPECIFIED"}
    updated = review(client, batch, {"room": "101"}).json()
    issues = updated["rows"][0]["issues"]
    assert {issue["id"] for issue in issues} == original
    assert {issue["code"] for issue in issues} >= {"REFERENCES_UNCONFIRMED", "SUBGROUP_UNSPECIFIED"}


def test_ac003a_stray_cell_does_not_expand_table(monkeypatch):
    from openpyxl.worksheet._read_only import ReadOnlyWorksheet
    original = ReadOnlyWorksheet.iter_rows
    observed = []
    def bounded(self, *args, **kwargs):
        observed.append(kwargs.get("max_row"))
        return original(self, *args, **kwargs)
    monkeypatch.setattr(ReadOnlyWorksheet, "iter_rows", bounded)
    rows = read_s1(workbook(stray=True), "synthetic.xlsx", "Жүктеме", 237)
    assert len(rows) == 1 and observed == [237, 237]


@pytest.mark.parametrize("role", ["admin", "approver", "teacher", "student"])
def test_only_scheduler_can_upload_and_apply(client, app, role):
    login(client, app)
    batch = upload(client, app).json()
    login(client, app, role)
    assert upload(client, app).status_code == 403
    assert apply(client, batch).status_code == 403
    assert review(client, batch, {"room": "101"}).status_code == 403


@pytest.mark.parametrize("role,expected", [("admin", 200), ("approver", 403), ("teacher", 403), ("student", 403)])
def test_ac012b_original_file_and_preview_have_server_permissions(client, app, role, expected):
    login(client, app)
    content = workbook()
    batch = upload(client, app, content).json()
    login(client, app, role)
    response = client.get(f"/api/imports/{batch['id']}/source")
    assert response.status_code == expected
    assert client.get(f"/api/imports/{batch['id']}").status_code == expected
    if expected == 200:
        assert response.content == content and response.headers["cache-control"] == "no-store"


def test_cross_scope_and_revoked_access_are_rechecked(client, app):
    session = login(client, app)
    batch = upload(client, app).json()
    foreign = uuid.uuid4()
    with app.state.session_factory.begin() as db:
        context = db.scalar(select(ImportContext))
        db.add(Scope(id=foreign, name="Synthetic foreign scope", is_demo=True)); db.flush()
        context.scope_id = foreign
    assert client.get(f"/api/imports/{batch['id']}").status_code == 403
    assert apply(client, batch).status_code == 403


def test_stale_context_and_row_revision_are_rejected(client, app):
    login(client, app)
    first = upload(client, app).json()
    competing = upload(client, app).json()
    assert apply(client, first).status_code == 200
    assert apply(client, competing).status_code == 409
    assert client.get(f"/api/imports/{competing['id']}").json()["stale"] is True
    fresh = upload(client, app).json()
    assert review(client, fresh, {"room": "101"}).status_code == 200
    assert review(client, fresh, {"room": "102"}).status_code == 409


def test_apply_rollback_leaves_no_partial_references_or_demands(client, app, monkeypatch):
    login(client, app)
    second = list(ROW); second[1] = "Екінші синтетикалық пән"
    batch = upload(client, app, workbook([ROW, second])).json()
    for index in range(2):
        batch = review(client, batch, {"room": "101", "whole_group": True}, True, index).json()
    original = ImportService.reference
    calls = []
    def injected(self, *args, **kwargs):
        calls.append(1)
        if len(calls) == 4:
            raise ApiError("TEST_ROLLBACK", 409)
        return original(self, *args, **kwargs)
    monkeypatch.setattr(ImportService, "reference", injected)
    assert apply(client, batch).status_code == 409
    assert count(app, TeachingDemand) == count(app, DemandRevision) == count(app, TeachingAssignment) == 0
    assert count(app, Teacher) == 1
    assert client.get(f"/api/imports/{batch['id']}").json()["status"] == "preview"


def test_concurrent_apply_of_same_batch_is_idempotent(client, app):
    login(client, app)
    batch = upload(client, app).json()
    def request(_):
        with TestClient(app, base_url="http://127.0.0.1:8000") as parallel:
            login(parallel, app)
            return apply(parallel, batch).status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert list(pool.map(request, range(2))) == [200, 200]
    assert count(app, TeachingDemand) == count(app, DemandRevision) == 1


def test_duplicate_natural_key_is_preserved_without_inventing_demands(client, app):
    login(client, app)
    batch = upload(client, app, workbook([ROW, ROW])).json()
    assert batch["summary"]["duplicate_rows"] == 2
    assert apply(client, batch).status_code == 200
    assert count(app, ImportRow) == 2 and count(app, TeachingDemand) == 0
    with app.state.session_factory() as db:
        context = db.scalar(select(ImportContext))
        assert len(ImportService.unresolved_for_context(db, context.id)) == 2
    other = list(ROW); other[3] = "TEST-B"
    other_batch = upload(client, app, workbook([other])).json()
    assert apply(client, other_batch).status_code == 200
    with app.state.session_factory() as db:
        # Disappearing ambiguous source rows do not silently clear their blockers.
        assert len(ImportService.unresolved_for_context(db, context.id, {"TEST-A"})) == 2
        assert len(ImportService.unresolved_for_context(db, context.id, {"TEST-B"})) == 1
    single = upload(client, app).json()
    single = review(client, single, {"room": "101", "whole_group": True}, True).json()
    assert apply(client, single).status_code == 200
    with app.state.session_factory() as db:
        assert ImportService.unresolved_for_context(db, context.id, {"TEST-A"}) == []
        assert ImportService.unresolved_for_context(db, context.id, {"TEST-B"})


def test_concurrent_different_batches_cannot_overwrite_a_stale_context(client, app):
    login(client, app)
    batches = [upload(client, app).json(), upload(client, app).json()]
    def request(index):
        with TestClient(app, base_url="http://127.0.0.1:8000") as parallel:
            login(parallel, app)
            return apply(parallel, batches[index]).status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(request, range(2))) == [200, 409]
    assert count(app, TeachingDemand) == count(app, DemandRevision) == 1


def test_synthetic_and_college_contexts_are_separate(client, app):
    login(client, app)
    synthetic = upload(client, app).json()
    college = upload(client, app, data_kind="college").json()
    assert apply(client, synthetic).status_code == apply(client, college).status_code == 200
    assert count(app, ImportContext) == count(app, TeachingDemand) == 2


@pytest.mark.parametrize("filename,content,expected", [("book.xlsm", workbook(), "IMPORT_FILE_TYPE"), ("broken.xlsx", b"not-a-zip", "IMPORT_ARCHIVE_INVALID")])
def test_invalid_files_are_controlled_errors_without_business_changes(client, app, filename, content, expected):
    login(client, app)
    response = upload(client, app, content, filename)
    assert response.status_code == 422 and response.json()["error"]["code"] == expected
    assert count(app, ImportBatch) == count(app, TeachingDemand) == 0


def test_wrong_sheet_header_range_and_year_are_rejected(client, app):
    login(client, app)
    assert upload(client, app, sheet="missing").json()["error"]["code"] == "IMPORT_SHEET_MISSING"
    changed = modify_zip(workbook(), "xl/worksheets/sheet1.xml", lambda xml: xml.replace("Мұғалім".encode(), b"wrong"))
    assert upload(client, app, changed).json()["error"]["code"] == "IMPORT_HEADER_MISMATCH"
    assert upload(client, app, last_row="1048570").status_code == 422
    assert upload(client, app, academic_year="2026-2029").status_code == 422


def test_formula_without_cache_is_preserved_never_executed(client, app):
    login(client, app)
    row = list(ROW); row[6] = "=1+1"
    batch = upload(client, app, workbook([row])).json()
    stored = batch["rows"][0]
    assert stored["raw"]["weekly_hours"]["formula"] == "=1+1"
    assert stored["normalized"]["weekly_hours"] is None
    assert any(issue["code"] == "FORMULA_NO_CACHE" and issue["coordinate"] == "G2" for issue in stored["issues"])


def test_entity_xml_macro_and_zip_bomb_are_rejected_before_parsing():
    content = workbook()
    entity = modify_zip(content, "xl/workbook.xml", lambda xml: b'<!DOCTYPE x [<!ENTITY bad "value">]>' + xml)
    with pytest.raises(ImportFileError, match="IMPORT_ARCHIVE_INVALID"):
        inspect_archive(entity, "book.xlsx")
    for name, value, code in [("xl/vbaProject.bin", b"macro", "IMPORT_MACROS_REJECTED"), ("xl/bomb.xml", b"0" * 2000000, "IMPORT_ARCHIVE_LIMIT")]:
        out = BytesIO(content)
        with zipfile.ZipFile(out, "a", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(name, value)
        with pytest.raises(ImportFileError, match=code):
            inspect_archive(out.getvalue(), "book.xlsx")


def test_oversized_upload_is_rejected(client, app):
    login(client, app)
    response = upload(client, app, b"0" * (10 * 1024 * 1024 + 1))
    assert response.status_code == 413
    assert count(app, ImportBatch) == 0

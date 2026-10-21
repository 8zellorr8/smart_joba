import re
import uuid
from typing import Literal
from urllib.parse import quote

from fastapi import APIRouter, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field, StrictBool, ValidationError, model_validator
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.exceptions import HTTPException

from ..application.auth import ApiError
from ..infrastructure.s1_excel import MAX_FILE_BYTES


class UploadContext(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)
    academic_year: str = Field(pattern=r"^20\d{2}-20\d{2}$")
    data_kind: Literal["college", "synthetic"]
    sheet: str = Field(default="Жүктеме", min_length=1, max_length=31)
    last_row: int = Field(default=237, ge=2, le=5000)
    hour_unit: Literal["source_hour", "academic_hour", "pair", "minute"] = "source_hour"
    template: Literal["s1-v1"] = "s1-v1"

    @model_validator(mode="after")
    def adjacent_years(self):
        if int(self.academic_year[5:]) != int(self.academic_year[:4]) + 1:
            raise ValueError("Academic years must be consecutive")
        return self


class Corrections(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)
    teacher: str | None = Field(default=None, max_length=160)
    subject: str | None = Field(default=None, max_length=2000)
    index: str | None = Field(default=None, max_length=2000)
    group: str | None = Field(default=None, max_length=80)
    course: str | None = Field(default=None, max_length=32)
    room: str | None = Field(default=None, max_length=80)
    weekly_hours: str | None = Field(default=None, max_length=32)
    subgroup: str | None = Field(default=None, max_length=160)
    specialty: str | None = Field(default=None, max_length=2000)
    qualification: str | None = Field(default=None, max_length=2000)
    semester_hours: str | None = Field(default=None, max_length=32)
    semester: str | None = Field(default=None, max_length=32)
    whole_group: StrictBool = False


class ReviewBody(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)
    expected_revision: int = Field(ge=1)
    corrections: Corrections
    references_confirmed: StrictBool


class ApplyBody(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)
    expected_revision: int = Field(ge=1)
    confirmed: Literal[True]


def import_router(service):
    router = APIRouter()

    def token(request):
        return request.cookies.get("smart_joba_session")

    @router.get("/api/scopes/{scope_id}/imports")
    def list_batches(scope_id: uuid.UUID, request: Request):
        return service.list(token(request), scope_id)

    @router.post("/api/scopes/{scope_id}/imports/s1", status_code=201)
    async def preview(scope_id: uuid.UUID, request: Request):
        with service.factory() as db:
            service.authorize(db, token(request), scope_id, write=True)
        try:
            async with request.form(max_files=1, max_fields=6, max_part_size=MAX_FILE_BYTES) as form:
                if len(form.multi_items()) != len(form):
                    raise ApiError("IMPORT_CONTEXT_INVALID", 422)
                upload = form.get("file")
                if not isinstance(upload, UploadFile) or not upload.filename:
                    raise ApiError("IMPORT_FILE_REQUIRED", 422)
                context = UploadContext.model_validate({key: value for key, value in form.items() if key != "file"})
                filename = re.split(r"[/\\]", upload.filename)[-1]
                if not filename or len(filename) > 255 or any(ord(char) < 32 for char in filename):
                    raise ApiError("IMPORT_FILE_TYPE", 422)
                content = await upload.read(MAX_FILE_BYTES + 1)
                if len(content) > MAX_FILE_BYTES:
                    raise ApiError("IMPORT_FILE_TOO_LARGE", 413)
                return await run_in_threadpool(service.create, token(request), scope_id, content, filename,
                    context.sheet, context.last_row, context.academic_year, context.data_kind, context.hour_unit,
                    request.state.request_id)
        except (ValidationError, ValueError, HTTPException):
            raise ApiError("IMPORT_CONTEXT_INVALID", 422) from None

    @router.get("/api/imports/{batch_id}")
    def get_batch(batch_id: uuid.UUID, request: Request, offset: int = Query(0, ge=0), limit: int = Query(25, ge=1, le=100)):
        return service.get(token(request), batch_id, offset, limit)

    @router.post("/api/imports/{batch_id}/rows/{row_id}/review")
    def review_row(batch_id: uuid.UUID, row_id: uuid.UUID, body: ReviewBody, request: Request):
        return service.revise(token(request), batch_id, row_id, body.expected_revision,
                              body.corrections.model_dump(exclude_unset=True), body.references_confirmed, request.state.request_id)

    @router.post("/api/imports/{batch_id}/apply")
    def apply_batch(batch_id: uuid.UUID, body: ApplyBody, request: Request):
        return service.apply(token(request), batch_id, body.expected_revision, request.state.request_id)

    @router.get("/api/imports/{batch_id}/rows/{row_id}/history")
    def history(batch_id: uuid.UUID, row_id: uuid.UUID, request: Request):
        return service.history(token(request), batch_id, row_id)

    @router.get("/api/imports/{batch_id}/source")
    def original(batch_id: uuid.UUID, request: Request):
        filename, content = service.source(token(request), batch_id)
        return Response(content, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                        headers={"Content-Disposition": "attachment; filename=source.xlsx; filename*=UTF-8''" + quote(filename, safe="")})

    return router

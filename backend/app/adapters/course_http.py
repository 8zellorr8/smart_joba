import uuid
from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, File, Form, Request, Response, UploadFile
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from ..application.auth import ApiError
from ..application.courses import MAX_PDF_BYTES

Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=160)]


class TopicInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: uuid.UUID
    title: Title
    week_number: int | None = Field(default=None, ge=1, le=10, strict=True)


def material_payload(text, file):
    if (text is None) == (file is None):
        raise ApiError("VALIDATION_ERROR", 422)
    if file is not None:
        pdf = file.file.read(MAX_PDF_BYTES + 1)
        if len(pdf) > MAX_PDF_BYTES:
            raise ApiError("REQUEST_TOO_LARGE", 413)
        if not (pdf.startswith(b"%PDF-") and pdf.rstrip().endswith(b"%%EOF")):
            raise ApiError("COURSE_PDF_INVALID", 422)
        return None, pdf
    text = text.strip()
    if not text:
        raise ApiError("VALIDATION_ERROR", 422)
    return text, None


def course_router(service):
    router = APIRouter(prefix="/api/scopes/{scope_id}/courses")

    def token(request):
        return request.cookies.get("smart_joba_session")

    @router.get("")
    def index(scope_id: uuid.UUID, request: Request):
        return service.courses(token(request), scope_id)

    @router.post("/{course_id}/open")
    def open_course(scope_id: uuid.UUID, course_id: uuid.UUID, request: Request):
        return service.open_course(token(request), scope_id, course_id)

    @router.get("/{course_id}")
    def contents(scope_id: uuid.UUID, course_id: uuid.UUID, request: Request):
        return service.contents(token(request), scope_id, course_id)

    @router.post("/{course_id}/topics")
    def topic(scope_id: uuid.UUID, course_id: uuid.UUID, body: TopicInput, request: Request):
        return service.add_topic(token(request), scope_id, course_id, body.id, body.title, body.week_number)

    @router.post("/{course_id}/topics/{topic_id}/materials")
    def add_material(scope_id: uuid.UUID, course_id: uuid.UUID, topic_id: uuid.UUID, request: Request,
                     id: Annotated[uuid.UUID, Form()], title: Annotated[str, Form(max_length=160)],
                     text: Annotated[str | None, Form(max_length=20000)] = None,
                     file: Annotated[UploadFile | None, File()] = None):
        title = title.strip()
        if not title:
            raise ApiError("VALIDATION_ERROR", 422)
        text, pdf = material_payload(text, file)
        return service.add_material(token(request), scope_id, course_id, topic_id, id, title, text, pdf)

    @router.get("/{course_id}/materials/{material_id}")
    def material(scope_id: uuid.UUID, course_id: uuid.UUID, material_id: uuid.UUID, request: Request):
        title, text, pdf = service.material(token(request), scope_id, course_id, material_id)
        if pdf is not None:
            return Response(pdf, media_type="application/pdf", headers={
                "Content-Disposition": "attachment; filename=material.pdf; filename*=UTF-8''" + quote(title + ".pdf", safe="")})
        return {"title": title, "text": text}

    @router.get("/{course_id}/materials/{material_id}/edit")
    def material_for_edit(scope_id: uuid.UUID, course_id: uuid.UUID, material_id: uuid.UUID, request: Request):
        return service.material_for_edit(token(request), scope_id, course_id, material_id)

    @router.put("/{course_id}/materials/{material_id}")
    def update_material(scope_id: uuid.UUID, course_id: uuid.UUID, material_id: uuid.UUID, request: Request,
                        expected_revision: Annotated[int, Form(ge=1)], title: Annotated[str, Form(max_length=160)],
                        text: Annotated[str | None, Form(max_length=20000)] = None,
                        file: Annotated[UploadFile | None, File()] = None):
        title = title.strip()
        if not title or (text is not None and file is not None):
            raise ApiError("VALIDATION_ERROR", 422)
        if text is not None or file is not None:
            text, pdf = material_payload(text, file)
        else:
            text, pdf = None, None
        return service.update_material(token(request), scope_id, course_id, material_id,
            expected_revision, title, text, pdf)

    return router

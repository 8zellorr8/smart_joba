import uuid
from datetime import date
from typing import Annotated, Literal

from fastapi import APIRouter, File, Form, Query, Request, Response, UploadFile
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator
from ..application.auth import ApiError
from .course_http import Title, material_payload

Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=20000)]


class TaskInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: uuid.UUID
    topic_id: uuid.UUID
    title: Title
    instructions: Text
    due_on: date | None = None


class TaskUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: uuid.UUID
    expected_revision: int = Field(ge=1, strict=True)
    title: Title
    instructions: Text
    due_on: date | None = None


class ReviewInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: uuid.UUID
    expected_revision: int = Field(ge=0, strict=True)
    outcome: Literal["graded", "returned"]
    grade: int | None = Field(default=None, ge=0, le=100, strict=True)
    feedback: Annotated[str, StringConstraints(strip_whitespace=True, max_length=4000)] = ""
    reason: Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)] = ""

    @model_validator(mode="after")
    def result_matches(self):
        if self.outcome == "graded" and self.grade is None:
            raise ValueError("A grade is required")
        if self.outcome == "returned" and (self.grade is not None or not self.feedback):
            raise ValueError("Return requires feedback and no grade")
        return self


class Cursor(BaseModel):
    model_config = ConfigDict(extra="forbid")
    after: uuid.UUID | None = None


def task_router(service):
    router = APIRouter(prefix="/api/scopes/{scope_id}/courses/{course_id}/tasks")
    def token(request):
        return request.cookies.get("smart_joba_session")

    @router.post("")
    def create(scope_id: uuid.UUID, course_id: uuid.UUID, body: TaskInput, request: Request):
        return service.create(token(request), scope_id, course_id, body.model_dump())

    @router.put("/{task_id}")
    def update(scope_id: uuid.UUID, course_id: uuid.UUID, task_id: uuid.UUID, body: TaskUpdate, request: Request):
        return service.update(token(request), scope_id, course_id, task_id, body.model_dump())

    @router.get("/{task_id}")
    def detail(scope_id: uuid.UUID, course_id: uuid.UUID, task_id: uuid.UUID, request: Request):
        return service.details(token(request), scope_id, course_id, task_id)

    @router.get("/{task_id}/submissions")
    def submissions(scope_id: uuid.UUID, course_id: uuid.UUID, task_id: uuid.UUID, request: Request, cursor: Annotated[Cursor, Query()]):
        return service.submissions(token(request), scope_id, course_id, task_id, cursor.after)

    @router.post("/{task_id}/submissions")
    def submit(scope_id: uuid.UUID, course_id: uuid.UUID, task_id: uuid.UUID, request: Request,
               id: Annotated[uuid.UUID, Form()], expected_attempt: Annotated[int, Form(ge=0)],
               text: Annotated[str | None, Form(max_length=20000)] = None,
               file: Annotated[UploadFile | None, File()] = None):
        body, pdf = material_payload(text, file)
        return service.submit(token(request), scope_id, course_id, task_id, id, expected_attempt, body, pdf)

    @router.get("/{task_id}/submissions/{submission_id}")
    def attempts(scope_id: uuid.UUID, course_id: uuid.UUID, task_id: uuid.UUID, submission_id: uuid.UUID, request: Request):
        return service.student_attempts(token(request), scope_id, course_id, task_id, submission_id)

    @router.post("/{task_id}/submissions/{submission_id}/reviews")
    def review(scope_id: uuid.UUID, course_id: uuid.UUID, task_id: uuid.UUID, submission_id: uuid.UUID, body: ReviewInput, request: Request):
        return service.review(token(request), scope_id, course_id, task_id, submission_id, body.model_dump())

    @router.get("/{task_id}/submissions/{submission_id}/pdf")
    def pdf(scope_id: uuid.UUID, course_id: uuid.UUID, task_id: uuid.UUID, submission_id: uuid.UUID, request: Request):
        return Response(service.download(token(request), scope_id, course_id, task_id, submission_id),
                        media_type="application/pdf", headers={"Content-Disposition": 'attachment; filename="submission.pdf"'})

    return router

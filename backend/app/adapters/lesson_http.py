import uuid
from typing import Annotated, Literal, Union

from fastapi import APIRouter, Query, Request
from pydantic import Field, StrictBool

from .journal_http import Contract


class Attendance(Contract):
    student_id: uuid.UUID
    value: Literal["present", "absent", "late", "excused"] | None


class Grade(Contract):
    student_id: uuid.UUID
    value: Annotated[int, Field(strict=True, ge=0, le=100)] | None


class EventRef(Contract):
    journal_id: uuid.UUID
    publication_id: uuid.UUID
    event_id: uuid.UUID


class RecordLesson(EventRef):
    kind: Literal["record_lesson"]
    topic: str = Field(max_length=2000)
    conducted: StrictBool
    attendance: list[Attendance] = Field(default_factory=list, max_length=100)
    grades: list[Grade] = Field(default_factory=list, max_length=100)
    reason: str = Field(default="", max_length=500)


class UpdateLesson(Contract):
    kind: Literal["update_lesson"]
    lesson_id: uuid.UUID
    topic: str | None = Field(default=None, max_length=2000)
    attendance: list[Attendance] = Field(default_factory=list, max_length=100)
    grades: list[Grade] = Field(default_factory=list, max_length=100)
    reason: str = Field(default="", max_length=500)


class ResolveEvent(EventRef):
    kind: Literal["resolve_event"]
    lesson_id: uuid.UUID | None
    reason: str = Field(min_length=1, max_length=500)


class CorrectRoster(Contract):
    kind: Literal["correct_roster"]
    lesson_id: uuid.UUID
    student_ids: list[uuid.UUID] = Field(min_length=1, max_length=100)
    reason: str = Field(min_length=1, max_length=500)


class Envelope(Contract):
    operation_id: uuid.UUID
    expected_revision: int = Field(strict=True, ge=0)
    expected_registry_revision: int = Field(strict=True, ge=0)


class LessonCommand(Envelope):
    command: Annotated[Union[RecordLesson, UpdateLesson], Field(discriminator="kind")]


class AdminCommand(Envelope):
    command: Annotated[Union[ResolveEvent, CorrectRoster], Field(discriminator="kind")]


def lesson_router(service):
    router = APIRouter(prefix="/api/scopes/{scope_id}/journal")

    def token(request):
        return request.cookies.get("smart_joba_session")

    @router.get("/journals/{journal_id}/lessons")
    def lessons(scope_id: uuid.UUID, journal_id: uuid.UUID, request: Request, offset: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=100)):
        return service.list(token(request), scope_id, journal_id, offset, limit)

    @router.get("/journals/{journal_id}/event")
    def event(scope_id: uuid.UUID, journal_id: uuid.UUID, request: Request, publication_id: uuid.UUID, event_id: uuid.UUID):
        return service.preview(token(request), scope_id, journal_id, publication_id, event_id)

    @router.get("/lessons/{lesson_id}")
    def lesson(scope_id: uuid.UUID, lesson_id: uuid.UUID, request: Request):
        return service.get(token(request), scope_id, lesson_id)

    @router.get("/lessons/{lesson_id}/history")
    def history(scope_id: uuid.UUID, lesson_id: uuid.UUID, request: Request, offset: int = Query(0, ge=0)):
        return service.history(token(request), scope_id, lesson_id, offset)

    @router.post("/lesson-commands")
    def command(scope_id: uuid.UUID, request: Request, body: LessonCommand):
        return service.command(token(request), scope_id, body.model_dump(mode="json"), request.state.request_id)

    @router.get("/lesson-admin/journals/{journal_id}")
    def admin_lessons(scope_id: uuid.UUID, journal_id: uuid.UUID, request: Request, offset: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=100), recorded_only: bool = False):
        return service.list(token(request), scope_id, journal_id, offset, limit, admin=True, recorded_only=recorded_only)

    @router.get("/lesson-admin/lessons/{lesson_id}/roster")
    def admin_roster(scope_id: uuid.UUID, lesson_id: uuid.UUID, request: Request):
        return service.admin_roster(token(request), scope_id, lesson_id)

    @router.post("/lesson-admin/commands")
    def admin_command(scope_id: uuid.UUID, request: Request, body: AdminCommand):
        return service.command(token(request), scope_id, body.model_dump(mode="json"), request.state.request_id, admin=True)

    return router

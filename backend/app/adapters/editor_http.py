import uuid
from datetime import date
from typing import Literal

from fastapi import APIRouter, Query, Request
from pydantic import Field, StrictBool

from .calendar_http import Clock, Contract, Pattern


class RoomBody(Contract):
    code: str = Field(min_length=1, max_length=80)
    data_kind: Literal["college", "synthetic"]
    exclusive: StrictBool | None = None
    confirmed: StrictBool = False
    source: str = Field(default="", max_length=300)


class RoomReview(RoomBody):
    expected_revision: int = Field(strict=True, ge=1)


class DraftBody(Contract):
    context_id: uuid.UUID
    name: str = Field(min_length=1, max_length=160)


class Dependencies(Contract):
    context_revision: int = Field(strict=True, ge=0)
    calendars: dict[uuid.UUID, int | None] = Field(default_factory=dict, max_length=200)
    rooms: dict[uuid.UUID, int | None] = Field(default_factory=dict, max_length=200)


class ExpectedDraft(Contract):
    expected_revision: int = Field(strict=True, ge=1)
    expected_dependencies: Dependencies


class SeriesBody(ExpectedDraft):
    assignment_id: uuid.UUID
    assignment_revision: int = Field(strict=True, ge=1)
    calendar_id: uuid.UUID
    calendar_revision: int = Field(strict=True, ge=1)
    room_id: uuid.UUID
    room_revision: int = Field(strict=True, ge=1)
    pattern: Pattern


class OneDateBody(ExpectedDraft):
    date: date
    start: Clock
    end: Clock
    room_id: uuid.UUID
    room_revision: int = Field(strict=True, ge=1)
    cancelled: StrictBool
    pinned: StrictBool


def editor_router(service):
    router = APIRouter()

    def token(request):
        return request.cookies.get("smart_joba_session")

    @router.get("/api/scopes/{scope_id}/editor-data")
    def options(scope_id: uuid.UUID, request: Request):
        return service.options(token(request), scope_id)

    @router.post("/api/scopes/{scope_id}/rooms", status_code=201)
    def room_create(scope_id: uuid.UUID, body: RoomBody, request: Request):
        return service.room_save(token(request), scope_id, body.model_dump(mode="json"), request.state.request_id)

    @router.post("/api/rooms/{room_id}")
    def room_review(room_id: uuid.UUID, body: RoomReview, request: Request):
        return service.room_save(token(request), None, body.model_dump(mode="json"), request.state.request_id, room_id)

    @router.post("/api/scopes/{scope_id}/drafts", status_code=201)
    def draft_create(scope_id: uuid.UUID, body: DraftBody, request: Request):
        return service.create(token(request), scope_id, body.context_id, body.name, request.state.request_id)

    @router.get("/api/drafts/{draft_id}")
    def draft_get(draft_id: uuid.UUID, request: Request, start: date | None = None, end: date | None = None,
                  view: Literal["group", "teacher", "room"] = "group", resource_id: uuid.UUID | None = None,
                  offset: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=500)):
        return service.get(token(request), draft_id, start.isoformat() if start else None, end.isoformat() if end else None,
                           view, str(resource_id) if resource_id else None, offset, limit)

    @router.post("/api/drafts/{draft_id}/series", status_code=201)
    def series_create(draft_id: uuid.UUID, body: SeriesBody, request: Request):
        return service.save_series(token(request), draft_id, body.model_dump(mode="json"), request.state.request_id)

    @router.post("/api/drafts/{draft_id}/series/{series_id}")
    def series_update(draft_id: uuid.UUID, series_id: uuid.UUID, body: SeriesBody, request: Request):
        return service.save_series(token(request), draft_id, body.model_dump(mode="json"), request.state.request_id, series_id)

    @router.post("/api/drafts/{draft_id}/occurrences/{occurrence_id}")
    def occurrence_update(draft_id: uuid.UUID, occurrence_id: uuid.UUID, body: OneDateBody, request: Request):
        return service.save_one(token(request), draft_id, str(occurrence_id), body.model_dump(mode="json"), request.state.request_id)

    return router

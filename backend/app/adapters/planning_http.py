import uuid
from datetime import date
from typing import Annotated, Literal

from fastapi import APIRouter, Request
from pydantic import Field, StrictBool

from .calendar_http import Clock, Contract

Positive = Annotated[int, Field(strict=True, ge=1, le=10000)]
Features = Annotated[list[Annotated[str, Field(min_length=1, max_length=60)]], Field(max_length=30)]


class Availability(Contract):
    resource_type: Literal["teacher", "room"]
    resource_id: uuid.UUID
    start_date: date
    end_date: date
    weekdays: list[Annotated[int, Field(strict=True, ge=0, le=6)]] = Field(min_length=1, max_length=7)
    start: Clock
    end: Clock


class Busy(Contract):
    resource_type: Literal["teacher", "group", "room"]
    resource_id: uuid.UUID
    date: date
    start: Clock
    end: Clock
    source: str = Field(min_length=1, max_length=300)


class GroupSize(Contract):
    group_id: uuid.UUID
    size: Positive | None


class RoomProperties(Contract):
    room_id: uuid.UUID
    capacity: Positive | None
    features: Features


class RoomNeed(Contract):
    demand_id: uuid.UUID
    features: Features


class RulesDocument(Contract):
    confirmed: StrictBool
    source: str = Field(max_length=300)
    external_confirmed: StrictBool = False
    external_source: str = Field(default="", max_length=300)
    groups: list[GroupSize] = Field(max_length=200)
    rooms: list[RoomProperties] = Field(max_length=200)
    needs: list[RoomNeed] = Field(max_length=200)
    availability: list[Availability] = Field(max_length=400)
    busy: list[Busy] = Field(default_factory=list, max_length=500)


class RulesBody(Contract):
    expected_revision: int = Field(strict=True, ge=0)
    document: RulesDocument


class Selection(Contract):
    context_id: uuid.UUID
    group_ids: list[uuid.UUID] = Field(min_length=1, max_length=20)
    room_ids: list[uuid.UUID] = Field(min_length=1, max_length=30)
    semester: int = Field(strict=True, ge=1, le=20)
    base_draft_id: uuid.UUID | None = None


class CreateJob(Selection):
    token: str = Field(pattern=r"^[0-9a-f]{64}$")
    seconds: int = Field(default=30, strict=True, ge=1, le=30)


class ValidateBody(Contract):
    expected_revision: int = Field(strict=True, ge=1)
    group_ids: list[uuid.UUID] = Field(min_length=1, max_length=20)
    room_ids: list[uuid.UUID] = Field(min_length=1, max_length=30)
    semester: int = Field(strict=True, ge=1, le=20)


def planning_router(service):
    router = APIRouter()
    def token(request): return request.cookies.get("smart_joba_session")

    @router.get("/api/scopes/{scope_id}/planning-data")
    def options(scope_id: uuid.UUID, request: Request):
        return service.inputs.options(token(request), scope_id)

    @router.post("/api/planning-contexts/{context_id}/rules")
    def rules(context_id: uuid.UUID, body: RulesBody, request: Request):
        return service.inputs.save_rules(token(request), context_id, body.model_dump(mode="json"), request.state.request_id)

    @router.post("/api/scopes/{scope_id}/generation-preview")
    def preview(scope_id: uuid.UUID, body: Selection, request: Request):
        return service.inputs.preview(token(request), scope_id, body.model_dump(mode="json"))

    @router.post("/api/scopes/{scope_id}/solver-jobs", status_code=201)
    def create(scope_id: uuid.UUID, body: CreateJob, request: Request):
        return service.create(token(request), scope_id, body.model_dump(mode="json"), request.state.request_id)

    @router.get("/api/scopes/{scope_id}/solver-jobs")
    def jobs(scope_id: uuid.UUID, request: Request):
        return service.list(token(request), scope_id)

    @router.get("/api/solver-jobs/{job_id}")
    def get(job_id: uuid.UUID, request: Request): return service.get(token(request), job_id)

    @router.post("/api/solver-jobs/{job_id}/cancel")
    def cancel(job_id: uuid.UUID, request: Request): return service.cancel(token(request), job_id, request.state.request_id)

    @router.post("/api/drafts/{draft_id}/validate", status_code=201)
    def validate(draft_id: uuid.UUID, body: ValidateBody, request: Request):
        return service.validate(token(request), draft_id, body.model_dump(mode="json"), request.state.request_id)

    @router.get("/api/drafts/{draft_id}/validations")
    def reports(draft_id: uuid.UUID, request: Request): return service.reports(token(request), draft_id)

    return router

import uuid
from datetime import date
from typing import Annotated, Literal

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, ConfigDict, Field, StrictBool, model_validator

from .import_http import UploadContext


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)


class Period(Contract):
    start: date
    end: date
    kind: Literal["theory", "practice", "vacation", "attestation", "nonstudy", "unknown"]
    label: str = Field(default="", max_length=160)
    semester: int | None = Field(default=None, strict=True, ge=1, le=20)


Clock = Annotated[str, Field(pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")]


class Slot(Contract):
    id: str = Field(min_length=1, max_length=40)
    label: str = Field(min_length=1, max_length=80)
    start: Clock
    end: Clock


class ExceptionDay(Contract):
    date: date
    allowed: StrictBool
    reason: str = Field(min_length=1, max_length=300)


class CalendarDocument(Contract):
    start: date
    end: date
    timezone: str = Field(default="Asia/Almaty", min_length=1, max_length=80)
    academic_minutes: int = Field(default=45, strict=True, ge=1, le=240)
    pair_minutes: int = Field(default=90, strict=True, ge=1, le=480)
    confirmed: StrictBool = False
    source: str = Field(default="", max_length=300)
    units_confirmed: StrictBool = False
    units_source: str = Field(default="", max_length=300)
    timezone_confirmed: StrictBool = False
    timezone_source: str = Field(default="", max_length=300)
    periods: list[Period] = Field(default_factory=list, max_length=150)
    slots: list[Slot] = Field(default_factory=list, max_length=20)
    exceptions: list[ExceptionDay] = Field(default_factory=list, max_length=100)


class CreateCalendar(Contract):
    academic_year: str = Field(pattern=r"^20\d{2}-20\d{2}$")
    data_kind: Literal["college", "synthetic"]
    group_id: uuid.UUID
    document: CalendarDocument

    @model_validator(mode="after")
    def consecutive_years(self):
        UploadContext(academic_year=self.academic_year, data_kind=self.data_kind)
        return self


class UpdateCalendar(Contract):
    expected_revision: int = Field(strict=True, ge=1)
    expected_context_revision: int = Field(strict=True, ge=0)
    document: CalendarDocument


class Pattern(Contract):
    id: str = Field(min_length=1, max_length=40)
    start: date
    end: date
    slot_id: str = Field(min_length=1, max_length=40)
    weekdays: list[Annotated[int, Field(strict=True, ge=0, le=6)]] = Field(default_factory=list, max_length=7)
    dates: list[date] = Field(default_factory=list, max_length=732)
    cancelled_dates: list[date] = Field(default_factory=list, max_length=732)

    @model_validator(mode="after")
    def explicit_repeat(self):
        if bool(self.dates) == bool(self.weekdays) or len(set(self.weekdays)) != len(self.weekdays):
            raise ValueError("Choose explicit dates or weekdays")
        return self


class PreviewPlan(Contract):
    expected_revision: int = Field(strict=True, ge=1)
    expected_context_revision: int = Field(strict=True, ge=0)
    patterns: list[Pattern] = Field(min_length=1, max_length=30)
    demand_id: uuid.UUID | None = None


def calendar_router(service):
    router = APIRouter()

    def token(request):
        return request.cookies.get("smart_joba_session")

    @router.get("/api/scopes/{scope_id}/calendar-data")
    def options(scope_id: uuid.UUID, request: Request):
        return service.options(token(request), scope_id)

    @router.post("/api/scopes/{scope_id}/calendars", status_code=201)
    def create(scope_id: uuid.UUID, body: CreateCalendar, request: Request):
        return service.create(token(request), scope_id, body.academic_year, body.data_kind,
                              body.group_id, body.document.model_dump(mode="json"), request.state.request_id)

    @router.get("/api/calendars/{profile_id}")
    def get(profile_id: uuid.UUID, request: Request):
        return service.get(token(request), profile_id)

    @router.post("/api/calendars/{profile_id}")
    def update(profile_id: uuid.UUID, body: UpdateCalendar, request: Request):
        return service.update(token(request), profile_id, body.expected_revision, body.expected_context_revision,
                              body.document.model_dump(mode="json"), request.state.request_id)

    @router.get("/api/calendars/{profile_id}/dates")
    def dates(profile_id: uuid.UUID, request: Request, start: date = Query(), end: date = Query()):
        return service.dates(token(request), profile_id, start.isoformat(), end.isoformat())

    @router.get("/api/calendars/{profile_id}/history")
    def history(profile_id: uuid.UUID, request: Request):
        return service.history(token(request), profile_id)

    @router.post("/api/calendars/{profile_id}/preview")
    def preview(profile_id: uuid.UUID, body: PreviewPlan, request: Request):
        return service.preview(token(request), profile_id, body.expected_revision, body.expected_context_revision,
                               [p.model_dump(mode="json") for p in body.patterns], body.demand_id)

    return router

import uuid
from datetime import date
from typing import Annotated, Literal, Union

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, ConfigDict, Field, StrictBool


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)


class CreateStudent(Contract):
    kind: Literal["create_student"]
    display_name: str = Field(min_length=1, max_length=160)
    data_kind: Literal["college", "synthetic"]


class RenameStudent(Contract):
    kind: Literal["rename_student"]
    student_id: uuid.UUID
    display_name: str = Field(min_length=1, max_length=160)
    reason: str = Field(min_length=1, max_length=500)


class Evidence(Contract):
    source: str = Field(min_length=1, max_length=300)
    confirmed: StrictBool
    reason: str = Field(default="", max_length=500)


class Membership(Evidence):
    kind: Literal["save_membership"]
    id: uuid.UUID | None = None
    student_id: uuid.UUID
    context_id: uuid.UUID
    group_id: uuid.UUID
    start: date
    end: date


class Binding(Evidence):
    kind: Literal["bind_account"]
    user_id: uuid.UUID
    student_id: uuid.UUID | None


class SyncGroup(Contract):
    kind: Literal["sync_schedule_group"]
    membership_id: uuid.UUID
    reason: str = Field(min_length=1, max_length=500)


class CreateJournal(Evidence):
    kind: Literal["create_journal"]
    demand_id: uuid.UUID


class Assignment(Evidence):
    kind: Literal["save_assignment"]
    id: uuid.UUID | None = None
    journal_id: uuid.UUID
    teacher_id: uuid.UUID
    start: date
    end: date
    active: StrictBool = True


class SetupCommand(Contract):
    operation_id: uuid.UUID
    expected_revision: int = Field(strict=True, ge=0)
    command: Annotated[Union[CreateStudent, RenameStudent, Membership, Binding, SyncGroup, CreateJournal, Assignment], Field(discriminator="kind")]


def journal_router(service):
    router = APIRouter()

    def token(request):
        return request.cookies.get("smart_joba_session")

    @router.get("/api/scopes/{scope_id}/journal/setup")
    def setup(scope_id: uuid.UUID, request: Request):
        return service.setup(token(request), scope_id)

    @router.post("/api/scopes/{scope_id}/journal/commands")
    def command(scope_id: uuid.UUID, body: SetupCommand, request: Request):
        return service.command(token(request), scope_id, body.model_dump(mode="json"), request.state.request_id)

    @router.get("/api/scopes/{scope_id}/journal/history")
    def history(scope_id: uuid.UUID, request: Request, before_revision: int | None = Query(default=None, ge=1)):
        return service.history(token(request), scope_id, before_revision)

    @router.get("/api/scopes/{scope_id}/journal/journals")
    def journals(scope_id: uuid.UUID, request: Request):
        return service.journals(token(request), scope_id)

    @router.get("/api/scopes/{scope_id}/journal/journals/{journal_id}/roster")
    def roster(scope_id: uuid.UUID, journal_id: uuid.UUID, request: Request, on: date = Query()):
        return service.roster(token(request), scope_id, journal_id, on)

    @router.get("/api/scopes/{scope_id}/journal/me")
    def me(scope_id: uuid.UUID, request: Request):
        return service.me(token(request), scope_id)

    return router

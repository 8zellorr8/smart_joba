import uuid
from datetime import date
from typing import Literal

from fastapi import APIRouter, Query, Request
from pydantic import Field

from .calendar_http import Contract


class ExpectedVersion(Contract):
    expected_revision: int = Field(strict=True, ge=1)
    expected_workflow_revision: int = Field(strict=True, ge=1)


class SubmitVersion(ExpectedVersion):
    group_ids: list[uuid.UUID] = Field(min_length=1, max_length=20)
    room_ids: list[uuid.UUID] = Field(min_length=1, max_length=30)
    semester: int = Field(strict=True, ge=1, le=20)


class DecideVersion(ExpectedVersion):
    submission_id: uuid.UUID
    comment: str = Field(default="", max_length=2000)


class ForkVersion(ExpectedVersion):
    name: str = Field(min_length=1, max_length=160)


class PublishVersion(ExpectedVersion):
    approval_id: uuid.UUID
    idempotency_key: uuid.UUID
    readiness_token: str = Field(pattern=r"^[0-9a-f]{64}$")


def publication_router(versions, publications):
    router = APIRouter()
    def token(request): return request.cookies.get("smart_joba_session")

    @router.get("/api/scopes/{scope_id}/schedule-versions")
    def version_list(scope_id: uuid.UUID, request: Request):
        return versions.list(token(request), scope_id)

    @router.get("/api/schedule-versions/{version_id}")
    def version_get(version_id: uuid.UUID, request: Request):
        return versions.get(token(request), version_id)

    @router.post("/api/drafts/{version_id}/submit")
    @router.post("/api/schedule-versions/{version_id}/submit")
    def submit(version_id: uuid.UUID, body: SubmitVersion, request: Request):
        return versions.submit(token(request), version_id, body.model_dump(mode="json"), request.state.request_id)

    @router.post("/api/schedule-versions/{version_id}/approve")
    def approve(version_id: uuid.UUID, body: DecideVersion, request: Request):
        return versions.decide(token(request), version_id, "approve", body.model_dump(mode="json"), request.state.request_id)

    @router.post("/api/schedule-versions/{version_id}/reject")
    def reject(version_id: uuid.UUID, body: DecideVersion, request: Request):
        return versions.decide(token(request), version_id, "reject", body.model_dump(mode="json"), request.state.request_id)

    @router.post("/api/schedule-versions/{version_id}/reopen")
    def reopen(version_id: uuid.UUID, body: ExpectedVersion, request: Request):
        return versions.reopen(token(request), version_id, body.model_dump(mode="json"), request.state.request_id)

    @router.post("/api/schedule-versions/{version_id}/fork", status_code=201)
    def fork(version_id: uuid.UUID, body: ForkVersion, request: Request):
        return versions.fork(token(request), version_id, body.model_dump(mode="json"), request.state.request_id)

    @router.get("/api/readiness")
    def readiness(request: Request, schedule_version_id: uuid.UUID, expected_revision: int = Query(ge=1)):
        return publications.readiness(token(request), schedule_version_id, expected_revision)

    @router.post("/api/schedule-versions/{version_id}/publish")
    def publish(version_id: uuid.UUID, body: PublishVersion, request: Request):
        return publications.publish(token(request), version_id, body.model_dump(mode="json"), request.state.request_id)

    @router.get("/api/scopes/{scope_id}/publications")
    def publication_list(scope_id: uuid.UUID, request: Request):
        return publications.list(token(request), scope_id)

    @router.get("/api/publications/{publication_id}")
    def publication_get(publication_id: uuid.UUID, request: Request, start: date | None = None, end: date | None = None,
                        view: Literal["group", "teacher", "room"] = "group", resource_id: uuid.UUID | None = None,
                        offset: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=500)):
        return publications.get(token(request), publication_id, start.isoformat() if start else None, end.isoformat() if end else None,
            view, str(resource_id) if resource_id else None, offset, limit)

    return router

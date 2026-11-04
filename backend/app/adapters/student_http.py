import uuid

from fastapi import APIRouter, Query, Request

from ..application.auth import ApiError


def student_router(service):
    router = APIRouter()

    @router.get("/api/scopes/{scope_id}/journal/me/results")
    def results(scope_id: uuid.UUID, request: Request,
                context_id: uuid.UUID | None = None, semester: int | None = Query(default=None, ge=1, le=20),
                subject_id: uuid.UUID | None = None, page: int = Query(default=1, ge=1, le=1000000),
                page_size: int = Query(default=20, ge=1, le=100),
                revision: str | None = Query(default=None, pattern="^[a-f0-9]{64}$")):
        allowed = {"context_id", "semester", "subject_id", "page", "page_size", "revision"}
        # No caller-supplied student identity, history switch, or duplicate keys.
        if set(request.query_params) - allowed or any(len(request.query_params.getlist(k)) != 1 for k in request.query_params):
            raise ApiError("VALIDATION_ERROR", 422)
        return service.read(request.cookies.get("smart_joba_session"), scope_id,
                            context_id, semester, subject_id, page, page_size, revision)

    return router

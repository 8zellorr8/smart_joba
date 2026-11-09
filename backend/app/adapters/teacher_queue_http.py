import uuid
from datetime import date, datetime

from fastapi import APIRouter, Query, Request


def teacher_queue_router(tasks, lessons):
    router = APIRouter(prefix="/api/scopes/{scope_id}/teacher/queue")

    @router.get("/submissions")
    def submissions(scope_id: uuid.UUID, request: Request, after_at: datetime | None = None, after_id: uuid.UUID | None = None, limit: int = Query(25, ge=1, le=25)):
        return tasks.pending(request.cookies.get("smart_joba_session"), scope_id, after_at, after_id, limit)

    @router.get("/attendance")
    def attendance(scope_id: uuid.UUID, request: Request, after_date: date | None = None, after_id: uuid.UUID | None = None, limit: int = Query(25, ge=1, le=25)):
        return lessons.pending_attendance(request.cookies.get("smart_joba_session"), scope_id, after_date, after_id, limit)

    return router

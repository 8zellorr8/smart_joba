import uuid
import re
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from starlette.exceptions import HTTPException
from starlette.staticfiles import StaticFiles

from .dto import HealthDTO, SessionDTO, UserDTO, WorkspaceDTO
from .import_http import import_router
from .calendar_http import calendar_router
from .editor_http import editor_router
from ..application.auth import ApiError, AuthService, audit
from ..application.imports import ImportService
from ..application.calendars import CalendarService
from ..application.editor import EditorService
from ..domain.calendar import CalendarError
from ..infrastructure.s1_excel import MAX_FILE_BYTES
from ..config import ROOT, Settings
from ..domain.permissions import permissions_for
from ..infrastructure.database import create_database
from ..infrastructure.models import Scope
from ..infrastructure.security import sign_csrf, valid_csrf

SESSION_COOKIE = "smart_joba_session"
CSRF_COOKIE = "smart_joba_csrf"


class LoginBody(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=256, repr=False)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    engine, session_factory = create_database(settings.database_url)
    auth = AuthService(session_factory, settings)
    app = FastAPI(title="Smart Joba API", version="0.1.0", docs_url=None, openapi_url="/api/openapi.json", redoc_url=None)
    app.state.settings, app.state.engine = settings, engine
    app.state.session_factory, app.state.auth = session_factory, auth
    app.add_middleware(CORSMiddleware, allow_origins=settings.origins, allow_credentials=True,
                       allow_methods=["GET", "POST", "OPTIONS"], allow_headers=["Content-Type", "X-CSRF-Token"])

    def error_response(request: Request, code: str, status: int, params=None):
        return JSONResponse({"error": {"code": code, "params": params or {}, "request_id": getattr(request.state, "request_id", str(uuid.uuid4()))}}, status_code=status,
                            headers={"Cache-Control": "no-store", "Retry-After": str(params["retry_after"])} if status == 429 else {"Cache-Control": "no-store"})

    @app.middleware("http")
    async def request_security(request: Request, call_next):
        request.state.request_id = str(uuid.uuid4())
        host = request.headers.get("host", "").lower()
        if host not in settings.authorities:
            return error_response(request, "HOST_INVALID", 400)
        if settings.local_only and request.client and request.client.host not in {"127.0.0.1", "::1", "testclient"}:
            return error_response(request, "ACCESS_DENIED", 403)
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            if request.headers.get("origin") not in settings.origins:
                return error_response(request, "ORIGIN_INVALID", 403)
            if not valid_csrf(request.headers.get("x-csrf-token", ""), request.cookies.get(CSRF_COOKIE, ""), settings.app_secret, request.cookies.get(SESSION_COOKIE, "")):
                return error_response(request, "CSRF_INVALID", 403)
            upload = re.fullmatch(r"/api/scopes/[^/]+/imports/s1", request.url.path)
            calendar_write = request.url.path.startswith("/api/calendars/") or bool(re.fullmatch(r"/api/scopes/[^/]+/calendars", request.url.path))
            editor_write = request.url.path.startswith(("/api/drafts/", "/api/rooms/")) or bool(re.fullmatch(r"/api/scopes/[^/]+/(drafts|rooms)", request.url.path))
            if request.url.path.startswith("/api/auth/") or upload or request.url.path.startswith("/api/imports/") or calendar_write or editor_write:
                limit = MAX_FILE_BYTES + 131072 if upload else (131072 if calendar_write or editor_write else (65536 if request.url.path.startswith("/api/imports/") else 8192))
                body = bytearray()
                async for chunk in request.stream():
                    body.extend(chunk)
                    if len(body) > limit:
                        return error_response(request, "REQUEST_TOO_LARGE", 413)
                request._body = bytes(body)
        response = await call_next(request)
        response.headers.update({"X-Request-ID": request.state.request_id, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
                                 "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"})
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(ApiError)
    async def api_error(request: Request, exc: ApiError):
        return error_response(request, exc.code, exc.status, exc.params)

    @app.exception_handler(CalendarError)
    async def calendar_error(request: Request, exc: CalendarError):
        return error_response(request, exc.code, 422)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        # Pydantic errors can contain the entire password/body; never serialize them.
        return error_response(request, "VALIDATION_ERROR", 422)

    @app.exception_handler(SQLAlchemyError)
    async def database_error(request: Request, exc: SQLAlchemyError):
        return error_response(request, "SERVICE_UNAVAILABLE", 503)

    @app.exception_handler(Exception)
    async def internal_error(request: Request, exc: Exception):
        return error_response(request, "INTERNAL_ERROR", 500)

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, exc: HTTPException):
        return error_response(request, "NOT_FOUND" if exc.status_code == 404 else "REQUEST_FAILED", exc.status_code)

    def set_cookie(response, name, value, max_age):
        response.set_cookie(name, value, max_age=max_age, httponly=True, secure=settings.cookie_secure, samesite="strict", path="/")

    def session_response(user, session_token="", set_session=False):
        csrf = sign_csrf(settings.app_secret, session_token)
        body = SessionDTO(user=user, csrf_token=csrf).model_dump(mode="json")
        response = JSONResponse(body, headers={"Cache-Control": "no-store"})
        set_cookie(response, CSRF_COOKIE, csrf, 3600)
        if set_session:
            set_cookie(response, SESSION_COOKIE, session_token, settings.session_hours * 3600)
        return response

    def require_user(db, request):
        user = auth.resolve(db, request.cookies.get(SESSION_COOKIE))
        if user is None:
            raise ApiError("AUTH_REQUIRED", 401)
        return user

    @app.get("/api/health", response_model=HealthDTO)
    def health():
        with engine.connect() as db:
            db.execute(text("SELECT 1"))
        return {"status": "ok", "database": "ok", "stage": 4}

    @app.get("/api/auth/session", response_model=SessionDTO)
    def session(request: Request):
        token = request.cookies.get(SESSION_COOKIE, "")
        with session_factory() as db:
            user = auth.resolve(db, token)
            response = session_response(auth.user_dto(db, user) if user else None, token if user else "")
        if token and not user:
            response.delete_cookie(SESSION_COOKIE, path="/", httponly=True, secure=settings.cookie_secure, samesite="strict")
        return response

    @app.post("/api/auth/login", response_model=SessionDTO)
    def login(body: LoginBody, request: Request):
        user, token = auth.login(body.email, body.password, request.client.host if request.client else "unknown", request.state.request_id, request.cookies.get(SESSION_COOKIE))
        return session_response(user, token, set_session=True)

    @app.post("/api/auth/logout", status_code=204)
    def logout(request: Request):
        auth.logout(request.cookies.get(SESSION_COOKIE), request.state.request_id)
        response = Response(status_code=204)
        for cookie in (SESSION_COOKIE, CSRF_COOKIE):
            response.delete_cookie(cookie, path="/", httponly=True, secure=settings.cookie_secure, samesite="strict")
        return response

    @app.get("/api/me", response_model=UserDTO)
    def me(request: Request):
        with session_factory() as db:
            return auth.user_dto(db, require_user(db, request))

    @app.get("/api/scopes/{scope_id}/workspace", response_model=WorkspaceDTO)
    def workspace(scope_id: uuid.UUID, request: Request):
        with session_factory() as db:
            user = require_user(db, request)
            grants = [grant for grant in auth.grants(db, user.id) if grant["scope_id"] == str(scope_id)]
            if not grants:
                raise ApiError("ACCESS_DENIED", 403)
            scope = db.get(Scope, scope_id)
            return {"scope": {"id": str(scope.id), "name": scope.name, "is_demo": scope.is_demo},
                    "role_codes": sorted({grant["role"] for grant in grants}),
                    "permissions": permissions_for(grants, str(scope_id)), "stage": 4}

    @app.post("/api/schedule-versions/{version_id}/approve")
    def approve_guard(version_id: uuid.UUID, request: Request, scope_id: uuid.UUID | None = None):
        # Stage 1 deliberately has no schedule versions. This guard proves the
        # direct request is denied; even an authorized approver gets no fake success.
        # When versions exist, derive scope from the loaded version, never from
        # this provisional query parameter. AC-010a is partial until then.
        with session_factory.begin() as db:
            user = require_user(db, request)
            allowed = scope_id and "draft.approve" in permissions_for(auth.grants(db, user.id), str(scope_id))
            audit(db, "draft.approve", "not_implemented" if allowed else "denied", request.state.request_id, user.id)
        raise ApiError("STAGE_NOT_IMPLEMENTED" if allowed else "ACCESS_DENIED", 501 if allowed else 403)

    app.include_router(import_router(ImportService(session_factory, auth)))
    app.include_router(calendar_router(CalendarService(session_factory, auth)))
    app.include_router(editor_router(EditorService(session_factory, auth)))

    dist = ROOT / "frontend" / "dist"
    if (dist / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

    @app.get("/favicon.svg", include_in_schema=False)
    def favicon():
        icon = dist / "favicon.svg"
        if icon.is_file():
            return FileResponse(icon, media_type="image/svg+xml", headers={"Cache-Control": "no-cache"})
        raise HTTPException(status_code=404)

    @app.get("/", include_in_schema=False)
    def index():
        if (dist / "index.html").is_file():
            return FileResponse(dist / "index.html", headers={"Cache-Control": "no-cache"})
        return JSONResponse({"status": "frontend_not_built", "stage": 4}, status_code=503)

    return app

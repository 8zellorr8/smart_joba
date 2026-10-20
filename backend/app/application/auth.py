import hashlib
import hmac
import secrets
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert

from ..infrastructure.models import AuditEvent, AuthSession, LoginThrottle, RoleGrant, Scope, User
from ..infrastructure.security import DUMMY_HASH, PASSWORDS, token_hash


class ApiError(Exception):
    def __init__(self, code: str, status: int, params: dict | None = None):
        self.code, self.status, self.params = code, status, params or {}


def audit(db, action: str, outcome: str, request_id: str, actor_id=None):
    # Intentionally allowlisted columns: never email, password, body or token.
    db.add(AuditEvent(action=action, outcome=outcome, request_id=request_id, actor_id=actor_id))


class AuthService:
    def __init__(self, session_factory, settings):
        self.session_factory, self.settings = session_factory, settings

    def grants(self, db, user_id) -> list[dict]:
        rows = db.execute(select(RoleGrant, Scope).join(Scope, Scope.id == RoleGrant.scope_id).where(RoleGrant.user_id == user_id)).all()
        return [{"role": grant.role, "scope_id": str(scope.id), "scope_name": scope.name, "is_demo": scope.is_demo,
                 "group_id": str(grant.group_id) if grant.group_id else None,
                 "teacher_id": str(grant.teacher_id) if grant.teacher_id else None,
                 "can_publish": grant.can_publish} for grant, scope in rows]

    def user_dto(self, db, user: User) -> dict:
        grants = [{k: v for k, v in grant.items() if k != "can_publish"} for grant in self.grants(db, user.id)]
        return {"id": str(user.id), "email": user.email, "display_name": user.display_name,
                "home_scope_id": str(user.home_scope_id), "grants": grants}

    def resolve(self, db, token: str | None) -> User | None:
        if not token or len(token) > 128:
            return None
        session = db.scalar(select(AuthSession).where(AuthSession.token_hash == token_hash(token), AuthSession.revoked_at.is_(None), AuthSession.expires_at > datetime.now(UTC)))
        if session is None:
            return None
        user = db.get(User, session.user_id)
        return user if user is not None and user.is_active else None

    def _bucket(self, label: str) -> str:
        return hmac.new(self.settings.app_secret.encode(), label.encode(), hashlib.sha256).hexdigest()

    def _reserve_attempt(self, db, email: str, ip: str, now: datetime) -> int:
        # Upsert + SELECT FOR UPDATE serialize reservations across workers.
        buckets = sorted([(self._bucket("account:" + email), self.settings.login_max_attempts),
                          (self._bucket("ip:" + ip), self.settings.login_max_attempts * 10)])
        rows = []
        for key, limit in buckets:
            db.execute(insert(LoginThrottle).values(key=key, window_started_at=now, attempts=0).on_conflict_do_nothing())
            row = db.scalar(select(LoginThrottle).where(LoginThrottle.key == key).with_for_update())
            if (now - row.window_started_at).total_seconds() >= self.settings.login_window_seconds:
                row.window_started_at, row.attempts = now, 0
            rows.append((row, limit))
        limited = [row for row, limit in rows if row.attempts >= limit]
        if limited:
            return max(1, max(int(self.settings.login_window_seconds - (now - row.window_started_at).total_seconds()) for row in limited))
        for row, _ in rows:
            row.attempts += 1
        db.flush()
        return 0

    def login(self, email: str, password: str, ip: str, request_id: str, old_token: str | None):
        email = email.strip().casefold()
        result = None
        failure = None
        now = datetime.now(UTC)
        with self.session_factory.begin() as db:
            retry_after = self._reserve_attempt(db, email, ip, now)
            if retry_after:
                audit(db, "auth.login", "rate_limited", request_id)
                failure = ApiError("AUTH_RATE_LIMITED", 429, {"retry_after": retry_after})
            else:
                user = db.scalar(select(User).where(User.email == email))
                verified = PASSWORDS.verify(password, user.password_hash if user else DUMMY_HASH)
                if not verified or user is None or not user.is_active:
                    audit(db, "auth.login", "denied", request_id)
                    failure = ApiError("AUTH_INVALID_CREDENTIALS", 401)
                else:
                    if old_token:
                        old_session = db.scalar(select(AuthSession).where(AuthSession.token_hash == token_hash(old_token)))
                        if old_session:
                            old_session.revoked_at = now
                    db.execute(delete(LoginThrottle).where(LoginThrottle.key == self._bucket("account:" + email)))
                    token = secrets.token_urlsafe(32)
                    db.add(AuthSession(token_hash=token_hash(token), user_id=user.id, expires_at=now + timedelta(hours=self.settings.session_hours)))
                    audit(db, "auth.login", "success", request_id, user.id)
                    result = (self.user_dto(db, user), token)
        if failure:
            raise failure
        return result

    def logout(self, token: str | None, request_id: str):
        with self.session_factory.begin() as db:
            session = db.scalar(select(AuthSession).where(AuthSession.token_hash == token_hash(token))) if token else None
            if session:
                session.revoked_at = datetime.now(UTC)
            audit(db, "auth.logout", "success", request_id, session.user_id if session else None)

import hashlib
import hmac
import secrets
import time

from pwdlib import PasswordHash

PASSWORDS = PasswordHash.recommended()
# Computed once so an unknown address still incurs a real Argon2 verification.
DUMMY_HASH = PASSWORDS.hash(secrets.token_urlsafe(32))


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def sign_csrf(secret: str, session_token: str = "") -> str:
    payload = f"{int(time.time())}.{secrets.token_urlsafe(32)}"
    signature = hmac.new(secret.encode(), f"{session_token}|{payload}".encode(), hashlib.sha256).hexdigest()
    return f"{payload}.{signature}"


def valid_csrf(token: str, cookie: str, secret: str, session_token: str = "") -> bool:
    if not token or len(token) > 256 or not token.isascii() or not cookie.isascii() or not hmac.compare_digest(token, cookie):
        return False
    try:
        timestamp, nonce, signature = token.split(".")
        age = time.time() - int(timestamp)
    except (ValueError, TypeError):
        return False
    expected = hmac.new(secret.encode(), f"{session_token}|{timestamp}.{nonce}".encode(), hashlib.sha256).hexdigest()
    return 0 <= age <= 3600 and hmac.compare_digest(signature, expected)

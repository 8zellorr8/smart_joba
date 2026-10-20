from pathlib import Path
from urllib.parse import urlsplit

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / ".env", extra="ignore", hide_input_in_errors=True)

    database_url: str = Field(repr=False)
    app_secret: str = Field(min_length=32, repr=False)
    local_only: bool = True
    cookie_secure: bool = False
    allowed_origins: str = "http://127.0.0.1:8000,http://localhost:8000,http://127.0.0.1:5173,http://localhost:5173"
    session_hours: int = Field(default=8, ge=1, le=24)
    login_max_attempts: int = Field(default=5, ge=2, le=20)
    login_window_seconds: int = Field(default=900, ge=60, le=3600)

    @field_validator("database_url")
    @classmethod
    def postgres_only(cls, value: str) -> str:
        if not value.startswith("postgresql+psycopg://"):
            raise ValueError("PostgreSQL with psycopg is required")
        return value

    @model_validator(mode="after")
    def validate_security(self):
        if not self.local_only and not self.cookie_secure:
            raise ValueError("Network mode requires secure cookies and HTTPS")
        for origin in self.origins:
            parsed = urlsplit(origin)
            if parsed.path or parsed.query or parsed.fragment or parsed.username:
                raise ValueError("An origin must contain only scheme and authority")
            if self.local_only and parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
                raise ValueError("Local mode accepts only loopback origins")
            if parsed.scheme not in ({"http", "https"} if self.local_only else {"https"}):
                raise ValueError("Invalid origin scheme")
        return self

    @property
    def origins(self) -> list[str]:
        return [value.strip() for value in self.allowed_origins.split(",") if value.strip()]

    @property
    def authorities(self) -> set[str]:
        return {urlsplit(origin).netloc for origin in self.origins}

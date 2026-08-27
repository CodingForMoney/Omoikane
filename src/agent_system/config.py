from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv
from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="AGENT_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    database_url: str = "sqlite+aiosqlite:///./var/agent-system.db"
    host: str = "127.0.0.1"
    port: int = Field(default=8000, ge=1, le=65_535)
    redis_url: str | None = None
    artifact_backend: str = "local"
    artifact_root: Path = Path("./var/artifacts")
    skill_root: Path = Path("./var/skills")
    sandbox_root: Path = Path("./var/sandboxes")
    sandbox_host_root: Path | None = None
    run_state_secret: str = "development-only-change-me-before-production"
    worker_poll_seconds: float = Field(default=0.5, gt=0)
    run_lease_seconds: int = Field(default=60, ge=10)
    sse_heartbeat_seconds: int = Field(default=15, ge=1)
    tracing_disabled: bool = True
    max_event_payload_bytes: int = Field(default=256_000, ge=1024)
    default_daily_budget_usd: float | None = Field(default=None, ge=0)
    default_approval_timeout_seconds: int = Field(default=86_400, ge=60)
    auto_create_schema: bool = True
    environment: str = "development"

    s3_bucket: str | None = None
    s3_endpoint_url: str | None = None
    s3_region: str | None = None

    @model_validator(mode="after")
    def validate_production(self) -> Settings:
        if self.environment == "production":
            if self.run_state_secret.startswith("development-only"):
                raise ValueError("AGENT_RUN_STATE_SECRET must be replaced in production")
            if self.database_url.startswith("sqlite"):
                raise ValueError("production requires PostgreSQL")
            if self.auto_create_schema:
                raise ValueError(
                    "production requires AGENT_AUTO_CREATE_SCHEMA=false and Alembic migrations"
                )
        return self

    def ensure_directories(self) -> None:
        for path in (self.artifact_root, self.skill_root, self.sandbox_root):
            path.expanduser().resolve().mkdir(parents=True, exist_ok=True)
        if self.database_url.startswith("sqlite") and "///" in self.database_url:
            raw_path = self.database_url.split("///", 1)[1]
            if raw_path != ":memory:":
                Path(raw_path).expanduser().resolve().parent.mkdir(parents=True, exist_ok=True)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    # Pydantic Settings reads values used by the Settings model from `.env`, but
    # provider credentials are intentionally referenced by name and resolved
    # later through os.environ. Load the same local file into the process without
    # replacing environment values supplied by the service manager/container.
    load_dotenv(dotenv_path=".env", override=False)
    settings = Settings()
    settings.ensure_directories()
    return settings

from __future__ import annotations

import uvicorn

from .api import create_app
from .config import get_settings

app = create_app()


def run() -> None:
    settings = get_settings()
    uvicorn.run(
        "agent_system.main:app",
        host=settings.host,
        port=settings.port,
        reload=False,
    )

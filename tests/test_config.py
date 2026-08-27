from __future__ import annotations

import os

from agent_system.config import get_settings


def test_get_settings_loads_provider_credentials_without_overriding_environment(
    tmp_path, monkeypatch
):
    env_file = tmp_path / ".env"
    env_file.write_text(
        "DEMO_PROVIDER_CREDENTIAL=from-dotenv\nDEMO_PROVIDER_OVERRIDE=from-dotenv\n",
        encoding="utf-8",
    )
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("DEMO_PROVIDER_CREDENTIAL", raising=False)
    monkeypatch.setenv("DEMO_PROVIDER_OVERRIDE", "from-process")
    get_settings.cache_clear()

    try:
        get_settings()
        assert os.environ["DEMO_PROVIDER_CREDENTIAL"] == "from-dotenv"
        assert os.environ["DEMO_PROVIDER_OVERRIDE"] == "from-process"
    finally:
        get_settings.cache_clear()
        os.environ.pop("DEMO_PROVIDER_CREDENTIAL", None)

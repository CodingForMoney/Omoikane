from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version


def installed_package_version(distribution: str) -> str:
    try:
        return version(distribution)
    except PackageNotFoundError:  # pragma: no cover - invalid source-only environment
        return "uninstalled"


OPENAI_AGENTS_SDK_VERSION = installed_package_version("openai-agents")
RUN_STATE_FORMAT_VERSION = 1

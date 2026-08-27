from __future__ import annotations

import asyncio
import json
import tempfile
from pathlib import Path

from agent_system.config import Settings
from agent_system.sandbox import DockerSandboxProvider, SandboxSpec


async def smoke() -> dict:
    with tempfile.TemporaryDirectory(prefix="agent-system-sandbox-") as raw:
        root = Path(raw)
        settings = Settings(
            environment="production",
            auto_create_schema=False,
            database_url="postgresql+asyncpg://unused:unused@localhost/unused",
            run_state_secret="sandbox-smoke-production-state-secret",
            sandbox_root=root,
        )
        provider = DockerSandboxProvider(settings)
        handle = await provider.create(
            SandboxSpec(
                run_id="sandbox-smoke",
                cpu_limit=0.5,
                memory_mb=128,
                disk_mb=64,
                timeout_seconds=20,
                network_enabled=False,
            )
        )
        try:
            identity = await provider.exec(handle, ["id", "-u"])
            workspace_write = await provider.exec(
                handle, ["sh", "-c", "printf ok > /workspace/result.txt"]
            )
            root_write = await provider.exec(
                handle, ["sh", "-c", "printf forbidden > /root-write-test"]
            )
            network = await provider.exec(
                handle,
                [
                    "python",
                    "-c",
                    "import socket; socket.create_connection(('1.1.1.1', 53), timeout=2)",
                ],
                timeout=5,
            )
            return {
                "container_id": handle.id,
                "non_root": identity.return_code == 0 and identity.stdout.strip() == "65534",
                "workspace_writable": workspace_write.return_code == 0,
                "root_filesystem_read_only": root_write.return_code != 0,
                "network_blocked": network.return_code != 0,
                "workspace_result": (root / "sandbox-smoke" / "result.txt").read_text(),
            }
        finally:
            await provider.destroy(handle)


if __name__ == "__main__":
    print(json.dumps(asyncio.run(smoke()), ensure_ascii=False, indent=2))

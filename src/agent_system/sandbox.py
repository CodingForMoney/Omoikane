from __future__ import annotations

import asyncio
import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from .config import Settings


@dataclass(slots=True)
class SandboxSpec:
    run_id: str
    cpu_limit: float = 1.0
    memory_mb: int = 512
    disk_mb: int = 1024
    timeout_seconds: int = 60
    network_enabled: bool = False


@dataclass(slots=True)
class SandboxHandle:
    id: str
    root: Path
    provider: str


@dataclass(slots=True)
class ExecResult:
    return_code: int
    stdout: str
    stderr: str
    timed_out: bool = False


class SandboxProvider(Protocol):
    async def create(self, spec: SandboxSpec) -> SandboxHandle: ...

    async def exec(
        self, handle: SandboxHandle, command: list[str], cwd: str = ".", timeout: int | None = None
    ) -> ExecResult: ...

    async def destroy(self, handle: SandboxHandle) -> None: ...


class LocalSandboxProvider:
    def __init__(self, settings: Settings):
        if settings.environment == "production":
            raise RuntimeError("LocalSandboxProvider is prohibited in production")
        self.root = settings.sandbox_root.expanduser().resolve()

    async def create(self, spec: SandboxSpec) -> SandboxHandle:
        root = (self.root / spec.run_id).resolve()
        if self.root not in root.parents:
            raise ValueError("invalid sandbox run id")
        root.mkdir(parents=True, exist_ok=True)
        return SandboxHandle(id=spec.run_id, root=root, provider="local")

    async def exec(
        self, handle: SandboxHandle, command: list[str], cwd: str = ".", timeout: int | None = None
    ) -> ExecResult:
        if not command or len(command) > 64:
            raise ValueError("command must contain 1-64 argv items")
        working_dir = (handle.root / cwd).resolve()
        if working_dir != handle.root and handle.root not in working_dir.parents:
            raise ValueError("sandbox cwd escapes workspace")
        working_dir.mkdir(parents=True, exist_ok=True)
        process = await asyncio.create_subprocess_exec(
            *command,
            cwd=working_dir,
            env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(handle.root)},
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout or 60)
            return ExecResult(
                return_code=process.returncode or 0,
                stdout=stdout.decode("utf-8", errors="replace")[:1_000_000],
                stderr=stderr.decode("utf-8", errors="replace")[:1_000_000],
            )
        except TimeoutError:
            process.kill()
            await process.wait()
            return ExecResult(return_code=124, stdout="", stderr="timed out", timed_out=True)

    async def destroy(self, handle: SandboxHandle) -> None:
        if handle.root.exists() and self.root in handle.root.parents:
            await asyncio.to_thread(shutil.rmtree, handle.root)


class DockerSandboxProvider:
    def __init__(self, settings: Settings, image: str = "python:3.12-slim"):
        self.root = settings.sandbox_root.expanduser().resolve()
        self.host_root = (
            settings.sandbox_host_root.expanduser().resolve()
            if settings.sandbox_host_root
            else self.root
        )
        self.image = image
        self._specs: dict[str, SandboxSpec] = {}

    async def _docker(self, *args: str, timeout: int = 60) -> tuple[int, str, str]:
        process = await asyncio.create_subprocess_exec(
            "docker",
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
        return process.returncode or 0, stdout.decode().strip(), stderr.decode().strip()

    async def create(self, spec: SandboxSpec) -> SandboxHandle:
        root = (self.root / spec.run_id).resolve()
        host_root = (self.host_root / spec.run_id).resolve()
        if self.root not in root.parents or self.host_root not in host_root.parents:
            raise ValueError("invalid sandbox run id")
        root.mkdir(parents=True, exist_ok=True)
        name = f"agent-system-{spec.run_id}".replace("_", "-")[:63]
        args = [
            "run",
            "-d",
            "--name",
            name,
            "--user",
            "65534:65534",
            "--read-only",
            "--security-opt",
            "no-new-privileges",
            "--cpus",
            str(spec.cpu_limit),
            "--memory",
            f"{spec.memory_mb}m",
            "--pids-limit",
            "128",
            "--tmpfs",
            f"/tmp:rw,noexec,nosuid,size={min(spec.disk_mb, 256)}m",
            "-v",
            f"{host_root}:/workspace:rw",
            "-w",
            "/workspace",
        ]
        if not spec.network_enabled:
            args.extend(["--network", "none"])
        args.extend([self.image, "sleep", "infinity"])
        code, _, error = await self._docker(*args)
        if code != 0:
            raise RuntimeError(f"docker sandbox create failed: {error}")
        self._specs[name] = spec
        return SandboxHandle(id=name, root=root, provider="docker")

    async def exec(
        self, handle: SandboxHandle, command: list[str], cwd: str = ".", timeout: int | None = None
    ) -> ExecResult:
        if not command:
            raise ValueError("empty command")
        container_cwd = str((Path("/workspace") / cwd).as_posix())
        if ".." in Path(cwd).parts:
            raise ValueError("sandbox cwd escapes workspace")
        code, stdout, stderr = await self._docker(
            "exec", "-w", container_cwd, handle.id, *command, timeout=timeout or 60
        )
        return ExecResult(return_code=code, stdout=stdout, stderr=stderr)

    async def destroy(self, handle: SandboxHandle) -> None:
        await self._docker("rm", "-f", handle.id)
        if handle.root.exists() and self.root in handle.root.parents:
            await asyncio.to_thread(shutil.rmtree, handle.root)

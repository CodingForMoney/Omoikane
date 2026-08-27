from __future__ import annotations

import asyncio
from dataclasses import dataclass

from .agent_definitions import AgentDefinitionService
from .agent_factory import AgentFactory
from .artifacts import ArtifactService
from .compaction import CompactionService
from .config import Settings, get_settings
from .costs import CostService
from .db import Database
from .events import EventNotifier, EventStore
from .memory import MemoryService
from .providers import ProviderService
from .registry import RegistryService
from .runner import RunnerService
from .sandbox import DockerSandboxProvider, LocalSandboxProvider, SandboxProvider
from .skills import SkillService
from .tool_executions import ToolExecutionService
from .tools import ToolRegistry


@dataclass
class Container:
    settings: Settings
    db: Database
    notifier: EventNotifier
    events: EventStore
    artifacts: ArtifactService
    compaction: CompactionService
    memory: MemoryService
    providers: ProviderService
    definitions: AgentDefinitionService
    skills: SkillService
    sandbox: SandboxProvider
    tool_executions: ToolExecutionService
    tools: ToolRegistry
    factory: AgentFactory
    costs: CostService
    registry: RegistryService
    runner: RunnerService
    worker_stop: asyncio.Event | None = None
    worker_task: asyncio.Task | None = None

    async def close(self) -> None:
        if self.worker_stop is not None:
            self.worker_stop.set()
        if self.worker_task is not None:
            try:
                await asyncio.wait_for(self.worker_task, timeout=5)
            except TimeoutError:
                self.worker_task.cancel()
            except asyncio.CancelledError:
                pass
        await self.notifier.close()
        await self.db.dispose()


async def create_container(
    *, settings: Settings | None = None, start_worker: bool = False
) -> Container:
    settings = settings or get_settings()
    settings.ensure_directories()
    db = Database(settings)
    if settings.auto_create_schema:
        await db.create_schema()
    notifier = EventNotifier(settings)
    events = EventStore(db, notifier, settings)
    artifacts = ArtifactService(db, settings)
    compaction = CompactionService(db, artifacts, events)
    memory = MemoryService(db)
    providers = ProviderService(db, settings)
    definitions = AgentDefinitionService(db, providers, settings)
    skills = SkillService(db, settings)
    sandbox: SandboxProvider = (
        DockerSandboxProvider(settings)
        if settings.environment == "production"
        else LocalSandboxProvider(settings)
    )
    tool_executions = ToolExecutionService(db)
    tools = ToolRegistry(artifacts, memory, sandbox, tool_executions)
    factory = AgentFactory(db, tools, skills, providers, definitions, settings)
    costs = CostService(db)
    registry = RegistryService(db, factory, providers, definitions)
    await registry.seed_builtin_tools()
    await providers.seed_legacy_connections()
    await providers.backfill_default_models()
    runner = RunnerService(
        db=db,
        settings=settings,
        events=events,
        factory=factory,
        memory=memory,
        providers=providers,
        definitions=definitions,
        skills=skills,
        sandbox=sandbox,
        costs=costs,
        compaction=compaction,
        tool_executions=tool_executions,
    )
    container = Container(
        settings=settings,
        db=db,
        notifier=notifier,
        events=events,
        artifacts=artifacts,
        compaction=compaction,
        memory=memory,
        providers=providers,
        definitions=definitions,
        skills=skills,
        sandbox=sandbox,
        tool_executions=tool_executions,
        tools=tools,
        factory=factory,
        costs=costs,
        registry=registry,
        runner=runner,
    )
    if start_worker:
        container.worker_stop = asyncio.Event()
        container.worker_task = asyncio.create_task(
            runner.run_forever(container.worker_stop), name="agent-system-worker"
        )
    return container

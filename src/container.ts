import type { Settings } from "./config.js";
import { getSettings } from "./config.js";
import { Database } from "./database.js";
import { assertMigrationCompatible, migrate } from "./migrations.js";
import { ArtifactService } from "./artifacts.js";
import { SandboxService } from "./sandbox.js";
import { SkillService } from "./skills.js";
import { ToolService } from "./tools.js";
import { ProviderService } from "./providers.js";
import { AgentDefinitionService } from "./agent-definitions.js";
import { AgentFactory } from "./agent-factory.js";
import { EventStore } from "./events.js";
import { UsageService } from "./usage.js";
import { CompactionService } from "./compaction.js";
import { RunnerService } from "./runner.js";
import { ResourceStore } from "./resources.js";
import { McpService } from "./mcp.js";
import { NO_FAULT_INJECTOR, type FaultInjector } from "./recovery.js";
import { GuardrailService } from "./guardrails.js";
import { ObservabilityService } from "./observability.js";
import { InputTokenCountingService } from "./input-token-counting.js";

export interface ContainerOptions {
  startWorker?: boolean;
  /** Programmatic test hook. It is never configurable through REST or env. */
  faultInjector?: FaultInjector;
}

export class Container {
  readonly resources: ResourceStore;
  readonly artifacts: ArtifactService;
  readonly sandbox: SandboxService;
  readonly skills: SkillService;
  readonly tools: ToolService;
  readonly mcp: McpService;
  readonly providers: ProviderService;
  readonly guardrails: GuardrailService;
  readonly definitions: AgentDefinitionService;
  readonly factory: AgentFactory;
  readonly events: EventStore;
  readonly usage: UsageService;
  readonly compaction: CompactionService;
  readonly inputTokenCounting: InputTokenCountingService;
  readonly runner: RunnerService;
  private readonly abort = new AbortController();
  private readonly workers: Promise<void>[] = [];
  private maintenance?: Promise<void>;
  private constructor(
    readonly settings: Settings,
    readonly db: Database,
    readonly faults: FaultInjector,
    readonly observability: ObservabilityService,
  ) {
    this.resources = new ResourceStore(db);
    this.artifacts = new ArtifactService(db, settings);
    this.sandbox = new SandboxService(settings);
    this.skills = new SkillService(db, settings);
    this.events = new EventStore(db, settings.maxEventPayloadBytes);
    this.tools = new ToolService(
      db,
      this.artifacts,
      this.sandbox,
      this.events,
      faults,
    );
    this.mcp = new McpService(db, faults);
    this.providers = new ProviderService(db, settings.credentialSecret);
    this.guardrails = new GuardrailService(this.events);
    this.definitions = new AgentDefinitionService(db, this.skills, this.tools);
    this.factory = new AgentFactory(
      db,
      this.providers,
      this.tools,
      this.skills,
      this.mcp,
      this.sandbox,
      this.guardrails,
    );
    this.usage = new UsageService(db);
    this.compaction = new CompactionService(this.providers);
    this.inputTokenCounting = new InputTokenCountingService(
      db,
      this.factory,
      this.providers,
      this.compaction,
    );
    this.runner = new RunnerService(
      db,
      settings,
      this.events,
      this.factory,
      this.providers,
      this.usage,
      this.compaction,
      this.sandbox,
      this.tools,
      this.artifacts,
      faults,
      observability,
    );
  }
  static async create(
    settings: Settings = getSettings(),
    options: ContainerOptions = {},
  ) {
    const db = await Database.connect(settings);
    let observability: ObservabilityService | undefined;
    try {
      const preflight = await assertMigrationCompatible(db);
      if (preflight.pending_versions.length) {
        if (settings.autoMigrate && !preflight.migration_table_exists) {
          await migrate(db, { credentialSecret: settings.credentialSecret });
        } else {
          throw new Error(
            `database upgrade required (${preflight.current_version ?? "uninitialized"} -> ${preflight.target_version}); stop the Runtime and run "omoikane upgrade"`,
          );
        }
      }
      observability = await ObservabilityService.create(settings);
      const container = new Container(
        settings,
        db,
        options.faultInjector ?? NO_FAULT_INJECTOR,
        observability,
      );
      await container.artifacts.reconcile();
      await container.tools.seed();
      if (options.startWorker ?? true) {
        container.runner.configureWorkers(settings.runConcurrency, true);
        for (let index = 0; index < settings.runConcurrency; index += 1)
          container.workers.push(
            container.runner.runForever(container.abort.signal, index),
          );
        container.maintenance = container.runner.maintainForever(
          container.abort.signal,
        );
      } else {
        container.runner.configureWorkers(0, false);
      }
      return container;
    } catch (error) {
      await observability?.close();
      await db.close();
      throw error;
    }
  }
  async close() {
    this.abort.abort();
    this.runner.stop();
    await Promise.allSettled([
      ...this.workers,
      ...([this.maintenance].filter(Boolean) as Promise<void>[]),
    ]);
    await this.observability.close();
    await this.db.close();
  }
}

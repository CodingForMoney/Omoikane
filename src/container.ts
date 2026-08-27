import type { Settings } from "./config.js";
import { getSettings } from "./config.js";
import { Database } from "./database.js";
import { migrate } from "./migrations.js";
import { ArtifactService } from "./artifacts.js";
import { MemoryService } from "./memory.js";
import { SandboxService } from "./sandbox.js";
import { SkillService } from "./skills.js";
import { ToolService } from "./tools.js";
import { ProviderService } from "./providers.js";
import { AgentDefinitionService } from "./agent-definitions.js";
import { AgentFactory } from "./agent-factory.js";
import { EventStore } from "./events.js";
import { CostService } from "./costs.js";
import { CompactionService } from "./compaction.js";
import { ReleaseService } from "./releases.js";
import { WebhookService } from "./webhooks.js";
import { RunnerService } from "./runner.js";
import { SessionService } from "./sessions.js";
import { ResourceStore } from "./resources.js";

export class Container {
  readonly resources: ResourceStore;
  readonly artifacts: ArtifactService;
  readonly memory: MemoryService;
  readonly sandbox: SandboxService;
  readonly skills: SkillService;
  readonly tools: ToolService;
  readonly providers: ProviderService;
  readonly definitions: AgentDefinitionService;
  readonly factory: AgentFactory;
  readonly events: EventStore;
  readonly costs: CostService;
  readonly compaction: CompactionService;
  readonly releases: ReleaseService;
  readonly webhooks: WebhookService;
  readonly runner: RunnerService;
  readonly sessions: SessionService;
  private readonly abort = new AbortController();
  private worker?: Promise<void>;
  private webhookWorker?: Promise<void>;
  private constructor(
    readonly settings: Settings,
    readonly db: Database,
  ) {
    this.resources = new ResourceStore(db);
    this.artifacts = new ArtifactService(db, settings);
    this.memory = new MemoryService(db);
    this.sandbox = new SandboxService(settings);
    this.skills = new SkillService(db, settings);
    this.tools = new ToolService(db, this.artifacts, this.memory, this.sandbox);
    this.providers = new ProviderService(db, settings.runStateSecret);
    this.definitions = new AgentDefinitionService(db);
    this.factory = new AgentFactory(
      db,
      this.providers,
      this.tools,
      this.skills,
    );
    this.events = new EventStore(db, settings.maxEventPayloadBytes);
    this.costs = new CostService(db);
    this.compaction = new CompactionService(db, this.providers);
    this.releases = new ReleaseService(db);
    this.webhooks = new WebhookService(db, settings);
    this.sessions = new SessionService(db);
    this.runner = new RunnerService(
      db,
      settings,
      this.events,
      this.factory,
      this.providers,
      this.memory,
      this.costs,
      this.compaction,
      this.sandbox,
      this.tools,
    );
  }
  static async create(
    settings: Settings = getSettings(),
    options: { startWorker?: boolean } = {},
  ) {
    const db = await Database.connect(settings);
    if (settings.autoMigrate) await migrate(db);
    const container = new Container(settings, db);
    await container.tools.seed();
    if (options.startWorker ?? settings.embeddedWorker) {
      container.worker = container.runner.runForever(container.abort.signal);
      container.webhookWorker = container.webhooks.runForever(
        container.abort.signal,
      );
    }
    return container;
  }
  async close() {
    this.abort.abort();
    this.runner.stop();
    this.webhooks.stop();
    await Promise.allSettled(
      [this.worker, this.webhookWorker].filter(Boolean) as Promise<void>[],
    );
    await this.db.close();
  }
}

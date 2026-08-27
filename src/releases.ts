import type { Database } from "./database.js";
import { ConflictError, ValidationError } from "./database.js";
import { ResourceStore } from "./resources.js";
import { hashJson } from "./serialization.js";

export class ReleaseService {
  private readonly store: ResourceStore;
  constructor(private readonly db: Database) {
    this.store = new ResourceStore(db);
  }
  async validate(tenantId: string, manifest: Record<string, unknown>) {
    if (
      manifest.apiVersion !== "omoikane.io/v1" ||
      manifest.kind !== "ProjectRelease"
    )
      throw new ValidationError("invalid project release manifest");
    const project = String(manifest.project ?? "");
    if (!/^[a-z0-9][a-z0-9_-]{1,127}$/.test(project))
      throw new ValidationError("invalid release project");
    const resources = (manifest.resources ?? {}) as Record<string, unknown>;
    const missing: string[] = [];
    for (const [kind, values] of [
      ["agent_version", resources.agents],
      ["skill_version", resources.skills],
      ["mcp_server", resources.mcpServers ?? resources.mcp_servers],
    ] as const) {
      for (const id of Object.values(
        (values ?? {}) as Record<string, string>,
      )) {
        try {
          await this.store.get(tenantId, kind, id);
        } catch {
          missing.push(`${kind}:${id}`);
        }
      }
    }
    return {
      valid: missing.length === 0,
      missing,
      manifest_hash: hashJson(manifest),
    };
  }
  async create(
    tenantId: string,
    manifest: Record<string, unknown>,
    actorId: string,
  ) {
    const validation = await this.validate(tenantId, manifest);
    if (!validation.valid)
      throw new ValidationError(
        `release contains missing resources: ${validation.missing.join(", ")}`,
      );
    const project = String(manifest.project);
    const existing = (
      await this.store.list<Record<string, unknown>>(
        tenantId,
        "project_release",
      )
    ).filter((item) => item.project === project);
    const duplicate = existing.find(
      (item) => item.manifest_hash === validation.manifest_hash,
    );
    if (duplicate) return duplicate;
    const version =
      Math.max(0, ...existing.map((item) => Number(item.version))) + 1;
    return this.store.create({
      tenantId,
      kind: "project_release",
      slug: `${project}-${version}`,
      name: `${project} v${version}`,
      status: "published",
      data: {
        project,
        version,
        manifest,
        manifest_hash: validation.manifest_hash,
        resources: manifest.resources ?? {},
        source_commit: manifest.sourceCommit ?? null,
        created_by: actorId,
      },
    });
  }
  async list(tenantId: string, project?: string) {
    const all = await this.store.list<Record<string, unknown>>(
      tenantId,
      "project_release",
    );
    return project ? all.filter((item) => item.project === project) : all;
  }
  async get(tenantId: string, id: string) {
    return this.store.get(tenantId, "project_release", id);
  }
  async setChannel(
    tenantId: string,
    project: string,
    channel: string,
    releaseId: string,
    expectedRevision?: number,
    actorId = "system",
  ) {
    const release = await this.get(tenantId, releaseId);
    if (release.project !== project)
      throw new ValidationError("release belongs to another project");
    const slug = `${project}-${channel}`;
    const current = await this.store.findBySlug<Record<string, unknown>>(
      tenantId,
      "release_channel",
      slug,
    );
    if (current) {
      if (
        expectedRevision !== undefined &&
        Number(current.revision) !== expectedRevision
      )
        throw new ConflictError("release channel revision conflict");
      return this.store.update(tenantId, "release_channel", current.id, {
        data: {
          release_id: releaseId,
          project,
          channel,
          revision: Number(current.revision) + 1,
          updated_by: actorId,
        },
      });
    }
    if (expectedRevision !== undefined)
      throw new ConflictError("release channel does not exist");
    return this.store.create({
      tenantId,
      kind: "release_channel",
      slug,
      name: `${project}:${channel}`,
      data: {
        release_id: releaseId,
        project,
        channel,
        revision: 1,
        updated_by: actorId,
      },
    });
  }
  async channel(tenantId: string, project: string, channel: string) {
    const row = await this.store.findBySlug<Record<string, unknown>>(
      tenantId,
      "release_channel",
      `${project}-${channel}`,
    );
    if (!row) throw new ValidationError("release channel not found");
    return {
      ...row,
      release: await this.get(tenantId, String(row.release_id)),
    };
  }
}

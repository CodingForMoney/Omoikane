import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve, relative, dirname } from "node:path";
import fg from "fast-glob";
import YAML from "yaml";
import type { Settings } from "./config.js";
import type { Database } from "./database.js";
import { ValidationError } from "./database.js";
import { ResourceStore } from "./resources.js";
import { checksum } from "./crypto.js";

const safeRelative = (path: string) => {
  const normalized = path.replace(/\\/g, "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").includes("..")
  )
    throw new ValidationError(`unsafe bundle path: ${path}`);
  return normalized;
};

function parseSkill(source: string) {
  const normalized = source.replace(/\r\n/g, "\n");
  let metadata: Record<string, unknown> = {};
  let body = normalized;
  if (normalized.startsWith("---\n")) {
    const end = normalized.indexOf("\n---\n", 4);
    if (end < 0)
      throw new ValidationError("SKILL.md front matter is not closed");
    metadata = (YAML.parse(normalized.slice(4, end)) ?? {}) as Record<
      string,
      unknown
    >;
    body = normalized.slice(end + 5);
  }
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const name = String(metadata.name ?? heading ?? "Skill");
  const slug = String(
    metadata.slug ??
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, ""),
  );
  if (!/^[a-z0-9][a-z0-9-]{1,127}$/.test(slug))
    throw new ValidationError("invalid skill slug");
  return {
    name,
    slug,
    description: String(metadata.description ?? ""),
    metadata,
    body: body.trim(),
  };
}

export class SkillService {
  private readonly store: ResourceStore;
  constructor(
    private readonly db: Database,
    private readonly settings: Settings,
  ) {
    this.store = new ResourceStore(db);
  }

  async importPath(tenantId: string, path: string) {
    const root = resolve(path);
    const info = await stat(root);
    const directory = info.isDirectory() ? root : dirname(root);
    const skillPath = info.isDirectory() ? resolve(root, "SKILL.md") : root;
    const source = await readFile(skillPath, "utf8");
    const parsed = parseSkill(source);
    const files = await fg(["**/*"], {
      cwd: directory,
      onlyFiles: true,
      dot: true,
      ignore: [".git/**", "node_modules/**"],
    });
    const bundle = await Promise.all(
      files.map(async (file) => ({
        path: safeRelative(file),
        content_base64: (await readFile(resolve(directory, file))).toString(
          "base64",
        ),
      })),
    );
    return this.importBundle(tenantId, bundle, parsed);
  }

  async importBundle(
    tenantId: string,
    files: Array<{ path: string; content_base64: string }>,
    known?: ReturnType<typeof parseSkill>,
  ) {
    if (!files.length || files.length > 500)
      throw new ValidationError("skill bundle must contain 1-500 files");
    const sanitized = files.map((file) => ({
      path: safeRelative(file.path),
      data: Buffer.from(file.content_base64, "base64"),
    }));
    const skillFile = sanitized.find((file) => file.path === "SKILL.md");
    if (!skillFile) throw new ValidationError("skill bundle requires SKILL.md");
    const parsed = known ?? parseSkill(skillFile.data.toString("utf8"));
    let skill = await this.store.findBySlug(tenantId, "skill", parsed.slug);
    if (!skill)
      skill = await this.store.create({
        tenantId,
        kind: "skill",
        slug: parsed.slug,
        name: parsed.name,
        data: { description: parsed.description },
      });
    const versions = await this.store.list<Record<string, unknown>>(
      tenantId,
      "skill_version",
      { parentId: skill.id },
    );
    const version = Math.max(0, ...versions.map((v) => Number(v.version))) + 1;
    const digest = checksum(
      Buffer.concat(
        sanitized
          .sort((a, b) => a.path.localeCompare(b.path))
          .flatMap((file) => [Buffer.from(file.path), file.data]),
      ),
    );
    const target = resolve(this.settings.skillRoot, skill.id, String(version));
    for (const file of sanitized) {
      const destination = resolve(target, file.path);
      if (!destination.startsWith(target))
        throw new ValidationError("bundle path escaped skill root");
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, file.data);
    }
    const skillVersion = await this.store.create({
      tenantId,
      kind: "skill_version",
      parentId: skill.id,
      name: `v${version}`,
      status: "published",
      data: {
        version,
        content_hash: digest,
        manifest: {
          ...parsed.metadata,
          name: parsed.name,
          slug: parsed.slug,
          description: parsed.description,
        },
        bundle_uri: target,
      },
    });
    return { skill, version: skillVersion };
  }

  async list(tenantId: string) {
    return this.store.list(tenantId, "skill");
  }
  async versions(tenantId: string, skillId: string) {
    return this.store.list(tenantId, "skill_version", { parentId: skillId });
  }
  async materialize(
    tenantId: string,
    skillVersionId: string,
    sandboxRoot: string,
  ) {
    const version = await this.store.get<Record<string, unknown>>(
      tenantId,
      "skill_version",
      skillVersionId,
    );
    const source = String(version.bundle_uri);
    const destination = resolve(
      sandboxRoot,
      "skills",
      version.parent_id!,
      String(version.version),
    );
    const files = await fg(["**/*"], {
      cwd: source,
      onlyFiles: true,
      dot: true,
    });
    for (const file of files) {
      const target = resolve(destination, file);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await readFile(resolve(source, file)));
    }
    return { path: destination, files };
  }

  async instruction(tenantId: string, skillVersionId: string) {
    const version = await this.store.get<Record<string, unknown>>(
      tenantId,
      "skill_version",
      skillVersionId,
    );
    return readFile(resolve(String(version.bundle_uri), "SKILL.md"), "utf8");
  }
}

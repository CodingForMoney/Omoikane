import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, posix, resolve } from "node:path";
import YAML from "yaml";
import type { Settings } from "./config.js";
import type { Database } from "./database.js";
import { ConflictError, ValidationError } from "./database.js";
import { ResourceStore, type Resource } from "./resources.js";
import { checksum } from "./crypto.js";
import { newId } from "./serialization.js";
import type { SandboxHandle, SandboxService } from "./sandbox.js";
import type { PageOptions } from "./pagination.js";

const MAX_FILES = 500;
const MAX_SKILL_BYTES = 1 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const WORKSPACE_ROOT = ".omoikane/skills";

interface BundleFile {
  path: string;
  data: Buffer;
}

interface SkillFileIndex {
  path: string;
  size: number;
  sha256: string;
}

export interface SkillEntrypoint {
  command: string[];
}

export interface SkillManifestExtension {
  schema_version: 1;
  workspace: "none" | "optional" | "required";
  requires: {
    tools: string[];
    commands: string[];
    network: boolean;
  };
  entrypoints: Record<string, SkillEntrypoint>;
}

interface SkillVersionData extends Record<string, unknown> {
  version: number;
  content_hash: string;
  manifest: Record<string, unknown> & {
    name: string;
    slug: string;
    description: string;
    omoikane: SkillManifestExtension;
  };
  files?: SkillFileIndex[];
  hash_format?: "file-index-v1";
  bundle_uri: string;
}

export interface SkillRuntimeBinding {
  version_id: string;
  skill_id: string;
  slug: string;
  name: string;
  content_hash: string;
  workspace: string | null;
  entrypoints: Record<string, SkillEntrypoint>;
  requirements: SkillManifestExtension["requires"];
  instruction: string;
  file_count: number;
  materialized: boolean;
}

export interface SkillValidationOptions {
  toolNames: ReadonlySet<string>;
  sandboxConfig?: Record<string, unknown>;
  sandbox?: SandboxHandle;
  sandboxService?: SandboxService;
}

const pathInside = (root: string, candidate: string) => {
  const rootPath = resolve(root);
  const target = resolve(candidate);
  return target === rootPath || target.startsWith(`${rootPath}/`);
};

const safeRelative = (input: string) => {
  const value = input.normalize("NFC");
  if (
    !value ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.endsWith("/")
  )
    throw new ValidationError(`unsafe bundle path: ${input}`);
  const segments = value.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  )
    throw new ValidationError(`unsafe bundle path: ${input}`);
  const normalized = posix.normalize(value);
  if (normalized !== value || normalized.startsWith("../"))
    throw new ValidationError(`unsafe bundle path: ${input}`);
  return normalized;
};

const strictBase64 = (value: string, path: string) => {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw new ValidationError(`invalid base64 content for ${path}`);
  const data = Buffer.from(value, "base64");
  if (data.toString("base64") !== value)
    throw new ValidationError(`invalid base64 content for ${path}`);
  return data;
};

const validateFiles = (files: BundleFile[]) => {
  if (!files.length || files.length > MAX_FILES)
    throw new ValidationError(`skill bundle must contain 1-${MAX_FILES} files`);
  const exact = new Set<string>();
  const portable = new Set<string>();
  let total = 0;
  for (const file of files) {
    file.path = safeRelative(file.path);
    if (exact.has(file.path))
      throw new ValidationError(`duplicate bundle path: ${file.path}`);
    exact.add(file.path);
    const key = file.path.toLocaleLowerCase("en-US");
    if (portable.has(key))
      throw new ValidationError(
        `bundle paths conflict on case-insensitive filesystems: ${file.path}`,
      );
    portable.add(key);
    if (file.data.byteLength > MAX_FILE_BYTES)
      throw new ValidationError(
        `skill file exceeds ${MAX_FILE_BYTES} bytes: ${file.path}`,
      );
    total += file.data.byteLength;
    if (total > MAX_BUNDLE_BYTES)
      throw new ValidationError(
        `skill bundle exceeds ${MAX_BUNDLE_BYTES} bytes`,
      );
  }
  const skill = files.find((file) => file.path === "SKILL.md");
  if (!skill) throw new ValidationError("skill bundle requires SKILL.md");
  if (skill.data.byteLength > MAX_SKILL_BYTES)
    throw new ValidationError(`SKILL.md exceeds ${MAX_SKILL_BYTES} bytes`);
};

const stringList = (value: unknown, location: string, unique = true) => {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new ValidationError(`${location} must be an array`);
  const result = value.map((item, index) => {
    if (typeof item !== "string" || !item.trim() || item.length > 256)
      throw new ValidationError(`${location}[${index}] must be a short string`);
    return item.trim();
  });
  if (unique && new Set(result).size !== result.length)
    throw new ValidationError(`${location} contains duplicates`);
  return result;
};

const manifestExtension = (metadata: Record<string, unknown>) => {
  const value = metadata.omoikane;
  if (value === undefined)
    return {
      schema_version: 1,
      workspace: "optional",
      requires: { tools: [], commands: [], network: false },
      entrypoints: {},
    } satisfies SkillManifestExtension;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ValidationError("omoikane Skill metadata must be an object");
  const raw = value as Record<string, unknown>;
  const unknown = Object.keys(raw).filter(
    (key) =>
      !["schema_version", "workspace", "requires", "entrypoints"].includes(key),
  );
  if (unknown.length)
    throw new ValidationError(
      `unsupported omoikane Skill fields: ${unknown.join(", ")}`,
    );
  const schemaVersion = raw.schema_version ?? 1;
  if (schemaVersion !== 1)
    throw new ValidationError("unsupported omoikane Skill schema_version");
  const workspace = raw.workspace ?? "optional";
  if (!(["none", "optional", "required"] as unknown[]).includes(workspace))
    throw new ValidationError(
      "omoikane.workspace must be none, optional, or required",
    );
  const rawRequires = raw.requires ?? {};
  if (
    !rawRequires ||
    typeof rawRequires !== "object" ||
    Array.isArray(rawRequires)
  )
    throw new ValidationError("omoikane.requires must be an object");
  const requiresRecord = rawRequires as Record<string, unknown>;
  const unknownRequires = Object.keys(requiresRecord).filter(
    (key) => !["tools", "commands", "network"].includes(key),
  );
  if (unknownRequires.length)
    throw new ValidationError(
      `unsupported omoikane.requires fields: ${unknownRequires.join(", ")}`,
    );
  if (
    requiresRecord.network !== undefined &&
    typeof requiresRecord.network !== "boolean"
  )
    throw new ValidationError("omoikane.requires.network must be boolean");
  const requires = {
    tools: stringList(requiresRecord.tools, "omoikane.requires.tools"),
    commands: stringList(requiresRecord.commands, "omoikane.requires.commands"),
    network: requiresRecord.network === true,
  };
  for (const command of requires.commands) {
    if (!/^[A-Za-z0-9._+-]+$/.test(command))
      throw new ValidationError(
        `omoikane requires an invalid command name: ${command}`,
      );
  }
  const rawEntrypoints = raw.entrypoints ?? {};
  if (
    !rawEntrypoints ||
    typeof rawEntrypoints !== "object" ||
    Array.isArray(rawEntrypoints)
  )
    throw new ValidationError("omoikane.entrypoints must be an object");
  const entrypoints: Record<string, SkillEntrypoint> = {};
  for (const [name, rawEntrypoint] of Object.entries(
    rawEntrypoints as Record<string, unknown>,
  )) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name))
      throw new ValidationError(`invalid Skill entrypoint name: ${name}`);
    if (
      !rawEntrypoint ||
      typeof rawEntrypoint !== "object" ||
      Array.isArray(rawEntrypoint)
    )
      throw new ValidationError(
        `omoikane.entrypoints.${name} must be an object`,
      );
    const entrypoint = rawEntrypoint as Record<string, unknown>;
    const unknownEntrypoint = Object.keys(entrypoint).filter(
      (key) => key !== "command",
    );
    if (unknownEntrypoint.length)
      throw new ValidationError(
        `unsupported fields in omoikane.entrypoints.${name}: ${unknownEntrypoint.join(", ")}`,
      );
    const command = stringList(
      entrypoint.command,
      `omoikane.entrypoints.${name}.command`,
      false,
    );
    if (!command.length)
      throw new ValidationError(
        `omoikane.entrypoints.${name}.command cannot be empty`,
      );
    if (!/^[A-Za-z0-9._+-]+$/.test(command[0]!))
      throw new ValidationError(
        `omoikane.entrypoints.${name} has an invalid executable`,
      );
    entrypoints[name] = { command };
  }
  if (
    workspace === "none" &&
    (requires.commands.length ||
      requires.network ||
      Object.keys(entrypoints).length)
  )
    throw new ValidationError(
      "workspace=none cannot declare commands, network, or entrypoints",
    );
  return {
    schema_version: 1,
    workspace,
    requires,
    entrypoints,
  } as SkillManifestExtension;
};

function parseSkill(source: string) {
  const normalized = source.replace(/\r\n/g, "\n");
  let metadata: Record<string, unknown> = {};
  let body = normalized;
  if (normalized.startsWith("---\n")) {
    const end = normalized.indexOf("\n---\n", 4);
    if (end < 0)
      throw new ValidationError("SKILL.md front matter is not closed");
    const raw = YAML.parse(normalized.slice(4, end));
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new ValidationError("SKILL.md front matter must be an object");
    metadata = raw as Record<string, unknown>;
    body = normalized.slice(end + 5);
  }
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const name = String(metadata.name ?? heading ?? "Skill").trim();
  if (!name || name.length > 512)
    throw new ValidationError("invalid skill name");
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
    extension: manifestExtension(metadata),
    body: body.trim(),
  };
}

async function readDirectory(
  directory: string,
  options: { ignoreDevelopmentDirectories?: boolean } = {},
) {
  const result: BundleFile[] = [];
  const walk = async (current: string, prefix: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (
        options.ignoreDevelopmentDirectories &&
        entry.isDirectory() &&
        [".git", "node_modules"].includes(entry.name)
      )
        continue;
      const path = safeRelative(
        prefix ? `${prefix}/${entry.name}` : entry.name,
      );
      const absolute = resolve(current, entry.name);
      if (entry.isSymbolicLink())
        throw new ValidationError(
          `Skill bundle cannot contain symlinks: ${path}`,
        );
      if (entry.isDirectory()) {
        await walk(absolute, path);
        continue;
      }
      if (!entry.isFile())
        throw new ValidationError(
          `unsupported Skill filesystem entry: ${path}`,
        );
      const handle = await open(
        absolute,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const info = await handle.stat();
        if (!info.isFile())
          throw new ValidationError(
            `Skill entry changed while importing: ${path}`,
          );
        if (info.size > MAX_FILE_BYTES)
          throw new ValidationError(
            `skill file exceeds ${MAX_FILE_BYTES} bytes: ${path}`,
          );
        result.push({ path, data: await handle.readFile() });
      } finally {
        await handle.close();
      }
      if (result.length > MAX_FILES)
        throw new ValidationError(
          `skill bundle must contain 1-${MAX_FILES} files`,
        );
    }
  };
  await walk(directory, "");
  validateFiles(result);
  return result;
}

const fileIndex = (files: BundleFile[]): SkillFileIndex[] =>
  [...files]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => ({
      path: file.path,
      size: file.data.byteLength,
      sha256: checksum(file.data),
    }));

const bundleDigest = (index: SkillFileIndex[]) =>
  checksum(Buffer.from(JSON.stringify(index), "utf8"));

async function makeWritable(path: string): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await chmod(path, 0o700);
    for (const entry of await readdir(path))
      await makeWritable(resolve(path, entry));
  } else await chmod(path, 0o600);
}

async function removeTree(path: string) {
  await makeWritable(path);
  await rm(path, { recursive: true, force: true });
}

async function sealTree(path: string, sealDirectories = true): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink())
    throw new ValidationError("Skill workspace cannot contain symlinks");
  if (info.isDirectory()) {
    for (const entry of await readdir(path))
      await sealTree(resolve(path, entry), sealDirectories);
    if (sealDirectories) await chmod(path, 0o555);
  } else await chmod(path, 0o444);
}

export class SkillService {
  private readonly store: ResourceStore;
  constructor(
    private readonly db: Database,
    private readonly settings: Settings,
  ) {
    this.store = new ResourceStore(db);
  }

  async importPath(path: string) {
    const root = resolve(path);
    const info = await lstat(root);
    if (info.isSymbolicLink())
      throw new ValidationError("Skill import root cannot be a symlink");
    if (!info.isDirectory() && !info.isFile())
      throw new ValidationError(
        "Skill import path must be a directory or SKILL.md",
      );
    if (info.isFile() && basename(root) !== "SKILL.md")
      throw new ValidationError(
        "Skill file import requires a file named SKILL.md",
      );
    const directory = info.isDirectory() ? root : dirname(root);
    const files = await readDirectory(directory, {
      ignoreDevelopmentDirectories: true,
    });
    return this.importFiles(files);
  }

  async importBundle(files: Array<{ path: string; content_base64: string }>) {
    if (!files.length || files.length > MAX_FILES)
      throw new ValidationError(
        `skill bundle must contain 1-${MAX_FILES} files`,
      );
    return this.importFiles(
      files.map((file) => ({
        path: safeRelative(file.path),
        data: strictBase64(file.content_base64, file.path),
      })),
    );
  }

  private async importFiles(files: BundleFile[]) {
    validateFiles(files);
    const skillFile = files.find((file) => file.path === "SKILL.md")!;
    const parsed = parseSkill(skillFile.data.toString("utf8"));
    const index = fileIndex(files);
    const digest = bundleDigest(index);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let createdTarget: string | undefined;
      let stage: string | undefined;
      try {
        return await this.db.transaction(async (tx) => {
          let skill = await this.store.findBySlug("skill", parsed.slug, tx);
          if (!skill)
            skill = await this.store.create(
              {
                kind: "skill",
                slug: parsed.slug,
                name: parsed.name,
                data: { description: parsed.description },
              },
              tx,
            );
          await tx.query("SELECT id FROM resources WHERE id=$1 FOR UPDATE", [
            skill.id,
          ]);
          const versions = await this.store.list<Record<string, unknown>>(
            "skill_version",
            { parentId: skill.id },
            tx,
          );
          const existing = versions.find(
            (item) => String(item.content_hash) === digest,
          );
          if (existing) return { skill, version: existing, reused: true };
          const version =
            Math.max(0, ...versions.map((item) => Number(item.version))) + 1;
          const parent = resolve(this.settings.skillRoot, skill.id);
          await mkdir(parent, { recursive: true });
          stage = await mkdtemp(join(parent, `.v${version}-staging-`));
          for (const file of files) {
            const destination = resolve(stage, file.path);
            if (!pathInside(stage, destination))
              throw new ValidationError(
                "bundle path escaped Skill staging root",
              );
            await mkdir(dirname(destination), { recursive: true });
            await writeFile(destination, file.data, { flag: "wx" });
          }
          await sealTree(stage, false);
          const target = resolve(parent, String(version));
          if (!pathInside(parent, target))
            throw new ValidationError("Skill target escaped Skill root");
          await rename(stage, target);
          stage = undefined;
          createdTarget = target;
          const skillVersion = await this.store.create<SkillVersionData>(
            {
              kind: "skill_version",
              parentId: skill.id,
              name: `v${version}`,
              status: "published",
              data: {
                version,
                content_hash: digest,
                hash_format: "file-index-v1",
                manifest: {
                  ...parsed.metadata,
                  name: parsed.name,
                  slug: parsed.slug,
                  description: parsed.description,
                  omoikane: parsed.extension,
                },
                files: index,
                bundle_uri: target,
              },
            },
            tx,
          );
          return { skill, version: skillVersion, reused: false };
        });
      } catch (error) {
        if (stage) await removeTree(stage);
        if (createdTarget) await removeTree(createdTarget);
        if (error instanceof ConflictError && attempt === 0) continue;
        throw error;
      }
    }
    throw new ConflictError("concurrent Skill import could not be serialized");
  }

  async list() {
    return this.store.list("skill");
  }

  async page(options: PageOptions & { status?: string } = {}) {
    return this.store.page("skill", options);
  }

  async versions(skillId: string) {
    return this.store.list("skill_version", { parentId: skillId });
  }

  async versionsPage(skillId: string, options: PageOptions = {}) {
    return this.store.page("skill_version", {
      ...options,
      parentId: skillId,
    });
  }

  private referenceId(reference: unknown, index: number) {
    if (typeof reference === "string") {
      if (!reference.trim())
        throw new ValidationError(`skills[${index}] is empty`);
      return reference.trim();
    }
    if (!reference || typeof reference !== "object" || Array.isArray(reference))
      throw new ValidationError(
        `skills[${index}] must be an immutable Skill version ID`,
      );
    const record = reference as Record<string, unknown>;
    const unknown = Object.keys(record).filter(
      (key) => !["version_id", "id"].includes(key),
    );
    if (unknown.length)
      throw new ValidationError(
        `skills[${index}] contains unsupported fields: ${unknown.join(", ")}`,
      );
    const value = record.version_id ?? record.id;
    if (typeof value !== "string" || !value.trim())
      throw new ValidationError(`skills[${index}] requires version_id`);
    return value.trim();
  }

  private async version(reference: unknown, index: number) {
    return this.store.get<SkillVersionData>(
      "skill_version",
      this.referenceId(reference, index),
    );
  }

  private extension(version: Resource<SkillVersionData> & SkillVersionData) {
    return manifestExtension(version.manifest);
  }

  async validateBindings(references: unknown, options: SkillValidationOptions) {
    if (references === undefined) return [];
    if (!Array.isArray(references))
      throw new ValidationError("skills must be an array");
    const versions = await Promise.all(
      references.map((reference, index) => this.version(reference, index)),
    );
    const seenIds = new Set<string>();
    const seenSlugs = new Set<string>();
    for (const version of versions) {
      const slug = String(version.manifest.slug);
      if (seenIds.has(version.id))
        throw new ValidationError(
          `duplicate Skill version binding: ${version.id}`,
        );
      if (seenSlugs.has(slug))
        throw new ValidationError(`multiple versions bound for Skill: ${slug}`);
      seenIds.add(version.id);
      seenSlugs.add(slug);
      const extension = this.extension(version);
      const enabled = Boolean(
        options.sandboxConfig?.enabled ?? options.sandbox,
      );
      const networkEnabled = Boolean(
        options.sandboxConfig?.network_enabled ??
        options.sandbox?.spec.networkEnabled,
      );
      if (
        !enabled &&
        (extension.workspace === "required" ||
          extension.requires.commands.length ||
          Object.keys(extension.entrypoints).length)
      )
        throw new ValidationError(
          `Skill ${slug} requires an enabled Sandbox workspace`,
        );
      if (extension.requires.network && !networkEnabled)
        throw new ValidationError(
          `Skill ${slug} requires Sandbox network access, but it is disabled`,
        );
      for (const tool of extension.requires.tools) {
        if (!options.toolNames.has(tool))
          throw new ValidationError(
            `Skill ${slug} requires explicitly bound Tool: ${tool}`,
          );
      }
    }
    return versions;
  }

  private async verifiedFiles(
    version: Resource<SkillVersionData> & SkillVersionData,
  ) {
    const source = resolve(String(version.bundle_uri));
    if (!pathInside(this.settings.skillRoot, source))
      throw new ValidationError(
        `Skill ${version.id} bundle location escaped the configured Skill root`,
      );
    const info = await stat(source);
    if (!info.isDirectory())
      throw new ValidationError(`Skill ${version.id} bundle is unavailable`);
    const files = await readDirectory(source);
    const index = fileIndex(files);
    const digest = bundleDigest(index);
    if (
      version.hash_format === "file-index-v1" &&
      Array.isArray(version.files)
    ) {
      if (
        digest !== version.content_hash ||
        JSON.stringify(index) !== JSON.stringify(version.files)
      )
        throw new ValidationError(
          `Skill ${version.id} content no longer matches its immutable hash`,
        );
    } else {
      const legacyDigest = checksum(
        Buffer.concat(
          [...files]
            .sort((left, right) => left.path.localeCompare(right.path))
            .flatMap((file) => [Buffer.from(file.path), file.data]),
        ),
      );
      if (legacyDigest !== version.content_hash)
        throw new ValidationError(
          `Skill ${version.id} content no longer matches its immutable hash`,
        );
      await this.store.update<SkillVersionData>("skill_version", version.id, {
        data: {
          files: index,
          content_hash: digest,
          hash_format: "file-index-v1",
        },
      });
      version.files = index;
      version.content_hash = digest;
      version.hash_format = "file-index-v1";
    }
    return { files, index, contentHash: digest };
  }

  private async materializeVersion(
    version: Resource<SkillVersionData> & SkillVersionData,
    sandboxRoot: string,
    files: BundleFile[],
  ) {
    const slug = String(version.manifest.slug);
    const relativePath = `${WORKSPACE_ROOT}/${slug}`;
    const destination = resolve(sandboxRoot, relativePath);
    if (!pathInside(sandboxRoot, destination))
      throw new ValidationError("Skill workspace escaped Sandbox root");
    try {
      const existing = await stat(destination);
      if (!existing.isDirectory())
        throw new ValidationError(`Skill workspace collision: ${relativePath}`);
      const materialized = await readDirectory(destination);
      if (bundleDigest(fileIndex(materialized)) !== version.content_hash)
        throw new ValidationError(
          `Skill workspace collision for ${slug}; another version is already materialized`,
        );
      return { path: relativePath, created: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = resolve(sandboxRoot, WORKSPACE_ROOT);
    await mkdir(parent, { recursive: true });
    const stage = resolve(parent, `.${slug}.staging-${newId()}`);
    await mkdir(stage, { recursive: false });
    try {
      for (const file of files) {
        const target = resolve(stage, file.path);
        if (!pathInside(stage, target))
          throw new ValidationError("Skill path escaped materialization root");
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.data, { flag: "wx" });
      }
      await sealTree(stage);
      await rename(stage, destination);
      return { path: relativePath, created: true };
    } catch (error) {
      await removeTree(stage);
      throw error;
    }
  }

  async prepareForRun(
    references: unknown,
    options: SkillValidationOptions,
  ): Promise<SkillRuntimeBinding[]> {
    const versions = await this.validateBindings(references, options);
    const result: SkillRuntimeBinding[] = [];
    for (const version of versions) {
      const extension = this.extension(version);
      const verified = await this.verifiedFiles(version);
      const files = verified.files;
      const effectiveCommands = new Set([
        ...extension.requires.commands,
        ...Object.values(extension.entrypoints).map(
          (entrypoint) => entrypoint.command[0]!,
        ),
      ]);
      if (effectiveCommands.size) {
        if (!options.sandbox || !options.sandboxService)
          throw new ValidationError(
            `Skill ${version.manifest.slug} command requirements need a Sandbox`,
          );
        for (const command of effectiveCommands) {
          if (
            !(await options.sandboxService.commandAvailable(
              options.sandbox,
              command,
            ))
          )
            throw new ValidationError(
              `Skill ${version.manifest.slug} requires unavailable command: ${command}`,
            );
        }
      }
      const workspace =
        options.sandbox && extension.workspace !== "none"
          ? await this.materializeVersion(version, options.sandbox.root, files)
          : undefined;
      const instruction = files
        .find((file) => file.path === "SKILL.md")!
        .data.toString("utf8");
      result.push({
        version_id: version.id,
        skill_id: String(version.parent_id),
        slug: String(version.manifest.slug),
        name: String(version.manifest.name),
        content_hash: verified.contentHash,
        workspace: workspace?.path ?? null,
        entrypoints: extension.entrypoints,
        requirements: extension.requires,
        instruction,
        file_count: verified.index.length,
        materialized: workspace?.created ?? false,
      });
    }
    return result;
  }

  async materialize(skillVersionId: string, sandboxRoot: string) {
    const version = await this.version(skillVersionId, 0);
    const verified = await this.verifiedFiles(version);
    const materialized = await this.materializeVersion(
      version,
      sandboxRoot,
      verified.files,
    );
    return {
      path: materialized.path,
      files: verified.files.map((file) => file.path),
    };
  }

  async instruction(skillVersionId: string) {
    const version = await this.version(skillVersionId, 0);
    const verified = await this.verifiedFiles(version);
    return verified.files
      .find((file) => file.path === "SKILL.md")!
      .data.toString("utf8");
  }
}

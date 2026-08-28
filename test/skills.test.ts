import {
  appendFile,
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelResponse,
} from "@openai/agents/testing";
import type { Container } from "../src/container.js";
import { checksum } from "../src/crypto.js";
import { publishedAgent, testContainer } from "./helpers.js";

let container: Container | undefined;
let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  container = undefined;
  cleanup = undefined;
});

const encoded = (value: string) => Buffer.from(value).toString("base64");

const skillSource = (options: {
  slug: string;
  workspace?: "none" | "optional" | "required";
  tools?: string[];
  commands?: string[];
  network?: boolean;
  entrypoint?: string[];
}) => `---
name: ${options.slug}
slug: ${options.slug}
description: Integration test Skill
omoikane:
  schema_version: 1
  workspace: ${options.workspace ?? "optional"}
  requires:
    tools: ${JSON.stringify(options.tools ?? [])}
    commands: ${JSON.stringify(options.commands ?? [])}
    network: ${options.network ?? false}
  entrypoints: ${
    options.entrypoint
      ? `
    run:
      command: ${JSON.stringify(options.entrypoint)}`
      : "{}"
  }
---

# ${options.slug}

Use the bundled resources only through explicitly available Tools.
`;

const baseConfig = (skillVersionId: string) => ({
  name: "Skill validation Agent",
  instructions: "Use the bound Skill.",
  provider: { connection_id: "deployment-validation-does-not-call-provider" },
  model: "test-model",
  model_settings: {},
  skills: [{ version_id: skillVersionId }],
  tools: ["sandbox-exec"],
  sandbox: { enabled: true, network_enabled: false },
});

describe("SKILL.md execution contract", () => {
  it("materializes an immutable workspace and reuses it across approval resume", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const source = skillSource({
      slug: "workspace-review",
      workspace: "required",
      tools: ["sandbox_exec"],
      commands: ["node"],
      entrypoint: [
        "node",
        ".omoikane/skills/workspace-review/scripts/review.mjs",
      ],
    });
    const imported = await container.skills.importBundle([
      { path: "SKILL.md", content_base64: encoded(source) },
      {
        path: "references/input.json",
        content_base64: encoded('{"marker":"SKILL_WORKSPACE_OK"}\n'),
      },
      {
        path: "scripts/review.mjs",
        content_base64: encoded(
          "import fs from 'node:fs'; const value=JSON.parse(fs.readFileSync('.omoikane/skills/workspace-review/references/input.json','utf8')); console.log(value.marker);\n",
        ),
      },
    ]);
    const model = new ScriptedModel([
      modelResponse([
        functionCall(
          "sandbox_exec",
          {
            command: "node",
            args: [".omoikane/skills/workspace-review/scripts/review.mjs"],
          },
          { callId: "skill-workspace-call" },
        ),
      ]),
      modelResponse([assistantMessage("Skill workspace completed")]),
    ]);
    const fixture = await publishedAgent(container, {
      model,
      tools: ["sandbox-exec"],
      skills: [{ version_id: imported.version.id }],
      sandbox: true,
    });
    const created = await container.runner.create({
      deploymentId: fixture.version.id,
      input: "Run the Skill entrypoint",
    });

    await container.runner.processNext();
    const waiting = await container.runner.get(created.id);
    expect(waiting.status, JSON.stringify(waiting.error_json)).toBe(
      "waiting_approval",
    );
    const sandbox = waiting.context_json.sandbox as {
      root: string;
    };
    const workspace = join(sandbox.root, ".omoikane/skills/workspace-review");
    expect(
      await readFile(join(workspace, "references/input.json"), "utf8"),
    ).toContain("SKILL_WORKSPACE_OK");
    expect((await stat(join(workspace, "SKILL.md"))).mode & 0o222).toBe(0);
    expect((await stat(workspace)).mode & 0o222).toBe(0);
    const approval = (
      await container.db.query<{ id: string }>(
        "SELECT id FROM approvals WHERE run_id=$1",
        [created.id],
      )
    ).rows[0]!;

    await container.runner.decideApproval(approval.id, "approved");
    await container.runner.processNext();

    const completed = await container.runner.publicRun(created.id);
    expect(completed.status).toBe("completed");
    expect(completed.output).toBe("Skill workspace completed");
    const executions = await container.tools.executions(created.id);
    expect(executions).toHaveLength(1);
    expect(executions[0]?.output_json).toMatchObject({
      exit_code: 0,
      timed_out: false,
    });
    expect(
      String((executions[0]?.output_json as Record<string, unknown>).stdout),
    ).toContain("SKILL_WORKSPACE_OK");
    await expect(lstat(sandbox.root)).rejects.toMatchObject({ code: "ENOENT" });
    const stored = await container.runner.get(created.id);
    expect(stored.context_json).not.toHaveProperty("sandbox");
    expect(stored.context_json.skill_bindings).toMatchObject([
      {
        version_id: imported.version.id,
        slug: "workspace-review",
        workspace: ".omoikane/skills/workspace-review",
        file_count: 3,
      },
    ]);
    const events = await container.events.list(created.id);
    expect(
      events.filter((event) => event.type === "skill.prepared"),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.type === "sandbox.destroyed"),
    ).toHaveLength(1);
  }, 30_000);

  it("validates immutable versions and declared privileges at deployment", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const imported = await container.skills.importBundle([
      {
        path: "SKILL.md",
        content_base64: encoded(
          skillSource({
            slug: "privilege-contract",
            workspace: "required",
            tools: ["sandbox_exec"],
            commands: ["node"],
            network: true,
          }),
        ),
      },
    ]);

    await expect(
      container.definitions.deploy({
        config: {
          ...baseConfig(imported.version.id),
          tools: [],
          sandbox: { enabled: true, network_enabled: true },
        },
      }),
    ).rejects.toThrow("requires explicitly bound Tool: sandbox_exec");
    await expect(
      container.definitions.deploy({
        config: {
          ...baseConfig(imported.version.id),
          sandbox: { enabled: false },
        },
      }),
    ).rejects.toThrow("requires an enabled Sandbox workspace");
    await expect(
      container.definitions.deploy({
        config: baseConfig(imported.version.id),
      }),
    ).rejects.toThrow("requires Sandbox network access");
    await expect(
      container.definitions.deploy({
        config: {
          ...baseConfig(imported.version.id),
          skills: ["privilege-contract"],
          sandbox: { enabled: true, network_enabled: true },
        },
      }),
    ).rejects.toThrow("skill_version not found");
    await expect(
      container.definitions.deploy({
        config: {
          ...baseConfig(imported.version.id),
          skills: [imported.version.id, imported.version.id],
          sandbox: { enabled: true, network_enabled: true },
        },
      }),
    ).rejects.toThrow("duplicate Skill version binding");

    const deployment = await container.definitions.deploy({
      config: {
        ...baseConfig(imported.version.id),
        sandbox: { enabled: true, network_enabled: true },
      },
    });
    expect(deployment.config.skills).toEqual([
      { version_id: imported.version.id },
    ]);
  });

  it("fails before model execution when a required Sandbox command is missing", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const imported = await container.skills.importBundle([
      {
        path: "SKILL.md",
        content_base64: encoded(
          skillSource({
            slug: "missing-command",
            workspace: "required",
            commands: ["omoikane-command-that-does-not-exist"],
          }),
        ),
      },
    ]);
    const model = new ScriptedModel([
      modelResponse([assistantMessage("must not execute")]),
    ]);
    const fixture = await publishedAgent(container, {
      model,
      skills: [imported.version.id],
      sandbox: true,
    });
    const run = await container.runner.create({
      deploymentId: fixture.version.id,
      input: "This should fail at Skill preflight",
    });

    await container.runner.processNext();

    const failed = await container.runner.get(run.id);
    expect(failed.status).toBe("failed");
    expect(failed.error_json?.message).toContain(
      "requires unavailable command: omoikane-command-that-does-not-exist",
    );
    expect(model.calls).toHaveLength(0);
    expect(failed.context_json).not.toHaveProperty("sandbox");
  });

  it("verifies and upgrades the hash metadata of legacy Skill versions", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const skill = await container.resources.create({
      kind: "skill",
      id: "legacy-skill",
      slug: "legacy-skill",
      name: "Legacy Skill",
      data: { description: "Imported by the earlier Runtime format" },
    });
    const directory = join(container.settings.skillRoot, skill.id, "1");
    const source = Buffer.from(
      skillSource({ slug: "legacy-skill", workspace: "optional" }),
    );
    const asset = Buffer.from("legacy asset");
    await mkdir(join(directory, "references"), { recursive: true });
    await writeFile(join(directory, "SKILL.md"), source);
    await writeFile(join(directory, "references/asset.txt"), asset);
    const legacyDigest = checksum(
      Buffer.concat([
        Buffer.from("references/asset.txt"),
        asset,
        Buffer.from("SKILL.md"),
        source,
      ]),
    );
    const version = await container.resources.create({
      kind: "skill_version",
      parentId: skill.id,
      name: "v1",
      status: "published",
      data: {
        version: 1,
        content_hash: legacyDigest,
        manifest: {
          name: "Legacy Skill",
          slug: "legacy-skill",
          description: "Imported by the earlier Runtime format",
        },
        bundle_uri: directory,
      },
    });

    expect(await container.skills.instruction(version.id)).toContain(
      "# legacy-skill",
    );
    const upgraded = await container.resources.get<Record<string, unknown>>(
      "skill_version",
      version.id,
    );
    expect(upgraded.hash_format).toBe("file-index-v1");
    expect(upgraded.files).toMatchObject([
      { path: "references/asset.txt", size: asset.byteLength },
      { path: "SKILL.md", size: source.byteLength },
    ]);
    expect(upgraded.content_hash).not.toBe(legacyDigest);
  });

  it("rejects unsafe bundles, symlinks, and post-import mutation", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const minimal = skillSource({ slug: "bundle-safety" });
    await expect(
      container.skills.importBundle([
        { path: "SKILL.md", content_base64: encoded(minimal) },
        { path: "../escape.txt", content_base64: encoded("escape") },
      ]),
    ).rejects.toThrow("unsafe bundle path");
    await expect(
      container.skills.importBundle([
        { path: "SKILL.md", content_base64: encoded(minimal) },
        { path: "bad.txt", content_base64: "not-base64" },
      ]),
    ).rejects.toThrow("invalid base64 content");
    await expect(
      container.skills.importBundle([
        { path: "SKILL.md", content_base64: encoded(minimal) },
        { path: "Asset.txt", content_base64: encoded("one") },
        { path: "asset.txt", content_base64: encoded("two") },
      ]),
    ).rejects.toThrow("case-insensitive filesystems");

    const concurrent = skillSource({ slug: "concurrent-import" });
    const importedConcurrently = await Promise.all([
      container.skills.importBundle([
        { path: "SKILL.md", content_base64: encoded(concurrent) },
      ]),
      container.skills.importBundle([
        { path: "SKILL.md", content_base64: encoded(concurrent) },
      ]),
    ]);
    expect(
      importedConcurrently
        .map((item) => Number(item.version.version))
        .sort((left, right) => left - right),
    ).toEqual([1, 2]);

    const local = await mkdtemp(join(tmpdir(), "omoikane-skill-source-"));
    try {
      await mkdir(join(local, "references"));
      await writeFile(join(local, "SKILL.md"), minimal);
      await writeFile(join(local, "outside.txt"), "outside");
      await symlink(
        join(local, "outside.txt"),
        join(local, "references", "linked.txt"),
      );
      await expect(container.skills.importPath(local)).rejects.toThrow(
        "cannot contain symlinks",
      );
    } finally {
      await rm(local, { recursive: true, force: true });
    }

    const imported = await container.skills.importBundle([
      { path: "SKILL.md", content_base64: encoded(minimal) },
      { path: "empty.txt", content_base64: "" },
    ]);
    const sourcePath = String(imported.version.bundle_uri);
    await chmod(join(sourcePath, "SKILL.md"), 0o600);
    await appendFile(join(sourcePath, "SKILL.md"), "\nmutated\n");
    await expect(
      container.skills.instruction(imported.version.id),
    ).rejects.toThrow("no longer matches its immutable hash");
  });
});

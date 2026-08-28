import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/api.js";
import {
  ArtifactCapacityError,
  ArtifactTooLargeError,
} from "../src/artifacts.js";
import { getSettings } from "../src/config.js";
import { Container } from "../src/container.js";
import { publishedAgent, testContainer } from "./helpers.js";

let closeCurrent: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeCurrent?.();
  closeCurrent = undefined;
});

async function createRun(container: Container) {
  const fixture = await publishedAgent(container);
  return container.runner.create({
    deploymentId: fixture.version.id,
    input: "artifact lifecycle fixture",
  });
}

const missing = async (path: string) => {
  try {
    await access(path);
    return false;
  } catch {
    return true;
  }
};

describe("temporary Artifact lifecycle", () => {
  it("lists active Artifacts by Run with stable cursor pagination and immediate TTL enforcement", async () => {
    const test = await testContainer();
    closeCurrent = test.close;
    const run = await createRun(test.container);
    const otherRun = await test.container.runner.create({
      deploymentId: run.deployment_id,
      input: "other Run",
    });
    const artifacts = await Promise.all(
      ["one", "two", "three"].map((value) =>
        test.container.artifacts.create(`${value}.txt`, Buffer.from(value), {
          runId: run.id,
          mimeType: "text/plain",
        }),
      ),
    );
    await test.container.artifacts.create("other.txt", Buffer.from("other"), {
      runId: otherRun.id,
    });
    await test.container.db.query(
      "UPDATE artifacts SET created_at='2026-01-01T00:00:00.000Z' WHERE run_id=$1",
      [run.id],
    );

    const expected = artifacts
      .map((item) => item.id)
      .sort()
      .reverse();
    const first = await test.container.artifacts.page({
      runId: run.id,
      limit: 2,
    });
    const second = await test.container.artifacts.page({
      runId: run.id,
      limit: 2,
      cursor: first.next_cursor!,
    });
    expect([...first.data, ...second.data].map((item) => item.id)).toEqual(
      expected,
    );
    expect(first.data.every((item) => !("storage_key" in item))).toBe(true);

    await test.container.db.query(
      "UPDATE artifacts SET expires_at=now()-interval '1 second' WHERE id=$1",
      [artifacts[0]!.id],
    );
    await expect(
      test.container.artifacts.get(artifacts[0]!.id),
    ).rejects.toThrow("artifact not found");
    const available = await test.container.artifacts.page({ runId: run.id });
    expect(available.data.map((item) => item.id)).not.toContain(
      artifacts[0]!.id,
    );
  });

  it("streams uploads, enforces file and total limits, and cleans failed partial uploads", async () => {
    const test = await testContainer({
      env: {
        OMOIKANE_ARTIFACT_MAX_FILE_BYTES: "6",
        OMOIKANE_ARTIFACT_MAX_TOTAL_BYTES: "10",
      },
    });
    closeCurrent = test.close;
    const run = await createRun(test.container);

    await expect(
      test.container.artifacts.create("large.bin", Buffer.alloc(7), {
        runId: run.id,
      }),
    ).rejects.toBeInstanceOf(ArtifactTooLargeError);

    const broken = Readable.from(
      (async function* () {
        yield Buffer.from("abc");
        throw new Error("simulated interrupted upload");
      })(),
    );
    await expect(
      test.container.artifacts.createStream("partial.bin", broken, {
        runId: run.id,
      }),
    ).rejects.toThrow("simulated interrupted upload");

    const concurrent = await Promise.allSettled([
      test.container.artifacts.create("left.bin", Buffer.alloc(6), {
        runId: run.id,
      }),
      test.container.artifacts.create("right.bin", Buffer.alloc(6), {
        runId: run.id,
      }),
    ]);
    expect(
      concurrent.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = concurrent.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected?.reason).toBeInstanceOf(ArtifactCapacityError);

    const rows = await test.container.db.query<{
      status: string;
      count: number;
    }>("SELECT status,count(*)::int AS count FROM artifacts GROUP BY status");
    expect(rows.rows.find((row) => row.status === "active")?.count).toBe(1);
    expect(
      await readdir(join(test.container.settings.artifactRoot, ".staging")),
    ).toEqual([]);
    expect(await test.container.artifacts.usage()).toMatchObject({
      active_bytes: 6,
      maximum_file_bytes: 6,
      maximum_total_bytes: 10,
    });
  });

  it("returns a typed corruption error and removes invalid bytes", async () => {
    const test = await testContainer();
    closeCurrent = test.close;
    const run = await createRun(test.container);
    const artifact = await test.container.artifacts.create(
      "integrity.txt",
      Buffer.from("original"),
      { runId: run.id },
    );
    const stored = (
      await test.container.db.query<{ storage_key: string }>(
        "SELECT storage_key FROM artifacts WHERE id=$1",
        [artifact.id],
      )
    ).rows[0]!;
    const path = join(test.container.settings.artifactRoot, stored.storage_key);
    await writeFile(path, "tampered");

    const app = await createApp(test.container);
    try {
      const metadata = await app.inject({
        method: "GET",
        url: `/v1/artifacts/${artifact.id}`,
      });
      expect(metadata.json()).not.toHaveProperty("storage_key");
      const response = await app.inject({
        method: "GET",
        url: `/v1/artifacts/${artifact.id}/download`,
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: { code: "artifact_corrupt" },
      });
    } finally {
      await app.close();
    }
    expect(
      (
        await test.container.db.query<{ status: string }>(
          "SELECT status FROM artifacts WHERE id=$1",
          [artifact.id],
        )
      ).rows[0]?.status,
    ).toBe("corrupt");
    expect(await missing(path)).toBe(true);
  });

  it("recovers staging/deleting states and orphan files when the Runtime restarts", async () => {
    const root = await mkdtemp(join(tmpdir(), "omoikane-artifact-restart-"));
    const env = {
      OMOIKANE_DATA_DIR: root,
      OMOIKANE_DATABASE_URL: `pglite://${join(root, "database")}`,
      OMOIKANE_ARTIFACT_DIR: join(root, "artifacts"),
      OMOIKANE_SKILL_DIR: join(root, "skills"),
      OMOIKANE_SANDBOX_DIR: join(root, "sandboxes"),
      OMOIKANE_CREDENTIAL_SECRET: "artifact-restart-test-secret",
      OMOIKANE_TRACING_EXPORTER: "disabled",
      OMOIKANE_LOG_LEVEL: "silent",
      OMOIKANE_AUTO_MIGRATE: "true",
    };
    let first: Container | undefined;
    let restarted: Container | undefined;
    try {
      first = await Container.create(getSettings(env), { startWorker: false });
      const run = await createRun(first);
      const staged = await first.artifacts.create(
        "staged.txt",
        Buffer.from("recover me"),
        { runId: run.id },
      );
      const deleting = await first.artifacts.create(
        "deleting.txt",
        Buffer.from("delete me"),
        { runId: run.id },
      );
      const corrupt = await first.artifacts.create(
        "corrupt.txt",
        Buffer.from("valid before crash"),
        { runId: run.id },
      );
      const records = await first.db.query<{
        id: string;
        storage_key: string;
      }>("SELECT id,storage_key FROM artifacts WHERE run_id=$1", [run.id]);
      const keys = new Map(
        records.rows.map((row) => [row.id, row.storage_key]),
      );
      await first.db.query(
        "UPDATE artifacts SET status='staging' WHERE id=$1",
        [staged.id],
      );
      await first.db.query(
        "UPDATE artifacts SET status='deleting' WHERE id=$1",
        [deleting.id],
      );
      await writeFile(
        join(first.settings.artifactRoot, keys.get(corrupt.id)!),
        "bad",
      );
      const orphan = join(first.settings.artifactRoot, "orphan", "file.bin");
      await mkdir(dirname(orphan), { recursive: true });
      await writeFile(orphan, "orphan");
      await first.close();
      first = undefined;

      restarted = await Container.create(getSettings(env), {
        startWorker: false,
      });
      expect(
        Buffer.from(await restarted.artifacts.bytes(staged.id)).toString(),
      ).toBe("recover me");
      await expect(restarted.artifacts.get(deleting.id)).rejects.toThrow(
        "artifact not found",
      );
      await expect(restarted.artifacts.get(corrupt.id)).rejects.toThrow(
        "artifact not found",
      );
      const statuses = await restarted.db.query<{ id: string; status: string }>(
        "SELECT id,status FROM artifacts WHERE run_id=$1",
        [run.id],
      );
      expect(new Map(statuses.rows.map((row) => [row.id, row.status]))).toEqual(
        new Map([
          [staged.id, "active"],
          [deleting.id, "deleted"],
          [corrupt.id, "corrupt"],
        ]),
      );
      expect(await missing(orphan)).toBe(true);
      expect(
        createHash("sha256")
          .update(await restarted.artifacts.bytes(staged.id))
          .digest("hex"),
      ).toBe(staged.sha256);
    } finally {
      await restarted?.close();
      await first?.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("converges when explicit deletion races expiration cleanup", async () => {
    const test = await testContainer();
    closeCurrent = test.close;
    const run = await createRun(test.container);
    const artifact = await test.container.artifacts.create(
      "race.txt",
      Buffer.from("race"),
      { runId: run.id },
    );
    await test.container.db.query(
      "UPDATE artifacts SET expires_at=now()-interval '1 second' WHERE id=$1",
      [artifact.id],
    );
    await Promise.allSettled([
      test.container.artifacts.remove(artifact.id),
      test.container.artifacts.reapExpired(),
    ]);
    await test.container.artifacts.reapExpired();
    const row = (
      await test.container.db.query<{ status: string }>(
        "SELECT status FROM artifacts WHERE id=$1",
        [artifact.id],
      )
    ).rows[0];
    expect(row?.status).toBe("deleted");
    await expect(test.container.artifacts.get(artifact.id)).rejects.toThrow(
      "artifact not found",
    );
    await test.container.db.query(
      "UPDATE artifacts SET updated_at=now()-interval '2 days' WHERE id=$1",
      [artifact.id],
    );
    await test.container.artifacts.reapExpired();
    expect(
      (
        await test.container.db.query("SELECT id FROM artifacts WHERE id=$1", [
          artifact.id,
        ])
      ).rowCount,
    ).toBe(0);
  });

  it("exposes paged Artifact metadata and capacity through REST", async () => {
    const test = await testContainer();
    closeCurrent = test.close;
    const run = await createRun(test.container);
    const app = await createApp(test.container);
    try {
      const boundary = "omoikane-artifact-test-boundary";
      const uploaded = await app.inject({
        method: "POST",
        url: `/v1/artifacts?run_id=${run.id}`,
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload: Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="api.txt"\r\nContent-Type: text/plain\r\n\r\napi\r\n--${boundary}--\r\n`,
        ),
      });
      expect(uploaded.statusCode).toBe(201);
      const artifact = uploaded.json() as { id: string };
      const listed = await app.inject({
        method: "GET",
        url: `/v1/artifacts?run_id=${run.id}&limit=1`,
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toEqual({
        data: [expect.objectContaining({ id: artifact.id, status: "active" })],
        next_cursor: null,
      });
      expect(listed.body).not.toContain("storage_key");
      const status = await app.inject({
        method: "GET",
        url: "/v1/runtime/status",
      });
      expect(status.json().artifacts).toMatchObject({
        active_bytes: 3,
        maximum_file_bytes: 100_000_000,
        maximum_total_bytes: 1_000_000_000,
      });
    } finally {
      await app.close();
    }
  });
});

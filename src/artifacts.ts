import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Settings } from "./config.js";
import type { Database } from "./database.js";
import { NotFoundError, required } from "./database.js";
import { checksum } from "./crypto.js";
import {
  decodePageCursor,
  pageFromRows,
  pageLimit,
  type PageOptions,
} from "./pagination.js";
import { newId } from "./serialization.js";

export type ArtifactStatus =
  "staging" | "active" | "deleting" | "deleted" | "corrupt";

export interface ArtifactRecord extends Record<string, unknown> {
  id: string;
  run_id: string;
  source: string;
  filename: string;
  sha256: string;
  mime_type: string;
  size: number;
  lineage_json: Record<string, unknown>;
  status: ArtifactStatus;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ArtifactRow extends ArtifactRecord {
  storage_key: string;
}

class ArtifactRuntimeError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly errorCode: string,
  ) {
    super(message);
  }
}

export class ArtifactTooLargeError extends ArtifactRuntimeError {
  constructor(limit: number) {
    super(
      `artifact exceeds the ${limit} byte file limit`,
      413,
      "artifact_too_large",
    );
  }
}

export class ArtifactCapacityError extends ArtifactRuntimeError {
  constructor(limit: number) {
    super(
      `temporary artifact storage exceeds the ${limit} byte Runtime limit`,
      507,
      "artifact_capacity_exceeded",
    );
  }
}

export class ArtifactCorruptError extends ArtifactRuntimeError {
  constructor() {
    super(
      "artifact bytes are missing or do not match their recorded checksum",
      409,
      "artifact_corrupt",
    );
  }
}

const publicArtifact = ({ storage_key: _storageKey, ...row }: ArtifactRow) =>
  row as ArtifactRecord;

const isMissing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";

export class ArtifactService {
  private readonly activeUploads = new Set<string>();
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: Database,
    private readonly settings: Settings,
  ) {}

  private path(storageKey: string) {
    const root = resolve(this.settings.artifactRoot);
    const target = resolve(root, storageKey);
    if (!target.startsWith(`${root}${sep}`)) throw new ArtifactCorruptError();
    return target;
  }

  private stagingPath(id: string) {
    return this.path(`.staging/${id}.tmp`);
  }

  private async serialized<T>(callback: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.mutationTail;
    this.mutationTail = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }

  private async activeBytes() {
    const result = await this.db.query<{ bytes: number | string }>(
      "SELECT COALESCE(SUM(size),0) AS bytes FROM artifacts WHERE status='active'",
    );
    return Number(result.rows[0]?.bytes ?? 0);
  }

  private async removeFiles(row: Pick<ArtifactRow, "id" | "storage_key">) {
    await Promise.all([
      rm(dirname(this.path(row.storage_key)), { recursive: true, force: true }),
      rm(this.stagingPath(row.id), { force: true }),
    ]);
  }

  private async abandon(row: Pick<ArtifactRow, "id" | "storage_key">) {
    await this.removeFiles(row);
    await this.db.query(
      "UPDATE artifacts SET status='deleted',updated_at=now() WHERE id=$1 AND status IN ('staging','deleting')",
      [row.id],
    );
  }

  private async markCorrupt(row: Pick<ArtifactRow, "id" | "storage_key">) {
    await this.db.query(
      "UPDATE artifacts SET status='corrupt',updated_at=now() WHERE id=$1 AND status IN ('staging','active')",
      [row.id],
    );
    await this.removeFiles(row);
  }

  private async digestFile(path: string) {
    const hash = createHash("sha256");
    let size = 0;
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink())
        return { validFile: false, size: 0, sha256: "" };
      for await (const chunk of createReadStream(path)) {
        const bytes = Buffer.from(chunk as Uint8Array);
        size += bytes.byteLength;
        hash.update(bytes);
      }
      return { validFile: true, size, sha256: hash.digest("hex") };
    } catch (error) {
      if (isMissing(error)) return { validFile: false, size: 0, sha256: "" };
      throw error;
    }
  }

  async create(
    filename: string,
    data: Uint8Array,
    options: {
      runId: string;
      mimeType?: string;
      source?: string;
      lineage?: Record<string, unknown>;
    },
  ) {
    if (data.byteLength > this.settings.artifactMaxFileBytes)
      throw new ArtifactTooLargeError(this.settings.artifactMaxFileBytes);
    return this.createStream(filename, Readable.from([data]), options);
  }

  async createStream(
    filename: string,
    source: Readable,
    options: {
      runId: string;
      mimeType?: string;
      source?: string;
      lineage?: Record<string, unknown>;
    },
  ) {
    await required(
      this.db,
      "SELECT id FROM runs WHERE id=$1",
      [options.runId],
      "run not found",
    );
    const id = newId();
    const filenameBase = basename(filename) || "artifact.bin";
    const clean =
      filenameBase.replace(/[\u0000-\u001f\u007f]/g, "_").slice(0, 255) ||
      "artifact.bin";
    const key = `${id}/${clean}`;
    const temporary = this.stagingPath(id);
    const target = this.path(key);
    const staged = await required<ArtifactRow>(
      this.db,
      `INSERT INTO artifacts(id,run_id,source,filename,storage_key,sha256,mime_type,size,lineage_json,status,expires_at)
       VALUES($1,$2,$3,$4,$5,'',$6,0,$7::jsonb,'staging',now()+($8 || ' seconds')::interval) RETURNING *`,
      [
        id,
        options.runId,
        options.source ?? "upload",
        clean,
        key,
        options.mimeType ?? "application/octet-stream",
        JSON.stringify(options.lineage ?? {}),
        this.settings.artifactTtlSeconds,
      ],
    );
    this.activeUploads.add(id);
    const hash = createHash("sha256");
    let size = 0;
    const meter = new Transform({
      transform: (chunk: Buffer, _encoding, done) => {
        size += chunk.byteLength;
        if (size > this.settings.artifactMaxFileBytes) {
          done(new ArtifactTooLargeError(this.settings.artifactMaxFileBytes));
          return;
        }
        hash.update(chunk);
        done(null, chunk);
      },
    });
    try {
      await mkdir(dirname(temporary), { recursive: true });
      await pipeline(
        source,
        meter,
        createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
      );
      const sha256 = hash.digest("hex");
      return await this.serialized(async () => {
        if (
          (await this.activeBytes()) + size >
          this.settings.artifactMaxTotalBytes
        )
          throw new ArtifactCapacityError(this.settings.artifactMaxTotalBytes);
        const reserved = await this.db.query(
          `UPDATE artifacts SET sha256=$2,size=$3,updated_at=now()
           WHERE id=$1 AND status='staging'`,
          [id, sha256, size],
        );
        if (!reserved.rowCount)
          throw new NotFoundError("artifact upload is no longer active");
        await mkdir(dirname(target), { recursive: true });
        await rename(temporary, target);
        const active = await required<ArtifactRow>(
          this.db,
          `UPDATE artifacts SET status='active',updated_at=now()
           WHERE id=$1 AND status='staging' RETURNING *`,
          [id],
          "artifact upload is no longer active",
        );
        return publicArtifact(active);
      });
    } catch (error) {
      await this.abandon(staged).catch(() => undefined);
      throw error;
    } finally {
      this.activeUploads.delete(id);
    }
  }

  async get(id: string) {
    const row = await required<ArtifactRow>(
      this.db,
      `SELECT * FROM artifacts
       WHERE id=$1 AND status='active' AND (expires_at IS NULL OR expires_at>now())`,
      [id],
      "artifact not found",
    );
    return publicArtifact(row);
  }

  async page(
    options: PageOptions & { runId: string; status?: ArtifactStatus },
  ) {
    await required(
      this.db,
      "SELECT id FROM runs WHERE id=$1",
      [options.runId],
      "run not found",
    );
    const status = options.status ?? "active";
    const scope = `artifacts:${options.runId}:${status}`;
    const cursor = decodePageCursor(options.cursor, scope);
    const limit = pageLimit(options.limit);
    const params: unknown[] = [options.runId, status];
    let cursorSql = "";
    if (cursor) {
      params.push(cursor.createdAt, cursor.id);
      cursorSql = ` AND (created_at<$3 OR (created_at=$3 AND id<$4))`;
    }
    params.push(limit + 1);
    const rows = await this.db.query<ArtifactRow>(
      `SELECT * FROM artifacts WHERE run_id=$1 AND status=$2
       ${status === "active" ? "AND (expires_at IS NULL OR expires_at>now())" : ""}
       ${cursorSql} ORDER BY created_at DESC,id DESC LIMIT $${params.length}`,
      params,
    );
    const page = pageFromRows(rows.rows, limit, scope);
    return { ...page, data: page.data.map(publicArtifact) };
  }

  async bytes(id: string): Promise<Uint8Array> {
    const row = await required<ArtifactRow>(
      this.db,
      `SELECT * FROM artifacts
       WHERE id=$1 AND status='active' AND (expires_at IS NULL OR expires_at>now())`,
      [id],
      "artifact not found",
    );
    try {
      const data = await readFile(this.path(row.storage_key));
      if (data.byteLength !== Number(row.size) || checksum(data) !== row.sha256)
        throw new ArtifactCorruptError();
      return data;
    } catch (error) {
      if (error instanceof ArtifactCorruptError || isMissing(error)) {
        await this.markCorrupt(row);
        throw new ArtifactCorruptError();
      }
      throw error;
    }
  }

  async remove(id: string) {
    const row = await required<ArtifactRow>(
      this.db,
      `UPDATE artifacts SET status='deleting',updated_at=now()
       WHERE id=$1 AND status='active' RETURNING *`,
      [id],
      "artifact not found",
    );
    await this.removeFiles(row);
    await this.db.query(
      "UPDATE artifacts SET status='deleted',updated_at=now() WHERE id=$1 AND status='deleting'",
      [id],
    );
  }

  async reapExpired() {
    await this.db.query(
      `UPDATE artifacts SET status='deleting',updated_at=now()
       WHERE status='active' AND expires_at<=now()`,
    );
    const deleting = await this.db.query<ArtifactRow>(
      "SELECT * FROM artifacts WHERE status='deleting' ORDER BY created_at,id",
    );
    for (const row of deleting.rows) await this.abandon(row);
    const tombstones = await this.db.query(
      `DELETE FROM artifacts
       WHERE status IN ('deleted','corrupt')
       AND updated_at<=now()-($1 || ' seconds')::interval`,
      [this.settings.artifactTtlSeconds],
    );
    return deleting.rowCount + tombstones.rowCount;
  }

  private async recoverStaging(row: ArtifactRow) {
    if (this.activeUploads.has(row.id)) return false;
    const temporary = this.stagingPath(row.id);
    const target = this.path(row.storage_key);
    if (!/^[a-f0-9]{64}$/.test(row.sha256)) {
      await this.abandon(row);
      return true;
    }
    const targetDigest = await this.digestFile(target);
    const temporaryDigest = targetDigest.validFile
      ? undefined
      : await this.digestFile(temporary);
    const actual = targetDigest.validFile ? targetDigest : temporaryDigest!;
    if (
      !actual.validFile ||
      actual.size !== Number(row.size) ||
      actual.sha256 !== row.sha256
    ) {
      await this.markCorrupt(row);
      return true;
    }
    await this.serialized(async () => {
      if (
        (await this.activeBytes()) + Number(row.size) >
        this.settings.artifactMaxTotalBytes
      ) {
        await this.abandon(row);
        return;
      }
      if (!targetDigest.validFile) {
        await mkdir(dirname(target), { recursive: true });
        await rename(temporary, target);
      }
      await this.db.query(
        "UPDATE artifacts SET status='active',updated_at=now() WHERE id=$1 AND status='staging'",
        [row.id],
      );
    });
    return true;
  }

  async reconcile() {
    let changed = 0;
    const rows = await this.db.query<ArtifactRow>(
      "SELECT * FROM artifacts WHERE status IN ('staging','active','deleting') ORDER BY created_at,id",
    );
    for (const row of rows.rows) {
      if (row.status === "staging") {
        if (await this.recoverStaging(row)) changed += 1;
        continue;
      }
      if (row.status === "deleting") {
        await this.abandon(row);
        changed += 1;
        continue;
      }
      if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
        await this.remove(row.id);
        changed += 1;
        continue;
      }
      const digest = await this.digestFile(this.path(row.storage_key));
      if (
        !digest.validFile ||
        digest.size !== Number(row.size) ||
        digest.sha256 !== row.sha256
      ) {
        await this.markCorrupt(row);
        changed += 1;
      }
    }

    const live = await this.db.query<{ id: string; storage_key: string }>(
      "SELECT id,storage_key FROM artifacts WHERE status IN ('staging','active','deleting')",
    );
    const liveDirectories = new Set(
      live.rows.map((row) => row.storage_key.split("/")[0]!),
    );
    for (const entry of await readdir(this.settings.artifactRoot, {
      withFileTypes: true,
    })) {
      if (entry.name === ".staging") continue;
      if (!liveDirectories.has(entry.name)) {
        await rm(resolve(this.settings.artifactRoot, entry.name), {
          recursive: true,
          force: true,
        });
        changed += 1;
      }
    }
    const stagingRoot = resolve(this.settings.artifactRoot, ".staging");
    await mkdir(stagingRoot, { recursive: true });
    const stagingFiles = new Set(
      live.rows
        .filter((row) => this.activeUploads.has(row.id))
        .map((row) => `${row.id}.tmp`),
    );
    for (const entry of await readdir(stagingRoot, { withFileTypes: true })) {
      if (!stagingFiles.has(entry.name)) {
        await rm(resolve(stagingRoot, entry.name), {
          recursive: true,
          force: true,
        });
        changed += 1;
      }
    }
    return changed;
  }

  async usage() {
    const rows = await this.db.query<{
      status: string;
      bytes: number | string;
    }>(
      `SELECT status,COALESCE(SUM(size),0) AS bytes
       FROM artifacts GROUP BY status ORDER BY status`,
    );
    return {
      maximum_file_bytes: this.settings.artifactMaxFileBytes,
      maximum_total_bytes: this.settings.artifactMaxTotalBytes,
      active_bytes: Number(
        rows.rows.find((row) => row.status === "active")?.bytes ?? 0,
      ),
    };
  }

  localStream(row: ArtifactRow) {
    return createReadStream(this.path(row.storage_key));
  }
}

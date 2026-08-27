import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Settings } from "./config.js";
import type { Database } from "./database.js";
import { NotFoundError, required } from "./database.js";
import { checksum } from "./crypto.js";
import { newId } from "./serialization.js";

interface ArtifactRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  run_id: string | null;
  source: string;
  filename: string;
  storage_key: string;
  sha256: string;
  mime_type: string;
  size: number;
  lineage_json: Record<string, unknown>;
  status: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export class ArtifactService {
  private readonly s3?: S3Client;
  constructor(
    private readonly db: Database,
    private readonly settings: Settings,
  ) {
    if (settings.artifactBackend === "s3")
      this.s3 = new S3Client({
        region: settings.s3Region ?? "auto",
        endpoint: settings.s3EndpointUrl,
        forcePathStyle: Boolean(settings.s3EndpointUrl),
      });
  }
  async create(
    tenantId: string,
    filename: string,
    data: Uint8Array,
    options: {
      runId?: string;
      mimeType?: string;
      source?: string;
      lineage?: Record<string, unknown>;
    } = {},
  ) {
    const id = newId();
    const clean = basename(filename) || "artifact.bin";
    const key = `${tenantId}/${id}/${clean}`;
    const hash = checksum(data);
    if (this.s3) {
      if (!this.settings.s3Bucket)
        throw new Error("AGENT_S3_BUCKET is required");
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.settings.s3Bucket,
          Key: key,
          Body: data,
          ContentType: options.mimeType,
        }),
      );
    } else {
      const target = resolve(this.settings.artifactRoot, key);
      await mkdir(dirname(target), { recursive: true });
      const temporary = `${target}.${newId()}.tmp`;
      await writeFile(temporary, data);
      await rename(temporary, target);
    }
    return required<ArtifactRow>(
      this.db,
      `INSERT INTO artifacts(id,tenant_id,run_id,source,filename,storage_key,sha256,mime_type,size,lineage_json)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING *`,
      [
        id,
        tenantId,
        options.runId ?? null,
        options.source ?? "upload",
        clean,
        key,
        hash,
        options.mimeType ?? "application/octet-stream",
        data.byteLength,
        JSON.stringify(options.lineage ?? {}),
      ],
    );
  }
  async get(tenantId: string, id: string) {
    return required<ArtifactRow>(
      this.db,
      "SELECT * FROM artifacts WHERE id=$1 AND tenant_id=$2 AND status='active'",
      [id, tenantId],
      "artifact not found",
    );
  }
  async bytes(tenantId: string, id: string): Promise<Uint8Array> {
    const row = await this.get(tenantId, id);
    if (this.s3) {
      const response = await this.s3.send(
        new GetObjectCommand({
          Bucket: this.settings.s3Bucket!,
          Key: row.storage_key,
        }),
      );
      return response.Body?.transformToByteArray() ?? new Uint8Array();
    }
    return readFile(resolve(this.settings.artifactRoot, row.storage_key));
  }
  async remove(tenantId: string, id: string) {
    const row = await this.get(tenantId, id);
    if (this.s3)
      await this.s3.send(
        new DeleteObjectCommand({
          Bucket: this.settings.s3Bucket!,
          Key: row.storage_key,
        }),
      );
    else
      await rm(resolve(this.settings.artifactRoot, row.storage_key), {
        force: true,
      });
    await this.db.query(
      "UPDATE artifacts SET status='deleted',updated_at=now() WHERE id=$1",
      [id],
    );
  }
  localStream(row: ArtifactRow) {
    if (this.s3) return undefined;
    return createReadStream(
      resolve(this.settings.artifactRoot, row.storage_key),
    );
  }
}

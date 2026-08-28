import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

interface LockRecord {
  pid: number;
  token: string;
  owner: string;
  started_at: string;
}

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function readLock(path: string): Promise<LockRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as LockRecord;
    if (
      !Number.isSafeInteger(value.pid) ||
      value.pid < 1 ||
      typeof value.token !== "string" ||
      typeof value.owner !== "string"
    )
      throw new Error(`Runtime lock is malformed: ${path}`);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export class RuntimeLock {
  private released = false;
  private constructor(
    readonly path: string,
    readonly owner: string,
    private readonly token: string,
  ) {}

  static async acquire(dataDir: string, owner: string): Promise<RuntimeLock> {
    const reservation = `${resolve(dataDir)}.restore.lock`;
    const existing = await readLock(reservation);
    if (existing) {
      if (processIsAlive(existing.pid))
        throw new Error(`Runtime data directory is being restored: ${dataDir}`);
      await unlink(reservation).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
    return this.acquirePath(resolve(dataDir, "runtime.lock"), owner);
  }

  static async acquireRestoreReservation(
    targetDataDir: string,
    owner = "restore",
  ): Promise<RuntimeLock> {
    return this.acquirePath(`${resolve(targetDataDir)}.restore.lock`, owner);
  }

  private static async acquirePath(
    path: string,
    owner: string,
  ): Promise<RuntimeLock> {
    await mkdir(dirname(path), { recursive: true });
    const token = randomUUID();
    const record: LockRecord = {
      pid: process.pid,
      token,
      owner,
      started_at: new Date().toISOString(),
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(path, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        return new RuntimeLock(path, owner, token);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await readLock(path);
        if (existing && processIsAlive(existing.pid))
          throw new Error(
            `Runtime data directory is in use by ${existing.owner} (pid ${existing.pid})`,
          );
        if (attempt === 0) {
          await unlink(path).catch((unlinkError) => {
            if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT")
              throw unlinkError;
          });
          continue;
        }
        throw new Error(`cannot acquire Runtime lock: ${path}`);
      }
    }
    throw new Error(`cannot acquire Runtime lock: ${path}`);
  }

  async release() {
    if (this.released) return;
    this.released = true;
    const existing = await readLock(this.path);
    if (existing?.token === this.token)
      await unlink(this.path).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
  }
}

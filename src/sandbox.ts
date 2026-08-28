import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Settings } from "./config.js";
import { ValidationError } from "./database.js";
import { newId } from "./serialization.js";

export interface SandboxSpec {
  runId: string;
  cpuLimit: number;
  memoryMb: number;
  diskMb: number;
  timeoutSeconds: number;
  networkEnabled: boolean;
  image?: string;
}
export interface SandboxHandle {
  id: string;
  root: string;
  provider: "process" | "docker";
  spec: SandboxSpec;
}
export interface SandboxResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  timed_out: boolean;
}
const runProcess = (
  command: string,
  args: string[],
  options: {
    cwd?: string;
    timeoutMs: number;
    maxBytes?: number;
    env?: NodeJS.ProcessEnv;
  },
): Promise<SandboxResult> =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      timed = false;
    const max = options.maxBytes ?? 2_000_000;
    child.stdout.on("data", (data) => {
      if (stdout.length < max) stdout += data.toString();
    });
    child.stderr.on("data", (data) => {
      if (stderr.length < max) stderr += data.toString();
    });
    child.on("error", reject);
    const timer = setTimeout(() => {
      timed = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({
        exit_code: code ?? -1,
        stdout: stdout.slice(0, max),
        stderr: stderr.slice(0, max),
        timed_out: timed,
      });
    });
  });

export class SandboxService {
  constructor(private readonly settings: Settings) {}
  async create(
    spec: Partial<SandboxSpec> & { runId: string },
  ): Promise<SandboxHandle> {
    const complete: SandboxSpec = {
      cpuLimit: spec.cpuLimit ?? 1,
      memoryMb: spec.memoryMb ?? 512,
      diskMb: spec.diskMb ?? 1024,
      timeoutSeconds: spec.timeoutSeconds ?? 60,
      networkEnabled: spec.networkEnabled ?? false,
      image: spec.image ?? "node:22-alpine",
      runId: spec.runId,
    };
    const id = newId();
    const root = resolve(this.settings.sandboxRoot, id);
    await mkdir(root, { recursive: true });
    if (this.settings.sandboxProvider === "docker") await chmod(root, 0o777);
    return {
      id,
      root,
      provider: this.settings.sandboxProvider,
      spec: complete,
    };
  }
  private safe(handle: SandboxHandle, path: string) {
    const target = resolve(handle.root, path);
    if (
      !target.startsWith(`${resolve(handle.root)}/`) &&
      target !== resolve(handle.root)
    )
      throw new ValidationError("sandbox path escape blocked");
    return target;
  }
  async write(handle: SandboxHandle, path: string, data: Uint8Array | string) {
    const target = this.safe(handle, path);
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, data);
  }
  async execute(
    handle: SandboxHandle,
    command: string,
    args: string[] = [],
  ): Promise<SandboxResult> {
    if (!command || command.includes("\0"))
      throw new ValidationError("invalid command");
    const timeoutMs = handle.spec.timeoutSeconds * 1000;
    if (handle.provider === "process")
      return runProcess(command, args, {
        cwd: handle.root,
        timeoutMs,
        env: {
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          LANG: process.env.LANG ?? "C.UTF-8",
          OMOIKANE_SANDBOX: "process",
        },
      });
    const dockerArgs = [
      "run",
      "--rm",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--user=65532:65532",
      "--pids-limit=128",
      `--cpus=${handle.spec.cpuLimit}`,
      `--memory=${handle.spec.memoryMb}m`,
      `--network=${handle.spec.networkEnabled ? "bridge" : "none"}`,
      "--tmpfs",
      `/tmp:rw,noexec,nosuid,size=64m`,
      `--mount`,
      `type=bind,source=${handle.root},target=/workspace`,
      "--workdir",
      "/workspace",
      handle.spec.image ?? "node:22-alpine",
      command,
      ...args,
    ];
    return runProcess("docker", dockerArgs, { timeoutMs });
  }
  async commandAvailable(handle: SandboxHandle, command: string) {
    if (!/^[A-Za-z0-9._+-]+$/.test(command))
      throw new ValidationError("invalid command requirement");
    const result = await this.execute(handle, "sh", [
      "-c",
      'command -v "$1" >/dev/null 2>&1',
      "omoikane-command-check",
      command,
    ]);
    return result.exit_code === 0 && !result.timed_out;
  }
  async destroy(handle: SandboxHandle) {
    const makeWritable = async (path: string): Promise<void> => {
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
    };
    await makeWritable(handle.root);
    await rm(handle.root, { recursive: true, force: true });
  }
}

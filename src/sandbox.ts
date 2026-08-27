import { spawn } from "node:child_process";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
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
  provider: "local" | "docker";
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
  options: { cwd?: string; timeoutMs: number; maxBytes?: number },
): Promise<SandboxResult> =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
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
    if (this.settings.environment === "production") await chmod(root, 0o777);
    return {
      id,
      root,
      provider: this.settings.environment === "production" ? "docker" : "local",
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
    if (handle.provider === "local")
      return runProcess(command, args, { cwd: handle.root, timeoutMs });
    const hostRoot = this.settings.sandboxHostRoot
      ? resolve(this.settings.sandboxHostRoot, handle.id)
      : handle.root;
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
      `type=bind,source=${hostRoot},target=/workspace`,
      "--workdir",
      "/workspace",
      handle.spec.image ?? "node:22-alpine",
      command,
      ...args,
    ];
    return runProcess("docker", dockerArgs, { timeoutMs });
  }
  async destroy(handle: SandboxHandle) {
    await rm(handle.root, { recursive: true, force: true });
  }
}

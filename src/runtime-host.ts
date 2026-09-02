import type { FastifyInstance } from "fastify";
import { createApp } from "./api.js";
import { getSettings, type Settings } from "./config.js";
import { Container } from "./container.js";
import { RuntimeLock } from "./runtime-lock.js";

export interface StartRuntimeOptions {
  settings?: Settings;
  handleSignals?: boolean;
}

export interface RuntimeHandle {
  readonly settings: Settings;
  readonly container: Container;
  readonly app: FastifyInstance;
  close(): Promise<void>;
}

/** Start one durable Runtime after the caller has registered local extensions. */
export async function startRuntime(
  options: StartRuntimeOptions = {},
): Promise<RuntimeHandle> {
  const settings = options.settings ?? getSettings();
  const lock = await RuntimeLock.acquire(settings.dataDir, "Runtime");
  let container: Container | undefined;
  let app: FastifyInstance | undefined;
  let closing: Promise<void> | undefined;
  const signalHandler = () => {
    void close().catch((error) => process.stderr.write(`${String(error)}\n`));
  };
  const close = async () => {
    if (closing) return closing;
    closing = (async () => {
      if (options.handleSignals !== false) {
        process.off("SIGINT", signalHandler);
        process.off("SIGTERM", signalHandler);
      }
      try {
        await app?.close();
      } finally {
        try {
          await container?.close();
        } finally {
          await lock.release();
        }
      }
    })();
    return closing;
  };

  try {
    container = await Container.create(settings);
    app = await createApp(container);
    await app.listen({ host: settings.host, port: settings.port });
    if (options.handleSignals !== false) {
      process.on("SIGINT", signalHandler);
      process.on("SIGTERM", signalHandler);
    }
    return {
      settings,
      container,
      app,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

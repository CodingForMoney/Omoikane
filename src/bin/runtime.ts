#!/usr/bin/env node
import { Container } from "../container.js";
import { createApp } from "../api.js";
import { getSettings } from "../config.js";
import { RuntimeLock } from "../runtime-lock.js";

const settings = getSettings();
const lock = await RuntimeLock.acquire(settings.dataDir, "Runtime");
let container: Container | undefined;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  try {
    await app?.close();
  } finally {
    try {
      await container?.close();
    } finally {
      await lock.release();
    }
  }
};
try {
  container = await Container.create(settings);
  app = await createApp(container);
  await app.listen({ host: settings.host, port: settings.port });
  const closeFromSignal = () => {
    void close().catch((error) => process.stderr.write(`${String(error)}\n`));
  };
  process.on("SIGINT", closeFromSignal);
  process.on("SIGTERM", closeFromSignal);
} catch (error) {
  await close();
  throw error;
}

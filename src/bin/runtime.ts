#!/usr/bin/env node
import { Container } from "../container.js";
import { createApp } from "../api.js";
import { getSettings } from "../config.js";

const settings = getSettings();
const container = await Container.create(settings, {
  startWorker: settings.embeddedWorker,
});
const app = await createApp(container);
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await app.close();
  await container.close();
};
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
await app.listen({ host: settings.host, port: settings.port });

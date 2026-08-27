#!/usr/bin/env node
import { Container } from "../container.js";
import { getSettings } from "../config.js";
const container = await Container.create(getSettings(), { startWorker: false });
const abort = new AbortController();
process.on("SIGINT", () => abort.abort());
process.on("SIGTERM", () => abort.abort());
try {
  await container.webhooks.runForever(abort.signal);
} finally {
  await container.close();
}

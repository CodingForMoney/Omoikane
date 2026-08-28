import { Container } from "../../src/container.js";
import { getSettings } from "../../src/config.js";

const container = await Container.create(getSettings(), { startWorker: false });
const run = await container.runner.claim();
if (!run) {
  process.stderr.write("NO_RUN\n");
  process.exit(2);
}
process.stdout.write(`CLAIMED:${run.id}\n`);
setInterval(() => {}, 60_000);

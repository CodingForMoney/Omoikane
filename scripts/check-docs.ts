import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import fg from "fast-glob";

const files = await fg(["README.md", "docs/**/*.md", "examples/**/*.md"], {
  absolute: true,
});
const forbidden = [
  /\buv sync\b/i,
  /\bpip install\b/i,
  /\bpytest\b/i,
  /\balembic\b/i,
  /clients\/python/i,
  /src\/agent_system/i,
  /agent-system-v0\.1/i,
];
const failures: string[] = [];
for (const file of files) {
  const source = await readFile(file, "utf8");
  for (const pattern of forbidden) {
    if (pattern.test(source))
      failures.push(`${file}: obsolete reference ${pattern}`);
  }
  for (const match of source.matchAll(
    /\[[^\]]+\]\((?!https?:|#)([^)]+\.md(?:#[^)]+)?)\)/g,
  )) {
    const target = match[1]!.split("#")[0]!;
    await access(resolve(file, "..", target)).catch(() => {
      failures.push(`${file}: broken link ${target}`);
    });
  }
}

const readmePath = resolve("README.md");
const readme = await readFile(readmePath, "utf8");
const topicDocs = await fg("docs/*.md", { absolute: true });
for (const file of topicDocs) {
  const name = file.split("/").at(-1)!;
  if (!readme.includes(`(docs/${name})`))
    failures.push(`${readmePath}: document is missing from README: ${name}`);
}
if (failures.length) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Checked ${files.length} Markdown files.\n`);
}

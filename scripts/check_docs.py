from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
MARKDOWN_LINK = re.compile(r"\[[^]]+\]\(([^)]+)\)")
METADATA_FIELDS = ("文档类型：", "状态：", "最后核对：", "适用版本：")


def markdown_files() -> list[Path]:
    return [ROOT / "README.md", *sorted(DOCS.glob("*.md"))]


def check_relative_links(files: list[Path]) -> list[str]:
    errors: list[str] = []
    for path in files:
        content = path.read_text(encoding="utf-8")
        for target in MARKDOWN_LINK.findall(content):
            if target.startswith(("http://", "https://", "mailto:", "#")):
                continue
            relative = target.split("#", 1)[0]
            if relative and not (path.parent / relative).resolve().exists():
                errors.append(f"{path.relative_to(ROOT)}: broken relative link: {target}")
    return errors


def check_index(files: list[Path]) -> list[str]:
    index = (DOCS / "INDEX.md").read_text(encoding="utf-8")
    errors: list[str] = []
    for path in files:
        if path.parent == DOCS and path.name != "INDEX.md" and path.name not in index:
            errors.append(f"docs/INDEX.md: missing document: {path.name}")
    return errors


def check_metadata(files: list[Path]) -> list[str]:
    errors: list[str] = []
    for path in files:
        if path.name == "README.md":
            continue
        head = "\n".join(path.read_text(encoding="utf-8").splitlines()[:12])
        for field in METADATA_FIELDS:
            if field not in head:
                errors.append(f"{path.relative_to(ROOT)}: missing metadata field {field}")
    return errors


def check_current_versions(files: list[Path]) -> list[str]:
    errors: list[str] = []
    pyproject = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
    match = re.search(r'"openai-agents==([^"\s]+)"', pyproject)
    if not match:
        return ["pyproject.toml: cannot determine pinned openai-agents version"]
    sdk_version = match.group(1)
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    if f"`openai-agents=={sdk_version}`" not in readme:
        errors.append(f"README.md: pinned SDK version {sdk_version} is not declared")

    migrations = sorted((ROOT / "migrations" / "versions").glob("[0-9][0-9][0-9][0-9]_*.py"))
    if not migrations:
        errors.append("migrations/versions: no numbered migrations found")
    else:
        head = migrations[-1].name[:4]
        if f"数据库迁移当前到 `{head}`" not in readme:
            errors.append(f"README.md: migration head {head} is not current")
    return errors


def check_obsolete_official_paths(files: list[Path]) -> list[str]:
    errors: list[str] = []
    obsolete = "developers.openai.com/api/docs/guides/agents-sdk/"
    for path in files:
        if obsolete in path.read_text(encoding="utf-8"):
            errors.append(f"{path.relative_to(ROOT)}: contains obsolete OpenAI Agents docs path")
    return errors


def check_env_example() -> list[str]:
    tree = ast.parse((ROOT / "src" / "agent_system" / "config.py").read_text(encoding="utf-8"))
    settings = next(
        node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "Settings"
    )
    expected = {
        f"AGENT_{node.target.id.upper()}"
        for node in settings.body
        if isinstance(node, ast.AnnAssign)
        and isinstance(node.target, ast.Name)
        and node.target.id != "model_config"
    }
    declared = {
        line.split("=", 1)[0]
        for line in (ROOT / ".env.example").read_text(encoding="utf-8").splitlines()
        if line and not line.startswith("#") and "=" in line
    }
    return [
        f".env.example: missing Settings variable: {name}"
        for name in sorted(expected - declared)
    ]


def main() -> int:
    files = markdown_files()
    errors = [
        *check_relative_links(files),
        *check_index(files),
        *check_metadata(files),
        *check_current_versions(files),
        *check_obsolete_official_paths(files),
        *check_env_example(),
    ]
    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        return 1
    print(f"Documentation checks passed for {len(files)} Markdown files.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

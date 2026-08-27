from __future__ import annotations

from pathlib import Path

from agent_system.sandbox import SandboxSpec


async def test_skill_import_materialization_sandbox_and_artifact(container, tmp_path: Path):
    source = tmp_path / "source-skill"
    source.mkdir()
    (source / "SKILL.md").write_text(
        "---\nname: source-review\ndescription: Review sources before conclusions.\n---\n"
        "# Source Review\nAlways inspect source files first.\n",
        encoding="utf-8",
    )
    (source / "references").mkdir()
    (source / "references" / "rules.md").write_text("Cite artifacts.", encoding="utf-8")
    version = await container.skills.import_directory("default", str(source))
    handle = await container.sandbox.create(SandboxSpec(run_id="skill-sandbox-test"))
    try:
        materialized = await container.skills.materialize(version.id, handle.root)
        assert Path(materialized["path"], "SKILL.md").is_file()
        result = await container.sandbox.exec(
            handle, ["sh", "-c", "printf sandbox-ok > result.txt"]
        )
        assert result.return_code == 0
        assert (handle.root / "result.txt").read_text() == "sandbox-ok"
        artifact = await container.artifacts.create(
            tenant_id="default",
            filename="result.txt",
            data=(handle.root / "result.txt").read_bytes(),
            source="sandbox",
        )
        stored, data = await container.artifacts.read(artifact.id)
        assert stored.sha256 == artifact.sha256
        assert data == b"sandbox-ok"
        deleted = await container.artifacts.delete("default", artifact.id)
        assert deleted.status == "deleted"
        assert not container.artifacts.store._path(artifact.storage_key).exists()
    finally:
        await container.sandbox.destroy(handle)
    assert not handle.root.exists()

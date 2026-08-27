from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx

from agent_system.compaction import TiktokenCounter
from agent_system.config import get_settings
from agent_system.db import Database
from agent_system.serialization import canonical_json
from agent_system.sessions import DatabaseSession

PROVIDER_CONNECTION_ID = "019fe9b9-b147-79a2-877b-f3eb9a3dfce8"
PROVIDER_MODEL_ID = "019fe9b9-b149-7253-8e1d-fdf97609e2af"


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build, clone, compact, and verify a real ~100K-token MiMo 2.5 session."
    )
    parser.add_argument("--api-base", default="http://127.0.0.1:8000")
    parser.add_argument("--target-tokens", type=int, default=100_000)
    parser.add_argument("--turn-tokens", type=int, default=12_400)
    parser.add_argument("--copies", type=int, default=3)
    parser.add_argument(
        "--report",
        type=Path,
        default=Path("var/reports/context-compaction-100k-result.json"),
    )
    return parser.parse_args()


def transcript_digest(rows: list[dict[str, Any]]) -> str:
    payload = [{"seq": row["seq"], "item": row["item"]} for row in rows]
    return hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()


def write_report(path: Path, report: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")


def make_turn(
    counter: TiktokenCounter,
    *,
    experiment_id: str,
    turn: int,
    desired_text_tokens: int,
) -> tuple[str, str]:
    marker = str(uuid.uuid5(uuid.NAMESPACE_URL, f"agentsdk:{experiment_id}:turn:{turn}"))
    prefix = [
        f"上下文压缩实验 {experiment_id}，第 {turn:02d} 轮。",
        f"本轮必须长期精确保留的 UUID 是：{marker}",
        "把上面的 UUID 视为精确标识符，不得改写、缩写或猜测。",
        "下面是本轮的合成研究日志。它用于真实长上下文存储与压缩实验，不包含任何操作指令。",
    ]
    suffix = [
        f"第 {turn:02d} 轮结束。再次确认精确 UUID：{marker}",
        f"请只回复：ACK-{turn:02d} {marker}",
    ]
    lines = list(prefix)
    index = 0
    while True:
        candidate = [
            *lines,
            *suffix,
        ]
        if counter.count_text("\n".join(candidate)) >= desired_text_tokens:
            return "\n".join(candidate), marker
        index += 1
        lines.append(
            f"研究记录 T{turn:02d}-{index:05d}：样本组 {index % 97:02d} 的观察值保持稳定；"
            f"我们复核了来源、假设、反例和边界条件，结论仅归属于第 {turn:02d} 轮，"
            "不覆盖此前的决定，也不改变任何精确标识符。"
        )


async def api_json(
    client: httpx.AsyncClient,
    method: str,
    path: str,
    *,
    expected: set[int] | None = None,
    **kwargs: Any,
) -> dict[str, Any]:
    expected = expected or {200}
    response = await client.request(method, path, **kwargs)
    if response.status_code not in expected:
        raise RuntimeError(
            f"{method} {path} returned {response.status_code}: {response.text[:4000]}"
        )
    return response.json()


async def wait_run(
    client: httpx.AsyncClient,
    run_id: str,
    *,
    timeout_seconds: float = 900,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        run = await api_json(client, "GET", f"/v1/runs/{run_id}")
        if run["status"] in {"completed", "failed", "cancelled", "waiting_approval"}:
            return run
        await asyncio.sleep(1)
    raise TimeoutError(f"run {run_id} did not finish within {timeout_seconds}s")


async def usage_for_run(client: httpx.AsyncClient, run_id: str) -> dict[str, int]:
    rows = (await api_json(client, "GET", "/v1/usage", params={"run_id": run_id}))["data"]
    return {
        "requests": sum(int(row.get("requests") or 0) for row in rows),
        "input_tokens": sum(int(row.get("input_tokens") or 0) for row in rows),
        "output_tokens": sum(int(row.get("output_tokens") or 0) for row in rows),
        "total_tokens": sum(int(row.get("total_tokens") or 0) for row in rows),
    }


async def create_experiment_agent(client: httpx.AsyncClient, experiment_id: str) -> tuple[str, str]:
    provider = await api_json(
        client, "GET", f"/v1/provider-connections/{PROVIDER_CONNECTION_ID}"
    )
    models = (
        await api_json(
            client, "GET", f"/v1/provider-connections/{PROVIDER_CONNECTION_ID}/models"
        )
    )["data"]
    model = next(item for item in models if item["id"] == PROVIDER_MODEL_ID)
    if provider["provider"] != "xiaomi_mimo" or model["model_id"] != "mimo-v2.5":
        raise RuntimeError("configured provider/model no longer points to Xiaomi MiMo 2.5")
    slug = f"mimo-context-100k-{experiment_id.lower()}"
    agent = await api_json(
        client,
        "POST",
        "/v1/agents",
        expected={201},
        json={
            "slug": slug,
            "name": f"MiMo 2.5 Context 100K Experiment {experiment_id}",
            "description": "Real long-context persistence and portable compaction experiment.",
        },
    )
    config = {
        "name": f"MiMo 2.5 Context 100K Experiment {experiment_id}",
        "instructions": (
            "你是上下文完整性实验助手。用户发送合成研究日志时，只输出其要求的 ACK 行；"
            "所有明确标记的 UUID 都是必须原样保留的精确标识符。进行验证时，只依据当前会话上下文回答。"
        ),
        "provider_connection_id": PROVIDER_CONNECTION_ID,
        "provider_model_id": PROVIDER_MODEL_ID,
        "provider_options": {"structured_output_mode": "prompt"},
        "reasoning_effort": "none",
        "runtime_policy": {
            "max_turns": 8,
            "max_duration_seconds": 900,
            "max_tool_calls": 4,
        },
        "compaction": {
            "enabled": True,
            "strategy": "portable",
            "context_window": 1_048_576,
            "context_window_type": "total",
            "reserved_output_tokens": 32_768,
            "reserved_tool_loop_tokens": 8_192,
            "safety_margin_tokens": 4_096,
            "trigger_tokens": 900_000,
            "target_projection_tokens": 45_000,
            "keep_recent_tokens": 24_000,
            "min_tail_user_messages": 2,
            "summary_context_window": 1_048_576,
            "summary_context_window_type": "total",
            "summary_output_tokens": 8_192,
            "summary_prompt_reserve_tokens": 8_192,
            "artifact_threshold_tokens": 4_096,
            "minimum_savings_ratio": 0.20,
            "tokenizer": "o200k_base",
            "lease_seconds": 900,
            "timeout_seconds": 900,
            "cooldown_seconds": 60,
            "rebase_every": 3,
        },
        "bindings": [],
    }
    version = await api_json(
        client,
        "POST",
        f"/v1/agents/{agent['id']}/versions",
        expected={201},
        json={"config": config},
    )
    await api_json(client, "POST", f"/v1/agents/{agent['id']}/versions/1/publish")
    return agent["id"], version["id"]


async def create_run(
    client: httpx.AsyncClient,
    *,
    version_id: str,
    session_id: str,
    prompt: str,
    key: str,
) -> tuple[dict[str, Any], dict[str, int]]:
    queued = await api_json(
        client,
        "POST",
        "/v1/runs",
        expected={202},
        headers={"Idempotency-Key": key},
        json={
            "agent_version_id": version_id,
            "session_id": session_id,
            "input": prompt,
            "context": {},
            "limits": {"max_turns": 4, "max_duration_seconds": 900},
        },
    )
    run = await wait_run(client, queued["id"])
    usage = await usage_for_run(client, queued["id"])
    if run["status"] != "completed":
        raise RuntimeError(f"run {run['id']} failed: {run.get('error_json')}")
    return run, usage


async def database_snapshot(
    db: Database,
    counter: TiktokenCounter,
    session_id: str,
) -> dict[str, Any]:
    sdk_session = DatabaseSession(db, session_id)
    rows = await sdk_session.canonical_items()
    projection = await sdk_session.get_items()
    return {
        "canonical_rows": rows,
        "canonical_items": len(rows),
        "canonical_tokens": counter.count_items([row["item"] for row in rows]),
        "canonical_sha256": transcript_digest(rows),
        "projection_items": len(projection),
        "projection_tokens": counter.count_items(projection),
        "projection_sha256": hashlib.sha256(
            canonical_json(projection).encode("utf-8")
        ).hexdigest(),
    }


def public_snapshot(snapshot: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in snapshot.items() if key != "canonical_rows"}


async def main() -> None:
    args = arguments()
    if args.target_tokens < 20_000 or args.turn_tokens < 2_000:
        raise SystemExit("target and per-turn token budgets are too small for this experiment")
    experiment_id = datetime.now(UTC).strftime("%Y%m%d%H%M%S")
    counter = TiktokenCounter("o200k_base")
    report: dict[str, Any] = {
        "experiment_id": experiment_id,
        "started_at": datetime.now(UTC).isoformat(),
        "provider": {
            "connection_id": PROVIDER_CONNECTION_ID,
            "provider": "xiaomi_mimo",
            "model_record_id": PROVIDER_MODEL_ID,
            "model": "mimo-v2.5",
            "credential_recorded": False,
        },
        "target_tokens": args.target_tokens,
        "tokenizer": counter.name,
        "turns": [],
        "markers": [],
        "status": "initializing",
    }
    write_report(args.report, report)
    timeout = httpx.Timeout(connect=10, read=1_000, write=120, pool=30)
    settings = get_settings()
    db = Database(settings)
    try:
        async with httpx.AsyncClient(base_url=args.api_base, timeout=timeout) as client:
            health = await api_json(client, "GET", "/healthz")
            print(f"API ready: SDK {health['sdk_version']}", flush=True)
            agent_id, version_id = await create_experiment_agent(client, experiment_id)
            report.update(
                {
                    "agent_id": agent_id,
                    "agent_version_id": version_id,
                    "status": "building_source",
                }
            )
            session = await api_json(
                client,
                "POST",
                "/v1/sessions",
                expected={201},
                json={
                    "scope": {
                        "agent_id": agent_id,
                        "agent_version_id": version_id,
                        "source": "context-compaction-100k-experiment",
                        "title": f"MiMo 100K Source {experiment_id}",
                        "experiment_id": experiment_id,
                        "variant": "source",
                    }
                },
            )
            source_session_id = session["id"]
            report["source_session_id"] = source_session_id
            write_report(args.report, report)

            turn = 0
            while True:
                before = await database_snapshot(db, counter, source_session_id)
                if before["canonical_tokens"] >= int(args.target_tokens * 0.98):
                    break
                turn += 1
                if turn > 12:
                    raise RuntimeError("source did not reach target within 12 turns")
                remaining = args.target_tokens - before["canonical_tokens"]
                desired = min(args.turn_tokens, max(2_000, remaining - 80))
                prompt, marker = make_turn(
                    counter,
                    experiment_id=experiment_id,
                    turn=turn,
                    desired_text_tokens=desired,
                )
                text_tokens = counter.count_text(prompt)
                print(
                    f"Turn {turn:02d}: sending {text_tokens:,} text tokens "
                    f"(stored {before['canonical_tokens']:,})",
                    flush=True,
                )
                started = time.monotonic()
                run, usage = await create_run(
                    client,
                    version_id=version_id,
                    session_id=source_session_id,
                    prompt=prompt,
                    key=f"ctx100k-{experiment_id}-turn-{turn}",
                )
                after = await database_snapshot(db, counter, source_session_id)
                output = str(run.get("output_json") or "")
                ack_ok = marker in output and f"ACK-{turn:02d}" in output
                turn_result = {
                    "turn": turn,
                    "run_id": run["id"],
                    "marker_uuid": marker,
                    "generated_text_tokens": text_tokens,
                    "provider_usage": usage,
                    "elapsed_seconds": round(time.monotonic() - started, 3),
                    "ack_ok": ack_ok,
                    "output_preview": output[:300],
                    "canonical_tokens_after": after["canonical_tokens"],
                    "canonical_items_after": after["canonical_items"],
                    "canonical_sha256_after": after["canonical_sha256"],
                }
                report["turns"].append(turn_result)
                report["markers"].append(marker)
                write_report(args.report, report)
                print(
                    f"Turn {turn:02d}: completed in {turn_result['elapsed_seconds']:.1f}s; "
                    f"stored={after['canonical_tokens']:,}; ack={ack_ok}",
                    flush=True,
                )

            source_snapshot = await database_snapshot(db, counter, source_session_id)
            source_rows = source_snapshot["canonical_rows"]
            serialized_transcript = canonical_json(
                [{"seq": row["seq"], "item": row["item"]} for row in source_rows]
            )
            storage_checks = {
                "all_turn_markers_present": all(
                    marker in serialized_transcript for marker in report["markers"]
                ),
                "all_turn_acks_succeeded": all(item["ack_ok"] for item in report["turns"]),
                "sequence_is_contiguous": [row["seq"] for row in source_rows]
                == list(range(1, len(source_rows) + 1)),
                "canonical_matches_projection_before_compaction": (
                    source_snapshot["canonical_tokens"] == source_snapshot["projection_tokens"]
                    and source_snapshot["canonical_items"] == source_snapshot["projection_items"]
                ),
            }
            storage_checks["passed"] = all(storage_checks.values())
            report["source_before_clone"] = public_snapshot(source_snapshot)
            report["storage_checks"] = storage_checks
            report["status"] = "cloning"
            write_report(args.report, report)
            print(
                f"Source complete: {source_snapshot['canonical_tokens']:,} tokens, "
                f"{source_snapshot['canonical_items']} items, SHA-256 "
                f"{source_snapshot['canonical_sha256'][:16]}…",
                flush=True,
            )

            copies: list[dict[str, Any]] = []
            source_sdk_session = DatabaseSession(db, source_session_id)
            for index in range(1, args.copies + 1):
                variant = "compressed-experiment" if index == args.copies else f"archive-control-{index}"
                clone = await source_sdk_session.clone(
                    scope={
                        "title": f"MiMo 100K {variant} {experiment_id}",
                        "variant": variant,
                    }
                )
                snapshot = await database_snapshot(db, counter, clone.id)
                copy_result = {
                    "session_id": clone.id,
                    "variant": variant,
                    **public_snapshot(snapshot),
                    "matches_source": (
                        snapshot["canonical_sha256"] == source_snapshot["canonical_sha256"]
                        and snapshot["canonical_tokens"] == source_snapshot["canonical_tokens"]
                        and snapshot["canonical_items"] == source_snapshot["canonical_items"]
                    ),
                }
                copies.append(copy_result)
                print(
                    f"Clone {index}: {variant} {clone.id}; exact={copy_result['matches_source']}",
                    flush=True,
                )
            report["copies_before_compaction"] = copies
            report["status"] = "compacting"
            write_report(args.report, report)

            compressed_copy = copies[-1]
            compact_started = time.monotonic()
            print(
                f"Compacting only {compressed_copy['session_id']} with portable strategy…",
                flush=True,
            )
            compacted = await api_json(
                client,
                "POST",
                f"/v1/sessions/{compressed_copy['session_id']}/compact",
                json={
                    "agent_version_id": version_id,
                    "strategy": "portable",
                    "focus": "精确保留每一轮 UUID、已经完成的 ACK，以及当前实验目标。",
                    "force": True,
                    "dry_run": False,
                },
            )
            if not compacted.get("compacted") or not compacted.get("compaction"):
                raise RuntimeError("manual compaction unexpectedly returned no compaction")
            compaction = compacted["compaction"]
            after_compaction = await database_snapshot(
                db, counter, compressed_copy["session_id"]
            )
            canonical_after_compaction = after_compaction["canonical_rows"]
            report["compaction"] = {
                "session_id": compressed_copy["session_id"],
                "elapsed_seconds": round(time.monotonic() - compact_started, 3),
                "record": compaction,
                "after": public_snapshot(after_compaction),
                "canonical_unchanged": (
                    transcript_digest(canonical_after_compaction)
                    == source_snapshot["canonical_sha256"]
                ),
                "projection_reduced": (
                    after_compaction["projection_tokens"]
                    < source_snapshot["projection_tokens"]
                ),
            }
            write_report(args.report, report)
            print(
                f"Compaction complete in {report['compaction']['elapsed_seconds']:.1f}s: "
                f"projection {source_snapshot['projection_tokens']:,} -> "
                f"{after_compaction['projection_tokens']:,} tokens; canonical unchanged="
                f"{report['compaction']['canonical_unchanged']}",
                flush=True,
            )

            report["status"] = "verifying_continuity"
            write_report(args.report, report)
            marker_lines = "\n".join(f"{index}." for index in range(1, len(report["markers"]) + 1))
            verification_prompt = (
                f"这是压缩后连续性验证。请从此前会话恢复全部 {len(report['markers'])} 个"
                "精确 UUID，按首次出现顺序逐行输出，每行只写一个 UUID，不要解释、不要猜测。\n"
                f"输出应有 {len(report['markers'])} 行：\n{marker_lines}"
            )
            verify_started = time.monotonic()
            verification_run, verification_usage = await create_run(
                client,
                version_id=version_id,
                session_id=compressed_copy["session_id"],
                prompt=verification_prompt,
                key=f"ctx100k-{experiment_id}-continuity",
            )
            verification_output = str(verification_run.get("output_json") or "")
            marker_results = {
                marker: verification_output.count(marker) == 1 for marker in report["markers"]
            }
            marker_positions = [verification_output.find(marker) for marker in report["markers"]]
            final_snapshot = await database_snapshot(db, counter, compressed_copy["session_id"])
            final_rows = final_snapshot["canonical_rows"]
            original_prefix = final_rows[: len(source_rows)]
            archive_checks = []
            for copy in copies[:-1]:
                current = await database_snapshot(db, counter, copy["session_id"])
                archive_checks.append(
                    {
                        "session_id": copy["session_id"],
                        "variant": copy["variant"],
                        "still_matches_source": (
                            current["canonical_sha256"] == source_snapshot["canonical_sha256"]
                            and current["projection_sha256"] == source_snapshot["projection_sha256"]
                        ),
                        **public_snapshot(current),
                    }
                )
            report["continuity_verification"] = {
                "run_id": verification_run["id"],
                "elapsed_seconds": round(time.monotonic() - verify_started, 3),
                "provider_usage": verification_usage,
                "output": verification_output,
                "marker_results": marker_results,
                "all_markers_recalled_exactly_once": all(marker_results.values()),
                "markers_in_original_order": marker_positions == sorted(marker_positions),
                "source_prefix_still_unchanged": (
                    transcript_digest(original_prefix) == source_snapshot["canonical_sha256"]
                ),
                "final_compressed_session": public_snapshot(final_snapshot),
            }
            report["archive_controls_after_experiment"] = archive_checks
            all_build_usage = {
                key: sum(int(turn["provider_usage"][key]) for turn in report["turns"])
                for key in ("requests", "input_tokens", "output_tokens", "total_tokens")
            }
            report["usage_totals"] = {
                "source_conversation": all_build_usage,
                "continuity_verification": verification_usage,
                "compaction_summary_input_tokens": int(compaction.get("summary_input_tokens") or 0),
                "compaction_summary_output_tokens": int(compaction.get("summary_output_tokens") or 0),
            }
            report["status"] = "completed"
            report["completed_at"] = datetime.now(UTC).isoformat()
            report["passed"] = all(
                [
                    storage_checks["passed"],
                    all(copy["matches_source"] for copy in copies),
                    report["compaction"]["canonical_unchanged"],
                    report["compaction"]["projection_reduced"],
                    report["continuity_verification"]["all_markers_recalled_exactly_once"],
                    report["continuity_verification"]["markers_in_original_order"],
                    report["continuity_verification"]["source_prefix_still_unchanged"],
                    all(item["still_matches_source"] for item in archive_checks),
                ]
            )
            write_report(args.report, report)
            print(
                f"Experiment complete: passed={report['passed']}; report={args.report.resolve()}",
                flush=True,
            )
    except Exception as exc:
        report["status"] = "failed"
        report["failed_at"] = datetime.now(UTC).isoformat()
        report["error"] = f"{type(exc).__name__}: {exc}"
        write_report(args.report, report)
        raise
    finally:
        await db.dispose()


if __name__ == "__main__":
    asyncio.run(main())

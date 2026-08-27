from __future__ import annotations

import argparse
import asyncio
import json
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import select

from agent_system.compaction import CompactionConfig, TiktokenCounter
from agent_system.config import get_settings
from agent_system.container import create_container
from agent_system.models import AgentVersionRecord, CompactionRecord, RunRecord, SessionRecord
from agent_system.sessions import DatabaseSession, session_item_text


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Retest the v2 deterministic execution state.")
    parser.add_argument(
        "--source-session-id",
        default="019fead0-6926-79a6-8485-3ed79a886fd4",
    )
    parser.add_argument("--existing-clone-session-id")
    parser.add_argument(
        "--report",
        type=Path,
        default=Path("var/reports/context-compaction-state-fix-retest.json"),
    )
    return parser.parse_args()


async def main() -> None:
    args = arguments()
    container = await create_container(settings=get_settings(), start_worker=False)
    report: dict[str, Any] = {
        "started_at": datetime.now(UTC).isoformat(),
        "source_session_id": args.source_session_id,
    }
    try:
        source = DatabaseSession(container.db, args.source_session_id)
        source_items = await source.get_items()
        source_record = None
        async with container.db.sessions() as session:
            source_record = await session.get(SessionRecord, args.source_session_id)
        if source_record is None:
            raise KeyError("source session not found")
        version_id = str((source_record.scope or {}).get("agent_version_id") or "")
        async with container.db.sessions() as session:
            version = await session.get(AgentVersionRecord, version_id)
        if version is None:
            raise KeyError("experiment agent version not found")
        config = await container.providers.resolve_agent_config(
            dict(version.config_json), version.tenant_id
        )
        compaction_config = CompactionConfig.from_agent_config(config, strategy="portable")
        counter = TiktokenCounter(compaction_config.tokenizer)
        if args.existing_clone_session_id:
            clone_record = None
            async with container.db.sessions() as session:
                clone_record = await session.get(SessionRecord, args.existing_clone_session_id)
            if clone_record is None:
                raise KeyError("existing clone session not found")
            clone_id = clone_record.id
        else:
            clone_record = await source.clone(
                scope={
                    "title": "MiMo 100K execution-state-v2 retest",
                    "variant": "execution-state-v2-retest",
                }
            )
            clone_id = clone_record.id
        clone_session = DatabaseSession(container.db, clone_id)
        report.update(
            {
                "clone_session_id": clone_id,
                "agent_version_id": version_id,
                "tokens_before": counter.count_items(source_items),
                "items_before": len(source_items),
            }
        )
        print(
            f"Using clone {args.source_session_id} -> {clone_id}; "
            f"tokens={report['tokens_before']:,}",
            flush=True,
        )
        started = time.monotonic()
        if args.existing_clone_session_id:
            async with container.db.sessions() as session:
                compaction = await session.scalar(
                    select(CompactionRecord)
                    .where(
                        CompactionRecord.session_id == clone_id,
                        CompactionRecord.status == "active",
                    )
                    .order_by(CompactionRecord.created_at.desc())
                    .limit(1)
                )
        else:
            compaction = await container.compaction.compact_session(
                clone_id,
                config,
                force=True,
                strategy="portable",
                focus="保留 UUID，并以 runtime-derived execution state 为唯一任务状态权威。",
                trigger="execution_state_v2_retest",
            )
        if compaction is None:
            raise RuntimeError("compaction returned no record")
        projection = await clone_session.get_items()
        summary = dict(compaction.summary_json or {})
        execution = dict(summary.get("execution_state") or {})
        checkpoint_source_to = int(execution.get("source_to_seq") or 0)
        covered = source_items[:checkpoint_source_to]
        covered_user_seqs = [
            index
            for index, item in enumerate(covered, start=1)
            if item.get("role") == "user" and session_item_text(item.get("content")).strip()
        ]
        last_covered = covered[-1] if covered else {}
        raw_tail = projection[1:]
        turn_06_is_atomic = any(
            item.get("role") == "user"
            and "第 06 轮" in session_item_text(item.get("content"))
            and index + 1 < len(raw_tail)
            and raw_tail[index + 1].get("role") == "assistant"
            and "ACK-06" in session_item_text(raw_tail[index + 1].get("content"))
            for index, item in enumerate(raw_tail)
        )
        checks = {
            "schema_version_is_2": compaction.schema_version == 2,
            "engine_version_is_2": compaction.engine_version == "2",
            "validator_accepted_execution_state": bool(
                (compaction.validation_json or {}).get("execution_state_validated")
            ),
            "authority_is_runtime_derived": execution.get("authority") == "runtime_derived",
            "checkpoint_ends_on_assistant_response": last_covered.get("role") == "assistant",
            "all_checkpoint_user_turns_responded": execution.get(
                "responded_user_turn_count"
            )
            == len(covered_user_seqs),
            "last_responded_user_seq_matches_source": execution.get(
                "last_responded_user_source_seq"
            )
            == (covered_user_seqs[-1] if covered_user_seqs else 0),
            "no_pending_user_in_checkpoint": execution.get("pending_user_turn_count") == 0,
            "active_task_is_empty": summary.get("active_task")
            == {"latest_unfulfilled_user_input": "", "source_seq": 0},
            "turn_06_user_and_ack_are_atomic_in_raw_tail": turn_06_is_atomic,
            "runtime_progress_has_no_in_progress_item": not (
                (summary.get("progress") or {}).get("in_progress")
            ),
        }
        report["compaction"] = {
            "id": compaction.id,
            "elapsed_seconds": (
                round(float((compaction.validation_json or {}).get("duration_ms") or 0) / 1000, 3)
                if args.existing_clone_session_id
                else round(time.monotonic() - started, 3)
            ),
            "tokens_after_compaction": int(compaction.tokens_after or 0),
            "items_after_compaction": int(
                (compaction.validation_json or {}).get("projected_items") or 0
            ),
            "current_projection_tokens": counter.count_items(projection),
            "current_projection_items": len(projection),
            "validation": compaction.validation_json,
            "execution_state": execution,
            "active_task": summary.get("active_task"),
            "completed_actions": summary.get("completed_actions"),
            "progress": summary.get("progress"),
            "narrative_summary": summary.get("narrative_summary"),
            "checks": checks,
        }
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(
            f"Compacted in {report['compaction']['elapsed_seconds']:.1f}s; "
            f"tokens={report['tokens_before']:,}->"
            f"{report['compaction']['tokens_after_compaction']:,}; "
            f"state_checks={all(checks.values())}",
            flush=True,
        )

        prompt = (
            "请只根据 CONTEXT CHECKPOINT 中 runtime-derived 的权威字段回答："
            "第6轮 ACK 是否已经完成？checkpoint 覆盖范围内还有多少个未响应用户输入？"
            "只输出一行：ACK-06=<已完成或未完成>; PENDING=<数字>。"
        )
        queued = await container.runner.create_run(
            tenant_id=version.tenant_id,
            agent_version_id=version_id,
            input_value=prompt,
            session_id=clone_id,
            context={},
            limits={"max_turns": 4, "max_duration_seconds": 900},
            idempotency_key=f"state-v2-{clone_id}",
        )
        deadline = time.monotonic() + 900
        run = None
        while time.monotonic() < deadline:
            await container.runner.process_next()
            async with container.db.sessions() as session:
                run = await session.get(RunRecord, queued.id)
            if run is not None and run.status in {
                "completed",
                "failed",
                "cancelled",
                "waiting_approval",
            }:
                break
            await asyncio.sleep(1)
        if run is None or run.status not in {
            "completed",
            "failed",
            "cancelled",
            "waiting_approval",
        }:
            raise TimeoutError(f"run {queued.id} did not finish")
        report["follow_up"] = {
            "run_id": run.id,
            "status": run.status,
            "output": run.output_json,
            "passed": run.status == "completed"
            and "ACK-06" in str(run.output_json or "")
            and "已完成" in str(run.output_json or "")
            and "PENDING=0" in str(run.output_json or ""),
        }
        report["passed"] = all(checks.values()) and report["follow_up"]["passed"]
        report["completed_at"] = datetime.now(UTC).isoformat()
        args.report.write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"Retest passed={report['passed']}; report={args.report.resolve()}", flush=True)
    finally:
        await container.close()


if __name__ == "__main__":
    asyncio.run(main())

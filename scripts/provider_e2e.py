from __future__ import annotations

import argparse
import asyncio
import getpass
import json
import os
import tempfile
from collections import Counter
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from sqlalchemy import select

from agent_system.config import Settings
from agent_system.container import Container, create_container
from agent_system.models import ApprovalRecord, RunRecord, SessionRecord, ToolRecord, UsageRecord
from agent_system.schemas import AgentCreate
from agent_system.sessions import DatabaseSession


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run a credential-safe end-to-end provider compatibility suite."
    )
    parser.add_argument(
        "--base-url", default="https://token-plan-cn.xiaomimimo.com/v1"
    )
    parser.add_argument("--model", default="mimo-v2.5")
    parser.add_argument("--api-key-env", default="MIMO_API_KEY")
    parser.add_argument(
        "--structured-only",
        action="store_true",
        help="Only validate the portable prompt + platform-schema structured output mode.",
    )
    parser.add_argument(
        "--compaction-only",
        action="store_true",
        help="Only run native capability probes and portable compaction continuity checks.",
    )
    parser.add_argument(
        "--concise",
        action="store_true",
        help="Print a compact report suitable for automated regression logs.",
    )
    return parser.parse_args()


async def create_version(
    container: Container,
    *,
    slug: str,
    protocol: str,
    base_url: str,
    model: str,
    api_key_env: str,
    instructions: str,
    bindings: list[dict[str, Any]] | None = None,
    output_schema: dict[str, Any] | None = None,
    structured_output_mode: str = "native",
    compaction: dict[str, Any] | None = None,
):
    agent = await container.registry.create_agent(
        "provider-test",
        "provider-test",
        AgentCreate(slug=slug, name=slug),
    )
    config: dict[str, Any] = {
        "name": slug,
        "model": model,
        "instructions": instructions,
        "provider": {
            "type": "openai_compatible",
            "name": "mimo",
            "protocol": protocol,
            "base_url": base_url,
            "api_key_env": api_key_env,
            "timeout_seconds": 180,
            "max_retries": 1,
            "structured_output_mode": structured_output_mode,
        },
        "runtime_policy": {
            "max_turns": 12,
            "max_duration_seconds": 300,
            "max_tool_calls": 12,
        },
        "bindings": bindings or [],
    }
    if output_schema:
        config["output_schema"] = output_schema
    if compaction:
        config["compaction"] = compaction
    version = await container.registry.create_agent_version(
        "provider-test", "provider-test", agent.id, config
    )
    return await container.registry.publish_agent_version(
        "provider-test", "provider-test", version.id
    )


async def execute(
    container: Container,
    version_id: str,
    prompt: str,
    *,
    session_id: str | None = None,
    idempotency_key: str | None = None,
) -> dict[str, Any]:
    run = await container.runner.create_run(
        tenant_id="provider-test",
        agent_version_id=version_id,
        input_value=prompt,
        session_id=session_id,
        context={"memory_scope": {"type": "project", "id": "provider-e2e"}},
        limits={},
        idempotency_key=idempotency_key,
    )
    await container.runner.process_next()
    async with container.db.sessions() as session:
        current = await session.get(RunRecord, run.id)
        usage_rows = (
            await session.scalars(select(UsageRecord).where(UsageRecord.run_id == run.id))
        ).all()
    events = await container.events.list(run.id)
    event_counts = Counter(event["type"] for event in events)
    return {
        "id": run.id,
        "status": current.status,
        "output": current.output_json,
        "error": current.error_json,
        "usage": {
            "requests": sum(row.requests for row in usage_rows),
            "input_tokens": sum(row.input_tokens for row in usage_rows),
            "output_tokens": sum(row.output_tokens for row in usage_rows),
            "total_tokens": sum(row.total_tokens for row in usage_rows),
        },
        "event_counts": dict(event_counts),
    }


def mimo_compaction_config() -> dict[str, Any]:
    return {
        "enabled": True,
        "strategy": "auto",
        "context_window": 32768,
        "reserved_output_tokens": 4096,
        "reserved_tool_loop_tokens": 4096,
        "safety_margin_tokens": 2048,
        "trigger_tokens": 22000,
        "target_projection_tokens": 10000,
        "keep_recent_tokens": 1000,
        "min_tail_user_messages": 2,
        "summary_context_window": 32768,
        "summary_output_tokens": 8192,
        "summary_prompt_reserve_tokens": 4096,
        "artifact_threshold_tokens": 4096,
        "minimum_savings_ratio": 0.10,
        "tokenizer": "o200k_base",
        "lease_seconds": 300,
        "timeout_seconds": 300,
        "cooldown_seconds": 60,
        "rebase_every": 3,
    }


async def compaction_check(
    container: Container,
    args: argparse.Namespace,
) -> dict[str, Any]:
    compaction = mimo_compaction_config()
    version = await create_version(
        container,
        slug="chat-context-compaction",
        protocol="chat_completions",
        base_url=args.base_url,
        model=args.model,
        api_key_env=args.api_key_env,
        instructions=(
            "Answer only from the current session context. Preserve exact identifiers, "
            "constraints, decisions, progress, and unresolved work. Answer in Chinese."
        ),
        compaction=compaction,
    )
    conversation = SessionRecord(tenant_id="provider-test")
    async with container.db.sessions() as session, session.begin():
        session.add(conversation)
    sdk_session = DatabaseSession(container.db, conversation.id)
    continuity_id = "7d9e2fd1-c739-4b5f-a98e-f24cb930be21"
    critical_path = "/private/tmp/research-agent/critical-ledger.csv"
    source_items: list[dict[str, Any]] = [
        {
            "role": "user",
            "content": (
                "项目初始目标：构建投研 Agent。不可变约束：不得访问生产系统，"
                f"必须保留连续性标识 {continuity_id}，权威文件是 {critical_path}。"
            ),
        },
        {
            "role": "assistant",
            "content": "已确认目标、约束、连续性标识和权威文件，后续变更均以此为准。",
        },
    ]
    for index in range(18):
        source_items.extend(
            [
                {
                    "role": "user",
                    "content": (
                        f"历史讨论 {index}：继续完善上下文引擎。决定使用不可变 Transcript "
                        "和独立 Projection；压缩失败必须 Hard No-op；Memory 不参与压缩。"
                        + " 本段用于形成足够长的真实历史，包含设计讨论、验证记录和回滚说明。"
                        * 4
                    ),
                },
                {
                    "role": "assistant",
                    "content": (
                        f"历史执行 {index}：已复核第 {index} 组设计记录，未改变初始约束。"
                        "已完成一致性检查，下一步仍是 Provider 合同测试和语义连续性验证。"
                        + " 保持 Tool Call、Result、Approval 与 Artifact 引用的原子关系。"
                        * 4
                    ),
                },
            ]
        )
    source_items.extend(
        [
            {
                "role": "user",
                "content": "当前任务：完成 MiMo portable compaction 实测并报告压缩率。",
            },
            {
                "role": "assistant",
                "content": "进行中：正在生成结构化 checkpoint，尚未完成最终报告。",
            },
            {
                "role": "user",
                "content": "未决问题：压缩后是否仍能恢复初始约束、标识符和权威文件？",
            },
        ]
    )
    await sdk_session.add_items(source_items)
    config = {
        "name": "chat-context-compaction",
        "model": args.model,
        "instructions": (
            "Answer only from the current session context. Preserve exact identifiers, "
            "constraints, decisions, progress, and unresolved work. Answer in Chinese."
        ),
        "provider": {
            "type": "openai_compatible",
            "name": "mimo",
            "protocol": "chat_completions",
            "base_url": args.base_url,
            "api_key_env": args.api_key_env,
            "timeout_seconds": 180,
            "max_retries": 1,
            "structured_output_mode": "prompt",
        },
        "compaction": compaction,
    }
    capability = await container.compaction.probe_capabilities(config)
    canonical_before = await sdk_session.canonical_items()
    record = await container.compaction.compact_session(
        conversation.id,
        config,
        force=True,
        strategy="portable",
        focus="保留初始约束、精确标识符、权威文件、当前进度和未决问题",
        trigger="provider_e2e",
    )
    projected_after = await sdk_session.get_items()
    canonical_after = await sdk_session.canonical_items()
    verification = await execute(
        container,
        version.id,
        (
            "请从会话上下文恢复并逐项回答：1. 连续性 UUID；2. 权威文件绝对路径；"
            "3. 不可变安全约束；4. 当前任务；5. 未决问题。不要猜测。"
        ),
        session_id=conversation.id,
    )
    rendered = str(verification.get("output") or "")
    semantic_checks = {
        "uuid_preserved": continuity_id in rendered,
        "path_preserved": critical_path in rendered,
        "constraint_preserved": "不得访问生产系统" in rendered,
        "current_task_preserved": "MiMo" in rendered and "压缩" in rendered,
        "unresolved_question_preserved": "初始约束" in rendered and "权威文件" in rendered,
    }
    return {
        "status": verification["status"],
        "strategy": record.strategy,
        "capabilities": capability,
        "canonical_items_before": len(canonical_before),
        "canonical_items_after": len(canonical_after),
        "canonical_transcript_unchanged": canonical_before == canonical_after,
        "projected_items_after": len(projected_after),
        "tokens_before": record.tokens_before,
        "tokens_after": record.tokens_after,
        "compression_ratio": record.compression_ratio,
        "summary_input_tokens": record.summary_input_tokens,
        "summary_output_tokens": record.summary_output_tokens,
        "source_chunk_count": record.source_chunk_count,
        "all_chunks_covered": record.all_chunks_covered,
        "validation": record.validation_json,
        "semantic_checks": semantic_checks,
        "all_semantic_checks_passed": all(semantic_checks.values()),
        "verification": verification,
    }


async def suite(args: argparse.Namespace) -> dict[str, Any]:
    load_dotenv(Path.cwd() / ".env", override=False)
    key = os.environ.get(args.api_key_env)
    if not key:
        key = getpass.getpass(f"{args.api_key_env}: ")
        if not key:
            raise SystemExit("provider API key is required")
        os.environ[args.api_key_env] = key

    results: dict[str, Any] = {
        "provider": {
            "base_url": args.base_url,
            "model": args.model,
            "credential_source": args.api_key_env,
            "run_max_output_tokens_override": None,
            "compaction_summary_output_budget": (
                8192 if args.compaction_only else "configured_per_compaction_check"
            ),
        },
        "checks": {},
    }
    with tempfile.TemporaryDirectory(prefix="agent-system-provider-") as raw:
        root = Path(raw)
        settings = Settings(
            environment="development",
            database_url=f"sqlite+aiosqlite:///{root}/provider.db",
            artifact_root=root / "artifacts",
            skill_root=root / "skills",
            sandbox_root=root / "sandboxes",
            run_state_secret="provider-e2e-ephemeral-state-encryption-secret",
            tracing_disabled=True,
        )
        container = await create_container(settings=settings, start_worker=False)
        try:
            if args.compaction_only:
                results["checks"]["context_compaction"] = await compaction_check(
                    container, args
                )
                return results
            if args.structured_only:
                schema = {
                    "type": "object",
                    "properties": {
                        "answer": {"type": "string"},
                        "confidence": {"type": "number"},
                    },
                    "required": ["answer", "confidence"],
                    "additionalProperties": False,
                }
                structured = await create_version(
                    container,
                    slug="chat-structured-fallback-only",
                    protocol="chat_completions",
                    base_url=args.base_url,
                    model=args.model,
                    api_key_env=args.api_key_env,
                    instructions=(
                        "Return the requested answer using the required structured schema."
                    ),
                    output_schema=schema,
                    structured_output_mode="prompt",
                )
                results["checks"]["structured_output_prompt_fallback"] = await execute(
                    container,
                    structured.id,
                    "计算 19 + 23，并给出 0 到 1 的置信度。",
                )
                return results
            for protocol in ("responses", "chat_completions"):
                try:
                    version = await create_version(
                        container,
                        slug=f"{protocol.replace('_', '-')}-basic",
                        protocol=protocol,
                        base_url=args.base_url,
                        model=args.model,
                        api_key_env=args.api_key_env,
                        instructions="Follow the user request accurately and answer in Chinese.",
                    )
                    result = await execute(
                        container,
                        version.id,
                        "请用三条完整句子说明长期记忆、会话历史和上下文压缩的区别；"
                        "总长度不少于120个中文字符。",
                    )
                    output_length = len(str(result.get("output") or ""))
                    result["output_length"] = output_length
                    result["instruction_followed_120_chars"] = output_length >= 120
                    result["not_16_token_limited"] = (
                        result["status"] == "completed"
                        and result["usage"]["output_tokens"] > 16
                    )
                    results["checks"][f"{protocol}_streaming"] = result
                except Exception as exc:
                    results["checks"][f"{protocol}_streaming"] = {
                        "status": "setup_failed",
                        "error": {"code": type(exc).__name__, "message": str(exc)[:1000]},
                    }

            chat_version = await create_version(
                container,
                slug="chat-session",
                protocol="chat_completions",
                base_url=args.base_url,
                model=args.model,
                api_key_env=args.api_key_env,
                instructions="Use conversation history when answering. Answer concisely.",
            )
            conversation = SessionRecord(tenant_id="provider-test")
            async with container.db.sessions() as session, session.begin():
                session.add(conversation)
            first = await execute(
                container,
                chat_version.id,
                "请记住本次测试代号是 ORCHID-731，只回复已记住。",
                session_id=conversation.id,
            )
            second = await execute(
                container,
                chat_version.id,
                "刚才的测试代号是什么？只回复代号。",
                session_id=conversation.id,
            )
            results["checks"]["session_multi_turn"] = {
                "status": second["status"],
                "first_output": first["output"],
                "second_output": second["output"],
                "remembered": "ORCHID-731" in str(second["output"]),
                "usage": {
                    "requests": first["usage"]["requests"] + second["usage"]["requests"],
                    "total_tokens": first["usage"]["total_tokens"]
                    + second["usage"]["total_tokens"],
                },
            }

            schema = {
                "type": "object",
                "properties": {
                    "answer": {"type": "string"},
                    "confidence": {"type": "number"},
                },
                "required": ["answer", "confidence"],
                "additionalProperties": False,
            }
            structured = await create_version(
                container,
                slug="chat-structured",
                protocol="chat_completions",
                base_url=args.base_url,
                model=args.model,
                api_key_env=args.api_key_env,
                instructions="Return the requested answer using the required structured schema.",
                output_schema=schema,
                structured_output_mode="prompt",
            )
            results["checks"]["structured_output"] = await execute(
                container, structured.id, "计算 19 + 23，并给出 0 到 1 的置信度。"
            )

            async with container.db.sessions() as session:
                add = await session.scalar(select(ToolRecord).where(ToolRecord.slug == "add"))
                echo = await session.scalar(select(ToolRecord).where(ToolRecord.slug == "echo"))
            tool_version = await create_version(
                container,
                slug="chat-tool",
                protocol="chat_completions",
                base_url=args.base_url,
                model=args.model,
                api_key_env=args.api_key_env,
                instructions="You must call the add tool for arithmetic, then report its result.",
                bindings=[{"kind": "tool", "target_id": add.id}],
            )
            tool_result = await execute(container, tool_version.id, "请用工具计算 37.5 + 4.25。")
            tool_result["tool_called"] = (
                tool_result["event_counts"].get("tool.completed", 0) > 0
            )
            results["checks"]["function_tool"] = tool_result

            approval_version = await create_version(
                container,
                slug="chat-approval",
                protocol="chat_completions",
                base_url=args.base_url,
                model=args.model,
                api_key_env=args.api_key_env,
                instructions="You must call echo with the exact text APPROVAL-CHECK.",
                bindings=[
                    {
                        "kind": "tool",
                        "target_id": echo.id,
                        "config": {"approval_mode": "always"},
                    }
                ],
            )
            approval_run = await container.runner.create_run(
                tenant_id="provider-test",
                agent_version_id=approval_version.id,
                input_value="执行指定的 echo 工具调用。",
                session_id=None,
                context={},
                limits={"approval_timeout_seconds": 300},
                idempotency_key=None,
            )
            await container.runner.process_next()
            async with container.db.sessions() as session:
                paused = await session.get(RunRecord, approval_run.id)
                approval = await session.scalar(
                    select(ApprovalRecord).where(ApprovalRecord.run_id == approval_run.id)
                )
            approval_check: dict[str, Any] = {
                "paused_status": paused.status,
                "approval_created": approval is not None,
            }
            if approval is not None:
                await container.runner.decide_approval(
                    tenant_id="provider-test",
                    approval_id=approval.id,
                    decision="approved",
                    actor_id="provider-test",
                    reason="end-to-end validation",
                )
                await container.runner.process_next()
                async with container.db.sessions() as session:
                    resumed = await session.get(RunRecord, approval_run.id)
                approval_check.update(
                    {
                        "status": resumed.status,
                        "output": resumed.output_json,
                        "error": resumed.error_json,
                    }
                )
            results["checks"]["approval_resume"] = approval_check
            results["checks"]["context_compaction"] = await compaction_check(
                container, args
            )
        finally:
            await container.close()
    return results


def concise_report(result: dict[str, Any]) -> dict[str, Any]:
    checks: dict[str, Any] = {}
    for name, item in result.get("checks", {}).items():
        if not isinstance(item, dict):
            checks[name] = item
            continue
        if name == "context_compaction":
            verification = item.get("verification") or {}
            checks[name] = {
                key: item.get(key)
                for key in (
                    "status",
                    "strategy",
                    "canonical_items_before",
                    "canonical_items_after",
                    "canonical_transcript_unchanged",
                    "projected_items_after",
                    "tokens_before",
                    "tokens_after",
                    "compression_ratio",
                    "summary_input_tokens",
                    "summary_output_tokens",
                    "source_chunk_count",
                    "all_chunks_covered",
                    "semantic_checks",
                    "all_semantic_checks_passed",
                )
            }
            checks[name]["verification_status"] = verification.get("status")
            checks[name]["verification_output"] = verification.get("output")
            checks[name]["verification_error"] = verification.get("error")
            continue
        checks[name] = {
            key: item.get(key)
            for key in (
                "status",
                "output",
                "error",
                "usage",
                "paused_status",
                "approval_created",
                "remembered",
                "tool_called",
                "instruction_followed_120_chars",
                "not_16_token_limited",
            )
            if key in item
        }
    return {"provider": result.get("provider"), "checks": checks}


def main() -> None:
    args = arguments()
    result = asyncio.run(suite(args))
    report = concise_report(result) if args.concise else result
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

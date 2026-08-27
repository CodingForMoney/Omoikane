from __future__ import annotations

from typing import Any

from agent_system.container import Container
from agent_system.schemas import AgentCreate


def deterministic_compaction_config(**overrides: Any) -> dict[str, Any]:
    compaction = {
        "context_window": 40000,
        "reserved_output_tokens": 1024,
        "reserved_tool_loop_tokens": 0,
        "safety_margin_tokens": 256,
        "trigger_tokens": 30000,
        "target_projection_tokens": 18000,
        "keep_recent_tokens": 80,
        "min_tail_user_messages": 1,
        "summary_context_window": 8192,
        "summary_output_tokens": 1024,
        "summary_prompt_reserve_tokens": 1024,
        "artifact_threshold_tokens": 100_000,
        "minimum_savings_ratio": 0.05,
        "tokenizer": "o200k_base",
    }
    compaction.update(overrides)
    return {
        "model": "deterministic-test-model",
        "provider": {"type": "deterministic"},
        "compaction": compaction,
    }


async def published_agent(
    container: Container,
    *,
    slug: str,
    provider: dict[str, Any] | None = None,
    bindings: list[dict[str, Any]] | None = None,
    output_schema: dict[str, Any] | None = None,
    guardrails: dict[str, Any] | None = None,
    sandbox: dict[str, Any] | None = None,
    compaction: dict[str, Any] | None = None,
):
    agent = await container.registry.create_agent(
        "default", "test", AgentCreate(slug=slug, name=slug.title())
    )
    config: dict[str, Any] = {
        "name": slug,
        "model": "deterministic-test-model",
        "instructions": "Follow the test request.",
        "provider": provider or {"type": "deterministic", "response_text": "OK"},
        "runtime_policy": {
            "max_turns": 5,
            "max_tool_calls": 10,
            "max_duration_seconds": 30,
        },
        "bindings": bindings or [],
    }
    if output_schema:
        config["output_schema"] = output_schema
    if guardrails:
        config["guardrails"] = guardrails
    if sandbox:
        config["sandbox"] = sandbox
    if compaction:
        config["compaction"] = compaction
    version = await container.registry.create_agent_version("default", "test", agent.id, config)
    await container.registry.publish_agent_version("default", "test", version.id)
    return agent, version

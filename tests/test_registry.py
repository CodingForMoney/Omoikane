from __future__ import annotations

import pytest
from sqlalchemy import func, select

from agent_system.models import ToolRecord
from agent_system.schemas import AgentCreate, MCPServerCreate

from .helpers import published_agent


async def test_builtin_tools_and_immutable_agent_versions(container):
    async with container.db.sessions() as session:
        tool_count = await session.scalar(select(func.count(ToolRecord.id)))
    assert tool_count == 6

    agent = await container.registry.create_agent(
        "default", "tester", AgentCreate(slug="versioned-agent", name="Versioned Agent")
    )
    base = {
        "model": "deterministic-test-model",
        "instructions": "Return OK.",
        "provider": {"type": "deterministic", "response_text": "OK"},
    }
    v1 = await container.registry.create_agent_version(
        "default", "tester", agent.id, {**base, "name": "v1"}
    )
    v2 = await container.registry.create_agent_version(
        "default", "tester", agent.id, {**base, "name": "v2"}
    )
    assert (v1.version, v2.version) == (1, 2)
    assert v1.config_hash != v2.config_hash
    published = await container.registry.publish_agent_version("default", "tester", v1.id)
    assert published.status == "published"


async def test_inline_provider_and_mcp_secrets_are_rejected(container):
    agent = await container.registry.create_agent(
        "default", "tester", AgentCreate(slug="secret-agent", name="Secret Agent")
    )
    with pytest.raises(ValueError, match="credentials"):
        await container.registry.create_agent_version(
            "default",
            "tester",
            agent.id,
            {
                "model": "m",
                "instructions": "x",
                "provider": {"type": "openai_compatible", "api_key": "do-not-store"},
            },
        )
    with pytest.raises(ValueError, match="secret_refs"):
        await container.registry.create_mcp(
            "default",
            MCPServerCreate(
                slug="unsafe-mcp",
                name="Unsafe",
                transport="streamable_http",
                endpoint_config={"url": "https://example.test", "authorization": "secret"},
            ),
        )
    with pytest.raises(ValueError, match="context_window"):
        await container.registry.create_agent_version(
            "default",
            "tester",
            agent.id,
            {
                "model": "m",
                "instructions": "x",
                "provider": {"type": "deterministic"},
                "compaction": {"enabled": True},
            },
        )


async def test_multi_agent_handoff_and_agent_tool_build(container):
    _, child = await published_agent(container, slug="child-agent")
    _, parent = await published_agent(
        container,
        slug="parent-agent",
        bindings=[
            {"kind": "handoff", "target_id": child.id},
            {
                "kind": "agent_tool",
                "target_id": child.id,
                "config": {"tool_name": "ask_child"},
            },
        ],
    )
    async with container.factory.build(
        parent.id, {"tenant_id": "default", "run_id": "build-test"}
    ) as agent:
        assert len(agent.handoffs) == 1
        assert any(getattr(tool, "name", None) == "ask_child" for tool in agent.tools)

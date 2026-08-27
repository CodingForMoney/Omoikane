from __future__ import annotations

import json
import time
import uuid
from collections.abc import AsyncIterator
from typing import Any

from agents.items import ModelResponse
from agents.models.interface import Model
from agents.usage import Usage
from openai.types.responses import (
    Response,
    ResponseCompletedEvent,
    ResponseFunctionToolCall,
    ResponseOutputMessage,
    ResponseOutputText,
    ResponseReasoningSummaryTextDeltaEvent,
    ResponseTextDeltaEvent,
)


class DeterministicModel(Model):
    """Offline model used only by the automated test environment.

    It still drives the real Agents SDK runner, tools, approvals, sessions, and streaming loop.
    """

    def __init__(
        self,
        *,
        final_text: str = "OK",
        reasoning_text: str | None = None,
        tool_name: str | None = None,
        tool_arguments: dict[str, Any] | None = None,
    ):
        self.final_text = final_text
        self.reasoning_text = reasoning_text
        self.tool_name = tool_name
        self.tool_arguments = tool_arguments or {}

    @staticmethod
    def _has_tool_result(input_value: Any) -> bool:
        if not isinstance(input_value, list):
            return False
        for item in input_value:
            item_type = item.get("type") if isinstance(item, dict) else getattr(item, "type", None)
            if item_type in {"function_call_output", "mcp_call"}:
                return True
        return False

    def _output(self, input_value: Any) -> list[Any]:
        if self.tool_name and not self._has_tool_result(input_value):
            return [
                ResponseFunctionToolCall(
                    arguments=json.dumps(self.tool_arguments, separators=(",", ":")),
                    call_id=f"call_{uuid.uuid4().hex}",
                    name=self.tool_name,
                    type="function_call",
                )
            ]
        return [
            ResponseOutputMessage(
                id=f"msg_{uuid.uuid4().hex}",
                content=[
                    ResponseOutputText(annotations=[], text=self.final_text, type="output_text")
                ],
                role="assistant",
                status="completed",
                type="message",
            )
        ]

    async def get_response(self, *args, **kwargs) -> ModelResponse:
        input_value = kwargs.get("input", args[1] if len(args) > 1 else "")
        return ModelResponse(
            output=self._output(input_value),
            usage=Usage(),
            response_id=f"resp_{uuid.uuid4().hex}",
        )

    async def stream_response(self, *args, **kwargs) -> AsyncIterator:
        input_value = kwargs.get("input", args[1] if len(args) > 1 else "")
        output = self._output(input_value)
        if output and isinstance(output[0], ResponseOutputMessage):
            sequence_number = 0
            if self.reasoning_text:
                yield ResponseReasoningSummaryTextDeltaEvent(
                    delta=self.reasoning_text,
                    item_id=f"reasoning_{uuid.uuid4().hex}",
                    output_index=0,
                    sequence_number=sequence_number,
                    summary_index=0,
                    type="response.reasoning_summary_text.delta",
                )
                sequence_number += 1
            yield ResponseTextDeltaEvent(
                content_index=0,
                delta=self.final_text,
                item_id=output[0].id,
                logprobs=[],
                output_index=0,
                sequence_number=sequence_number,
                type="response.output_text.delta",
            )
        response = Response(
            id=f"resp_{uuid.uuid4().hex}",
            created_at=time.time(),
            model="deterministic-test-model",
            object="response",
            output=output,
            parallel_tool_calls=False,
            tool_choice="auto",
            tools=[],
        )
        yield ResponseCompletedEvent(
            response=response,
            sequence_number=2 if self.reasoning_text else 1,
            type="response.completed",
        )

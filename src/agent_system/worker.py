from __future__ import annotations

import asyncio

from .container import create_container


async def main() -> None:
    container = await create_container(start_worker=False)
    try:
        await container.runner.run_forever()
    finally:
        await container.close()


def run() -> None:
    asyncio.run(main())

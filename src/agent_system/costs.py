from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .db import Database
from .models import CostRecord, PriceRecord, UsageRecord


class BudgetExceeded(RuntimeError):
    pass


class CostService:
    def __init__(self, db: Database):
        self.db = db

    async def find_price(self, provider: str, model: str) -> PriceRecord | None:
        now = datetime.now(UTC)
        async with self.db.sessions() as session:
            return await session.scalar(
                select(PriceRecord)
                .where(
                    PriceRecord.provider == provider,
                    PriceRecord.model == model,
                    PriceRecord.effective_from <= now,
                    or_(PriceRecord.effective_to.is_(None), PriceRecord.effective_to > now),
                )
                .order_by(PriceRecord.effective_from.desc())
                .limit(1)
            )

    async def estimate(
        self, provider: str, model: str, input_tokens: int, output_tokens: int
    ) -> float:
        price = await self.find_price(provider, model)
        if price is None:
            return 0.0
        return (
            input_tokens * price.input_per_million + output_tokens * price.output_per_million
        ) / 1_000_000

    async def assert_within_run_budget(
        self,
        *,
        provider: str,
        model: str,
        input_tokens: int,
        output_tokens: int,
        limit_usd: float | None,
        run_id: str | None = None,
    ) -> None:
        if limit_usd is None:
            return
        prior = await self.run_spend(run_id) if run_id else 0.0
        amount = prior + await self.estimate(provider, model, input_tokens, output_tokens)
        if amount >= limit_usd:
            raise BudgetExceeded(
                f"run cost limit reached before next model call: {amount:.6f} >= {limit_usd:.6f}"
            )

    async def run_spend(self, run_id: str) -> float:
        async with self.db.sessions() as session:
            return float(
                await session.scalar(
                    select(func.coalesce(func.sum(CostRecord.amount), 0.0)).where(
                        CostRecord.run_id == run_id
                    )
                )
                or 0.0
            )

    async def record(
        self,
        *,
        tenant_id: str,
        run_id: str,
        provider: str,
        model: str,
        requests: int,
        input_tokens: int,
        output_tokens: int,
        total_tokens: int,
        raw: dict,
    ) -> tuple[UsageRecord, CostRecord]:
        price = await self.find_price(provider, model)
        async with self.db.sessions() as session, session.begin():
            return await self.record_in_transaction(
                session,
                tenant_id=tenant_id,
                run_id=run_id,
                provider=provider,
                model=model,
                requests=requests,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                total_tokens=total_tokens,
                raw=raw,
                price=price,
            )

    async def record_in_transaction(
        self,
        session: AsyncSession,
        *,
        tenant_id: str,
        run_id: str,
        provider: str,
        model: str,
        requests: int,
        input_tokens: int,
        output_tokens: int,
        total_tokens: int,
        raw: dict,
        price: PriceRecord | None,
    ) -> tuple[UsageRecord, CostRecord]:
        amount = 0.0
        calculation = {"price_missing": price is None}
        if price is not None:
            amount = (
                input_tokens * price.input_per_million + output_tokens * price.output_per_million
            ) / 1_000_000
            calculation = {
                "price_version": price.version,
                "input_per_million": price.input_per_million,
                "output_per_million": price.output_per_million,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
            }
        usage = UsageRecord(
            tenant_id=tenant_id,
            run_id=run_id,
            model=model,
            provider=provider,
            requests=requests,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            total_tokens=total_tokens,
            raw_json=raw,
        )
        session.add(usage)
        await session.flush()
        cost = CostRecord(
            tenant_id=tenant_id,
            run_id=run_id,
            usage_record_id=usage.id,
            price_id=price.id if price else None,
            amount=amount,
            currency=price.currency if price else "USD",
            calculation_json=calculation,
        )
        session.add(cost)
        return usage, cost

    async def tenant_spend(self, tenant_id: str, since: datetime) -> float:
        async with self.db.sessions() as session:
            return float(
                await session.scalar(
                    select(func.coalesce(func.sum(CostRecord.amount), 0.0)).where(
                        CostRecord.tenant_id == tenant_id,
                        CostRecord.created_at >= since,
                    )
                )
                or 0.0
            )

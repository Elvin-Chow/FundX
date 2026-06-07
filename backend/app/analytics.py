from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request

from .auth import current_user_id
from .portfolio_read import get_active_portfolio, get_portfolio_analytics, portfolio_not_found
from .services import (
    MarketId,
    calculate_drawdown,
    calculate_volatility,
    get_market_data_meta,
    list_market_top_assets,
    number_or_zero,
    parse_market,
    read_db,
    round_number,
)

router = APIRouter()

DEFENSIVE_SECTORS: dict[MarketId, list[str]] = {
    "us": ["Healthcare", "Consumer Staples", "Utilities"],
}

CYCLICAL_SECTORS: dict[MarketId, list[str]] = {
    "us": ["Consumer Discretionary", "Industrials", "Energy", "Materials", "Financials"],
}


@router.get("/api/analytics")
def get_analytics(request: Request) -> dict[str, Any]:
    market_id = parse_market(request.query_params.get("market"))
    portfolio_id = request.query_params.get("portfolioId") or None
    user_id = current_user_id(request)
    db = read_db()
    portfolio = get_active_portfolio(db, user_id, market_id, portfolio_id)
    if not portfolio or (portfolio_id and portfolio.get("id") != portfolio_id):
        meta = get_market_data_meta(db, market_id, cached=True)
        return {
            **meta,
            "cached": True,
            "portfolio": None,
            "benchmarkComparison": None,
            "exposures": {"sector": [], "assetType": [], "concentration": 0},
            "fundRiskTable": [],
            "stockScores": [],
        }

    analytics = get_portfolio_analytics(db, portfolio)
    summary = normalize_summary_for_response(analytics["summary"])
    cached = bool(analytics["cached"])
    funds = list_market_records(db, "funds", market_id)
    stocks = list_market_records(db, "stocks", market_id)
    benchmark = funds[0] if funds else None

    return {
        **get_market_data_meta(db, market_id, cached=cached),
        "cached": cached,
        "portfolio": summary,
        "benchmarkComparison": build_benchmark_comparison(summary, benchmark),
        "exposures": {
            "sector": summary.get("sectorExposure", []),
            "assetType": summary.get("assetTypeExposure", []),
            "concentration": summary.get("topHoldingConcentration", 0),
        },
        "fundRiskTable": [fund_risk_row(fund) for fund in funds],
        "stockScores": [stock_score_row(stock) for stock in stocks],
    }


@router.get("/api/insights")
def get_insights(request: Request) -> dict[str, Any]:
    market_id = parse_market(request.query_params.get("market"))
    portfolio_id = request.query_params.get("portfolioId") or None
    user_id = current_user_id(request)
    db = read_db()
    portfolio = get_active_portfolio(db, user_id, market_id, portfolio_id)
    if not portfolio or (portfolio_id and portfolio.get("id") != portfolio_id):
        return {
            **get_market_data_meta(db, market_id, cached=True),
            "insights": [],
            "cards": market_level_cards(db, market_id),
        }

    funds = list_market_records(db, "funds", market_id)
    stocks = list_market_records(db, "stocks", market_id)
    insights = get_portfolio_insights(db, portfolio, funds, stocks)

    return {
        **get_market_data_meta(db, market_id),
        "insights": insights,
        "cards": [to_insight_card(insight) for insight in insights],
    }


def list_market_records(db: dict[str, Any], key: str, market_id: MarketId) -> list[dict[str, Any]]:
    return [item for item in db.get(key, []) if item.get("marketId") == market_id]


def market_level_cards(db: dict[str, Any], market_id: MarketId) -> list[dict[str, Any]]:
    fund_count = sum(1 for asset in db.get("assets", []) if asset.get("marketId") == market_id and asset_kind_from_record(asset) == "fund")
    stock_count = sum(1 for asset in db.get("assets", []) if asset.get("marketId") == market_id and asset_kind_from_record(asset) == "stock")
    top_stocks = list_market_top_assets(db, market_id, "stock", 3, require_real_turnover=True)
    top_funds = list_market_top_assets(db, market_id, "fund", 3, require_real_turnover=True)
    cards = [
        {
            "id": f"market-library-{market_id}",
            "title": "Local asset library is ready",
            "body": f"{fund_count} funds and {stock_count} stocks are searchable locally. Open details to refresh quotes only for selected assets.",
            "actionLabel": "Open Discover",
            "tone": "positive",
            "targetWeight": 80,
        },
        {
            "id": f"market-turnover-{market_id}",
            "title": "Turnover leaders are cached",
            "body": format_turnover_card_body(top_stocks, top_funds),
            "actionLabel": "Review rankings",
            "tone": "neutral",
            "targetWeight": 60,
        },
        {
            "id": f"portfolio-empty-{market_id}",
            "title": "Create a portfolio to unlock holdings insights",
            "body": "After holdings are saved, FundX will calculate concentration, sector exposure, drawdown, and rebalancing suggestions.",
            "actionLabel": "Create portfolio",
            "tone": "neutral",
            "targetWeight": 40,
        },
    ]
    return cards


def asset_kind_from_record(asset: dict[str, Any]) -> str:
    if asset.get("kind") in ("stock", "fund"):
        return str(asset.get("kind"))
    return "fund" if asset.get("assetType") in ("fund", "etf") else "stock"


def format_turnover_card_body(top_stocks: list[dict[str, Any]], top_funds: list[dict[str, Any]]) -> str:
    stock_symbols = ", ".join(str(asset.get("symbol")) for asset in top_stocks if asset.get("symbol")) or "no stock cache"
    fund_symbols = ", ".join(str(asset.get("symbol")) for asset in top_funds if asset.get("symbol")) or "no fund cache"
    return f"Stocks: {stock_symbols}. Funds: {fund_symbols}. Use manual refresh when you need a newer full-market snapshot."


def build_benchmark_comparison(summary: dict[str, Any], benchmark: dict[str, Any] | None) -> dict[str, Any] | None:
    if not benchmark:
        return None

    benchmark_return = number_or_zero(benchmark.get("oneYearReturn"))
    benchmark_history = safe_history(benchmark.get("navHistory"))
    return {
        "benchmarkId": benchmark.get("id"),
        "benchmarkName": benchmark.get("name"),
        "benchmarkSymbol": benchmark.get("symbol"),
        "portfolioAnnualizedReturn": summary.get("annualizedReturn", 0),
        "benchmarkOneYearReturn": benchmark_return,
        "excessReturn": round_number(number_or_zero(summary.get("annualizedReturn")) - benchmark_return, 2),
        "portfolioVolatility": summary.get("volatility", 0),
        "benchmarkVolatility": calculate_volatility(benchmark_history),
        "portfolioMaxDrawdown": summary.get("maxDrawdown", 0),
        "benchmarkMaxDrawdown": calculate_drawdown(benchmark_history).get("maxDrawdown", 0),
    }


def fund_risk_row(fund: dict[str, Any]) -> dict[str, Any]:
    history = safe_history(fund.get("navHistory"))
    return {
        "id": fund.get("id"),
        "name": fund.get("name"),
        "symbol": fund.get("symbol"),
        "return": fund.get("oneYearReturn"),
        "volatility": calculate_volatility(history),
        "maxDrawdown": calculate_drawdown(history).get("maxDrawdown", 0),
        "dividendYield": fund.get("dividendYield"),
        "expenseRatio": fund.get("expenseRatio"),
    }


def stock_score_row(stock: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": stock.get("id"),
        "name": stock.get("name"),
        "symbol": stock.get("symbol"),
        "sector": stock.get("sector"),
        "valueScore": stock.get("valueScore"),
        "qualityScore": stock.get("qualityScore"),
        "riskScore": stock.get("riskScore"),
    }


def normalize_summary_for_response(summary: dict[str, Any]) -> dict[str, Any]:
    return {
        **summary,
        "sectorExposure": sorted_exposures(summary.get("sectorExposure")),
        "assetTypeExposure": sorted_exposures(summary.get("assetTypeExposure")),
    }


def sorted_exposures(value: Any) -> list[dict[str, Any]]:
    return sorted(safe_items(value), key=lambda item: number_or_zero(item.get("weight")), reverse=True)


def get_portfolio_insights(
    db: dict[str, Any],
    portfolio: dict[str, Any],
    funds: list[dict[str, Any]],
    stocks: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    summary = normalize_summary_for_response(get_portfolio_analytics(db, portfolio)["summary"])
    market_id = parse_market(str(portfolio.get("marketId") or ""))
    sector_exposure = safe_items(summary.get("sectorExposure"))
    top_sector = sector_exposure[0] if sector_exposure else None
    defensive_sectors = DEFENSIVE_SECTORS[market_id]
    cyclical_sectors = CYCLICAL_SECTORS[market_id]
    defensive_weight = sum(
        number_or_zero(item.get("weight")) for item in sector_exposure if item.get("name") in defensive_sectors
    )
    cyclical_weight = sum(
        number_or_zero(item.get("weight")) for item in sector_exposure if item.get("name") in cyclical_sectors
    )
    insights: list[dict[str, Any]] = []

    if top_sector and number_or_zero(top_sector.get("weight")) > 35:
        insights.append(
            make_insight(
                portfolio,
                "concentration",
                "Sector concentration is elevated",
                f"{top_sector.get('name')} is {format_js_number(number_or_zero(top_sector.get('weight')))}% of the portfolio.",
                "A sector above 35% can dominate drawdowns.",
                f"Move new contributions toward {', '.join(defensive_sectors[:2])}.",
                28,
                summary,
                funds,
                stocks,
            )
        )

    if number_or_zero(summary.get("topHoldingConcentration")) > 25:
        insights.append(
            make_insight(
                portfolio,
                "rebalance",
                "Top holding needs a lighter role",
                f"Largest holding is {format_js_number(number_or_zero(summary.get('topHoldingConcentration')))}% of total value.",
                "Single-position weight above 25% changes the intended risk profile.",
                "Use contributions or partial trimming to move it toward target.",
                18,
                summary,
                funds,
                stocks,
            )
        )

    if defensive_weight < 18:
        insights.append(
            make_insight(
                portfolio,
                "defensive",
                "Defensive ballast is light",
                f"Defensive sectors are {format_js_number(round_number(defensive_weight, 1))}% of the portfolio.",
                "Dividend, healthcare, staples, and utilities can soften market stress.",
                "Build a 20% defensive sleeve before adding more cyclical exposure.",
                20,
                summary,
                funds,
                stocks,
            )
        )

    if cyclical_weight > 45:
        insights.append(
            make_insight(
                portfolio,
                "valuation",
                "Cyclical exposure may amplify volatility",
                f"Cyclical sectors are {format_js_number(round_number(cyclical_weight, 1))}% of total value.",
                "Cyclicals often move together around macro surprises.",
                "Pair cyclical value with low-volatility or dividend funds.",
                38,
                summary,
                funds,
                stocks,
            )
        )

    if not insights:
        insights.append(
            make_insight(
                portfolio,
                "income",
                "Portfolio balance looks healthy",
                "No major concentration or defensive gaps were detected.",
                "Risk, sector, and target-weight checks are within FundX thresholds.",
                "Keep DCA active and review drift monthly.",
                100,
                summary,
                funds,
                stocks,
            )
        )

    return [{**insight, "id": f"{insight.get('id')}-{index + 1}"} for index, insight in enumerate(insights)]


def make_insight(
    portfolio: dict[str, Any],
    insight_type: str,
    title: str,
    issue: str,
    reason: str,
    suggestion: str,
    target_weight: int,
    summary: dict[str, Any],
    funds: list[dict[str, Any]],
    stocks: list[dict[str, Any]],
) -> dict[str, Any]:
    market_id = parse_market(str(portfolio.get("marketId") or ""))
    risk_score = number_or_zero(summary.get("riskScore"))
    max_drawdown = number_or_zero(summary.get("maxDrawdown"))
    volatility = number_or_zero(summary.get("volatility"))
    top_holding_weight = number_or_zero(summary.get("topHoldingConcentration"))
    after_risk = round_number(clamp(risk_score - 5, 0, 100), 1)
    after_drawdown = round_number(min(0, max_drawdown + 2), 2)
    candidate_funds = [fund.get("symbol") for fund in funds if fund.get("marketId") == market_id][:2]
    candidate_stocks = [stock.get("symbol") for stock in stocks if stock.get("marketId") == market_id][:1]
    candidate_assets = [
        symbol
        for symbol in [*candidate_funds, *candidate_stocks]
        if isinstance(symbol, str) and symbol
    ]

    return {
        "id": f"insight-{market_id}-{portfolio.get('id')}",
        "marketId": market_id,
        "portfolioId": portfolio.get("id"),
        "type": insight_type,
        "title": title,
        "issue": issue,
        "reason": reason,
        "suggestion": suggestion,
        "targetWeight": target_weight,
        "candidateAssets": candidate_assets,
        "estimatedImpact": (
            f"Risk score {format_js_number(risk_score)} -> {format_js_number(after_risk)}; "
            f"max drawdown {format_js_number(max_drawdown)}% -> {format_js_number(after_drawdown)}%."
        ),
        "beforeMetrics": {
            "riskScore": risk_score,
            "maxDrawdown": max_drawdown,
            "volatility": volatility,
            "topHoldingWeight": top_holding_weight,
        },
        "afterMetrics": {
            "riskScore": after_risk,
            "maxDrawdown": after_drawdown,
            "volatility": round_number(max(0, volatility - 1.5), 2),
            "topHoldingWeight": round_number(max(0, top_holding_weight - 4), 2),
        },
        "createdAt": "2026-06-03",
    }


def to_insight_card(insight: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": insight.get("id"),
        "title": insight.get("title"),
        "body": f"{insight.get('issue')} {insight.get('suggestion')}",
        "actionLabel": "Review suggestion",
        "tone": "positive" if insight.get("type") == "income" else "neutral",
        "targetWeight": insight.get("targetWeight"),
    }


def safe_history(value: Any) -> list[dict[str, Any]]:
    return value if isinstance(value, list) else []


def safe_items(value: Any) -> list[dict[str, Any]]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def clamp(value: float, minimum: float, maximum: float) -> float:
    return min(max(value, minimum), maximum)


def format_js_number(value: float) -> str:
    return f"{value:.12g}"
